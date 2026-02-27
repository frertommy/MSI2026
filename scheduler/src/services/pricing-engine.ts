/**
 * Pricing engine — refactored from src/compute-prices.ts as a callable function.
 * All BT logic, shocks, blending, dollar pricing is identical to the CLI version.
 * The only differences:
 *   - Exported as `runPricingEngine(options)` instead of main()
 *   - Dynamic END_DATE (defaults to today)
 *   - Returns structured PricingResult
 *   - Uses shared supabase client
 */
import { getSupabase, upsertBatched, fetchAllRows } from "../api/supabase-client.js";
import { log } from "../logger.js";
import {
  INITIAL_ELO,
  BT_ITERATIONS,
  WINDOW_DAYS,
  DECAY_HALF_LIFE,
  SHOCK_HALF_LIFE,
  SHOCK_K,
  ORACLE_SHOCK_K,
  ORACLE_SHOCK_HALF_LIFE,
  PRIOR_PULL,
  CARRY_DECAY,
  DOLLAR_SPREAD,
  ORACLE_WEIGHT,
} from "../config.js";
import type {
  Match,
  OddsRow,
  NormalizedOdds,
  TeamPrice,
  MatchProb,
  PricingResult,
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
  "Sevilla": "Sevilla FC",
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
  const sb = getSupabase();
  const { data, error } = await sb
    .from("matches")
    .select("fixture_id, date, league, home_team, away_team, score")
    .order("date", { ascending: true });
  if (error) throw new Error(`matches: ${error.message}`);
  return (data ?? []) as Match[];
}

async function loadOdds(): Promise<OddsRow[]> {
  return fetchAllRows<Record<string, unknown>>(
    "odds_snapshots",
    "fixture_id, bookmaker, home_odds, away_odds, draw_odds, days_before_kickoff",
    [{ column: "days_before_kickoff", value: 1 }]
  ) as unknown as Promise<OddsRow[]>;
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
    for (const [legacyName, entries] of Object.entries(data)) {
      if (!entries || entries.length === 0) continue;
      const lastRating = entries[entries.length - 1].rating;
      eloMap.set(legacyName, lastRating);
    }
    log.info(`  ${eloMap.size} teams in legacy data`);
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

// ─── Normalize odds ──────────────────────────────────────────
function normalizeOdds(
  odds: OddsRow[],
  usePinnacleOnly: boolean
): Map<number, NormalizedOdds> {
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
      selected = pinnacle.length > 0 ? pinnacle : rows;
    } else {
      selected = rows;
    }

    let homeProb: number, drawProb: number, awayProb: number;

    if (usePinnacleOnly && selected[0]?.bookmaker === "pinnacle") {
      homeProb =
        selected.reduce((s, r) => s + 1 / r.home_odds!, 0) / selected.length;
      drawProb =
        selected.reduce((s, r) => s + 1 / r.draw_odds!, 0) / selected.length;
      awayProb =
        selected.reduce((s, r) => s + 1 / r.away_odds!, 0) / selected.length;
    } else {
      homeProb = median(selected.map((r) => 1 / r.home_odds!));
      drawProb = median(selected.map((r) => 1 / r.draw_odds!));
      awayProb = median(selected.map((r) => 1 / r.away_odds!));
    }

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

// ─── Home advantage ──────────────────────────────────────────
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
  return eloDiffFromProb(homeWinRate);
}

// ─── Bradley-Terry ───────────────────────────────────────────
function bradleyTerry(
  matches: Match[],
  normalizedOdds: Map<number, NormalizedOdds>,
  targetDate: string,
  homeAdv: number,
  allTeams: Set<string>,
  startingElos: Map<string, number>
): Map<string, number> {
  const windowStart = addDays(targetDate, -WINDOW_DAYS);
  const windowMatches = matches.filter(
    (m) =>
      m.date >= windowStart &&
      m.date <= targetDate &&
      normalizedOdds.has(m.fixture_id)
  );

  const ratings = new Map<string, number>();
  for (const t of allTeams)
    ratings.set(t, startingElos.get(t) ?? INITIAL_ELO);

  if (windowMatches.length === 0) return ratings;

  const weights = windowMatches.map((m) => {
    const age = daysBetween(m.date, targetDate);
    return Math.pow(0.5, age / DECAY_HALF_LIFE);
  });

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
      const expHome = eloExpectedScore(rHome + homeAdv, rAway);
      const obsHome = odds.homeProb;

      numSum.set(m.home_team, numSum.get(m.home_team)! + w * obsHome);
      denSum.set(m.home_team, denSum.get(m.home_team)! + w * expHome);
      numSum.set(m.away_team, numSum.get(m.away_team)! + w * (1 - obsHome));
      denSum.set(m.away_team, denSum.get(m.away_team)! + w * (1 - expHome));
    }

    for (const t of allTeams) {
      const num = numSum.get(t) ?? 0;
      const den = denSum.get(t) ?? 0;
      if (den > 0.001) {
        const factor = num / den;
        const oldR = ratings.get(t) ?? INITIAL_ELO;
        ratings.set(t, oldR + 40 * Math.log(factor));
      }
    }

    // Bayesian prior pull toward legacy Elo
    for (const t of allTeams) {
      const computed = ratings.get(t)!;
      const legacy = startingElos.get(t) ?? INITIAL_ELO;
      ratings.set(t, (1 - PRIOR_PULL) * computed + PRIOR_PULL * legacy);
    }

    // Re-center
    const avg =
      [...ratings.values()].reduce((a, b) => a + b, 0) / ratings.size;
    for (const [t, r] of ratings) {
      ratings.set(t, r - avg + INITIAL_ELO);
    }
  }

  return ratings;
}

