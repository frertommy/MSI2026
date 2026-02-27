import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_KEY as string
);

// ─── Types ───────────────────────────────────────────────────
interface Match {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
}

interface OddsRow {
  fixture_id: number;
  bookmaker: string;
  home_odds: number | null;
  away_odds: number | null;
  draw_odds: number | null;
  days_before_kickoff: number;
}

interface NormalizedOdds {
  fixture_id: number;
  homeProb: number;
  drawProb: number;
  awayProb: number;
}

interface TeamPrice {
  team: string;
  league: string;
  date: string;
  model: string;
  implied_elo: number;
  dollar_price: number;
  confidence: number;
  matches_in_window: number;
}

interface MatchProb {
  fixture_id: number;
  model: string;
  date: string;
  home_team: string;
  away_team: string;
  implied_home_win: number;
  implied_draw: number;
  implied_away_win: number;
  bookmaker_home_win: number;
  bookmaker_draw: number;
  bookmaker_away_win: number;
  edge_home: number;
  edge_draw: number;
  edge_away: number;
}

// ─── Config ──────────────────────────────────────────────────
const START_DATE = "2026-01-01";
const END_DATE = "2026-02-26";
const INITIAL_ELO = 1500;
const BT_ITERATIONS = 50;
const WINDOW_DAYS = 60;
const DECAY_HALF_LIFE = 14; // days
const SHOCK_HALF_LIFE = 7; // days for reactive model
const SHOCK_K = 32;
const CARRY_DECAY = 0.005; // 0.5%/day toward league mean
const BATCH_SIZE = 500;

// ─── Helpers ─────────────────────────────────────────────────
function daysBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86400000;
}

