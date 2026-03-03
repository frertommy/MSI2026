/**
 * Pricing engine — optimized foundation.
 *
 * Key features:
 *   - Linear pricing: max(FLOOR, (elo-ZERO)/SLOPE)
 *   - 1/0.5/0 scoring (zero-sum), permanent shocks, flat K=20
 *   - Carry decay toward 45-day MA anchor
 *   - xG shock multiplier (Understat)
 *   - Odds drift signal (line movement)
 *   - In-memory odds cache: full load once, incremental merges after
 *   - Incremental mode: replay only from last checkpoint date
 *   - No EMA smoothing (instant price discovery)
 *   - No confidence metric (always 1)
 */
import { getSupabase, upsertBatched, fetchAllRows } from "../api/supabase-client.js";
import { log } from "../logger.js";
import {
  INITIAL_ELO,
  SHOCK_K,
  PRICE_SLOPE,
  PRICE_ZERO,
  PRICE_FLOOR,
  CARRY_DECAY_RATE,
  MA_WINDOW,
  LIVE_SHOCK_DISCOUNT,
  DRIFT_SCALE,
  DRIFT_MIN_HOURS,
  DRIFT_FADE_DAYS,
  XG_ENABLED,
  XG_FLOOR,
  XG_CEILING,
} from "../config.js";
import { loadXgData, type XgEntry } from "./understat-poller.js";
import type {
  Match,
  TeamPrice,
  MatchProb,
  PricingResult,
  DriftSnapshot,
} from "../types.js";

const LEGACY_NAME_MAP: Record<string, string> = {
  "1. FC Heidenheim": "1. FC Heidenheim 1846",
  "1899 Hoffenheim": "TSG 1899 Hoffenheim",
  "Alaves": "Deportivo Alavés",
  "Angers": "Angers SCO",
  "Arsenal": "Arsenal FC",
  "Aston Villa": "Aston Villa FC",
  "Atalanta": "Atalanta BC",
  "Atletico Madrid": "Club Atlético de Madrid",
  "Auxerre": "AJ Auxerre",
  "Barcelona": "FC Barcelona",
  "Bayer Leverkusen": "Bayer 04 Leverkusen",
  "Bayern München": "FC Bayern München",
  "Bologna": "Bologna FC 1909",
  "Bournemouth": "AFC Bournemouth",
  "Brentford": "Brentford FC",
  "Brighton": "Brighton & Hove Albion FC",
  "Burnley": "Burnley FC",
  "Cagliari": "Cagliari Calcio",
  "Celta Vigo": "RC Celta de Vigo",
  "Chelsea": "Chelsea FC",
  "Como": "Como 1907",
  "Crystal Palace": "Crystal Palace FC",
  "Espanyol": "RCD Espanyol de Barcelona",
  "Everton": "Everton FC",
  "FC St. Pauli": "FC St. Pauli 1910",
  "FSV Mainz 05": "1. FSV Mainz 05",
  "Fiorentina": "ACF Fiorentina",
  "Fulham": "Fulham FC",
  "Genoa": "Genoa CFC",
  "Getafe": "Getafe CF",
  "Girona": "Girona FC",
  "Hellas Verona": "Hellas Verona FC",
  "Inter": "FC Internazionale Milano",
  "Juventus": "Juventus FC",
  "Lazio": "SS Lazio",
  "Le Havre": "Le Havre AC",
  "Lecce": "US Lecce",
  "Lens": "Racing Club de Lens",
  "Levante": "Levante UD",
  "Lille": "Lille OSC",
  "Liverpool": "Liverpool FC",
  "Lorient": "FC Lorient",
  "Lyon": "Olympique Lyonnais",
  "Mallorca": "RCD Mallorca",
  "Manchester City": "Manchester City FC",
  "Manchester United": "Manchester United FC",
  "Marseille": "Olympique de Marseille",
  "Metz": "FC Metz",
  "Monaco": "AS Monaco FC",
  "Nantes": "FC Nantes",
  "Napoli": "SSC Napoli",
  "Newcastle": "Newcastle United FC",
  "Nice": "OGC Nice",
  "Nottingham Forest": "Nottingham Forest FC",
  "Osasuna": "CA Osasuna",
  "Paris Saint Germain": "Paris Saint-Germain FC",
  "Parma": "Parma Calcio 1913",
  "Pisa": "AC Pisa 1909",
  "Rayo Vallecano": "Rayo Vallecano de Madrid",
  "Real Betis": "Real Betis Balompié",
  "Real Madrid": "Real Madrid CF",
  "Real Sociedad": "Real Sociedad de Fútbol",
  "Rennes": "Stade Rennais FC 1901",
  "Sassuolo": "US Sassuolo Calcio",
  "Sevilla": "Sevilla CF",
  "Strasbourg": "RC Strasbourg Alsace",
  "Sunderland": "Sunderland AFC",
  "Torino": "Torino FC",
  "Tottenham": "Tottenham Hotspur FC",
  "Toulouse": "Toulouse FC",
  "Udinese": "Udinese Calcio",
  "Union Berlin": "1. FC Union Berlin",
  "Valencia": "Valencia CF",
  "Villarreal": "Villarreal CF",
  "Werder Bremen": "SV Werder Bremen",
  "West Ham": "West Ham United FC",
  "Wolves": "Wolverhampton Wanderers FC",
};