// ─── Surprise shocks ─────────────────────────────────────────
interface Shock {
  team: string;
  date: string;
  amount: number;
}

function computeShocks(
  matches: Match[],
  normalizedOdds: Map<number, NormalizedOdds>,
  kBase: number,
  startingElos: Map<string, number>,
  teamLeague: Map<string, string>
): Shock[] {
  // League means for K-weighting
  const leagueTeams = new Map<string, string[]>();
  for (const [team, league] of teamLeague) {
    if (!leagueTeams.has(league)) leagueTeams.set(league, []);
    leagueTeams.get(league)!.push(team);
  }
  const leagueMeanElo = new Map<string, number>();
  for (const [league, teams] of leagueTeams) {
    const mean =
      teams.reduce((s, t) => s + (startingElos.get(t) ?? INITIAL_ELO), 0) /
      teams.length;
    leagueMeanElo.set(league, mean);
  }

  const shocks: Shock[] = [];

  for (const m of matches) {
    const odds = normalizedOdds.get(m.fixture_id);
    if (!odds) continue;
    const parts = m.score.split("-");
    if (parts.length !== 2) continue;
    const hg = parseInt(parts[0]);
    const ag = parseInt(parts[1]);
    if (isNaN(hg) || isNaN(ag)) continue;

    const league = teamLeague.get(m.home_team) ?? "";
    const lMean = leagueMeanElo.get(league) ?? INITIAL_ELO;

    // Home
    const awayElo = startingElos.get(m.away_team) ?? INITIAL_ELO;
    const homeEffK = kBase * (1 + (awayElo - lMean) / 400);
    const homeActual = hg > ag ? 3 : hg === ag ? 1 : 0;
    const homeExpected =
      3 * odds.homeProb + 1 * odds.drawProb + 0 * odds.awayProb;
    shocks.push({
      team: m.home_team,
      date: m.date,
      amount: (homeActual - homeExpected) * homeEffK,
    });

    // Away
    const homeElo = startingElos.get(m.home_team) ?? INITIAL_ELO;
    const awayEffK = kBase * (1 + (homeElo - lMean) / 400);
    const awayActual = ag > hg ? 3 : ag === hg ? 1 : 0;
    const awayExpected =
      3 * odds.awayProb + 1 * odds.drawProb + 0 * odds.homeProb;
    shocks.push({
      team: m.away_team,
      date: m.date,
      amount: (awayActual - awayExpected) * awayEffK,
    });
  }

  return shocks;
}