function addDays(date: string, n: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function allDates(start: string, end: string): string[] {
  const dates: string[] = [];
  let d = start;
  while (d <= end) {
    dates.push(d);
    d = addDays(d, 1);
  }
  return dates;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function eloExpectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function eloDiffFromProb(prob: number): number {
  if (prob <= 0.001) prob = 0.001;
  if (prob >= 0.999) prob = 0.999;
  return -400 * Math.log10(1 / prob - 1);
}

function logistic(elo: number, mean: number, spread: number): number {
  return 100 / (1 + Math.exp(-(elo - mean) / spread));
}

// ─── Data Loading ────────────────────────────────────────────
async function loadMatches(): Promise<Match[]> {
  const { data, error } = await sb
    .from("matches")
    .select("fixture_id, date, league, home_team, away_team, score")
    .order("date", { ascending: true });
  if (error) throw new Error(`matches: ${error.message}`);
  return data ?? [];
}

async function loadOdds(): Promise<OddsRow[]> {
  const all: OddsRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from("odds_snapshots")
      .select("fixture_id, bookmaker, home_odds, away_odds, draw_odds, days_before_kickoff")
      .eq("days_before_kickoff", 1)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`odds: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ─── Step 1: Normalize odds (remove margin) ──────────────────
function normalizeOdds(
  odds: OddsRow[],
  usePinnacleOnly: boolean
): Map<number, NormalizedOdds> {
  // Group by fixture
  const byFixture = new Map<number, OddsRow[]>();
  for (const o of odds) {
    if (!o.home_odds || !o.away_odds || !o.draw_odds) continue;
    if (o.home_odds <= 1 || o.away_odds <= 1 || o.draw_odds <= 1) continue;
    if (!byFixture.has(o.fixture_id)) byFixture.set(o.fixture_id, []);
    byFixture.get(o.fixture_id)!.push(o);
  }

  const result = new Map<number, NormalizedOdds>();

  for (const [fid, rows] of byFixture) {
    let selected: OddsRow[];
    if (usePinnacleOnly) {
      const pinnacle = rows.filter((r) => r.bookmaker === "pinnacle");
      selected = pinnacle.length > 0 ? pinnacle : rows; // fallback to all
    } else {
      selected = rows;
    }

    // Compute median or direct odds
    let homeProb: number, drawProb: number, awayProb: number;

    if (usePinnacleOnly && selected[0]?.bookmaker === "pinnacle") {
      // Use Pinnacle directly (average if multiple entries)
      homeProb = selected.reduce((s, r) => s + 1 / r.home_odds!, 0) / selected.length;
      drawProb = selected.reduce((s, r) => s + 1 / r.draw_odds!, 0) / selected.length;
      awayProb = selected.reduce((s, r) => s + 1 / r.away_odds!, 0) / selected.length;
    } else {
      // Median across bookmakers
      homeProb = median(selected.map((r) => 1 / r.home_odds!));
      drawProb = median(selected.map((r) => 1 / r.draw_odds!));
      awayProb = median(selected.map((r) => 1 / r.away_odds!));
    }

    // Remove margin (normalize to sum=1)
    const total = homeProb + drawProb + awayProb;
    if (total <= 0) continue;

    result.set(fid, {
      fixture_id: fid,
      homeProb: homeProb / total,
      drawProb: drawProb / total,
      awayProb: awayProb / total,
    });
  }

  return result;
}

// ─── Step 2: Home advantage calibration ──────────────────────
function calibrateHomeAdvantage(matches: Match[]): number {
  let homeWins = 0;
  let total = 0;
  for (const m of matches) {
    const parts = m.score.split("-");
    if (parts.length !== 2) continue;
    const hg = parseInt(parts[0]);
    const ag = parseInt(parts[1]);
    if (isNaN(hg) || isNaN(ag)) continue;
    total++;
    if (hg > ag) homeWins++;
  }
  const homeWinRate = total > 0 ? homeWins / total : 0.46;
  // Elo equivalent of home advantage
  const homeEloAdv = eloDiffFromProb(homeWinRate);
  console.log(
    `  Home advantage: ${(homeWinRate * 100).toFixed(1)}% win rate → ${homeEloAdv.toFixed(0)} Elo`
  );
  return homeEloAdv;
}

// ─── Step 3: Bradley-Terry optimization ──────────────────────
function bradleyTerry(
  matches: Match[],
  normalizedOdds: Map<number, NormalizedOdds>,
  targetDate: string,
  homeAdv: number,
  allTeams: Set<string>,
  teamLeague: Map<string, string>
): Map<string, number> {
  // Filter matches within window
  const windowStart = addDays(targetDate, -WINDOW_DAYS);
  const windowMatches = matches.filter(
    (m) => m.date >= windowStart && m.date <= targetDate && normalizedOdds.has(m.fixture_id)
  );

  // Initialize ratings
  const ratings = new Map<string, number>();
  for (const t of allTeams) ratings.set(t, INITIAL_ELO);

  if (windowMatches.length === 0) return ratings;

  // Exponential decay weights
  const weights = windowMatches.map((m) => {
    const age = daysBetween(m.date, targetDate);
    return Math.pow(0.5, age / DECAY_HALF_LIFE);
  });

  // BT iterations
  for (let iter = 0; iter < BT_ITERATIONS; iter++) {
    const numSum = new Map<string, number>();
    const denSum = new Map<string, number>();
    for (const t of allTeams) {
      numSum.set(t, 0);
      denSum.set(t, 0);
    }

    for (let i = 0; i < windowMatches.length; i++) {
      const m = windowMatches[i];
      const odds = normalizedOdds.get(m.fixture_id)!;
      const w = weights[i];

      const rHome = ratings.get(m.home_team) ?? INITIAL_ELO;
      const rAway = ratings.get(m.away_team) ?? INITIAL_ELO;

      // Expected score with home advantage
      const expHome = eloExpectedScore(rHome + homeAdv, rAway);

      // Observed score from odds (home win prob as proxy)
      const obsHome = odds.homeProb;

      // BT update: accumulate
      numSum.set(m.home_team, numSum.get(m.home_team)! + w * obsHome);
      denSum.set(m.home_team, denSum.get(m.home_team)! + w * expHome);
      numSum.set(m.away_team, numSum.get(m.away_team)! + w * (1 - obsHome));
      denSum.set(m.away_team, denSum.get(m.away_team)! + w * (1 - expHome));
    }

    // Update ratings
    for (const t of allTeams) {
      const num = numSum.get(t) ?? 0;
      const den = denSum.get(t) ?? 0;
      if (den > 0.001) {
        const factor = num / den;
        const oldR = ratings.get(t) ?? INITIAL_ELO;
        // Damped update
        ratings.set(t, oldR + 40 * Math.log(factor));
      }
    }

    // Re-center around 1500
    const avg =
      [...ratings.values()].reduce((a, b) => a + b, 0) / ratings.size;
    for (const [t, r] of ratings) {
      ratings.set(t, r - avg + INITIAL_ELO);
    }
  }

  return ratings;
}

// ─── Step 4: Carry forward with decay ────────────────────────
// (handled inline in the main date loop)

// ─── Dollar price mapping ────────────────────────────────────
// Calibrate spread so ±300 Elo → ~$15-$85
// logistic(1800, 1500, spread) = 85 → 100/(1+e^(-300/spread)) = 85
// 1+e^(-300/spread) = 100/85 ≈ 1.176
// e^(-300/spread) ≈ 0.176
// -300/spread = ln(0.176) ≈ -1.736
// spread ≈ 300/1.736 ≈ 172.8
const DOLLAR_SPREAD = 173;

// ─── Reactive model: surprise shocks ─────────────────────────
interface Shock {
  team: string;
  date: string;
  amount: number; // elo shock
}

function computeShocks(
  matches: Match[],
  normalizedOdds: Map<number, NormalizedOdds>
): Shock[] {
  const shocks: Shock[] = [];
  for (const m of matches) {
    const odds = normalizedOdds.get(m.fixture_id);
    if (!odds) continue;
    const parts = m.score.split("-");
    if (parts.length !== 2) continue;
    const hg = parseInt(parts[0]);
    const ag = parseInt(parts[1]);
    if (isNaN(hg) || isNaN(ag)) continue;

    // Home team
    const homeActual = hg > ag ? 3 : hg === ag ? 1 : 0;
    const homeExpected = 3 * odds.homeProb + 1 * odds.drawProb + 0 * odds.awayProb;
    const homeSurprise = homeActual - homeExpected;
    shocks.push({ team: m.home_team, date: m.date, amount: homeSurprise * SHOCK_K });

    // Away team
    const awayActual = ag > hg ? 3 : ag === hg ? 1 : 0;
    const awayExpected = 3 * odds.awayProb + 1 * odds.drawProb + 0 * odds.homeProb;
    const awaySurprise = awayActual - awayExpected;
    shocks.push({ team: m.away_team, date: m.date, amount: awaySurprise * SHOCK_K });
  }
  return shocks;
}

function activeShockBoost(
  team: string,
  date: string,
  shocks: Shock[]
): number {
  let total = 0;
  for (const s of shocks) {
    if (s.team !== team) continue;
    if (s.date > date) continue;
    const age = daysBetween(s.date, date);
    if (age < 0) continue;
    total += s.amount * Math.pow(0.5, age / SHOCK_HALF_LIFE);
  }
  return total;
}

// ─── Match probability from Elo ──────────────────────────────
function matchProbsFromElo(
  homeElo: number,
  awayElo: number,
  homeAdv: number
): { homeWin: number; draw: number; awayWin: number } {
  const expHome = eloExpectedScore(homeElo + homeAdv, awayElo);
  // Simple model: P(draw) ≈ 0.28 * (1 - |expHome - 0.5| * 2)
  // This gives ~28% draw when equal, less when one side is strong
  const drawBase = 0.28 * (1 - Math.pow(Math.abs(expHome - 0.5) * 2, 0.8));
  const draw = Math.max(0.05, Math.min(0.35, drawBase));
  const homeWin = expHome * (1 - draw);
  const awayWin = (1 - expHome) * (1 - draw);

  // Normalize
  const total = homeWin + draw + awayWin;
  return {
    homeWin: homeWin / total,
    draw: draw / total,
    awayWin: awayWin / total,
  };
}

// ─── Batch insert helper ─────────────────────────────────────
async function insertBatched(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string
) {
  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from(table)
      .upsert(batch, { onConflict, ignoreDuplicates: false });
    if (error) {
      console.error(`  ${table} batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`);
      failed += batch.length;
    } else {
      inserted += batch.length;
    }
  }
  return { inserted, failed };
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log("Loading data from Supabase...");
  const [matches, odds] = await Promise.all([loadMatches(), loadOdds()]);
  console.log(`  ${matches.length} matches, ${odds.length} odds rows`);

  // All teams and leagues
  const allTeams = new Set<string>();
  const teamLeague = new Map<string, string>();
  for (const m of matches) {
    allTeams.add(m.home_team);
    allTeams.add(m.away_team);
    teamLeague.set(m.home_team, m.league);
    teamLeague.set(m.away_team, m.league);
  }
  console.log(`  ${allTeams.size} teams across ${new Set(teamLeague.values()).size} leagues`);

  // League means (for carry-forward decay)
  const leagues = [...new Set(teamLeague.values())];

  // Home advantage calibration
  const homeAdv = calibrateHomeAdvantage(matches);

  // Normalize odds: median (for smooth & reactive) and pinnacle (for sharp)
  console.log("Normalizing odds...");
  const medianOdds = normalizeOdds(odds, false);
  const pinnacleOdds = normalizeOdds(odds, true);
  console.log(`  Median: ${medianOdds.size} fixtures, Pinnacle: ${pinnacleOdds.size} fixtures`);

  // Compute surprise shocks for reactive model
  console.log("Computing surprise shocks...");
  const shocks = computeShocks(matches, medianOdds);
  console.log(`  ${shocks.length} shocks`);

  // Date range
  const dates = allDates(START_DATE, END_DATE);
  console.log(`\nRunning models for ${dates.length} days (${START_DATE} to ${END_DATE})...`);

  const teamPriceRows: TeamPrice[] = [];
  const matchProbRows: MatchProb[] = [];

  // Track last BT ratings + last match date per team
  let prevRatingsMedian = new Map<string, number>();
  let prevRatingsPinnacle = new Map<string, number>();
  const lastMatchDate = new Map<string, string>();

  // Track matches by date for match probabilities
  const matchesByDate = new Map<string, Match[]>();
  for (const m of matches) {
    if (!matchesByDate.has(m.date)) matchesByDate.set(m.date, []);
    matchesByDate.get(m.date)!.push(m);
  }

  for (const date of dates) {
    // Run BT for this date — median odds
    const ratingsMedian = bradleyTerry(
      matches, medianOdds, date, homeAdv, allTeams, teamLeague
    );

    // Run BT for this date — pinnacle odds
    const ratingsPinnacle = bradleyTerry(
      matches, pinnacleOdds, date, homeAdv, allTeams, teamLeague
    );

    // Compute league means
    const leagueMeans = new Map<string, number>();
    for (const league of leagues) {
      const leagueTeams = [...allTeams].filter((t) => teamLeague.get(t) === league);
      const mean =
        leagueTeams.reduce((s, t) => s + (ratingsMedian.get(t) ?? INITIAL_ELO), 0) /
        leagueTeams.length;
      leagueMeans.set(league, mean);
    }

    // Step 4: Carry-forward decay on non-match days
    for (const team of allTeams) {
      const league = teamLeague.get(team)!;
      const leagueMean = leagueMeans.get(league) ?? INITIAL_ELO;

      // Check if team played on this date
      const playedToday = (matchesByDate.get(date) ?? []).some(
        (m) => m.home_team === team || m.away_team === team
      );

      if (playedToday) {
        lastMatchDate.set(team, date);
      } else {
        // Decay toward league mean
        const lastDate = lastMatchDate.get(team);
        if (lastDate) {
          const daysSince = daysBetween(lastDate, date);
          const decayFactor = 1 - CARRY_DECAY * daysSince;

          const eloMedian = ratingsMedian.get(team) ?? INITIAL_ELO;
          ratingsMedian.set(
            team,
            leagueMean + (eloMedian - leagueMean) * Math.max(0.5, decayFactor)
          );

          const eloPinn = ratingsPinnacle.get(team) ?? INITIAL_ELO;
          ratingsPinnacle.set(
            team,
            leagueMean + (eloPinn - leagueMean) * Math.max(0.5, decayFactor)
          );
        }
      }
    }

    // Count matches in window per team
    const windowStart = addDays(date, -WINDOW_DAYS);
    const matchesInWindow = new Map<string, number>();
    for (const m of matches) {
      if (m.date >= windowStart && m.date <= date) {
        matchesInWindow.set(m.home_team, (matchesInWindow.get(m.home_team) ?? 0) + 1);
        matchesInWindow.set(m.away_team, (matchesInWindow.get(m.away_team) ?? 0) + 1);
      }
    }

    // Generate prices for each team
    for (const team of allTeams) {
      const league = teamLeague.get(team)!;
      const leagueMean = leagueMeans.get(league) ?? INITIAL_ELO;
      const mInW = matchesInWindow.get(team) ?? 0;

      // Oracle A — smooth (median BT, no shocks)
      const eloSmooth = ratingsMedian.get(team) ?? INITIAL_ELO;
      const priceSmooth = logistic(eloSmooth, leagueMean, DOLLAR_SPREAD);
      teamPriceRows.push({
        team, league, date, model: "smooth",
        implied_elo: Math.round(eloSmooth * 10) / 10,
        dollar_price: Math.round(priceSmooth * 100) / 100,
        confidence: Math.min(1, mInW / 10),
        matches_in_window: mInW,
      });

      // Oracle B — reactive (median BT + shock boost)
      const shockBoost = activeShockBoost(team, date, shocks);
      const eloReactive = eloSmooth + shockBoost;
      const priceReactive = logistic(eloReactive, leagueMean, DOLLAR_SPREAD);
      teamPriceRows.push({
        team, league, date, model: "reactive",
        implied_elo: Math.round(eloReactive * 10) / 10,
        dollar_price: Math.round(priceReactive * 100) / 100,
        confidence: Math.min(1, mInW / 10),
        matches_in_window: mInW,
      });

      // Oracle C — sharp (pinnacle BT, no shocks)
      const eloSharp = ratingsPinnacle.get(team) ?? INITIAL_ELO;
      const priceSharp = logistic(eloSharp, leagueMean, DOLLAR_SPREAD);
      teamPriceRows.push({
        team, league, date, model: "sharp",
        implied_elo: Math.round(eloSharp * 10) / 10,
        dollar_price: Math.round(priceSharp * 100) / 100,
        confidence: Math.min(1, mInW / 10),
        matches_in_window: mInW,
      });
    }

    // Match probabilities for matches on this date
    const todayMatches = matchesByDate.get(date) ?? [];
    for (const m of todayMatches) {
      const bookOdds = medianOdds.get(m.fixture_id);
      if (!bookOdds) continue;

      for (const model of ["smooth", "reactive", "sharp"] as const) {
        let homeElo: number, awayElo: number;

        if (model === "smooth") {
          homeElo = ratingsMedian.get(m.home_team) ?? INITIAL_ELO;
          awayElo = ratingsMedian.get(m.away_team) ?? INITIAL_ELO;
        } else if (model === "reactive") {
          homeElo =
            (ratingsMedian.get(m.home_team) ?? INITIAL_ELO) +
            activeShockBoost(m.home_team, date, shocks);
          awayElo =
            (ratingsMedian.get(m.away_team) ?? INITIAL_ELO) +
            activeShockBoost(m.away_team, date, shocks);
        } else {
          homeElo = ratingsPinnacle.get(m.home_team) ?? INITIAL_ELO;
          awayElo = ratingsPinnacle.get(m.away_team) ?? INITIAL_ELO;
        }

        const implied = matchProbsFromElo(homeElo, awayElo, homeAdv);

        matchProbRows.push({
          fixture_id: m.fixture_id,
          model,
          date: m.date,
          home_team: m.home_team,
          away_team: m.away_team,
          implied_home_win: Math.round(implied.homeWin * 10000) / 10000,
          implied_draw: Math.round(implied.draw * 10000) / 10000,
          implied_away_win: Math.round(implied.awayWin * 10000) / 10000,
          bookmaker_home_win: Math.round(bookOdds.homeProb * 10000) / 10000,
          bookmaker_draw: Math.round(bookOdds.drawProb * 10000) / 10000,
          bookmaker_away_win: Math.round(bookOdds.awayProb * 10000) / 10000,
          edge_home: Math.round((implied.homeWin - bookOdds.homeProb) * 10000) / 10000,
          edge_draw: Math.round((implied.draw - bookOdds.drawProb) * 10000) / 10000,
          edge_away: Math.round((implied.awayWin - bookOdds.awayProb) * 10000) / 10000,
        });
      }
    }

    // Progress
    if (dates.indexOf(date) % 7 === 0) {
      process.stdout.write(`\r  ${date} (${dates.indexOf(date) + 1}/${dates.length})`);
    }

    prevRatingsMedian = ratingsMedian;
    prevRatingsPinnacle = ratingsPinnacle;
  }

  console.log(`\n\nGenerated ${teamPriceRows.length} team_prices rows`);
  console.log(`Generated ${matchProbRows.length} match_probabilities rows`);

  // ─── Insert into Supabase ────────────────────────────────
  console.log("\nInserting team_prices...");
  const tp = await insertBatched("team_prices", teamPriceRows as unknown as Record<string, unknown>[], "team,date,model");
  console.log(`  team_prices: ${tp.inserted} inserted, ${tp.failed} failed`);

  console.log("Inserting match_probabilities...");
  const mp = await insertBatched("match_probabilities", matchProbRows as unknown as Record<string, unknown>[], "fixture_id,model,date");
  console.log(`  match_probabilities: ${mp.inserted} inserted, ${mp.failed} failed`);

  // ─── Stats ───────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════");
  console.log("SUMMARY");
  console.log("═══════════════════════════════════════");
  console.log(`Teams: ${allTeams.size}`);
  console.log(`Date range: ${START_DATE} → ${END_DATE} (${dates.length} days)`);

  for (const model of ["smooth", "reactive", "sharp"]) {
    const modelPrices = teamPriceRows.filter((r) => r.model === model);
    const prices = modelPrices.map((r) => r.dollar_price);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

    // Daily changes
    const changes: number[] = [];
    const byTeam = new Map<string, TeamPrice[]>();
    for (const r of modelPrices) {
      if (!byTeam.has(r.team)) byTeam.set(r.team, []);
      byTeam.get(r.team)!.push(r);
    }
    for (const [, rows] of byTeam) {
      rows.sort((a, b) => a.date.localeCompare(b.date));
      for (let i = 1; i < rows.length; i++) {
        changes.push(Math.abs(rows[i].dollar_price - rows[i - 1].dollar_price));
      }
    }
    const stdev =
      changes.length > 0
        ? Math.sqrt(
            changes.reduce((s, c) => s + c * c, 0) / changes.length -
              Math.pow(changes.reduce((s, c) => s + c, 0) / changes.length, 2)
          )
        : 0;
    const maxMove = changes.length > 0 ? Math.max(...changes) : 0;

    console.log(
      `\n  ${model.toUpperCase()}: avg=$${avg.toFixed(2)}, daily_stdev=$${stdev.toFixed(3)}, max_move=$${maxMove.toFixed(2)}`
    );
  }

  // Top arb edges
  console.log("\nTop 5 arb edges:");
  const allEdges = matchProbRows
    .flatMap((r) => [
      { ...r, edgeType: "home", edge: Math.abs(r.edge_home) },
      { ...r, edgeType: "draw", edge: Math.abs(r.edge_draw) },
      { ...r, edgeType: "away", edge: Math.abs(r.edge_away) },
    ])
    .sort((a, b) => b.edge - a.edge)
    .slice(0, 5);

  for (const e of allEdges) {
    console.log(
      `  ${e.model} | ${e.home_team} vs ${e.away_team} (${e.date}) | ${e.edgeType}: ${(e.edge * 100).toFixed(1)}%`
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
