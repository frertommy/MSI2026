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
  drift_elo: number;
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

// ─── Legacy MSI name mapping (our short names → legacy full names) ────
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

const LEGACY_URL = "https://raw.githubusercontent.com/frertommy/MSI/main/data/msi_daily.json";

// ─── Config ──────────────────────────────────────────────────
const START_DATE = "2026-01-01";
const END_DATE = "2026-02-26";
const INITIAL_ELO = 1500;
const BT_ITERATIONS = 50;
const WINDOW_DAYS = 60;
const DECAY_HALF_LIFE = 14; // days
const SHOCK_HALF_LIFE = 7; // days for reactive model
const SHOCK_K = 32;
const ORACLE_SHOCK_K = 20; // oracle model: lighter shock
const ORACLE_SHOCK_HALF_LIFE = 10; // oracle model: slower decay
const PRIOR_PULL = 0.15; // Bayesian pull toward legacy Elo each BT iteration
const CARRY_DECAY = 0.005; // 0.5%/day toward league mean
const BATCH_SIZE = 500;

// ─── Odds drift signal constants ────────────────────────────
const DRIFT_SCALE = 400;        // Elo points per 1.0 probability drift
const DRIFT_MIN_HOURS = 12;     // Min gap between earliest/latest snapshot
const DRIFT_FADE_DAYS = 7;      // Days-before-kickoff at which drift reaches full weight

// ─── Outright blending constant ─────────────────────────────
const OUTRIGHT_WEIGHT = 0.15;   // blend weight into oracle model