const LEGACY_URL =
  "https://raw.githubusercontent.com/frertommy/MSI/main/data/msi_daily.json";

// ─── In-memory odds cache ──────────────────────────────────
// Persists across pricing cycles in the long-lived scheduler process.
// Full load on first call, incremental merges after.
let oddsCache: Map<number, DriftSnapshot[]> | null = null;
let oddsCacheLastTime: string | null = null; // ISO timestamp of latest snapshot in cache

/**
 * Load ALL odds into memory on first call.
 * On subsequent calls, only fetch snapshots newer than the last load.
 * Merges new snapshots into the existing cache.
 */
async function loadOddsWithCache(
  fixtureIds: number[]
): Promise<Map<number, DriftSnapshot[]>> {
  const sb = getSupabase();
  const BATCH = 30;
  const PAGE = 1000;

  if (oddsCache === null) {
    // First call: full load (same as before but builds cache)
    log.info("  Odds cache: full initial load...");
    oddsCache = new Map();
    oddsCacheLastTime = null;

    for (let i = 0; i < fixtureIds.length; i += BATCH) {
      const batch = fixtureIds.slice(i, i + BATCH);
      let from = 0;
      while (true) {
        const { data, error } = await sb
          .from("odds_snapshots")
          .select("fixture_id, bookmaker, home_odds, away_odds, draw_odds, snapshot_time")
          .in("fixture_id", batch)
          .range(from, from + PAGE - 1);

        if (error) {
          log.error(`odds batch error (offset ${from}):`, error.message);
          break;
        }
        if (!data || data.length === 0) break;

        for (const row of data as DriftSnapshot[]) {
          if (!row.home_odds || !row.away_odds || !row.draw_odds) continue;
          if (row.home_odds <= 1 || row.away_odds <= 1 || row.draw_odds <= 1) continue;
          const fid = row.fixture_id;
          if (!oddsCache.has(fid)) oddsCache.set(fid, []);
          oddsCache.get(fid)!.push(row);
          if (!oddsCacheLastTime || row.snapshot_time > oddsCacheLastTime) {
            oddsCacheLastTime = row.snapshot_time;
          }
        }

        if (data.length < PAGE) break;
        from += PAGE;
      }
    }

    // Sort each fixture's snapshots by time
    for (const snaps of oddsCache.values()) {
      snaps.sort((a, b) => a.snapshot_time.localeCompare(b.snapshot_time));
    }

    const totalSnaps = [...oddsCache.values()].reduce((a, b) => a + b.length, 0);
    log.info(`  Odds cache: loaded ${oddsCache.size} fixtures (${totalSnaps} snapshots)`);
  } else {
    // Subsequent call: incremental merge
    const sinceTime = oddsCacheLastTime ?? "2000-01-01T00:00:00Z";
    log.info(`  Odds cache: incremental fetch since ${sinceTime}...`);
    let newSnapshots = 0;
    let newFixtures = 0;

    // Also check for any new fixture IDs not in cache yet
    const uncachedIds = fixtureIds.filter((id) => !oddsCache!.has(id));
    const idsToFetch = uncachedIds.length > 0 ? uncachedIds : [];

    // Fetch new snapshots by time (for all fixtures)
    let from = 0;
    while (true) {
      const { data, error } = await sb
        .from("odds_snapshots")
        .select("fixture_id, bookmaker, home_odds, away_odds, draw_odds, snapshot_time")
        .gt("snapshot_time", sinceTime)
        .range(from, from + PAGE - 1);

      if (error) {
        log.error("odds incremental fetch error:", error.message);
        break;
      }
      if (!data || data.length === 0) break;

      for (const row of data as DriftSnapshot[]) {
        if (!row.home_odds || !row.away_odds || !row.draw_odds) continue;
        if (row.home_odds <= 1 || row.away_odds <= 1 || row.draw_odds <= 1) continue;
        const fid = row.fixture_id;
        if (!oddsCache!.has(fid)) {
          oddsCache!.set(fid, []);
          newFixtures++;
        }
        oddsCache!.get(fid)!.push(row);
        newSnapshots++;
        if (!oddsCacheLastTime || row.snapshot_time > oddsCacheLastTime) {
          oddsCacheLastTime = row.snapshot_time;
        }
      }

      if (data.length < PAGE) break;
      from += PAGE;
    }

    // Fetch odds for entirely new fixture IDs
    if (idsToFetch.length > 0) {
      for (let i = 0; i < idsToFetch.length; i += BATCH) {
        const batch = idsToFetch.slice(i, i + BATCH);
        let bFrom = 0;
        while (true) {
          const { data, error } = await sb
            .from("odds_snapshots")
            .select("fixture_id, bookmaker, home_odds, away_odds, draw_odds, snapshot_time")
            .in("fixture_id", batch)
            .range(bFrom, bFrom + PAGE - 1);

          if (error) break;
          if (!data || data.length === 0) break;

          for (const row of data as DriftSnapshot[]) {
            if (!row.home_odds || !row.away_odds || !row.draw_odds) continue;
            if (row.home_odds <= 1 || row.away_odds <= 1 || row.draw_odds <= 1) continue;
            const fid = row.fixture_id;
            if (!oddsCache!.has(fid)) {
              oddsCache!.set(fid, []);
              newFixtures++;
            }
            oddsCache!.get(fid)!.push(row);
            newSnapshots++;
            if (!oddsCacheLastTime || row.snapshot_time > oddsCacheLastTime) {
              oddsCacheLastTime = row.snapshot_time;
            }
          }

          if (data.length < PAGE) break;
          bFrom += PAGE;
        }
      }
    }

    // Re-sort only fixtures that got new data
    if (newSnapshots > 0) {
      for (const snaps of oddsCache!.values()) {
        // Only re-sort if unsorted (check last two elements)
        if (snaps.length >= 2) {
          const last = snaps[snaps.length - 1];
          const prev = snaps[snaps.length - 2];
          if (last.snapshot_time < prev.snapshot_time) {
            snaps.sort((a, b) => a.snapshot_time.localeCompare(b.snapshot_time));
          }
        }
      }
    }

    log.info(`  Odds cache: +${newSnapshots} snapshots, +${newFixtures} new fixtures`);
  }

  return oddsCache;
}