function activeShockBoost(
  team: string,
  date: string,
  shocks: Shock[],
  halfLife: number
): number {
  let total = 0;
  for (const s of shocks) {
    if (s.team !== team) continue;
    if (s.date > date) continue;
    const age = daysBetween(s.date, date);
    if (age < 0) continue;
    total += s.amount * Math.pow(0.5, age / halfLife);
  }
  return total;
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
}): Promise<PricingResult> {
  const END_DATE = options?.endDate ?? new Date().toISOString().slice(0, 10);
  const START_DATE = "2026-01-01";

  log.info(`Pricing engine: ${START_DATE} → ${END_DATE}`);

  const [matches, odds, legacyElos] = await Promise.all([
    loadMatches(),
    loadOdds(),
    fetchLegacyElos(),
  ]);
  log.info(`  ${matches.length} matches, ${odds.length} odds rows`);

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
  const leagues = [...new Set(teamLeague.values())];
  const homeAdv = calibrateHomeAdvantage(matches);

  // Normalize odds
  const medianOdds = normalizeOdds(odds, false);
  const pinnacleOdds = normalizeOdds(odds, true);
  log.info(
    `  Median: ${medianOdds.size} fixtures, Pinnacle: ${pinnacleOdds.size} fixtures`
  );

  // Shocks
  const reactiveShocks = computeShocks(
    matches,
    medianOdds,
    SHOCK_K,
    startingElos,
    teamLeague
  );
  const oracleShocks = computeShocks(
    matches,
    pinnacleOdds,
    ORACLE_SHOCK_K,
    startingElos,
    teamLeague
  );

  // Date range
  const dates = allDates(START_DATE, END_DATE);
  log.info(`  Running models for ${dates.length} days...`);

  const teamPriceRows: TeamPrice[] = [];
  const matchProbRows: MatchProb[] = [];

  const lastMatchDate = new Map<string, string>();
  const matchesByDate = new Map<string, Match[]>();
  for (const m of matches) {
    if (!matchesByDate.has(m.date)) matchesByDate.set(m.date, []);
    matchesByDate.get(m.date)!.push(m);
  }

  for (const date of dates) {
    const ratingsMedian = bradleyTerry(
      matches,
      medianOdds,
      date,
      homeAdv,
      allTeams,
      startingElos
    );
    const ratingsPinnacle = bradleyTerry(
      matches,
      pinnacleOdds,
      date,
      homeAdv,
      allTeams,
      startingElos
    );

    // League means
    const leagueMeans = new Map<string, number>();
    for (const league of leagues) {
      const lt = [...allTeams].filter((t) => teamLeague.get(t) === league);
      const mean =
        lt.reduce(
          (s, t) => s + (ratingsMedian.get(t) ?? INITIAL_ELO),
          0
        ) / lt.length;
      leagueMeans.set(league, mean);
    }

    // Carry-forward decay
    for (const team of allTeams) {
      const league = teamLeague.get(team)!;
      const leagueMean = leagueMeans.get(league) ?? INITIAL_ELO;
      const playedToday = (matchesByDate.get(date) ?? []).some(
        (m) => m.home_team === team || m.away_team === team
      );

      if (playedToday) {
        lastMatchDate.set(team, date);
      } else {
        const ld = lastMatchDate.get(team);
        if (ld) {
          const daysSince = daysBetween(ld, date);
          const decayFactor = 1 - CARRY_DECAY * daysSince;

          const eloM = ratingsMedian.get(team) ?? INITIAL_ELO;
          ratingsMedian.set(
            team,
            leagueMean + (eloM - leagueMean) * Math.max(0.5, decayFactor)
          );

          const eloP = ratingsPinnacle.get(team) ?? INITIAL_ELO;
          ratingsPinnacle.set(
            team,
            leagueMean + (eloP - leagueMean) * Math.max(0.5, decayFactor)
          );
        }
      }
    }

    // Matches in window
    const windowStart = addDays(date, -WINDOW_DAYS);
    const matchesInWindow = new Map<string, number>();
    for (const m of matches) {
      if (m.date >= windowStart && m.date <= date) {
        matchesInWindow.set(
          m.home_team,
          (matchesInWindow.get(m.home_team) ?? 0) + 1
        );
        matchesInWindow.set(
          m.away_team,
          (matchesInWindow.get(m.away_team) ?? 0) + 1
        );
      }
    }

    // Generate prices per team
    for (const team of allTeams) {
      const league = teamLeague.get(team)!;
      const mInW = matchesInWindow.get(team) ?? 0;

      // Smooth
      const eloSmooth = ratingsMedian.get(team) ?? INITIAL_ELO;
      teamPriceRows.push({
        team,
        league,
        date,
        model: "smooth",
        implied_elo: Math.round(eloSmooth * 10) / 10,
        dollar_price: Math.round(logistic(eloSmooth, INITIAL_ELO, DOLLAR_SPREAD) * 100) / 100,
        confidence: Math.min(1, mInW / 10),
        matches_in_window: mInW,
      });

      // Reactive
      const shockBoost = activeShockBoost(
        team,
        date,
        reactiveShocks,
        SHOCK_HALF_LIFE
      );
      const eloReactive = eloSmooth + shockBoost;
      teamPriceRows.push({
        team,
        league,
        date,
        model: "reactive",
        implied_elo: Math.round(eloReactive * 10) / 10,
        dollar_price:
          Math.round(logistic(eloReactive, INITIAL_ELO, DOLLAR_SPREAD) * 100) / 100,
        confidence: Math.min(1, mInW / 10),
        matches_in_window: mInW,
      });

      // Sharp
      const eloSharp = ratingsPinnacle.get(team) ?? INITIAL_ELO;
      teamPriceRows.push({
        team,
        league,
        date,
        model: "sharp",
        implied_elo: Math.round(eloSharp * 10) / 10,
        dollar_price:
          Math.round(logistic(eloSharp, INITIAL_ELO, DOLLAR_SPREAD) * 100) / 100,
        confidence: Math.min(1, mInW / 10),
        matches_in_window: mInW,
      });

      // Oracle
      const oracleBoost = activeShockBoost(
        team,
        date,
        oracleShocks,
        ORACLE_SHOCK_HALF_LIFE
      );
      const eloOracle = eloSharp + oracleBoost;
      teamPriceRows.push({
        team,
        league,
        date,
        model: "oracle",
        implied_elo: Math.round(eloOracle * 10) / 10,
        dollar_price:
          Math.round(logistic(eloOracle, INITIAL_ELO, DOLLAR_SPREAD) * 100) / 100,
        confidence: Math.min(1, mInW / 10),
        matches_in_window: mInW,
      });
    }

    // Match probabilities
    const todayMatches = matchesByDate.get(date) ?? [];
    for (const m of todayMatches) {
      const bookOdds = medianOdds.get(m.fixture_id);
      if (!bookOdds) continue;

      for (const model of [
        "smooth",
        "reactive",
        "sharp",
        "oracle",
      ] as const) {
        let homeElo: number, awayElo: number;

        if (model === "smooth") {
          homeElo = ratingsMedian.get(m.home_team) ?? INITIAL_ELO;
          awayElo = ratingsMedian.get(m.away_team) ?? INITIAL_ELO;
        } else if (model === "reactive") {
          homeElo =
            (ratingsMedian.get(m.home_team) ?? INITIAL_ELO) +
            activeShockBoost(m.home_team, date, reactiveShocks, SHOCK_HALF_LIFE);
          awayElo =
            (ratingsMedian.get(m.away_team) ?? INITIAL_ELO) +
            activeShockBoost(m.away_team, date, reactiveShocks, SHOCK_HALF_LIFE);
        } else if (model === "sharp") {
          homeElo = ratingsPinnacle.get(m.home_team) ?? INITIAL_ELO;
          awayElo = ratingsPinnacle.get(m.away_team) ?? INITIAL_ELO;
        } else {
          homeElo =
            (ratingsPinnacle.get(m.home_team) ?? INITIAL_ELO) +
            activeShockBoost(
              m.home_team,
              date,
              oracleShocks,
              ORACLE_SHOCK_HALF_LIFE
            );
          awayElo =
            (ratingsPinnacle.get(m.away_team) ?? INITIAL_ELO) +
            activeShockBoost(
              m.away_team,
              date,
              oracleShocks,
              ORACLE_SHOCK_HALF_LIFE
            );
        }

        const raw = matchProbsFromElo(homeElo, awayElo, homeAdv);

        // Blend: 70% oracle + 30% bookmaker
        const BOOK_WEIGHT = 1 - ORACLE_WEIGHT;
        const blendHome =
          ORACLE_WEIGHT * raw.homeWin + BOOK_WEIGHT * bookOdds.homeProb;
        const blendDraw =
          ORACLE_WEIGHT * raw.draw + BOOK_WEIGHT * bookOdds.drawProb;
        const blendAway =
          ORACLE_WEIGHT * raw.awayWin + BOOK_WEIGHT * bookOdds.awayProb;
        const blendTotal = blendHome + blendDraw + blendAway;
        const calHome = blendHome / blendTotal;
        const calDraw = blendDraw / blendTotal;
        const calAway = blendAway / blendTotal;

        matchProbRows.push({
          fixture_id: m.fixture_id,
          model,
          date: m.date,
          home_team: m.home_team,
          away_team: m.away_team,
          implied_home_win: Math.round(calHome * 10000) / 10000,
          implied_draw: Math.round(calDraw * 10000) / 10000,
          implied_away_win: Math.round(calAway * 10000) / 10000,
          bookmaker_home_win: Math.round(bookOdds.homeProb * 10000) / 10000,
          bookmaker_draw: Math.round(bookOdds.drawProb * 10000) / 10000,
          bookmaker_away_win: Math.round(bookOdds.awayProb * 10000) / 10000,
          edge_home:
            Math.round((calHome - bookOdds.homeProb) * 10000) / 10000,
          edge_draw:
            Math.round((calDraw - bookOdds.drawProb) * 10000) / 10000,
          edge_away:
            Math.round((calAway - bookOdds.awayProb) * 10000) / 10000,
        });
      }
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
  log.info(
    `  match_probabilities: ${mp.inserted} inserted, ${mp.failed} failed`
  );

  // Top 10 oracle prices
  const latestDate = dates[dates.length - 1];
  const topTeams = teamPriceRows
    .filter((r) => r.model === "oracle" && r.date === latestDate)
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