interface DriftSnapshot {
  fixture_id: number;
  bookmaker: string;
  home_odds: number;
  away_odds: number;
  draw_odds: number;
  snapshot_time: string;
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

// ─── Load ALL odds snapshots for drift signal ───────────────
async function loadAllOddsForDrift(): Promise<Map<number, DriftSnapshot[]>> {
  const all: DriftSnapshot[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from("odds_snapshots")
      .select("fixture_id, bookmaker, home_odds, away_odds, draw_odds, snapshot_time")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`drift odds: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (!r.home_odds || !r.away_odds || !r.snapshot_time) continue;
      all.push(r as DriftSnapshot);
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }

  // Group by fixture_id
  const map = new Map<number, DriftSnapshot[]>();
  for (const s of all) {
    if (!map.has(s.fixture_id)) map.set(s.fixture_id, []);
    map.get(s.fixture_id)!.push(s);
  }
  return map;
}

// ─── Load outright odds for oracle blending ─────────────────
async function loadOutrightOdds(): Promise<Map<string, number>> {
  try {
    const all: { league: string; team: string; implied_prob: number; snapshot_time: string }[] = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await sb
        .from("outright_odds")
        .select("league, team, implied_prob, snapshot_time")
        .order("snapshot_time", { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) {
        if (error.code === "PGRST205" || error.message.includes("does not exist")) {
          console.log("  outright_odds table not found — skipping outright blending");
          return new Map();
        }
        console.error(`  Failed to load outright_odds: ${error.message}`);
        return new Map();
      }
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }

    if (all.length === 0) {
      console.log("  No outright odds data — skipping outright blending");
      return new Map();
    }

    // For each team, take only the most recent snapshot (data is sorted DESC)
    const latestByTeam = new Map<string, { league: string; impliedProb: number }>();
    for (const row of all) {
      if (!latestByTeam.has(row.team)) {
        latestByTeam.set(row.team, {
          league: row.league,
          impliedProb: row.implied_prob,
        });
      }
    }

    // Group by league for normalization
    const byLeague = new Map<string, { team: string; prob: number }[]>();
    for (const [team, info] of latestByTeam) {
      if (!byLeague.has(info.league)) byLeague.set(info.league, []);
      byLeague.get(info.league)!.push({ team, prob: info.impliedProb });
    }

    // Normalize per league and compute outright Elo
    const outrightElos = new Map<string, number>();
    for (const [league, teams] of byLeague) {
      const totalProb = teams.reduce((s, t) => s + t.prob, 0);
      if (totalProb <= 0) continue;
      const N = teams.length;

      for (const t of teams) {
        const normalizedProb = t.prob / totalProb;
        const baseline = 1 / N;
        const ratio = Math.max(0.001, normalizedProb) / baseline;
        const outrightElo = INITIAL_ELO + 400 * Math.log10(ratio);
        outrightElos.set(t.team, outrightElo);
      }
    }

    console.log(`  Loaded outright Elos for ${outrightElos.size} teams across ${byLeague.size} leagues`);
    return outrightElos;
  } catch {
    console.log("  outright_odds load failed — table may not exist");
    return new Map();
  }
}

// ─── Odds drift signal ──────────────────────────────────────
function computeDriftForDate(
  date: string,
  matches: Match[],
  driftOdds: Map<number, DriftSnapshot[]>
): Map<string, number> {
  const driftMap = new Map<string, number>();
  const cutoff = addDays(date, 14);

  // Find upcoming matches (within next 14 days)
  const upcoming = matches.filter((m) => m.date > date && m.date <= cutoff);

  for (const match of upcoming) {
    const snapshots = driftOdds.get(match.fixture_id);
    if (!snapshots || snapshots.length < 2) continue;

    // Filter to snapshots taken on or before processing date
    const available = snapshots.filter(
      (s) => s.snapshot_time.slice(0, 10) <= date
    );
    if (available.length < 2) continue;

    // Prefer Pinnacle, fall back to all bookmakers
    const pinnacle = available.filter((s) => s.bookmaker === "pinnacle");
    const selected = pinnacle.length >= 2 ? pinnacle : available;

    // Sort by snapshot_time
    selected.sort((a, b) => a.snapshot_time.localeCompare(b.snapshot_time));

    const earliest = selected[0];
    const latest = selected[selected.length - 1];

    // Check minimum time gap
    const hoursDiff =
      (new Date(latest.snapshot_time).getTime() -
        new Date(earliest.snapshot_time).getTime()) /
      3600000;
    if (hoursDiff < DRIFT_MIN_HOURS) continue;

    // Proximity weight: far-out matches get full weight, tomorrow's get zero
    const daysBefore = daysBetween(date, match.date);
    const weight = Math.max(0, Math.min(1, (daysBefore - 1) / DRIFT_FADE_DAYS));
    if (weight <= 0) continue;

    // Home team drift
    if (earliest.home_odds > 0 && latest.home_odds > 0) {
      const earlyProb = 1 / earliest.home_odds;
      const lateProb = 1 / latest.home_odds;
      const homeDrift = DRIFT_SCALE * (lateProb - earlyProb) * weight;
      driftMap.set(
        match.home_team,
        (driftMap.get(match.home_team) ?? 0) + homeDrift
      );
    }

    // Away team drift
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

// ─── Fetch legacy MSI starting Elos ──────────────────────────
async function fetchLegacyElos(): Promise<Map<string, number>> {
  console.log("Fetching legacy MSI ratings...");
  const resp = await fetch(LEGACY_URL);
  if (!resp.ok) {
    console.error(`  Failed to fetch legacy data: ${resp.status}`);
    return new Map();
  }
  const data = await resp.json() as Record<string, { date: string; rating: number }[]>;
  const eloMap = new Map<string, number>();
  for (const [legacyName, entries] of Object.entries(data)) {
    if (!entries || entries.length === 0) continue;
    const lastRating = entries[entries.length - 1].rating;
    eloMap.set(legacyName, lastRating);
  }
  console.log(`  ${eloMap.size} teams in legacy data`);
  return eloMap;
}

function buildStartingElos(
  allTeams: Set<string>,
  legacyElos: Map<string, number>
): { startingElos: Map<string, number>; matched: number; fallback: number } {
  const startingElos = new Map<string, number>();
  let matched = 0;
  let fallback = 0;

  for (const team of allTeams) {
    // Try mapped name first, then exact match
    const legacyName = LEGACY_NAME_MAP[team] || team;
    if (legacyElos.has(legacyName)) {
      startingElos.set(team, legacyElos.get(legacyName)!);
      matched++;
    } else {
      startingElos.set(team, INITIAL_ELO);
      fallback++;
    }
  }

  return { startingElos, matched, fallback };
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
  teamLeague: Map<string, string>,
  startingElos: Map<string, number>
): Map<string, number> {
  // Filter matches within window
  const windowStart = addDays(targetDate, -WINDOW_DAYS);
  const windowMatches = matches.filter(
    (m) => m.date >= windowStart && m.date <= targetDate && normalizedOdds.has(m.fixture_id)
  );

  // Initialize ratings from legacy starting Elos
  const ratings = new Map<string, number>();
  for (const t of allTeams) ratings.set(t, startingElos.get(t) ?? INITIAL_ELO);

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

    // Bayesian prior: pull 15% toward legacy starting Elo each iteration
    // Prevents small-sample distortions from overriding years of historical data
    for (const t of allTeams) {
      const computed = ratings.get(t)!;
      const legacy = startingElos.get(t) ?? INITIAL_ELO;
      ratings.set(t, (1 - PRIOR_PULL) * computed + PRIOR_PULL * legacy);
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
// Use global center (INITIAL_ELO=1500) instead of per-league means
// so prices reflect absolute strength, not just within-league ranking.
// Calibrate spread so:
//   Elo 1850 → ~$82 (top clubs: Man City, Liverpool, Barcelona)
//   Elo 1500 → $50  (average)
//   Elo 1250 → ~$24 (bottom-tier)
//   Elo 1200 → ~$20
// logistic(1850, 1500, 220) = 100/(1+e^(-350/220)) ≈ $83
// logistic(1250, 1500, 220) = 100/(1+e^(250/220))  ≈ $24
const DOLLAR_SPREAD = 220;

// ─── Reactive model: surprise shocks ─────────────────────────
interface Shock {
  team: string;
  date: string;
  amount: number; // elo shock
}

interface ShockExample {
  match: string;
  date: string;
  team: string;
  opponent: string;
  oppElo: number;
  leagueMean: number;
  kFlat: number;
  kWeighted: number;
  shockFlat: number;
  shockWeighted: number;
}

function computeShocks(
  matches: Match[],
  normalizedOdds: Map<number, NormalizedOdds>,
  kBase: number,
  startingElos: Map<string, number>,
  teamLeague: Map<string, string>
): { shocks: Shock[]; examples: ShockExample[] } {
  // Compute league means from starting Elos for K-weighting
  const leagueTeams = new Map<string, string[]>();
  for (const [team, league] of teamLeague) {
    if (!leagueTeams.has(league)) leagueTeams.set(league, []);
    leagueTeams.get(league)!.push(team);
  }
  const leagueMeanElo = new Map<string, number>();
  for (const [league, teams] of leagueTeams) {
    const mean = teams.reduce((s, t) => s + (startingElos.get(t) ?? INITIAL_ELO), 0) / teams.length;
    leagueMeanElo.set(league, mean);
  }

  const shocks: Shock[] = [];
  const examples: ShockExample[] = [];

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

    // Home team: opponent is away team
    const awayElo = startingElos.get(m.away_team) ?? INITIAL_ELO;
    const homeEffK = kBase * (1 + (awayElo - lMean) / 400);
    const homeActual = hg > ag ? 3 : hg === ag ? 1 : 0;
    const homeExpected = 3 * odds.homeProb + 1 * odds.drawProb + 0 * odds.awayProb;
    const homeSurprise = homeActual - homeExpected;
    shocks.push({ team: m.home_team, date: m.date, amount: homeSurprise * homeEffK });

    // Away team: opponent is home team
    const homeElo = startingElos.get(m.home_team) ?? INITIAL_ELO;
    const awayEffK = kBase * (1 + (homeElo - lMean) / 400);
    const awayActual = ag > hg ? 3 : ag === hg ? 1 : 0;
    const awayExpected = 3 * odds.awayProb + 1 * odds.drawProb + 0 * odds.homeProb;
    const awaySurprise = awayActual - awayExpected;
    shocks.push({ team: m.away_team, date: m.date, amount: awaySurprise * awayEffK });

    // Collect examples for interesting matches (big K difference from flat)
    if (examples.length < 20) {
      examples.push({
        match: `${m.home_team} ${hg}-${ag} ${m.away_team}`,
        date: m.date,
        team: m.home_team,
        opponent: m.away_team,
        oppElo: awayElo,
        leagueMean: lMean,
        kFlat: kBase,
        kWeighted: homeEffK,
        shockFlat: homeSurprise * kBase,
        shockWeighted: homeSurprise * homeEffK,
      });
      examples.push({
        match: `${m.home_team} ${hg}-${ag} ${m.away_team}`,
        date: m.date,
        team: m.away_team,
        opponent: m.home_team,
        oppElo: homeElo,
        leagueMean: lMean,
        kFlat: kBase,
        kWeighted: awayEffK,
        shockFlat: awaySurprise * kBase,
        shockWeighted: awaySurprise * awayEffK,
      });
    }
  }
  return { shocks, examples };
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
  const [matches, odds, legacyElos, allDriftOdds, outrightElos] = await Promise.all([
    loadMatches(),
    loadOdds(),
    fetchLegacyElos(),
    loadAllOddsForDrift(),
    loadOutrightOdds(),
  ]);
  console.log(`  ${matches.length} matches, ${odds.length} odds rows, ${allDriftOdds.size} fixtures with drift snapshots, ${outrightElos.size} outright Elos`);

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

  // Build starting Elos from legacy MSI data
  const { startingElos, matched, fallback } = buildStartingElos(allTeams, legacyElos);
  console.log(`  Legacy Elo: ${matched} matched, ${fallback} fell back to ${INITIAL_ELO}`);
  if (fallback > 0) {
    const fallbackTeams = [...allTeams].filter((t) => !legacyElos.has(LEGACY_NAME_MAP[t] || t));
    console.log(`  Fallback teams: ${fallbackTeams.join(", ")}`);
  }

  // League means (for carry-forward decay)
  const leagues = [...new Set(teamLeague.values())];

  // Home advantage calibration
  const homeAdv = calibrateHomeAdvantage(matches);

  // Normalize odds: median (for smooth & reactive) and pinnacle (for sharp)
  console.log("Normalizing odds...");
  const medianOdds = normalizeOdds(odds, false);
  const pinnacleOdds = normalizeOdds(odds, true);
  console.log(`  Median: ${medianOdds.size} fixtures, Pinnacle: ${pinnacleOdds.size} fixtures`);

  // Compute surprise shocks (opponent-strength-weighted K)
  console.log("Computing surprise shocks (opponent-weighted K)...");
  const { shocks, examples: reactiveExamples } = computeShocks(matches, medianOdds, SHOCK_K, startingElos, teamLeague);
  const { shocks: oracleShocks, examples: oracleExamples } = computeShocks(matches, pinnacleOdds, ORACLE_SHOCK_K, startingElos, teamLeague);
  console.log(`  ${shocks.length} reactive shocks (K_base=${SHOCK_K}), ${oracleShocks.length} oracle shocks (K_base=${ORACLE_SHOCK_K})`);

  // Log 5 oracle shock examples: flat K vs weighted K
  console.log("\n  Opponent-weighted shock examples (oracle, K_base=20):");
  const sortedExamples = oracleExamples
    .filter((e) => Math.abs(e.shockFlat) > 1) // only interesting shocks
    .sort((a, b) => Math.abs(b.kWeighted - b.kFlat) - Math.abs(a.kWeighted - a.kFlat))
    .slice(0, 5);
  for (const ex of sortedExamples) {
    const mult = ex.kWeighted / ex.kFlat;
    console.log(
      `  ${ex.match} (${ex.date}) → ${ex.team}: opp_elo=${ex.oppElo.toFixed(0)}, league_mean=${ex.leagueMean.toFixed(0)}, K_flat=${ex.kFlat}, K_weighted=${ex.kWeighted.toFixed(1)} (${mult.toFixed(2)}x), shock: ${ex.shockFlat.toFixed(1)} → ${ex.shockWeighted.toFixed(1)}`
    );
  }

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
      matches, medianOdds, date, homeAdv, allTeams, teamLeague, startingElos
    );

    // Run BT for this date — pinnacle odds
    const ratingsPinnacle = bradleyTerry(
      matches, pinnacleOdds, date, homeAdv, allTeams, teamLeague, startingElos
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

    // Odds drift signal for this date
    const driftMap = computeDriftForDate(date, matches, allDriftOdds);

    // Generate prices for each team (global center = INITIAL_ELO)
    for (const team of allTeams) {
      const league = teamLeague.get(team)!;
      const mInW = matchesInWindow.get(team) ?? 0;
      const drift = driftMap.get(team) ?? 0;
      const driftRounded = Math.round(drift * 10) / 10;

      // Oracle A — smooth (median BT + drift, no shocks)
      const eloSmoothBase = ratingsMedian.get(team) ?? INITIAL_ELO;
      const eloSmooth = eloSmoothBase + drift;
      const priceSmooth = logistic(eloSmooth, INITIAL_ELO, DOLLAR_SPREAD);
      teamPriceRows.push({
        team, league, date, model: "smooth",
        implied_elo: Math.round(eloSmooth * 10) / 10,
        dollar_price: Math.round(priceSmooth * 100) / 100,
        confidence: Math.min(1, mInW / 10),
        matches_in_window: mInW,
        drift_elo: driftRounded,
      });

      // Oracle B — reactive (median BT + shock boost + drift)
      const shockBoost = activeShockBoost(team, date, shocks, SHOCK_HALF_LIFE);
      const eloReactive = eloSmoothBase + shockBoost + drift;
      const priceReactive = logistic(eloReactive, INITIAL_ELO, DOLLAR_SPREAD);
      teamPriceRows.push({
        team, league, date, model: "reactive",
        implied_elo: Math.round(eloReactive * 10) / 10,
        dollar_price: Math.round(priceReactive * 100) / 100,
        confidence: Math.min(1, mInW / 10),
        matches_in_window: mInW,
        drift_elo: driftRounded,
      });

      // Oracle C — sharp (pinnacle BT + drift, no shocks)
      const eloSharpBase = ratingsPinnacle.get(team) ?? INITIAL_ELO;
      const eloSharp = eloSharpBase + drift;
      const priceSharp = logistic(eloSharp, INITIAL_ELO, DOLLAR_SPREAD);
      teamPriceRows.push({
        team, league, date, model: "sharp",
        implied_elo: Math.round(eloSharp * 10) / 10,
        dollar_price: Math.round(priceSharp * 100) / 100,
        confidence: Math.min(1, mInW / 10),
        matches_in_window: mInW,
        drift_elo: driftRounded,
      });

      // Oracle D — oracle (pinnacle BT + outright blending + shocks + drift)
      const oracleBoost = activeShockBoost(team, date, oracleShocks, ORACLE_SHOCK_HALF_LIFE);
      const outrightElo = outrightElos.get(team);
      const blendedSharpBase = outrightElo !== undefined
        ? (1 - OUTRIGHT_WEIGHT) * eloSharpBase + OUTRIGHT_WEIGHT * outrightElo
        : eloSharpBase;
      const eloOracle = blendedSharpBase + oracleBoost + drift;
      const priceOracle = logistic(eloOracle, INITIAL_ELO, DOLLAR_SPREAD);
      teamPriceRows.push({
        team, league, date, model: "oracle",
        implied_elo: Math.round(eloOracle * 10) / 10,
        dollar_price: Math.round(priceOracle * 100) / 100,
        confidence: Math.min(1, mInW / 10),
        matches_in_window: mInW,
        drift_elo: driftRounded,
      });
    }

    // Match probabilities for matches on this date
    const todayMatches = matchesByDate.get(date) ?? [];
    for (const m of todayMatches) {
      const bookOdds = medianOdds.get(m.fixture_id);
      if (!bookOdds) continue;

      for (const model of ["smooth", "reactive", "sharp", "oracle"] as const) {
        let homeElo: number, awayElo: number;
        const homeDrift = driftMap.get(m.home_team) ?? 0;
        const awayDrift = driftMap.get(m.away_team) ?? 0;

        if (model === "smooth") {
          homeElo = (ratingsMedian.get(m.home_team) ?? INITIAL_ELO) + homeDrift;
          awayElo = (ratingsMedian.get(m.away_team) ?? INITIAL_ELO) + awayDrift;
        } else if (model === "reactive") {
          homeElo =
            (ratingsMedian.get(m.home_team) ?? INITIAL_ELO) +
            activeShockBoost(m.home_team, date, shocks, SHOCK_HALF_LIFE) +
            homeDrift;
          awayElo =
            (ratingsMedian.get(m.away_team) ?? INITIAL_ELO) +
            activeShockBoost(m.away_team, date, shocks, SHOCK_HALF_LIFE) +
            awayDrift;
        } else if (model === "sharp") {
          homeElo = (ratingsPinnacle.get(m.home_team) ?? INITIAL_ELO) + homeDrift;
          awayElo = (ratingsPinnacle.get(m.away_team) ?? INITIAL_ELO) + awayDrift;
        } else {
          // oracle: pinnacle BT + outright blending + oracle shocks + drift
          const homeSharpBase = ratingsPinnacle.get(m.home_team) ?? INITIAL_ELO;
          const awaySharpBase = ratingsPinnacle.get(m.away_team) ?? INITIAL_ELO;
          const homeOutright = outrightElos.get(m.home_team);
          const awayOutright = outrightElos.get(m.away_team);
          const homeBlended = homeOutright !== undefined
            ? (1 - OUTRIGHT_WEIGHT) * homeSharpBase + OUTRIGHT_WEIGHT * homeOutright
            : homeSharpBase;
          const awayBlended = awayOutright !== undefined
            ? (1 - OUTRIGHT_WEIGHT) * awaySharpBase + OUTRIGHT_WEIGHT * awayOutright
            : awaySharpBase;
          homeElo =
            homeBlended +
            activeShockBoost(m.home_team, date, oracleShocks, ORACLE_SHOCK_HALF_LIFE) +
            homeDrift;
          awayElo =
            awayBlended +
            activeShockBoost(m.away_team, date, oracleShocks, ORACLE_SHOCK_HALF_LIFE) +
            awayDrift;
        }

        const raw = matchProbsFromElo(homeElo, awayElo, homeAdv);

        // Blend: 70% oracle view + 30% bookmaker median
        // Prevents extreme divergence while keeping oracle dominant
        const ORACLE_WEIGHT = 0.7;
        const BOOK_WEIGHT = 1 - ORACLE_WEIGHT;
        const blendHome = ORACLE_WEIGHT * raw.homeWin + BOOK_WEIGHT * bookOdds.homeProb;
        const blendDraw = ORACLE_WEIGHT * raw.draw + BOOK_WEIGHT * bookOdds.drawProb;
        const blendAway = ORACLE_WEIGHT * raw.awayWin + BOOK_WEIGHT * bookOdds.awayProb;
        // Renormalize
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
          edge_home: Math.round((calHome - bookOdds.homeProb) * 10000) / 10000,
          edge_draw: Math.round((calDraw - bookOdds.drawProb) * 10000) / 10000,
          edge_away: Math.round((calAway - bookOdds.awayProb) * 10000) / 10000,
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

  for (const model of ["smooth", "reactive", "sharp", "oracle"]) {
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

  // Top 10 teams by oracle price (latest date)
  const latestDate = dates[dates.length - 1];
  const latestOracle = teamPriceRows
    .filter((r) => r.model === "oracle" && r.date === latestDate)
    .sort((a, b) => b.dollar_price - a.dollar_price);
  console.log(`\nTop 10 by oracle price (${latestDate}):`);
  for (let i = 0; i < Math.min(10, latestOracle.length); i++) {
    const t = latestOracle[i];
    console.log(
      `  ${(i + 1).toString().padStart(2)}. ${t.team.padEnd(22)} Elo=${t.implied_elo.toFixed(0).padStart(5)}  $${t.dollar_price.toFixed(2)}  (${t.league})`
    );
  }

  // Edge distribution
  console.log("\nEdge distribution (calibrated 0.7/0.3 blend):");
  for (const model of ["smooth", "reactive", "sharp", "oracle"]) {
    const modelRows = matchProbRows.filter((r) => r.model === model);
    const absEdges = modelRows.flatMap((r) => [
      Math.abs(r.edge_home),
      Math.abs(r.edge_draw),
      Math.abs(r.edge_away),
    ]);
    absEdges.sort((a, b) => a - b);
    const mean = absEdges.reduce((s, e) => s + e, 0) / absEdges.length;
    const med = absEdges[Math.floor(absEdges.length / 2)];
    const max = absEdges[absEdges.length - 1];
    const gt3 = absEdges.filter((e) => e > 0.03).length;
    const gt5 = absEdges.filter((e) => e > 0.05).length;
    const matchesWithEdge = modelRows.filter(
      (r) => Math.abs(r.edge_home) > 0.03 || Math.abs(r.edge_draw) > 0.03 || Math.abs(r.edge_away) > 0.03
    ).length;
    console.log(
      `  ${model.toUpperCase().padEnd(9)} mean=${(mean * 100).toFixed(2)}%  median=${(med * 100).toFixed(2)}%  max=${(max * 100).toFixed(2)}%  |  >3%: ${gt3}/${absEdges.length} outcomes  >5%: ${gt5}  |  matches w/ edge>3%: ${matchesWithEdge}/${modelRows.length} (${((matchesWithEdge / modelRows.length) * 100).toFixed(0)}%)`
    );
  }

  // Top 5 arb edges
  console.log("\nTop 5 edges:");
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