/** Reset the odds cache (for testing or forced full reload). */
export function resetOddsCache(): void {
  oddsCache = null;
  oddsCacheLastTime = null;
}

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

function parseScore(score: string): [number, number] | null {
  const parts = score.split("-");
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0].trim());
  const a = parseInt(parts[1].trim());
  if (isNaN(h) || isNaN(a)) return null;
  return [h, a];
}

// ─── Data Loading ────────────────────────────────────────────
async function loadMatches(): Promise<Match[]> {
  // Use paginated fetch — Supabase default limit is 1000 rows,
  // but we have 1400+ matches and need ALL of them.
  const rows = await fetchAllRows<Record<string, unknown>>(
    "matches",
    "fixture_id, date, league, home_team, away_team, score, status",
    undefined,
    { column: "date", ascending: true }
  );

  // Deduplicate: same date+home+away can have multiple fixture_ids.
  // Prefer rows with real scores over "N/A".
  const byKey = new Map<string, Match>();
  for (const r of rows) {
    const m: Match = {
      fixture_id: r.fixture_id as number,
      date: r.date as string,
      league: r.league as string,
      home_team: r.home_team as string,
      away_team: r.away_team as string,
      score: r.score as string,
      status: r.status as string,
    };
    const key = `${m.date}|${m.home_team}|${m.away_team}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, m);
    } else if (
      m.status === "finished" && existing.status !== "finished"
    ) {
      byKey.set(key, m);
    } else if (
      m.score && m.score !== "N/A" &&
      (!existing.score || existing.score === "N/A")
    ) {
      byKey.set(key, m);
    }
  }

  const matches = [...byKey.values()].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  log.info(`  Loaded ${rows.length} match rows → ${matches.length} deduplicated matches`);
  return matches;
}

// Freshness half-life for odds staleness (used by getBestOddsAsOf)
const ODDS_FRESHNESS_HALFLIFE_HOURS = 72;

/**
 * Point-in-time odds query: find the best odds available as of a given datetime.
 * - Finds latest snapshot per bookmaker where snapshot_time <= asOfISO
 * - Prefers Pinnacle; falls back to median across bookmakers
 * - Computes freshness: exp(-hoursAgo / half-life)
 */
function getBestOddsAsOf(
  fixtureId: number,
  asOfISO: string,
  oddsIndex: Map<number, DriftSnapshot[]>
): { homeProb: number; drawProb: number; awayProb: number; freshness: number } | null {
  const snapshots = oddsIndex.get(fixtureId);
  if (!snapshots || snapshots.length === 0) return null;

  const asOfTime = new Date(asOfISO).getTime();

  // Find latest snapshot per bookmaker where snapshot_time <= asOfISO
  const latestByBk = new Map<string, DriftSnapshot>();
  let latestTime = 0;

  for (const s of snapshots) {
    const sTime = new Date(s.snapshot_time).getTime();
    if (sTime > asOfTime) continue;
    const existing = latestByBk.get(s.bookmaker);
    if (!existing || sTime > new Date(existing.snapshot_time).getTime()) {
      latestByBk.set(s.bookmaker, s);
      if (sTime > latestTime) latestTime = sTime;
    }
  }

  if (latestByBk.size === 0) return null;

  // Prefer Pinnacle, else median across bookmakers
  const pinnacle = latestByBk.get("pinnacle");
  let homeProb: number, drawProb: number, awayProb: number;

  if (pinnacle) {
    homeProb = 1 / pinnacle.home_odds;
    drawProb = 1 / pinnacle.draw_odds;
    awayProb = 1 / pinnacle.away_odds;
  } else {
    const rows = [...latestByBk.values()];
    homeProb = median(rows.map((r) => 1 / r.home_odds));
    drawProb = median(rows.map((r) => 1 / r.draw_odds));
    awayProb = median(rows.map((r) => 1 / r.away_odds));
  }

  // Normalize
  const total = homeProb + drawProb + awayProb;
  if (total <= 0) return null;
  homeProb /= total;
  drawProb /= total;
  awayProb /= total;

  // Freshness: exp(-hoursAgo / half-life)
  const hoursAgo = (asOfTime - latestTime) / 3600000;
  const freshness = Math.exp(-hoursAgo / ODDS_FRESHNESS_HALFLIFE_HOURS);

  return { homeProb, drawProb, awayProb, freshness };
}

async function fetchLegacyElos(): Promise<Map<string, number>> {
  log.info("Fetching legacy MSI ratings...");
  try {
    const resp = await fetch(LEGACY_URL);
    if (!resp.ok) {
      log.error(`Failed to fetch legacy data: ${resp.status}`);
      return new Map();
    }
    const data = (await resp.json()) as Record<
      string,
      { date: string; rating: number }[]
    >;
    const eloMap = new Map<string, number>();
    const seasonStart = "2025-08-01";
    for (const [legacyName, entries] of Object.entries(data)) {
      if (!entries || entries.length === 0) continue;
      const preSeason = entries.filter((e) => e.date < seasonStart);
      const startRating = preSeason.length > 0
        ? preSeason[preSeason.length - 1].rating
        : entries[0].rating;
      eloMap.set(legacyName, startRating);
    }
    log.info(`  ${eloMap.size} teams in legacy data (pre-season anchor: <${seasonStart})`);
    return eloMap;
  } catch (err) {
    log.error("Legacy fetch error", err instanceof Error ? err.message : err);
    return new Map();
  }
}

function buildStartingElos(
  allTeams: Set<string>,
  legacyElos: Map<string, number>
): Map<string, number> {
  const startingElos = new Map<string, number>();
  for (const team of allTeams) {
    const legacyName = LEGACY_NAME_MAP[team] || team;
    if (legacyElos.has(legacyName)) {
      startingElos.set(team, legacyElos.get(legacyName)!);
    } else {
      startingElos.set(team, INITIAL_ELO);
    }
  }
  return startingElos;
}

// ─── Home advantage ──────────────────────────────────────────
export function calibrateHomeAdvantage(matches: Match[]): number {
  let homeWins = 0;
  let total = 0;
  for (const m of matches) {
    const sc = parseScore(m.score);
    if (!sc) continue;
    total++;
    if (sc[0] > sc[1]) homeWins++;
  }
  const homeWinRate = total > 0 ? homeWins / total : 0.46;
  const prob = Math.max(0.001, Math.min(0.999, homeWinRate));
  return -400 * Math.log10(1 / prob - 1);
}

// ─── xG multiplier ──────────────────────────────────────────
function xgMultiplier(
  teamXg: number,
  opponentXg: number,
  goalDiff: number
): number {
  const xgDiff = teamXg - opponentXg;
  const sign = goalDiff > 0 ? 1 : goalDiff < 0 ? -1 : 0;
  const raw = 1.0 + 0.3 * xgDiff * sign;
  return Math.max(XG_FLOOR, Math.min(XG_CEILING, raw));
}

// ─── Odds drift signal ───────────────────────────────────────
function computeDriftForDate(
  date: string,
  matches: Match[],
  driftOdds: Map<number, DriftSnapshot[]>
): Map<string, number> {
  const driftMap = new Map<string, number>();
  const cutoff = addDays(date, 14);

  const upcoming = matches.filter((m) => m.date > date && m.date <= cutoff);

  for (const match of upcoming) {
    const snapshots = driftOdds.get(match.fixture_id);
    if (!snapshots || snapshots.length < 2) continue;

    const available = snapshots.filter(
      (s) => s.snapshot_time.slice(0, 10) <= date
    );
    if (available.length < 2) continue;

    const pinnacle = available.filter((s) => s.bookmaker === "pinnacle");
    const selected = pinnacle.length >= 2 ? pinnacle : available;

    selected.sort((a, b) => a.snapshot_time.localeCompare(b.snapshot_time));

    const earliest = selected[0];
    const latest = selected[selected.length - 1];

    const hoursDiff =
      (new Date(latest.snapshot_time).getTime() -
        new Date(earliest.snapshot_time).getTime()) /
      3600000;
    if (hoursDiff < DRIFT_MIN_HOURS) continue;

    const dBefore = daysBetween(date, match.date);
    const weight = Math.max(0, Math.min(1, (dBefore - 1) / DRIFT_FADE_DAYS));
    if (weight <= 0) continue;

    if (earliest.home_odds > 0 && latest.home_odds > 0) {
      const earlyProb = 1 / earliest.home_odds;
      const lateProb = 1 / latest.home_odds;
      const homeDrift = DRIFT_SCALE * (lateProb - earlyProb) * weight;
      driftMap.set(
        match.home_team,
        (driftMap.get(match.home_team) ?? 0) + homeDrift
      );
    }

    if (earliest.away_odds > 0 && latest.away_odds > 0) {
      const earlyProb = 1 / earliest.away_odds;
      const lateProb = 1 / latest.away_odds;
      const awayDrift = DRIFT_SCALE * (lateProb - earlyProb) * weight;
      driftMap.set(
        match.away_team,
        (driftMap.get(match.away_team) ?? 0) + awayDrift
      );
    }
  }

  return driftMap;
}

// ─── Match probabilities from Elo ────────────────────────────
function matchProbsFromElo(
  homeElo: number,
  awayElo: number,
  homeAdv: number
): { homeWin: number; draw: number; awayWin: number } {
  const expHome = eloExpectedScore(homeElo + homeAdv, awayElo);
  const drawBase =
    0.28 * (1 - Math.pow(Math.abs(expHome - 0.5) * 2, 0.8));
  const draw = Math.max(0.05, Math.min(0.35, drawBase));
  const homeWin = expHome * (1 - draw);
  const awayWin = (1 - expHome) * (1 - draw);

  const total = homeWin + draw + awayWin;
  return {
    homeWin: homeWin / total,
    draw: draw / total,
    awayWin: awayWin / total,
  };
}

// ─── Main Engine ─────────────────────────────────────────────
export async function runPricingEngine(options?: {
  endDate?: string;
  incremental?: boolean;
}): Promise<PricingResult> {
  const END_DATE = options?.endDate ?? new Date().toISOString().slice(0, 10);
  const START_DATE = "2025-08-01";
  const incremental = options?.incremental ?? false;

  log.info(`Pricing engine: ${START_DATE} → ${END_DATE}${incremental ? " (incremental)" : ""}`);

  // Phase 1: Load data
  const [matches, legacyElos, xgData] = await Promise.all([
    loadMatches(),
    fetchLegacyElos(),
    XG_ENABLED ? loadXgData() : Promise.resolve({ byFixtureId: new Map<number, XgEntry>(), byKey: new Map<string, XgEntry>() }),
  ]);

  // All teams and leagues
  const allTeams = new Set<string>();
  const teamLeague = new Map<string, string>();
  for (const m of matches) {
    allTeams.add(m.home_team);
    allTeams.add(m.away_team);
    teamLeague.set(m.home_team, m.league);
    teamLeague.set(m.away_team, m.league);
  }

  const startingElos = buildStartingElos(allTeams, legacyElos);
  const homeAdv = calibrateHomeAdvantage(matches);

  // Phase 2: Odds loading (cached — first call is full load, subsequent are incremental)
  const allFixtureIds = [...new Set(matches.map((m) => m.fixture_id))];
  log.info(`  Loading odds for ${allFixtureIds.length} fixtures`);
  const oddsIndex = await loadOddsWithCache(allFixtureIds);
  log.info(`  ${matches.length} matches, ${oddsIndex.size} fixtures with odds, ${xgData.byFixtureId.size} xG entries`);

  // Date range
  const dates = allDates(START_DATE, END_DATE);
  log.info(`  Running oracle model for ${dates.length} days...`);

  // Determine which dates to write (full replay = all, incremental = last 2 days)
  const writeFromDate = incremental ? addDays(END_DATE, -1) : START_DATE;

  // State for day-by-day loop
  const teamElo = new Map<string, number>();
  const teamEloHistory = new Map<string, number[]>();
  const teamLastMatch = new Map<string, string>();
  for (const team of allTeams) {
    const elo = startingElos.get(team) ?? INITIAL_ELO;
    teamElo.set(team, elo);
    teamEloHistory.set(team, [elo]);
  }

  const teamPriceRows: TeamPrice[] = [];
  const matchProbRows: MatchProb[] = [];

  const matchesByDate = new Map<string, Match[]>();
  for (const m of matches) {
    if (!matchesByDate.has(m.date)) matchesByDate.set(m.date, []);
    matchesByDate.get(m.date)!.push(m);
  }

  for (const date of dates) {
    const todaysMatches = matchesByDate.get(date) ?? [];
    const playingToday = new Set<string>();
    for (const m of todaysMatches) {
      playingToday.add(m.home_team);
      playingToday.add(m.away_team);
    }

    // 1. Carry decay for non-playing teams → 45-day MA anchor
    for (const [team, elo] of teamElo) {
      if (playingToday.has(team)) continue;

      const lastMatch = teamLastMatch.get(team);
      if (!lastMatch) continue;

      const daysSince = Math.round(
        (new Date(date).getTime() - new Date(lastMatch).getTime()) / 86400000
      );
      if (daysSince <= 0) continue;

      const history = teamEloHistory.get(team) ?? [elo];
      const maSlice = history.slice(-MA_WINDOW);
      const ma45 = maSlice.reduce((a, b) => a + b, 0) / maSlice.length;

      const decayFactor = Math.max(0.5, 1 - CARRY_DECAY_RATE * daysSince);
      const newElo = ma45 + (elo - ma45) * decayFactor;
      teamElo.set(team, newElo);
    }

    // 2. Match shocks — permanent, 1/0.5/0 scoring, flat K, live discount
    const endOfDay = `${date}T23:59:59Z`;
    for (const m of todaysMatches) {
      const sc = parseScore(m.score);
      if (!sc) continue;
      const [hg, ag] = sc;
      const isLive = m.status === "live";

      const homeElo = teamElo.get(m.home_team) ?? INITIAL_ELO;
      const awayElo = teamElo.get(m.away_team) ?? INITIAL_ELO;

      // Get odds for expected score (point-in-time)
      const oddsResult = getBestOddsAsOf(m.fixture_id, endOfDay, oddsIndex);
      let homeProb = 0.45;
      let drawProb = 0.27;
      let awayProb = 0.28;
      if (oddsResult) {
        homeProb = oddsResult.homeProb;
        drawProb = oddsResult.drawProb;
        awayProb = oddsResult.awayProb;
      }

      // 1/0.5/0 scoring (zero-sum)
      const homeActual = hg > ag ? 1 : hg === ag ? 0.5 : 0;
      const awayActual = 1 - homeActual;
      const homeExpected = homeProb * 1 + drawProb * 0.5;
      const awayExpected = awayProb * 1 + drawProb * 0.5;

      // Flat K shocks
      let homeShock = SHOCK_K * (homeActual - homeExpected);
      let awayShock = SHOCK_K * (awayActual - awayExpected);

      // xG multiplier (only for finished matches)
      if (!isLive) {
        let xg: XgEntry | undefined;
        if (XG_ENABLED) {
          xg = xgData.byFixtureId.get(m.fixture_id);
          if (!xg) {
            const key = `${m.date}|${m.home_team}|${m.away_team}`;
            xg = xgData.byKey.get(key);
          }
        }

        if (xg) {
          const goalDiff = hg - ag;
          const homeMult = xgMultiplier(xg.home_xg, xg.away_xg, goalDiff);
          const awayMult = xgMultiplier(xg.away_xg, xg.home_xg, -goalDiff);
          homeShock *= homeMult;
          awayShock *= awayMult;
        }
      }

      // Live match discount
      if (isLive) {
        homeShock *= LIVE_SHOCK_DISCOUNT;
        awayShock *= LIVE_SHOCK_DISCOUNT;
      }

      // Apply shocks permanently
      teamElo.set(m.home_team, homeElo + homeShock);
      teamElo.set(m.away_team, awayElo + awayShock);

      teamLastMatch.set(m.home_team, date);
      teamLastMatch.set(m.away_team, date);
    }

    // 3. Re-center all Elos to mean 1500
    const allElos = [...teamElo.values()];
    const globalMean = allElos.reduce((a, b) => a + b, 0) / allElos.length;
    const shift = INITIAL_ELO - globalMean;
    for (const [team, elo] of teamElo) {
      teamElo.set(team, elo + shift);
    }

    // 4. Update Elo history
    for (const [team, elo] of teamElo) {
      const history = teamEloHistory.get(team)!;
      history.push(elo);
      if (history.length > MA_WINDOW + 30) {
        history.splice(0, history.length - MA_WINDOW - 10);
      }
    }

    // Only generate output rows for dates we want to write
    if (date < writeFromDate) continue;

    // Odds drift signal for this date
    const driftMap = computeDriftForDate(date, matches, oddsIndex);

    // 5. Generate prices — single oracle model
    for (const team of allTeams) {
      const league = teamLeague.get(team)!;
      const elo = teamElo.get(team) ?? INITIAL_ELO;
      const drift = driftMap.get(team) ?? 0;
      const driftRounded = Math.round(drift * 10) / 10;

      const eloWithDrift = elo + drift;
      const rawPrice = Math.max(PRICE_FLOOR, (eloWithDrift - PRICE_ZERO) / PRICE_SLOPE);
      const roundedPrice = Math.round(rawPrice * 100) / 100;

      teamPriceRows.push({
        team,
        league,
        date,
        model: "oracle",
        implied_elo: Math.round(eloWithDrift * 10) / 10,
        dollar_price: roundedPrice,
        ema_dollar_price: roundedPrice, // No EMA — instant price discovery
        confidence: 1, // Always 1 — column kept for backward compat
        matches_in_window: 0, // Deprecated — kept for backward compat
        drift_elo: driftRounded,
      });
    }

    // 6. Match probabilities — raw oracle probs only
    for (const m of todaysMatches) {
      const bookOdds = getBestOddsAsOf(m.fixture_id, endOfDay, oddsIndex);
      if (!bookOdds) continue;

      const homeElo = (teamElo.get(m.home_team) ?? INITIAL_ELO) + (driftMap.get(m.home_team) ?? 0);
      const awayElo = (teamElo.get(m.away_team) ?? INITIAL_ELO) + (driftMap.get(m.away_team) ?? 0);

      const raw = matchProbsFromElo(homeElo, awayElo, homeAdv);

      matchProbRows.push({
        fixture_id: m.fixture_id,
        model: "oracle",
        date: m.date,
        home_team: m.home_team,
        away_team: m.away_team,
        implied_home_win: Math.round(raw.homeWin * 10000) / 10000,
        implied_draw: Math.round(raw.draw * 10000) / 10000,
        implied_away_win: Math.round(raw.awayWin * 10000) / 10000,
        bookmaker_home_win: Math.round(bookOdds.homeProb * 10000) / 10000,
        bookmaker_draw: Math.round(bookOdds.drawProb * 10000) / 10000,
        bookmaker_away_win: Math.round(bookOdds.awayProb * 10000) / 10000,
        edge_home: Math.round((raw.homeWin - bookOdds.homeProb) * 10000) / 10000,
        edge_draw: Math.round((raw.draw - bookOdds.drawProb) * 10000) / 10000,
        edge_away: Math.round((raw.awayWin - bookOdds.awayProb) * 10000) / 10000,
      });
    }
  }

  log.info(`Generated ${teamPriceRows.length} team_prices, ${matchProbRows.length} match_probabilities`);

  // Insert into Supabase
  log.info("Inserting team_prices...");
  const tp = await upsertBatched(
    "team_prices",
    teamPriceRows as unknown as Record<string, unknown>[],
    "team,date,model"
  );
  log.info(`  team_prices: ${tp.inserted} inserted, ${tp.failed} failed`);

  log.info("Inserting match_probabilities...");
  const mp = await upsertBatched(
    "match_probabilities",
    matchProbRows as unknown as Record<string, unknown>[],
    "fixture_id,model,date"
  );
  log.info(`  match_probabilities: ${mp.inserted} inserted, ${mp.failed} failed`);

  // Top 10 oracle prices
  const latestDate = dates[dates.length - 1];
  const latestPrices = teamPriceRows.filter((r) => r.date === latestDate);
  const topTeams = (latestPrices.length > 0 ? latestPrices : teamPriceRows)
    .sort((a, b) => b.dollar_price - a.dollar_price)
    .slice(0, 10)
    .map((t) => ({
      team: t.team,
      elo: t.implied_elo,
      price: t.dollar_price,
    }));

  log.info("Top 10 oracle prices:");
  for (let i = 0; i < topTeams.length; i++) {
    const t = topTeams[i];
    log.info(
      `  ${(i + 1).toString().padStart(2)}. ${t.team.padEnd(22)} Elo=${t.elo.toFixed(0).padStart(5)}  $${t.price.toFixed(2)}`
    );
  }

  return {
    teamPriceRows: teamPriceRows.length,
    matchProbRows: matchProbRows.length,
    topTeams,
  };
}
