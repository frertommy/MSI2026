/**
 * full-backtest.ts
 *
 * Comprehensive backtest of Model 4 (single-K oracle) across:
 *   - 5 leagues (EPL, La Liga, Bundesliga, Serie A, Ligue 1)
 *   - 3 seasons (2023-24, 2024-25, 2025-26)
 *   - ~4,900 finished matches
 *   - Multiple K values (20, 25, 30, 35, 40, 45, 50)
 *
 * Analyzes:
 *   1. Settlement correctness (win always up, loss always down)
 *   2. Shock magnitudes by K
 *   3. Cross-season transitions (the hard problem)
 *   4. Per-league behavior differences
 *   5. Elo distribution and convergence
 *   6. Drift / mean-reversion diagnostics
 *
 * Usage:
 *   cd scheduler
 *   npx tsx src/scripts/full-backtest.ts
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("SUPABASE_URL / SUPABASE_KEY not set");
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Types ──────────────────────────────────────────────────
interface Match {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
  commence_time: string | null;
}

interface OddsSnapshot {
  fixture_id: number;
  bookmaker: string;
  home_odds: number;
  draw_odds: number;
  away_odds: number;
  snapshot_time: string;
  days_before_kickoff: number | null;
}

// ─── De-vig ─────────────────────────────────────────────────
function powerDevig(homeOdds: number, drawOdds: number, awayOdds: number): [number, number, number] | null {
  const raw = [1 / homeOdds, 1 / drawOdds, 1 / awayOdds];
  if (raw.some((r) => r <= 0 || r >= 1 || !isFinite(r))) return null;

  // Binary search for k where sum(raw^k) = 1
  let lo = 0.3, hi = 5.0;
  for (let iter = 0; iter < 200; iter++) {
    const mid = (lo + hi) / 2;
    const sum = raw.reduce((s, r) => s + Math.pow(r, mid), 0);
    if (Math.abs(sum - 1.0) < 1e-12) { lo = mid; hi = mid; break; }
    if (sum > 1.0) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  const p = raw.map((r) => Math.pow(r, k));
  const pSum = p.reduce((a, b) => a + b, 0);
  return [p[0] / pSum, p[1] / pSum, p[2] / pSum];
}

function normalizeDevig(homeOdds: number, drawOdds: number, awayOdds: number): [number, number, number] | null {
  const raw = [1 / homeOdds, 1 / drawOdds, 1 / awayOdds];
  if (raw.some((r) => r <= 0 || !isFinite(r))) return null;
  const s = raw.reduce((a, b) => a + b, 0);
  return [raw[0] / s, raw[1] / s, raw[2] / s];
}

// ─── Data loading ───────────────────────────────────────────
async function loadAllMatches(): Promise<Match[]> {
  const all: Match[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("fixture_id, date, league, home_team, away_team, score, status, commence_time")
      .eq("status", "finished")
      .order("date", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) { console.error("Match load error:", error.message); break; }
    if (!data || data.length === 0) break;
    all.push(...(data as Match[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function loadOddsForFixtures(fixtureIds: number[]): Promise<Map<number, OddsSnapshot[]>> {
  const map = new Map<number, OddsSnapshot[]>();
  // Load in chunks of 200 fixture IDs
  const chunkSize = 200;
  for (let i = 0; i < fixtureIds.length; i += chunkSize) {
    const chunk = fixtureIds.slice(i, i + chunkSize);
    let from = 0;
    while (true) {
      const { data, error } = await sb
        .from("odds_snapshots")
        .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time, days_before_kickoff")
        .in("fixture_id", chunk)
        .range(from, from + 999);
      if (error) { console.error("Odds load error:", error.message); break; }
      if (!data || data.length === 0) break;
      for (const row of data as OddsSnapshot[]) {
        if (!map.has(row.fixture_id)) map.set(row.fixture_id, []);
        map.get(row.fixture_id)!.push(row);
      }
      if (data.length < 1000) break;
      from += 1000;
    }
    if ((i / chunkSize) % 10 === 0 && i > 0) {
      process.stdout.write(`  Loaded odds for ${i}/${fixtureIds.length} fixtures...\r`);
    }
  }
  return map;
}

// ─── KR consensus ───────────────────────────────────────────
interface KRResult {
  pHome: number;
  pDraw: number;
  pAway: number;
  E_home: number;
  E_away: number;
  booksUsed: number;
}

function computeKR(
  odds: OddsSnapshot[],
  kickoffUtc: string | null,
  matchDate: string
): KRResult | null {
  // Filter to prematch window: 0.5-2.0 days before kickoff
  let eligible: OddsSnapshot[];

  if (kickoffUtc) {
    const koTime = new Date(kickoffUtc).getTime();
    eligible = odds.filter((o) => {
      const snapTime = new Date(o.snapshot_time).getTime();
      const hoursBeforeKO = (koTime - snapTime) / (1000 * 3600);
      return hoursBeforeKO >= 12 && hoursBeforeKO <= 48 && snapTime < koTime;
    });
  } else {
    // Fallback: use days_before_kickoff if available, or date-based filter
    eligible = odds.filter((o) => {
      if (o.days_before_kickoff !== null) {
        return o.days_before_kickoff >= 0.5 && o.days_before_kickoff <= 2.0;
      }
      // Fallback: snapshot on match day or day before
      const snapDate = o.snapshot_time.slice(0, 10);
      const matchD = new Date(matchDate);
      const snapD = new Date(snapDate);
      const daysDiff = (matchD.getTime() - snapD.getTime()) / 86400000;
      return daysDiff >= 0 && daysDiff <= 2;
    });
  }

  if (eligible.length === 0) {
    // Ultra-fallback: use ANY prematch odds we have
    eligible = odds.filter((o) => {
      if (o.days_before_kickoff !== null) return o.days_before_kickoff >= 0;
      return true;
    });
  }

  if (eligible.length === 0) return null;

  // Per-bookmaker: take latest eligible snapshot
  const byBook = new Map<string, OddsSnapshot>();
  for (const o of eligible) {
    const existing = byBook.get(o.bookmaker);
    if (!existing || o.snapshot_time > existing.snapshot_time) {
      byBook.set(o.bookmaker, o);
    }
  }

  // Power de-vig each bookmaker
  const probs: [number, number, number][] = [];
  for (const o of byBook.values()) {
    if (o.home_odds < 1.01 || o.draw_odds < 1.01 || o.away_odds < 1.01) continue;
    const p = powerDevig(o.home_odds, o.draw_odds, o.away_odds);
    if (p && p.every((v) => v > 0 && v < 1)) probs.push(p);
  }

  if (probs.length === 0) {
    // Try normalization fallback
    for (const o of byBook.values()) {
      const p = normalizeDevig(o.home_odds, o.draw_odds, o.away_odds);
      if (p && p.every((v) => v > 0 && v < 1)) probs.push(p);
    }
  }

  if (probs.length === 0) return null;

  // Median consensus
  const sorted = [
    probs.map((p) => p[0]).sort((a, b) => a - b),
    probs.map((p) => p[1]).sort((a, b) => a - b),
    probs.map((p) => p[2]).sort((a, b) => a - b),
  ];
  const mid = Math.floor(probs.length / 2);
  const median = sorted.map((arr) =>
    probs.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid]
  );

  // Renormalize
  const mSum = median.reduce((a, b) => a + b, 0);
  const pH = median[0] / mSum;
  const pD = median[1] / mSum;
  const pA = median[2] / mSum;

  return {
    pHome: pH,
    pDraw: pD,
    pAway: pA,
    E_home: pH + 0.5 * pD,
    E_away: pA + 0.5 * pD,
    booksUsed: probs.length,
  };
}

// ─── Parse score ────────────────────────────────────────────
function parseScore(score: string): [number, number] | null {
  const m = score.match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  return [parseInt(m[1]), parseInt(m[2])];
}

// ─── Season detection ───────────────────────────────────────
function getSeason(date: string): string {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  // Season starts ~August
  if (month >= 7) return `${year}-${(year + 1).toString().slice(2)}`;
  return `${year - 1}-${year.toString().slice(2)}`;
}

// ─── Elo simulation ────────────────────────────────────────
interface SimConfig {
  K: number;
  label: string;
  seasonReset: boolean;
  resetAlpha: number; // carry fraction at season boundary
}

interface MatchResult {
  fixture_id: number;
  date: string;
  season: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  result: "W" | "D" | "L"; // from home perspective
  E_home: number;
  E_away: number;
  homeEloBefore: number;
  awayEloBefore: number;
  homeEloAfter: number;
  awayEloAfter: number;
  homeDeltaR: number;
  awayDeltaR: number;
  booksUsed: number;
  surprise_home: number;
}

function runSimulation(
  matches: Match[],
  oddsMap: Map<number, OddsSnapshot[]>,
  config: SimConfig
): MatchResult[] {
  const INITIAL_ELO = 1500;
  const teamElo = new Map<string, number>();
  const results: MatchResult[] = [];
  let prevSeason = "";

  for (const m of matches) {
    const sc = parseScore(m.score);
    if (!sc) continue;
    const [hg, ag] = sc;

    const season = getSeason(m.date);

    // Cross-season reset
    if (config.seasonReset && prevSeason && season !== prevSeason) {
      const allElos = [...teamElo.values()];
      const globalMean = allElos.length > 0
        ? allElos.reduce((a, b) => a + b, 0) / allElos.length
        : INITIAL_ELO;

      for (const [team, elo] of teamElo) {
        const newElo = config.resetAlpha * elo + (1 - config.resetAlpha) * globalMean;
        teamElo.set(team, newElo);
      }
    }
    prevSeason = season;

    // Get or init Elos
    const homeElo = teamElo.get(m.home_team) ?? INITIAL_ELO;
    const awayElo = teamElo.get(m.away_team) ?? INITIAL_ELO;

    // Compute KR
    const odds = oddsMap.get(m.fixture_id) ?? [];
    const kr = computeKR(odds, m.commence_time, m.date);

    let E_home: number, E_away: number;
    let booksUsed = 0;

    if (kr) {
      E_home = kr.E_home;
      E_away = kr.E_away;
      booksUsed = kr.booksUsed;
    } else {
      // Elo-only fallback when no odds
      const diff = homeElo - awayElo;
      E_home = 1 / (1 + Math.pow(10, -diff / 400));
      E_away = 1 - E_home;
    }

    // Actual scores (Elo convention: W=1, D=0.5, L=0)
    const homeActual = hg > ag ? 1 : hg === ag ? 0.5 : 0;
    const awayActual = 1 - homeActual;
    const homeResult = hg > ag ? "W" : hg === ag ? "D" : "L";

    // Settlement
    const homeSurprise = homeActual - E_home;
    const awaySurprise = awayActual - E_away;
    const homeDeltaR = config.K * homeSurprise;
    const awayDeltaR = config.K * awaySurprise;

    const homeEloAfter = homeElo + homeDeltaR;
    const awayEloAfter = awayElo + awayDeltaR;

    teamElo.set(m.home_team, homeEloAfter);
    teamElo.set(m.away_team, awayEloAfter);

    results.push({
      fixture_id: m.fixture_id,
      date: m.date,
      season,
      league: m.league,
      homeTeam: m.home_team,
      awayTeam: m.away_team,
      homeGoals: hg,
      awayGoals: ag,
      result: homeResult as "W" | "D" | "L",
      E_home,
      E_away,
      homeEloBefore: homeElo,
      awayEloBefore: awayElo,
      homeEloAfter,
      awayEloAfter,
      homeDeltaR,
      awayDeltaR,
      booksUsed,
      surprise_home: homeSurprise,
    });
  }

  return results;
}

// ─── Analysis ───────────────────────────────────────────────
interface AnalysisReport {
  config: SimConfig;
  totalMatches: number;
  matchesWithOdds: number;
  matchesWithoutOdds: number;

  // Correctness
  winsUp: number;
  winsTotal: number;
  lossesDown: number;
  lossesTotal: number;
  drawsTotal: number;

  // Shock magnitudes
  avgAbsDeltaR: number;
  avgWinDeltaR: number;
  avgDrawDeltaR: number;
  avgLossDeltaR: number;
  maxDeltaR: number;
  minDeltaR: number;
  p95AbsDeltaR: number;

  // Per league
  leagueStats: Map<string, {
    matches: number;
    avgAbsDeltaR: number;
    avgE: number;
    winsUp: number;
    lossesDown: number;
    winsTotal: number;
    lossesTotal: number;
  }>;

  // Per season
  seasonStats: Map<string, {
    matches: number;
    avgAbsDeltaR: number;
    eloSpread: number; // max-min Elo at end of season
    avgE: number;
  }>;

  // Cross-season transition
  crossSeasonDrift: {
    season: string;
    avgEloShift: number;
    maxEloShift: number;
    teamsAffected: number;
  }[];

  // Elo distribution at end
  finalEloStats: {
    mean: number;
    std: number;
    min: number;
    max: number;
    spread: number;
  };

  // Serial correlation (post-match drift)
  postMatchDrift: {
    afterWin: number;
    afterLoss: number;
    afterDraw: number;
  };
}

function analyzeResults(results: MatchResult[], config: SimConfig): AnalysisReport {
  const withOdds = results.filter((r) => r.booksUsed > 0);
  const withoutOdds = results.filter((r) => r.booksUsed === 0);

  // Flatten to team-level events
  interface TeamEvent {
    team: string;
    date: string;
    season: string;
    league: string;
    result: "W" | "D" | "L";
    E: number;
    deltaR: number;
    eloBefore: number;
    eloAfter: number;
  }

  const teamEvents: TeamEvent[] = [];
  for (const r of results) {
    teamEvents.push({
      team: r.homeTeam, date: r.date, season: r.season, league: r.league,
      result: r.result,
      E: r.E_home, deltaR: r.homeDeltaR,
      eloBefore: r.homeEloBefore, eloAfter: r.homeEloAfter,
    });
    const awayResult = r.result === "W" ? "L" : r.result === "L" ? "W" : "D";
    teamEvents.push({
      team: r.awayTeam, date: r.date, season: r.season, league: r.league,
      result: awayResult as "W" | "D" | "L",
      E: r.E_away, deltaR: r.awayDeltaR,
      eloBefore: r.awayEloBefore, eloAfter: r.awayEloAfter,
    });
  }

  // Correctness
  const wins = teamEvents.filter((e) => e.result === "W");
  const losses = teamEvents.filter((e) => e.result === "L");
  const draws = teamEvents.filter((e) => e.result === "D");

  const winsUp = wins.filter((e) => e.deltaR > 0).length;
  const lossesDown = losses.filter((e) => e.deltaR < 0).length;

  // Shock magnitudes
  const allDeltas = teamEvents.map((e) => e.deltaR);
  const absDeltas = allDeltas.map(Math.abs).sort((a, b) => a - b);
  const avgAbsDeltaR = absDeltas.reduce((a, b) => a + b, 0) / absDeltas.length;
  const p95Idx = Math.floor(absDeltas.length * 0.95);

  // Per league
  const leagueStats = new Map<string, any>();
  const leagues = [...new Set(teamEvents.map((e) => e.league))];
  for (const league of leagues) {
    const le = teamEvents.filter((e) => e.league === league);
    const lWins = le.filter((e) => e.result === "W");
    const lLosses = le.filter((e) => e.result === "L");
    leagueStats.set(league, {
      matches: le.length / 2,
      avgAbsDeltaR: le.map((e) => Math.abs(e.deltaR)).reduce((a, b) => a + b, 0) / le.length,
      avgE: le.map((e) => e.E).reduce((a, b) => a + b, 0) / le.length,
      winsUp: lWins.filter((e) => e.deltaR > 0).length,
      lossesDown: lLosses.filter((e) => e.deltaR < 0).length,
      winsTotal: lWins.length,
      lossesTotal: lLosses.length,
    });
  }

  // Per season
  const seasonStats = new Map<string, any>();
  const seasons = [...new Set(teamEvents.map((e) => e.season))].sort();
  for (const season of seasons) {
    const se = teamEvents.filter((e) => e.season === season);
    const seasonResults = results.filter((r) => r.season === season);
    // Get final Elos for this season
    const lastElo = new Map<string, number>();
    for (const e of se) {
      lastElo.set(e.team, e.eloAfter);
    }
    const elos = [...lastElo.values()];
    seasonStats.set(season, {
      matches: seasonResults.length,
      avgAbsDeltaR: se.map((e) => Math.abs(e.deltaR)).reduce((a, b) => a + b, 0) / se.length,
      eloSpread: elos.length > 0 ? Math.max(...elos) - Math.min(...elos) : 0,
      avgE: se.map((e) => e.E).reduce((a, b) => a + b, 0) / se.length,
    });
  }

  // Cross-season transition analysis
  const crossSeasonDrift: any[] = [];
  // Sort results by date, track team Elos at season boundaries
  const teamEloEndOfSeason = new Map<string, Map<string, number>>();
  for (const e of teamEvents) {
    if (!teamEloEndOfSeason.has(e.season)) teamEloEndOfSeason.set(e.season, new Map());
    teamEloEndOfSeason.get(e.season)!.set(e.team, e.eloAfter);
  }
  for (let i = 1; i < seasons.length; i++) {
    const prevSeason = seasons[i - 1];
    const currSeason = seasons[i];
    const prevElos = teamEloEndOfSeason.get(prevSeason);
    const currEvents = teamEvents.filter((e) => e.season === currSeason);
    if (!prevElos) continue;

    // First match of new season for each team
    const firstMatch = new Map<string, TeamEvent>();
    for (const e of currEvents) {
      if (!firstMatch.has(e.team)) firstMatch.set(e.team, e);
    }

    const shifts: number[] = [];
    for (const [team, firstE] of firstMatch) {
      const prevElo = prevElos.get(team);
      if (prevElo !== undefined) {
        shifts.push(firstE.eloBefore - prevElo);
      }
    }

    if (shifts.length > 0) {
      crossSeasonDrift.push({
        season: `${prevSeason} → ${currSeason}`,
        avgEloShift: shifts.reduce((a, b) => a + b, 0) / shifts.length,
        maxEloShift: Math.max(...shifts.map(Math.abs)),
        teamsAffected: shifts.length,
      });
    }
  }

  // Final Elo distribution
  const finalElos: number[] = [];
  const lastTeamElo = new Map<string, number>();
  for (const e of teamEvents) {
    lastTeamElo.set(e.team, e.eloAfter);
  }
  for (const elo of lastTeamElo.values()) finalElos.push(elo);
  const eloMean = finalElos.reduce((a, b) => a + b, 0) / finalElos.length;
  const eloStd = Math.sqrt(finalElos.reduce((s, e) => s + (e - eloMean) ** 2, 0) / finalElos.length);

  // Post-match serial correlation (simple: does the NEXT match's deltaR correlate with this result?)
  const teamEventsByTeam = new Map<string, TeamEvent[]>();
  for (const e of teamEvents) {
    if (!teamEventsByTeam.has(e.team)) teamEventsByTeam.set(e.team, []);
    teamEventsByTeam.get(e.team)!.push(e);
  }

  let afterWinDeltas: number[] = [];
  let afterLossDeltas: number[] = [];
  let afterDrawDeltas: number[] = [];
  for (const events of teamEventsByTeam.values()) {
    events.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < events.length - 1; i++) {
      const curr = events[i];
      const next = events[i + 1];
      // Only count if same season (cross-season breaks are different)
      if (curr.season !== next.season) continue;
      if (curr.result === "W") afterWinDeltas.push(next.deltaR);
      else if (curr.result === "L") afterLossDeltas.push(next.deltaR);
      else afterDrawDeltas.push(next.deltaR);
    }
  }

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  return {
    config,
    totalMatches: results.length,
    matchesWithOdds: withOdds.length,
    matchesWithoutOdds: withoutOdds.length,
    winsUp,
    winsTotal: wins.length,
    lossesDown,
    lossesTotal: losses.length,
    drawsTotal: draws.length,
    avgAbsDeltaR,
    avgWinDeltaR: avg(wins.map((e) => e.deltaR)),
    avgDrawDeltaR: avg(draws.map((e) => e.deltaR)),
    avgLossDeltaR: avg(losses.map((e) => e.deltaR)),
    maxDeltaR: Math.max(...allDeltas),
    minDeltaR: Math.min(...allDeltas),
    p95AbsDeltaR: absDeltas[p95Idx] ?? 0,
    leagueStats,
    seasonStats,
    crossSeasonDrift,
    finalEloStats: {
      mean: eloMean,
      std: eloStd,
      min: Math.min(...finalElos),
      max: Math.max(...finalElos),
      spread: Math.max(...finalElos) - Math.min(...finalElos),
    },
    postMatchDrift: {
      afterWin: avg(afterWinDeltas),
      afterLoss: avg(afterLossDeltas),
      afterDraw: avg(afterDrawDeltas),
    },
  };
}

// ─── Formatting ─────────────────────────────────────────────
function printReport(report: AnalysisReport) {
  const r = report;
  const cfg = r.config;

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${cfg.label}`);
  console.log(`  K=${cfg.K}  seasonReset=${cfg.seasonReset}  resetAlpha=${cfg.resetAlpha}`);
  console.log(`${"═".repeat(70)}`);

  console.log(`\n  Matches: ${r.totalMatches} total (${r.matchesWithOdds} with odds, ${r.matchesWithoutOdds} without)`);

  console.log(`\n  CORRECTNESS:`);
  console.log(`    Win → up:    ${r.winsUp}/${r.winsTotal}  (${(100 * r.winsUp / r.winsTotal).toFixed(1)}%)`);
  console.log(`    Loss → down: ${r.lossesDown}/${r.lossesTotal}  (${(100 * r.lossesDown / r.lossesTotal).toFixed(1)}%)`);

  console.log(`\n  SHOCK MAGNITUDES:`);
  console.log(`    Avg |ΔR|:   ${r.avgAbsDeltaR.toFixed(2)}  ($${(r.avgAbsDeltaR / 5).toFixed(2)} price)`);
  console.log(`    Avg win ΔR:  +${r.avgWinDeltaR.toFixed(2)}  (+$${(r.avgWinDeltaR / 5).toFixed(2)})`);
  console.log(`    Avg draw ΔR: ${r.avgDrawDeltaR.toFixed(2)}  ($${(r.avgDrawDeltaR / 5).toFixed(2)})`);
  console.log(`    Avg loss ΔR: ${r.avgLossDeltaR.toFixed(2)}  ($${(r.avgLossDeltaR / 5).toFixed(2)})`);
  console.log(`    Max ΔR:      +${r.maxDeltaR.toFixed(2)}  (+$${(r.maxDeltaR / 5).toFixed(2)})`);
  console.log(`    Min ΔR:      ${r.minDeltaR.toFixed(2)}  ($${(r.minDeltaR / 5).toFixed(2)})`);
  console.log(`    P95 |ΔR|:   ${r.p95AbsDeltaR.toFixed(2)}  ($${(r.p95AbsDeltaR / 5).toFixed(2)})`);

  console.log(`\n  PER LEAGUE:`);
  for (const [league, ls] of r.leagueStats) {
    console.log(`    ${league.padEnd(16)} ${ls.matches} matches  avg|ΔR|=${ls.avgAbsDeltaR.toFixed(1)}  avgE=${ls.avgE.toFixed(3)}  W↑=${ls.winsUp}/${ls.winsTotal}  L↓=${ls.lossesDown}/${ls.lossesTotal}`);
  }

  console.log(`\n  PER SEASON:`);
  for (const [season, ss] of r.seasonStats) {
    console.log(`    ${season}  ${ss.matches} matches  avg|ΔR|=${ss.avgAbsDeltaR.toFixed(1)}  eloSpread=${ss.eloSpread.toFixed(0)}  avgE=${ss.avgE.toFixed(3)}`);
  }

  console.log(`\n  CROSS-SEASON TRANSITIONS:`);
  if (r.crossSeasonDrift.length === 0) {
    console.log(`    (no season reset applied)`);
  }
  for (const d of r.crossSeasonDrift) {
    console.log(`    ${d.season}  avgShift=${d.avgEloShift.toFixed(1)}  maxShift=${d.maxEloShift.toFixed(1)}  teams=${d.teamsAffected}`);
  }

  console.log(`\n  FINAL ELO DISTRIBUTION (${[...new Map<string, number>()].length} teams):`);
  console.log(`    Mean: ${r.finalEloStats.mean.toFixed(1)}  Std: ${r.finalEloStats.std.toFixed(1)}`);
  console.log(`    Range: ${r.finalEloStats.min.toFixed(0)} – ${r.finalEloStats.max.toFixed(0)} (spread=${r.finalEloStats.spread.toFixed(0)})`);

  console.log(`\n  POST-MATCH SERIAL CORRELATION (should be near zero):`);
  console.log(`    After win:  avg next ΔR = ${r.postMatchDrift.afterWin.toFixed(2)} (${r.postMatchDrift.afterWin > 0 ? "✓ no reversal" : "⚠ reversal"})`);
  console.log(`    After loss: avg next ΔR = ${r.postMatchDrift.afterLoss.toFixed(2)} (${r.postMatchDrift.afterLoss < 0 ? "⚠ reversal" : "✓ no reversal"})`);
  console.log(`    After draw: avg next ΔR = ${r.postMatchDrift.afterDraw.toFixed(2)}`);
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  FULL MULTI-SEASON BACKTEST`);
  console.log(`  5 leagues × 3 seasons × multiple K values`);
  console.log(`${"═".repeat(70)}\n`);

  // 1. Load matches
  console.log("Loading matches...");
  const allMatches = await loadAllMatches();
  console.log(`  ${allMatches.length} finished matches loaded`);
  console.log(`  Date range: ${allMatches[0]?.date} – ${allMatches[allMatches.length - 1]?.date}`);

  // Count by league and season
  const leagueCounts = new Map<string, number>();
  const seasonCounts = new Map<string, number>();
  for (const m of allMatches) {
    leagueCounts.set(m.league, (leagueCounts.get(m.league) ?? 0) + 1);
    const season = getSeason(m.date);
    seasonCounts.set(season, (seasonCounts.get(season) ?? 0) + 1);
  }
  console.log(`\n  By league:`);
  for (const [l, c] of [...leagueCounts.entries()].sort()) console.log(`    ${l}: ${c}`);
  console.log(`\n  By season:`);
  for (const [s, c] of [...seasonCounts.entries()].sort()) console.log(`    ${s}: ${c}`);

  // 2. Load odds
  console.log("\nLoading odds snapshots...");
  const fixtureIds = allMatches.map((m) => m.fixture_id);
  const oddsMap = await loadOddsForFixtures(fixtureIds);
  const matchesWithOdds = fixtureIds.filter((id) => oddsMap.has(id));
  let totalOddsRows = 0;
  for (const rows of oddsMap.values()) totalOddsRows += rows.length;
  console.log(`  ${matchesWithOdds.length}/${fixtureIds.length} matches have odds data`);
  console.log(`  ${totalOddsRows.toLocaleString()} total odds rows`);

  // 3. Run simulations
  const configs: SimConfig[] = [
    // Pure Model 4 variants (no season reset)
    { K: 20, label: "K=20 (no reset)", seasonReset: false, resetAlpha: 1.0 },
    { K: 25, label: "K=25 (no reset)", seasonReset: false, resetAlpha: 1.0 },
    { K: 30, label: "K=30 (no reset) — Spec v1", seasonReset: false, resetAlpha: 1.0 },
    { K: 35, label: "K=35 (no reset)", seasonReset: false, resetAlpha: 1.0 },
    { K: 40, label: "K=40 (no reset) — Model 4", seasonReset: false, resetAlpha: 1.0 },
    { K: 45, label: "K=45 (no reset)", seasonReset: false, resetAlpha: 1.0 },
    { K: 50, label: "K=50 (no reset)", seasonReset: false, resetAlpha: 1.0 },
    // With season reset (α=0.7 = carry 70%, regress 30%)
    { K: 30, label: "K=30 + reset α=0.7", seasonReset: true, resetAlpha: 0.7 },
    { K: 40, label: "K=40 + reset α=0.7", seasonReset: true, resetAlpha: 0.7 },
    { K: 40, label: "K=40 + reset α=0.5", seasonReset: true, resetAlpha: 0.5 },
    { K: 40, label: "K=40 + reset α=0.85", seasonReset: true, resetAlpha: 0.85 },
  ];

  const reports: AnalysisReport[] = [];

  for (const cfg of configs) {
    process.stdout.write(`\n  Running: ${cfg.label}...`);
    const results = runSimulation(allMatches, oddsMap, cfg);
    const report = analyzeResults(results, cfg);
    reports.push(report);
    printReport(report);
  }

  // ─── Comparison table ──────────────────────────────────────
  console.log(`\n\n${"═".repeat(100)}`);
  console.log(`  COMPARISON TABLE`);
  console.log(`${"═".repeat(100)}`);
  console.log(
    "  " +
    "Config".padEnd(28) +
    "Matches".padStart(8) +
    "W↑%".padStart(7) +
    "L↓%".padStart(7) +
    "Avg|ΔR|".padStart(9) +
    "AvgW".padStart(8) +
    "AvgL".padStart(8) +
    "P95".padStart(8) +
    "Max".padStart(8) +
    "EloSprd".padStart(8) +
    "PostW".padStart(8) +
    "PostL".padStart(8)
  );
  console.log("  " + "─".repeat(98));

  for (const r of reports) {
    const wPct = (100 * r.winsUp / r.winsTotal).toFixed(1);
    const lPct = (100 * r.lossesDown / r.lossesTotal).toFixed(1);
    console.log(
      "  " +
      r.config.label.padEnd(28) +
      r.totalMatches.toString().padStart(8) +
      (wPct + "%").padStart(7) +
      (lPct + "%").padStart(7) +
      r.avgAbsDeltaR.toFixed(1).padStart(9) +
      ("+" + r.avgWinDeltaR.toFixed(1)).padStart(8) +
      r.avgLossDeltaR.toFixed(1).padStart(8) +
      r.p95AbsDeltaR.toFixed(1).padStart(8) +
      r.maxDeltaR.toFixed(1).padStart(8) +
      r.finalEloStats.spread.toFixed(0).padStart(8) +
      r.postMatchDrift.afterWin.toFixed(2).padStart(8) +
      r.postMatchDrift.afterLoss.toFixed(2).padStart(8)
    );
  }

  // ─── Cross-season deep dive ────────────────────────────────
  console.log(`\n\n${"═".repeat(70)}`);
  console.log(`  CROSS-SEASON DEEP DIVE`);
  console.log(`${"═".repeat(70)}`);

  // Run K=40 no-reset simulation and track per-team Elo trajectories
  const baseResults = runSimulation(allMatches, oddsMap, {
    K: 40, label: "K=40 base", seasonReset: false, resetAlpha: 1.0,
  });

  // Track team Elos over time
  const teamTrajectories = new Map<string, { date: string; season: string; elo: number; league: string }[]>();
  for (const r of baseResults) {
    for (const [team, elo, league] of [
      [r.homeTeam, r.homeEloAfter, r.league],
      [r.awayTeam, r.awayEloAfter, r.league],
    ] as [string, number, string][]) {
      if (!teamTrajectories.has(team)) teamTrajectories.set(team, []);
      teamTrajectories.get(team)!.push({ date: r.date, season: r.season, elo, league });
    }
  }

  // Find teams that played in multiple seasons
  console.log(`\n  Teams spanning multiple seasons (showing season end-to-start Elo jumps):\n`);
  const multiSeasonTeams: {
    team: string;
    league: string;
    seasons: { season: string; startElo: number; endElo: number; matches: number }[];
  }[] = [];

  for (const [team, trajectory] of teamTrajectories) {
    const bySeasonMap = new Map<string, typeof trajectory>();
    for (const t of trajectory) {
      if (!bySeasonMap.has(t.season)) bySeasonMap.set(t.season, []);
      bySeasonMap.get(t.season)!.push(t);
    }
    if (bySeasonMap.size < 2) continue;

    const seasonEntries = [...bySeasonMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const seasons = seasonEntries.map(([season, events]) => ({
      season,
      startElo: events[0].elo - 40, // approximate: first event's elo minus that match's delta
      endElo: events[events.length - 1].elo,
      matches: events.length,
    }));

    multiSeasonTeams.push({ team, league: trajectory[0].league, seasons });
  }

  // Sort by largest cross-season jump
  multiSeasonTeams.sort((a, b) => {
    const aJump = a.seasons.length > 1 ? Math.abs(a.seasons[1].endElo - a.seasons[0].endElo) : 0;
    const bJump = b.seasons.length > 1 ? Math.abs(b.seasons[1].endElo - b.seasons[0].endElo) : 0;
    return bJump - aJump;
  });

  // Show top 20 teams with biggest cross-season variance
  for (const t of multiSeasonTeams.slice(0, 20)) {
    const seasonStrs = t.seasons.map((s) =>
      `${s.season}: ${s.endElo.toFixed(0)} (${s.matches} matches)`
    ).join("  →  ");
    console.log(`    ${t.team.padEnd(24)} ${seasonStrs}`);
  }

  // ─── Elo explosion detection ──────────────────────────────
  console.log(`\n\n  ELO EXPLOSION DETECTION (teams drifting beyond ±300 from 1500):\n`);
  let explosionCount = 0;
  for (const [team, trajectory] of teamTrajectories) {
    const extremes = trajectory.filter((t) => Math.abs(t.elo - 1500) > 300);
    if (extremes.length > 0) {
      const worst = extremes.reduce((a, b) => Math.abs(a.elo - 1500) > Math.abs(b.elo - 1500) ? a : b);
      console.log(`    ${team.padEnd(24)} hit ${worst.elo.toFixed(0)} on ${worst.date} (${worst.season})`);
      explosionCount++;
    }
  }
  if (explosionCount === 0) console.log("    None — all teams within ±300 of 1500");

  // ─── Promoted/relegated team behavior ──────────────────────
  console.log(`\n\n  PROMOTED/RELEGATED TEAMS (teams appearing or disappearing between seasons):\n`);
  const teamsPerSeason = new Map<string, Set<string>>();
  for (const r of baseResults) {
    const season = r.season;
    if (!teamsPerSeason.has(season)) teamsPerSeason.set(season, new Set());
    teamsPerSeason.get(season)!.add(r.homeTeam);
    teamsPerSeason.get(season)!.add(r.awayTeam);
  }
  const sortedSeasons = [...teamsPerSeason.keys()].sort();
  for (let i = 1; i < sortedSeasons.length; i++) {
    const prev = teamsPerSeason.get(sortedSeasons[i - 1])!;
    const curr = teamsPerSeason.get(sortedSeasons[i])!;
    const newTeams = [...curr].filter((t) => !prev.has(t));
    const goneTeams = [...prev].filter((t) => !curr.has(t));
    if (newTeams.length > 0 || goneTeams.length > 0) {
      console.log(`    ${sortedSeasons[i - 1]} → ${sortedSeasons[i]}:`);
      if (newTeams.length > 0) console.log(`      New (promoted): ${newTeams.join(", ")}`);
      if (goneTeams.length > 0) console.log(`      Gone (relegated): ${goneTeams.join(", ")}`);
    }
  }

  // ─── Save raw results for further analysis ─────────────────
  const outDir = path.resolve(__dirname, "../../../data/backtest");
  fs.mkdirSync(outDir, { recursive: true });

  // Save the K=40 no-reset results as CSV
  const csvHeader = "fixture_id,date,season,league,home_team,away_team,home_goals,away_goals,result,E_home,E_away,home_elo_before,away_elo_before,home_delta_R,away_delta_R,home_elo_after,away_elo_after,books_used\n";
  const csvRows = baseResults.map((r) =>
    [r.fixture_id, r.date, r.season, r.league,
      `"${r.homeTeam}"`, `"${r.awayTeam}"`,
      r.homeGoals, r.awayGoals, r.result,
      r.E_home.toFixed(4), r.E_away.toFixed(4),
      r.homeEloBefore.toFixed(1), r.awayEloBefore.toFixed(1),
      r.homeDeltaR.toFixed(2), r.awayDeltaR.toFixed(2),
      r.homeEloAfter.toFixed(1), r.awayEloAfter.toFixed(1),
      r.booksUsed].join(",")
  ).join("\n");
  fs.writeFileSync(path.join(outDir, "k40_results.csv"), csvHeader + csvRows);
  console.log(`\n  Saved: data/backtest/k40_results.csv`);

  // Save comparison summary as JSON
  const summary = reports.map((r) => ({
    config: r.config,
    totalMatches: r.totalMatches,
    matchesWithOdds: r.matchesWithOdds,
    winUpPct: r.winsUp / r.winsTotal,
    lossDownPct: r.lossesDown / r.lossesTotal,
    avgAbsDeltaR: r.avgAbsDeltaR,
    avgWinDeltaR: r.avgWinDeltaR,
    avgLossDeltaR: r.avgLossDeltaR,
    p95AbsDeltaR: r.p95AbsDeltaR,
    maxDeltaR: r.maxDeltaR,
    eloSpread: r.finalEloStats.spread,
    eloStd: r.finalEloStats.std,
    postWinDrift: r.postMatchDrift.afterWin,
    postLossDrift: r.postMatchDrift.afterLoss,
  }));
  fs.writeFileSync(path.join(outDir, "comparison_summary.json"), JSON.stringify(summary, null, 2));
  console.log(`  Saved: data/backtest/comparison_summary.json`);

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  BACKTEST COMPLETE`);
  console.log(`${"═".repeat(70)}\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
