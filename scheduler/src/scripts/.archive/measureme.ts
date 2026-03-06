/**
 * MeasureMe v3 — Parameter Grid Search with Odds Blend
 *
 * Runs 51 configs: 50 (K × decay × prematchWeight) + 1 drift baseline.
 * ZeroPoint fixed at 800; slope fixed at 5 (cancels in % returns).
 * Scores each with 10 objective indices. ALL indices use percentage PRICE returns.
 *
 * Optimized: 10 Elo replays (K × decay), then 5 price conversions (prematchWeight).
 *
 * Usage:  cd scheduler && npm run measureme
 */
import "dotenv/config";
import { getSupabase, upsertBatched } from "../api/supabase-client.js";
import { log } from "../logger.js";
import { INITIAL_ELO } from "../config.js";
import {
  calibrateHomeAdvantage,
  normalizeOdds,
  oddsImpliedStrength,
  findNextMatch,
  getLatestOddsForFixture,
} from "../services/odds-blend.js";
import type { DriftSnapshot } from "../types.js";

// ─── Legacy Elo name map (API-Football name → Legacy JSON name) ───
const LEGACY_NAME_MAP: Record<string, string> = {
  "1. FC Heidenheim": "1. FC Heidenheim 1846",
  "1899 Hoffenheim": "TSG 1899 Hoffenheim",
  Alaves: "Deportivo Alavés",
  Angers: "Angers SCO",
  Arsenal: "Arsenal FC",
  "Aston Villa": "Aston Villa FC",
  Atalanta: "Atalanta BC",
  "Atletico Madrid": "Club Atlético de Madrid",
  Auxerre: "AJ Auxerre",
  Barcelona: "FC Barcelona",
  "Bayer Leverkusen": "Bayer 04 Leverkusen",
  "Bayern München": "FC Bayern München",
  Bologna: "Bologna FC 1909",
  Bournemouth: "AFC Bournemouth",
  Brentford: "Brentford FC",
  Brighton: "Brighton & Hove Albion FC",
  Burnley: "Burnley FC",
  Cagliari: "Cagliari Calcio",
  "Celta Vigo": "RC Celta de Vigo",
  Chelsea: "Chelsea FC",
  Como: "Como 1907",
  "Crystal Palace": "Crystal Palace FC",
  Espanyol: "RCD Espanyol de Barcelona",
  Everton: "Everton FC",
  "FC St. Pauli": "FC St. Pauli 1910",
  "FSV Mainz 05": "1. FSV Mainz 05",
  Fiorentina: "ACF Fiorentina",
  Fulham: "Fulham FC",
  Genoa: "Genoa CFC",
  Getafe: "Getafe CF",
  Girona: "Girona FC",
  "Hellas Verona": "Hellas Verona FC",
  Inter: "FC Internazionale Milano",
  Juventus: "Juventus FC",
  Lazio: "SS Lazio",
  "Le Havre": "Le Havre AC",
  Lecce: "US Lecce",
  Lens: "Racing Club de Lens",
  Levante: "Levante UD",
  Lille: "Lille OSC",
  Liverpool: "Liverpool FC",
  Lorient: "FC Lorient",
  Lyon: "Olympique Lyonnais",
  Mallorca: "RCD Mallorca",
  "Manchester City": "Manchester City FC",
  "Manchester United": "Manchester United FC",
  Marseille: "Olympique de Marseille",
  Metz: "FC Metz",
  Monaco: "AS Monaco FC",
  Nantes: "FC Nantes",
  Napoli: "SSC Napoli",
  Newcastle: "Newcastle United FC",
  Nice: "OGC Nice",
  "Nottingham Forest": "Nottingham Forest FC",
  Osasuna: "CA Osasuna",
  "Paris Saint Germain": "Paris Saint-Germain FC",
  Parma: "Parma Calcio 1913",
  Pisa: "AC Pisa 1909",
  "Rayo Vallecano": "Rayo Vallecano de Madrid",
  "Real Betis": "Real Betis Balompié",
  "Real Madrid": "Real Madrid CF",
  "Real Sociedad": "Real Sociedad de Fútbol",
  Rennes: "Stade Rennais FC 1901",
  Sassuolo: "US Sassuolo Calcio",
  Sevilla: "Sevilla CF",
  Strasbourg: "RC Strasbourg Alsace",
  Sunderland: "Sunderland AFC",
  Torino: "Torino FC",
  Tottenham: "Tottenham Hotspur FC",
  Toulouse: "Toulouse FC",
  Udinese: "Udinese Calcio",
  "Union Berlin": "1. FC Union Berlin",
  Valencia: "Valencia CF",
  Villarreal: "Villarreal CF",
  "Werder Bremen": "SV Werder Bremen",
  "West Ham": "West Ham United FC",
  Wolves: "Wolverhampton Wanderers FC",
};

const LEGACY_URL =
  "https://raw.githubusercontent.com/frertommy/MSI/main/data/msi_daily.json";

// ─── Parameter Grid ──────────────────────────────────────────
const DEFAULT_SLOPE = 5;
const KS = [15, 20, 25, 30, 35];
const DECAYS = [0.001, 0.002];
const ZERO_POINTS = [800];
const PREMATCH_WEIGHTS = [0.0, 0.20, 0.30, 0.40, 0.50];
const MA_WINDOW = 45;
const ELO_REPLAYS = KS.length * DECAYS.length; // 10
const PRICE_COMBOS = PREMATCH_WEIGHTS.length;   // 5
const TOTAL = ELO_REPLAYS * PRICE_COMBOS + 1;   // 51

// ─── Drift baseline constants (legacy, for comparison only) ───
const DRIFT_SCALE_LEGACY = 400;
const DRIFT_MIN_HOURS_LEGACY = 12;
const DRIFT_FADE_DAYS_LEGACY = 7;

// ─── Types ───────────────────────────────────────────────────
interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
}

interface NormOdds {
  homeProb: number;
  drawProb: number;
  awayProb: number;
}

interface XgInfo {
  homeXg: number;
  awayXg: number;
}

interface RawMatchInfo {
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  odds: NormOdds | null;
  xg: XgInfo | null;
}

interface MatchEvent {
  dateIdx: number;
  team: string;
  surprise: number;
  actualScore: number;
}

interface SharedData {
  allTeams: string[];
  teamLeague: Map<string, string>;
  startingElos: Map<string, number>;
  matchesByDate: Map<string, RawMatchInfo[]>;
  dates: string[];
  teamStartingEloTier: Map<string, "top" | "mid" | "bot">;
  teamPoints: Map<string, number>;
  matches: MatchRow[];
  homeAdv: number;
  teamMatchDateIdxs: Map<string, Set<number>>;
}

interface EloReplayResult {
  dailyElos: Map<string, number[]>;
  matchEvents: MatchEvent[];
}

interface ConfigResult {
  slope: number;
  k: number;
  decay: number;
  zeroPoint: number;
  prematchWeight: number;
  composite: number;
  surpriseR2: number;
  driftNeutrality: number;
  floorHitPct: number;
  kurtosis: number;
  volUniformityRatio: number;
  meanRevSharpe: number;
  infoRatio: number;
  oddsResponsiveness: number;
  oddsResponsivenessScore: number;
  venueStability: number;
  venueStabilityScore: number;
  betweenMatchVol: number;
  betweenMatchVolScore: number;
  surpriseR2Score: number;
  driftScore: number;
  floorHitScore: number;
  kurtosisScore: number;
  volUniScore: number;
  meanRevScore: number;
  infoScore: number;
  avgMatchMovePct: number;
  avgAnnualVol: number;
  totalMatches: number;
  totalTeams: number;
  teamsAtFloor: number;
}

// ─── Helpers ─────────────────────────────────────────────────
function parseScore(s: string): [number, number] | null {
  const parts = s.split("-");
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0].trim());
  const a = parseInt(parts[1].trim());
  if (isNaN(h) || isNaN(a)) return null;
  return [h, a];
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86400000;
}

function eloExpected(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function linearPrice(elo: number, slope: number, zeroPoint: number): number {
  return Math.max(10, (elo - zeroPoint) / slope);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─── Data Loading ────────────────────────────────────────────
async function loadMatches(): Promise<MatchRow[]> {
  const sb = getSupabase();
  const all: MatchRow[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("fixture_id, date, league, home_team, away_team, score")
      .order("date", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      log.error("matches load error:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as MatchRow[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all.filter((r) => parseScore(r.score) !== null);
}

async function loadClosingOdds(
  fixtureIds: number[]
): Promise<Map<number, NormOdds>> {
  const sb = getSupabase();
  const rawSnaps = new Map<number, { hp: number; dp: number; ap: number }[]>();
  const foundFixtures = new Set<number>();

  for (const dbk of [0, 1, 2, 3]) {
    const remaining = fixtureIds.filter((id) => !foundFixtures.has(id));
    if (remaining.length === 0) break;

    const BATCH = 20;
    for (let i = 0; i < remaining.length; i += BATCH) {
      const batch = remaining.slice(i, i + BATCH);
      let from = 0;
      const PAGE = 1000;
      while (true) {
        const { data, error } = await sb
          .from("odds_snapshots")
          .select("fixture_id, home_odds, away_odds, draw_odds")
          .in("fixture_id", batch)
          .eq("days_before_kickoff", dbk)
          .range(from, from + PAGE - 1);

        if (error || !data || data.length === 0) break;

        for (const row of data) {
          const ho = row.home_odds as number | null;
          const ao = row.away_odds as number | null;
          const dw = row.draw_odds as number | null;
          if (!ho || !ao || !dw || ho <= 1 || ao <= 1 || dw <= 1) continue;
          if (!rawSnaps.has(row.fixture_id))
            rawSnaps.set(row.fixture_id, []);
          rawSnaps.get(row.fixture_id)!.push({
            hp: 1 / ho,
            dp: 1 / dw,
            ap: 1 / ao,
          });
          foundFixtures.add(row.fixture_id);
        }

        if (data.length < PAGE) break;
        from += PAGE;
      }
    }

    log.info(`  dbk=${dbk}: ${foundFixtures.size} fixtures found so far`);
  }

  const result = new Map<number, NormOdds>();
  for (const [fid, snaps] of rawSnaps) {
    const meanH = snaps.reduce((a, s) => a + s.hp, 0) / snaps.length;
    const meanD = snaps.reduce((a, s) => a + s.dp, 0) / snaps.length;
    const meanA = snaps.reduce((a, s) => a + s.ap, 0) / snaps.length;
    const total = meanH + meanD + meanA;
    if (total <= 0) continue;
    result.set(fid, {
      homeProb: meanH / total,
      drawProb: meanD / total,
      awayProb: meanA / total,
    });
  }

  log.info(
    `  Closing odds: ${result.size} / ${fixtureIds.length} fixtures`
  );
  return result;
}

async function loadFullOddsCache(
  fixtureIds: number[]
): Promise<Map<number, DriftSnapshot[]>> {
  const sb = getSupabase();
  const cache = new Map<number, DriftSnapshot[]>();
  const BATCH = 30;
  const PAGE = 1000;

  for (let i = 0; i < fixtureIds.length; i += BATCH) {
    const batch = fixtureIds.slice(i, i + BATCH);
    let from = 0;
    while (true) {
      const { data, error } = await sb
        .from("odds_snapshots")
        .select(
          "fixture_id, bookmaker, home_odds, away_odds, draw_odds, snapshot_time"
        )
        .in("fixture_id", batch)
        .range(from, from + PAGE - 1);

      if (error) {
        log.error(`odds cache error (offset ${from}):`, error.message);
        break;
      }
      if (!data || data.length === 0) break;

      for (const row of data as DriftSnapshot[]) {
        if (!row.home_odds || !row.away_odds || !row.draw_odds) continue;
        if (row.home_odds <= 1 || row.away_odds <= 1 || row.draw_odds <= 1)
          continue;
        const fid = row.fixture_id;
        if (!cache.has(fid)) cache.set(fid, []);
        cache.get(fid)!.push(row);
      }

      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  for (const snaps of cache.values()) {
    snaps.sort((a, b) => a.snapshot_time.localeCompare(b.snapshot_time));
  }

  const totalSnaps = [...cache.values()].reduce((a, b) => a + b.length, 0);
  log.info(
    `  Full odds cache: ${cache.size} fixtures (${totalSnaps} snapshots)`
  );
  return cache;
}

async function loadLegacyElos(): Promise<Map<string, number>> {
  log.info("Fetching legacy MSI ratings (pre-season anchor)...");
  try {
    const resp = await fetch(LEGACY_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as Record<
      string,
      { date: string; rating: number }[]
    >;
    const map = new Map<string, number>();
    const seasonStart = "2025-08-01";
    for (const [legacyName, entries] of Object.entries(data)) {
      if (!entries || entries.length === 0) continue;
      const preSeason = entries.filter((e) => e.date < seasonStart);
      const startRating =
        preSeason.length > 0
          ? preSeason[preSeason.length - 1].rating
          : entries[0].rating;
      map.set(legacyName, startRating);
    }
    log.info(
      `  Legacy Elos: ${map.size} teams (pre-season anchor: <${seasonStart})`
    );
    return map;
  } catch (err) {
    log.warn(
      "Legacy Elo fetch failed",
      err instanceof Error ? err.message : err
    );
    return new Map();
  }
}

async function loadXgData(): Promise<Map<number, XgInfo>> {
  const sb = getSupabase();
  const map = new Map<number, XgInfo>();
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from("match_xg")
      .select("fixture_id, home_xg, away_xg")
      .not("fixture_id", "is", null)
      .range(from, from + PAGE - 1);
    if (error) {
      log.warn("match_xg load error:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    for (const r of data) {
      map.set(r.fixture_id as number, {
        homeXg: r.home_xg as number,
        awayXg: r.away_xg as number,
      });
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  log.info(`  xG data: ${map.size} fixtures`);
  return map;
}

// ─── Drift signal (legacy, for baseline comparison only) ─────
function computeDriftForDate(
  date: string,
  matches: MatchRow[],
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
    if (hoursDiff < DRIFT_MIN_HOURS_LEGACY) continue;

    const dBefore = daysBetween(date, match.date);
    const weight = Math.max(
      0,
      Math.min(1, (dBefore - 1) / DRIFT_FADE_DAYS_LEGACY)
    );
    if (weight <= 0) continue;

    if (earliest.home_odds > 0 && latest.home_odds > 0) {
      const earlyProb = 1 / earliest.home_odds;
      const lateProb = 1 / latest.home_odds;
      const homeDrift = DRIFT_SCALE_LEGACY * (lateProb - earlyProb) * weight;
      driftMap.set(
        match.home_team,
        (driftMap.get(match.home_team) ?? 0) + homeDrift
      );
    }

    if (earliest.away_odds > 0 && latest.away_odds > 0) {
      const earlyProb = 1 / earliest.away_odds;
      const lateProb = 1 / latest.away_odds;
      const awayDrift = DRIFT_SCALE_LEGACY * (lateProb - earlyProb) * weight;
      driftMap.set(
        match.away_team,
        (driftMap.get(match.away_team) ?? 0) + awayDrift
      );
    }
  }

  return driftMap;
}

// ─── xG shock multiplier (same as pricing-engine.ts) ─────────
const XG_FLOOR = 0.4;
const XG_CEILING = 1.8;

function xgMultiplier(
  teamXg: number,
  opponentXg: number,
  goalDiff: number
): number {
  const sign = goalDiff > 0 ? 1 : goalDiff < 0 ? -1 : 0;
  const raw = 1.0 + 0.3 * (teamXg - opponentXg) * sign;
  return Math.max(XG_FLOOR, Math.min(XG_CEILING, raw));
}

// ─── Precompute shared data ──────────────────────────────────
function precompute(
  matches: MatchRow[],
  oddsMap: Map<number, NormOdds>,
  legacyElos: Map<string, number>,
  xgMap: Map<number, XgInfo>
): SharedData {
  const teamLeague = new Map<string, string>();
  for (const m of matches) {
    if (!teamLeague.has(m.home_team)) teamLeague.set(m.home_team, m.league);
    if (!teamLeague.has(m.away_team)) teamLeague.set(m.away_team, m.league);
  }
  const allTeams = [...teamLeague.keys()].sort();

  // Starting Elos
  const startingElos = new Map<string, number>();
  for (const t of allTeams) {
    const legacyName = LEGACY_NAME_MAP[t] || t;
    startingElos.set(t, legacyElos.get(legacyName) ?? INITIAL_ELO);
  }

  // Pre-group matches by date
  const matchesByDate = new Map<string, RawMatchInfo[]>();
  const teamPoints = new Map<string, number>();
  for (const t of allTeams) teamPoints.set(t, 0);

  for (const m of matches) {
    const sc = parseScore(m.score)!;
    const odds = oddsMap.get(m.fixture_id) ?? null;
    const xg = xgMap.get(m.fixture_id) ?? null;
    if (!matchesByDate.has(m.date)) matchesByDate.set(m.date, []);
    matchesByDate.get(m.date)!.push({
      homeTeam: m.home_team,
      awayTeam: m.away_team,
      homeGoals: sc[0],
      awayGoals: sc[1],
      odds,
      xg,
    });

    const hp = sc[0] > sc[1] ? 3 : sc[0] === sc[1] ? 1 : 0;
    const ap = sc[1] > sc[0] ? 3 : sc[0] === sc[1] ? 1 : 0;
    teamPoints.set(m.home_team, (teamPoints.get(m.home_team) ?? 0) + hp);
    teamPoints.set(m.away_team, (teamPoints.get(m.away_team) ?? 0) + ap);
  }

  // Date range
  const sortedMatchDates = [...matchesByDate.keys()].sort();
  const startDate = sortedMatchDates[0];
  const endDate = sortedMatchDates[sortedMatchDates.length - 1];
  const dates: string[] = [];
  let d = startDate;
  while (d <= endDate) {
    dates.push(d);
    d = addDays(d, 1);
  }

  // Date index map
  const dateIdxMap = new Map<string, number>();
  for (let i = 0; i < dates.length; i++) dateIdxMap.set(dates[i], i);

  // Tier teams by starting Elo
  const sortedByElo = allTeams
    .map((t) => ({ team: t, elo: startingElos.get(t)! }))
    .sort((a, b) => b.elo - a.elo);
  const topCut = Math.floor(sortedByElo.length * 0.25);
  const botCut = Math.floor(sortedByElo.length * 0.75);
  const teamStartingEloTier = new Map<string, "top" | "mid" | "bot">();
  for (let i = 0; i < sortedByElo.length; i++) {
    const tier = i < topCut ? "top" : i >= botCut ? "bot" : "mid";
    teamStartingEloTier.set(sortedByElo[i].team, tier);
  }

  // Home advantage
  const homeAdv = calibrateHomeAdvantage(matches);

  // Team match day indices
  const teamMatchDateIdxs = new Map<string, Set<number>>();
  for (const t of allTeams) teamMatchDateIdxs.set(t, new Set());
  for (const [dateStr, matchList] of matchesByDate) {
    const idx = dateIdxMap.get(dateStr);
    if (idx === undefined) continue;
    for (const m of matchList) {
      teamMatchDateIdxs.get(m.homeTeam)?.add(idx);
      teamMatchDateIdxs.get(m.awayTeam)?.add(idx);
    }
  }

  return {
    allTeams,
    teamLeague,
    startingElos,
    matchesByDate,
    dates,
    teamStartingEloTier,
    teamPoints,
    matches,
    homeAdv,
    teamMatchDateIdxs,
  };
}

// ─── Elo Replay (once per K × decay pair) ────────────────────
function replayElos(
  shared: SharedData,
  K: number,
  decay: number
): EloReplayResult {
  const { allTeams, matchesByDate, dates, startingElos } = shared;

  const elo = new Map<string, number>();
  const eloHistory = new Map<string, number[]>();
  const lastMatchDate = new Map<string, string>();

  const dailyElos = new Map<string, number[]>();
  for (const t of allTeams) {
    const e = startingElos.get(t)!;
    elo.set(t, e);
    eloHistory.set(t, [e]);
    dailyElos.set(t, [e]);
  }

  const matchEvents: MatchEvent[] = [];

  for (let dateIdx = 0; dateIdx < dates.length; dateIdx++) {
    const date = dates[dateIdx];
    const todaysMatches = matchesByDate.get(date) ?? [];
    const playingToday = new Set<string>();
    for (const m of todaysMatches) {
      playingToday.add(m.homeTeam);
      playingToday.add(m.awayTeam);
    }

    // 1. Carry decay for non-playing teams → 45-day MA anchor
    for (const t of allTeams) {
      if (playingToday.has(t)) continue;
      const lm = lastMatchDate.get(t);
      if (!lm) continue;
      const daysSince = Math.round(
        (new Date(date + "T00:00:00Z").getTime() -
          new Date(lm + "T00:00:00Z").getTime()) /
          86400000
      );
      if (daysSince <= 0) continue;

      const hist = eloHistory.get(t)!;
      const maSlice = hist.slice(-MA_WINDOW);
      const ma = maSlice.reduce((a, b) => a + b, 0) / maSlice.length;
      const factor = Math.max(0.5, 1 - decay * daysSince);
      elo.set(t, ma + (elo.get(t)! - ma) * factor);
    }

    // 2. Match shocks
    for (const m of todaysMatches) {
      const homeElo = elo.get(m.homeTeam)!;
      const awayElo = elo.get(m.awayTeam)!;

      const homeActual =
        m.homeGoals > m.awayGoals ? 1 : m.homeGoals === m.awayGoals ? 0.5 : 0;
      const awayActual = 1 - homeActual;

      let homeExpected: number;
      let awayExpected: number;
      if (m.odds) {
        homeExpected = m.odds.homeProb * 1 + m.odds.drawProb * 0.5;
        awayExpected = m.odds.awayProb * 1 + m.odds.drawProb * 0.5;
      } else {
        homeExpected = eloExpected(homeElo, awayElo);
        awayExpected = 1 - homeExpected;
      }

      let homeShock = K * (homeActual - homeExpected);
      let awayShock = K * (awayActual - awayExpected);

      if (m.xg) {
        const goalDiff = m.homeGoals - m.awayGoals;
        homeShock *= xgMultiplier(m.xg.homeXg, m.xg.awayXg, goalDiff);
        awayShock *= xgMultiplier(m.xg.awayXg, m.xg.homeXg, -goalDiff);
      }

      elo.set(m.homeTeam, homeElo + homeShock);
      elo.set(m.awayTeam, awayElo + awayShock);

      lastMatchDate.set(m.homeTeam, date);
      lastMatchDate.set(m.awayTeam, date);

      matchEvents.push({
        dateIdx,
        team: m.homeTeam,
        surprise: Math.abs(homeActual - homeExpected),
        actualScore: homeActual,
      });
      matchEvents.push({
        dateIdx,
        team: m.awayTeam,
        surprise: Math.abs(awayActual - awayExpected),
        actualScore: awayActual,
      });
    }

    // 3. Re-center all Elos to mean 1500
    let sum = 0;
    for (const t of allTeams) sum += elo.get(t)!;
    const shift = 1500 - sum / allTeams.length;
    for (const t of allTeams) elo.set(t, elo.get(t)! + shift);

    // 4. Update history + daily Elos
    for (const t of allTeams) {
      const e = elo.get(t)!;
      const hist = eloHistory.get(t)!;
      hist.push(e);
      if (hist.length > MA_WINDOW + 30)
        hist.splice(0, hist.length - MA_WINDOW - 10);
      dailyElos.get(t)!.push(e);
    }
  }

  return { dailyElos, matchEvents };
}

// ─── Pre-compute daily odds-implied strength per replay ──────
function computeDailyOddsImplied(
  replay: EloReplayResult,
  shared: SharedData,
  oddsCache: Map<number, DriftSnapshot[]>
): {
  dailyOddsImplied: Map<string, (number | null)[]>;
  dailyNextFixtureId: Map<string, (number | null)[]>;
} {
  const { allTeams, dates, matches, homeAdv } = shared;
  const { dailyElos } = replay;

  const dailyOddsImplied = new Map<string, (number | null)[]>();
  const dailyNextFixtureId = new Map<string, (number | null)[]>();

  for (const team of allTeams) {
    const implied: (number | null)[] = [];
    const nextFix: (number | null)[] = [];
    const elos = dailyElos.get(team)!;

    for (let dateIdx = 0; dateIdx < dates.length; dateIdx++) {
      const date = dates[dateIdx];

      const nextMatch = findNextMatch(team, date, matches, 14);
      if (nextMatch) {
        nextFix.push(nextMatch.fixture_id);

        const odds = getLatestOddsForFixture(
          nextMatch.fixture_id,
          date,
          oddsCache
        );
        if (
          odds &&
          odds.homeOdds > 0 &&
          odds.drawOdds > 0 &&
          odds.awayOdds > 0
        ) {
          const { homeProb, drawProb, awayProb } = normalizeOdds(
            odds.homeOdds,
            odds.drawOdds,
            odds.awayOdds
          );
          const isHome = nextMatch.home_team === team;
          const teamES = isHome
            ? homeProb + drawProb * 0.5
            : awayProb + drawProb * 0.5;
          const opponent = isHome
            ? nextMatch.away_team
            : nextMatch.home_team;
          // Use opponent's matchElo (not blended)
          const oppElo = elos[dateIdx + 1] !== undefined
            ? (dailyElos.get(opponent)?.[dateIdx + 1] ?? INITIAL_ELO)
            : INITIAL_ELO;

          implied.push(
            oddsImpliedStrength(teamES, oppElo, isHome, homeAdv)
          );
        } else {
          implied.push(null);
        }
      } else {
        nextFix.push(null);
        implied.push(null);
      }
    }

    dailyOddsImplied.set(team, implied);
    dailyNextFixtureId.set(team, nextFix);
  }

  return { dailyOddsImplied, dailyNextFixtureId };
}

// ─── Price conversion + all 10 indices ───────────────────────
function computeForPriceParams(
  replay: EloReplayResult,
  shared: SharedData,
  slope: number,
  zeroPoint: number,
  prematchWeight: number,
  dailyOddsImplied: Map<string, (number | null)[]>,
  dailyNextFixtureId: Map<string, (number | null)[]>,
  driftMaps?: Map<string, number>[]
): ConfigResult {
  const { allTeams, dates, teamStartingEloTier, teamLeague, teamPoints, teamMatchDateIdxs } =
    shared;
  const { dailyElos, matchEvents } = replay;

  // Convert Elos → prices, applying blend or drift
  const teamDailyPrices = new Map<string, number[]>();
  const teamDailyReturns = new Map<string, number[]>();

  for (const team of allTeams) {
    const elos = dailyElos.get(team)!;
    const oddsArr = dailyOddsImplied.get(team) ?? [];
    const prices: number[] = new Array(elos.length);
    const returns: number[] = new Array(elos.length - 1);

    for (let i = 0; i < elos.length; i++) {
      let eloForPricing = elos[i];

      if (i > 0) {
        const dateIdx = i - 1;

        if (driftMaps) {
          // Drift baseline: add legacy drift
          const drift = driftMaps[dateIdx]?.get(team) ?? 0;
          eloForPricing = elos[i] + drift;
        } else if (prematchWeight > 0) {
          // Odds blend
          const impl = oddsArr[dateIdx] ?? null;
          if (impl !== null) {
            eloForPricing =
              (1 - prematchWeight) * elos[i] + prematchWeight * impl;
          }
        }
      }

      prices[i] = linearPrice(eloForPricing, slope, zeroPoint);
    }

    for (let i = 0; i < returns.length; i++) {
      returns[i] =
        prices[i] > 0 ? (prices[i + 1] - prices[i]) / prices[i] : 0;
    }

    teamDailyPrices.set(team, prices);
    teamDailyReturns.set(team, returns);
  }

  // ── Index 1: Surprise-Response R² (20%) ─────────────
  const surprises: number[] = [];
  const priceMoves: number[] = [];

  for (const event of matchEvents) {
    if (event.dateIdx === 0) continue;
    const prices = teamDailyPrices.get(event.team)!;
    const priceBefore = prices[event.dateIdx];
    const priceAfter = prices[event.dateIdx + 1];
    if (priceBefore <= 0) continue;
    surprises.push(event.surprise);
    priceMoves.push(Math.abs(priceAfter - priceBefore) / priceBefore);
  }

  let r2 = 0;
  let avgMatchMove = 0;
  if (surprises.length >= 10) {
    const n = surprises.length;
    const meanX = surprises.reduce((a, b) => a + b, 0) / n;
    const meanY = priceMoves.reduce((a, b) => a + b, 0) / n;
    let ssXY = 0,
      ssXX = 0,
      ssYY = 0;
    for (let i = 0; i < n; i++) {
      const dx = surprises[i] - meanX;
      const dy = priceMoves[i] - meanY;
      ssXY += dx * dy;
      ssXX += dx * dx;
      ssYY += dy * dy;
    }
    r2 = ssXX > 0 && ssYY > 0 ? (ssXY * ssXY) / (ssXX * ssYY) : 0;
    avgMatchMove = meanY * 100;
  }

  // ── Index 2: Drift Neutrality (8%) ─────────────────
  let totalReturn = 0;
  let returnCount = 0;
  for (const returns of teamDailyReturns.values()) {
    for (let ri = 1; ri < returns.length; ri++) {
      totalReturn += returns[ri];
      returnCount++;
    }
  }
  const meanDailyReturn = returnCount > 0 ? totalReturn / returnCount : 0;

  // ── Index 3: Floor Hit % (5%) ──────────────────────
  let floorCount = 0;
  let totalObs = 0;
  let teamsAtFloor = 0;
  for (const team of allTeams) {
    const prices = teamDailyPrices.get(team)!;
    let teamHitFloor = false;
    for (let i = 2; i < prices.length; i++) {
      totalObs++;
      if (prices[i] <= 10.001) {
        floorCount++;
        teamHitFloor = true;
      }
    }
    if (teamHitFloor) teamsAtFloor++;
  }
  const floorHitPct = totalObs > 0 ? (floorCount / totalObs) * 100 : 0;

  // ── Index 4: Return Kurtosis (5%) ──────────────────
  const allReturns: number[] = [];
  for (const returns of teamDailyReturns.values()) {
    for (let ri = 1; ri < returns.length; ri++) allReturns.push(returns[ri]);
  }
  let kurtosis = 3;
  if (allReturns.length >= 20) {
    const n = allReturns.length;
    const mean = allReturns.reduce((a, b) => a + b, 0) / n;
    let m2 = 0,
      m4 = 0;
    for (const r of allReturns) {
      const dd = r - mean;
      m2 += dd * dd;
      m4 += dd * dd * dd * dd;
    }
    m2 /= n;
    m4 /= n;
    kurtosis = m2 > 0 ? m4 / (m2 * m2) : 3;
  }

  // ── Index 5: Vol Uniformity (5%) ───────────────────
  const tierVols: Record<string, number[]> = { top: [], mid: [], bot: [] };
  for (const team of allTeams) {
    const tier = teamStartingEloTier.get(team) ?? "mid";
    const allRet = teamDailyReturns.get(team)!;
    const returns = allRet.slice(1);
    if (returns.length < 10) continue;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
    const annVol = Math.sqrt(variance) * Math.sqrt(365) * 100;
    tierVols[tier].push(annVol);
  }
  const tierAvgs: number[] = [];
  for (const tier of ["top", "mid", "bot"] as const) {
    if (tierVols[tier].length === 0) continue;
    tierAvgs.push(
      tierVols[tier].reduce((a, b) => a + b, 0) / tierVols[tier].length
    );
  }
  const volRatio =
    tierAvgs.length >= 2
      ? Math.max(...tierAvgs) / Math.min(...tierAvgs.filter((v) => v > 0))
      : 1;

  // ── Index 6: Mean-Reversion Sharpe (15%) ────────────
  const teamMatchDays = new Map<string, Map<number, number>>();
  for (const event of matchEvents) {
    if (event.dateIdx === 0) continue;
    if (!teamMatchDays.has(event.team))
      teamMatchDays.set(event.team, new Map());
    teamMatchDays.get(event.team)!.set(event.dateIdx, event.actualScore);
  }

  const dailyPnl: number[] = [];
  for (const team of allTeams) {
    const returns = teamDailyReturns.get(team)!;
    const matchDays = teamMatchDays.get(team) ?? new Map();
    let position = 0;
    let holdDays = 0;

    for (let i = 1; i < returns.length; i++) {
      if (position !== 0) {
        dailyPnl.push(position * returns[i]);
        holdDays--;
        if (holdDays <= 0) position = 0;
      }

      const actual = matchDays.get(i);
      if (actual !== undefined) {
        if (actual === 0) {
          position = 1;
          holdDays = 3;
        } else if (actual === 1) {
          position = -1;
          holdDays = 3;
        }
      }
    }
  }

  let mrSharpe = 0;
  if (dailyPnl.length >= 30) {
    const mean = dailyPnl.reduce((a, b) => a + b, 0) / dailyPnl.length;
    const std = Math.sqrt(
      dailyPnl.reduce((a, r) => a + (r - mean) ** 2, 0) / dailyPnl.length
    );
    mrSharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;
  }

  // ── Index 7: Information Ratio (10%) ────────────────
  const leagues = new Set(teamLeague.values());
  const correlations: number[] = [];

  for (const league of leagues) {
    const teams = allTeams.filter((t) => teamLeague.get(t) === league);
    if (teams.length < 5) continue;

    const teamFinalPrice = new Map<string, number>();
    for (const t of teams) {
      const prices = teamDailyPrices.get(t)!;
      teamFinalPrice.set(t, prices[prices.length - 1]);
    }

    const byPrice = [...teams].sort(
      (a, b) => (teamFinalPrice.get(b) ?? 0) - (teamFinalPrice.get(a) ?? 0)
    );
    const priceRank = new Map<string, number>();
    byPrice.forEach((t, i) => priceRank.set(t, i + 1));

    const byPoints = [...teams].sort(
      (a, b) => (teamPoints.get(b) ?? 0) - (teamPoints.get(a) ?? 0)
    );
    const ptsRank = new Map<string, number>();
    byPoints.forEach((t, i) => ptsRank.set(t, i + 1));

    let dSq = 0;
    for (const t of teams) {
      const dd = (priceRank.get(t) ?? 0) - (ptsRank.get(t) ?? 0);
      dSq += dd * dd;
    }
    const n = teams.length;
    const rho = 1 - (6 * dSq) / (n * (n * n - 1));
    correlations.push(rho);
  }

  const infoRatio =
    correlations.length > 0
      ? correlations.reduce((a, b) => a + b, 0) / correlations.length
      : 0;

  // ── Index 8: Odds Responsiveness (15%) ──────────────
  // On non-match days where odds shifted (>5 Elo ≈ 1% prob), measure
  // correlation(Δ oddsImpliedStrength, Δ price)
  const oddsRespX: number[] = [];
  const oddsRespY: number[] = [];
  for (const team of allTeams) {
    const oddsArr = dailyOddsImplied.get(team) ?? [];
    const teamReturns = teamDailyReturns.get(team)!;
    const matchDays = teamMatchDateIdxs.get(team)!;

    for (let dateIdx = 1; dateIdx < dates.length; dateIdx++) {
      if (matchDays.has(dateIdx)) continue;
      if (dateIdx >= teamReturns.length) continue;

      const implToday = oddsArr[dateIdx] ?? null;
      const implYesterday = oddsArr[dateIdx - 1] ?? null;
      if (implToday === null || implYesterday === null) continue;

      const deltaImpl = implToday - implYesterday;
      if (Math.abs(deltaImpl) < 5) continue;

      oddsRespX.push(deltaImpl);
      oddsRespY.push(teamReturns[dateIdx] * 100);
    }
  }

  let oddsResp = 0;
  if (oddsRespX.length >= 20) {
    const n = oddsRespX.length;
    const meanX = oddsRespX.reduce((a, b) => a + b, 0) / n;
    const meanY = oddsRespY.reduce((a, b) => a + b, 0) / n;
    let ssXY = 0,
      ssXX = 0,
      ssYY = 0;
    for (let i = 0; i < n; i++) {
      const dx = oddsRespX[i] - meanX;
      const dy = oddsRespY[i] - meanY;
      ssXY += dx * dy;
      ssXX += dx * dx;
      ssYY += dy * dy;
    }
    oddsResp =
      ssXX > 0 && ssYY > 0 ? ssXY / Math.sqrt(ssXX * ssYY) : 0;
  }

  // ── Index 9: Venue Stability (10%) ──────────────────
  // When next-fixture changes on a non-match day, measure price move ratio
  const transitionMoves: number[] = [];
  const nonTransNonMatchMoves: number[] = [];

  for (const team of allTeams) {
    const nextFixArr = dailyNextFixtureId.get(team) ?? [];
    const teamReturns = teamDailyReturns.get(team)!;
    const matchDays = teamMatchDateIdxs.get(team)!;

    for (let dateIdx = 1; dateIdx < dates.length; dateIdx++) {
      if (matchDays.has(dateIdx)) continue;
      if (dateIdx >= teamReturns.length) continue;

      const prevFix = nextFixArr[dateIdx - 1] ?? null;
      const currFix = nextFixArr[dateIdx] ?? null;
      if (prevFix === null || currFix === null) continue;

      const absRet = Math.abs(teamReturns[dateIdx]);

      if (prevFix !== currFix) {
        transitionMoves.push(absRet);
      } else {
        nonTransNonMatchMoves.push(absRet);
      }
    }
  }

  let venueRatio = 1.0;
  if (transitionMoves.length >= 5 && nonTransNonMatchMoves.length >= 5) {
    const meanTrans =
      transitionMoves.reduce((a, b) => a + b, 0) / transitionMoves.length;
    const meanNonTrans =
      nonTransNonMatchMoves.reduce((a, b) => a + b, 0) /
      nonTransNonMatchMoves.length;
    venueRatio = meanNonTrans > 1e-10 ? meanTrans / meanNonTrans : 1.0;
  }

  // ── Index 10: Between-Match Vol (7%) ────────────────
  // Non-match-day annualized vol
  const nonMatchReturns: number[] = [];
  for (const team of allTeams) {
    const teamReturns = teamDailyReturns.get(team)!;
    const matchDays = teamMatchDateIdxs.get(team)!;

    for (let dateIdx = 1; dateIdx < dates.length; dateIdx++) {
      if (matchDays.has(dateIdx)) continue;
      if (dateIdx >= teamReturns.length) continue;
      nonMatchReturns.push(teamReturns[dateIdx]);
    }
  }

  let betweenMatchAnnVol = 0;
  if (nonMatchReturns.length >= 30) {
    const mean =
      nonMatchReturns.reduce((a, b) => a + b, 0) / nonMatchReturns.length;
    const variance =
      nonMatchReturns.reduce((a, r) => a + (r - mean) ** 2, 0) /
      nonMatchReturns.length;
    betweenMatchAnnVol = Math.sqrt(variance) * Math.sqrt(365) * 100;
  }

  // ── Avg Annual Vol ──────────────────────────────────
  const vols: number[] = [];
  for (const team of allTeams) {
    const allRet2 = teamDailyReturns.get(team)!;
    const returns = allRet2.slice(1);
    if (returns.length < 10) continue;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
    vols.push(Math.sqrt(variance) * Math.sqrt(365) * 100);
  }
  const avgAnnualVol =
    vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;

  // ── Scoring ─────────────────────────────────────────
  // Weights: R²=20%, Drift=8%, Floor=5%, Kurt=5%, VolUni=5%,
  //          MR=15%, Info=10%, OddsResp=15%, VenueStab=10%, BetweenVol=7%
  const s1 = Math.min(100, r2 * 143);
  const s2 = Math.max(0, 100 * (1 - Math.abs(meanDailyReturn) / 0.001));
  const s3 = Math.max(0, 100 * (1 - floorHitPct / 10));
  const s4 = Math.max(0, 100 - Math.abs(kurtosis - 7) * 5);
  const s5 = Math.max(0, 100 * (1 - (volRatio - 1.0) / 2.0));
  const s6 = Math.max(0, 100 * (1 - Math.abs(mrSharpe) / 0.8));
  const s7 = Math.min(100, Math.max(0, infoRatio * 110));
  const s8 = Math.min(100, Math.max(0, oddsResp * 125));
  const s9 = Math.max(0, 100 - Math.abs(venueRatio - 1.0) * 50);
  const s10 = Math.min(100, betweenMatchAnnVol * 5);

  const composite = round4(
    s1 * 0.20 +
      s2 * 0.08 +
      s3 * 0.05 +
      s4 * 0.05 +
      s5 * 0.05 +
      s6 * 0.15 +
      s7 * 0.10 +
      s8 * 0.15 +
      s9 * 0.10 +
      s10 * 0.07
  );

  return {
    slope,
    k: 0,
    decay: 0,
    zeroPoint,
    prematchWeight: 0,
    composite,
    surpriseR2: r2,
    driftNeutrality: meanDailyReturn,
    floorHitPct,
    kurtosis,
    volUniformityRatio: volRatio,
    meanRevSharpe: mrSharpe,
    infoRatio,
    oddsResponsiveness: oddsResp,
    oddsResponsivenessScore: round4(s8),
    venueStability: venueRatio,
    venueStabilityScore: round4(s9),
    betweenMatchVol: betweenMatchAnnVol,
    betweenMatchVolScore: round4(s10),
    surpriseR2Score: round4(s1),
    driftScore: round4(s2),
    floorHitScore: round4(s3),
    kurtosisScore: round4(s4),
    volUniScore: round4(s5),
    meanRevScore: round4(s6),
    infoScore: round4(s7),
    avgMatchMovePct: avgMatchMove,
    avgAnnualVol,
    totalMatches: matchEvents.length / 2,
    totalTeams: allTeams.length,
    teamsAtFloor,
  };
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const runId = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  log.info("═══ MeasureMe v3 Grid Search (Odds Blend) ═══");
  log.info(`Run ID: ${runId}`);
  log.info(
    `Grid: ${ELO_REPLAYS} Elo replays × ${PRICE_COMBOS} prematch weights = ${ELO_REPLAYS * PRICE_COMBOS} + 1 drift baseline = ${TOTAL} configs`
  );
  log.info("");

  // Phase 1: Load data
  log.info("Phase 1: Loading data...");
  const [matches, legacyElos, xgMap] = await Promise.all([
    loadMatches(),
    loadLegacyElos(),
    loadXgData(),
  ]);
  log.info(`  Matches: ${matches.length} completed`);

  const fixtureIds = [...new Set(matches.map((m) => m.fixture_id))];
  const [oddsMap, oddsCache] = await Promise.all([
    loadClosingOdds(fixtureIds),
    loadFullOddsCache(fixtureIds),
  ]);

  // Phase 2: Precompute
  log.info("Phase 2: Precomputing...");
  const shared = precompute(matches, oddsMap, legacyElos, xgMap);
  log.info(`  Teams: ${shared.allTeams.length}`);
  log.info(
    `  Dates: ${shared.dates[0]} → ${shared.dates[shared.dates.length - 1]} (${shared.dates.length} days)`
  );
  log.info(`  Home advantage: ${shared.homeAdv.toFixed(1)} Elo points`);
  log.info("");

  // Phase 3: Grid search
  log.info("Phase 3: Grid search...");
  const results: ConfigResult[] = [];
  let replayNum = 0;

  let savedReplayK20D001: EloReplayResult | null = null;
  let savedOddsInfoK20D001: {
    dailyOddsImplied: Map<string, (number | null)[]>;
    dailyNextFixtureId: Map<string, (number | null)[]>;
  } | null = null;

  for (const K of KS) {
    for (const decay of DECAYS) {
      replayNum++;
      const rt0 = Date.now();

      const replay = replayElos(shared, K, decay);
      const replayMs = Date.now() - rt0;

      // Pre-compute odds-implied strengths for this replay
      const ot0 = Date.now();
      const oddsInfo = computeDailyOddsImplied(replay, shared, oddsCache);
      const oddsMs = Date.now() - ot0;

      // Save K=20 decay=0.001 for drift baseline
      if (K === 20 && decay === 0.001) {
        savedReplayK20D001 = replay;
        savedOddsInfoK20D001 = oddsInfo;
      }

      for (const pw of PREMATCH_WEIGHTS) {
        const result = computeForPriceParams(
          replay,
          shared,
          DEFAULT_SLOPE,
          ZERO_POINTS[0],
          pw,
          oddsInfo.dailyOddsImplied,
          oddsInfo.dailyNextFixtureId
        );
        result.k = K;
        result.decay = decay;
        result.prematchWeight = pw;
        results.push(result);
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const bestSoFar = results.reduce((a, b) =>
        a.composite > b.composite ? a : b
      );
      log.info(
        `  [${replayNum}/${ELO_REPLAYS}] K=${K} decay=${decay} (replay ${replayMs}ms, odds ${oddsMs}ms) → best: ${bestSoFar.composite}  (${elapsed}s)`
      );
    }
  }

  // Drift baseline: K=20 decay=0.001 + legacy drift signal
  if (savedReplayK20D001 && savedOddsInfoK20D001) {
    log.info("  Computing drift baseline (K=20 decay=0.001 + legacy drift)...");
    const dt0 = Date.now();
    const driftMaps: Map<string, number>[] = [];
    for (const date of shared.dates) {
      driftMaps.push(computeDriftForDate(date, shared.matches, oddsCache));
    }

    const driftResult = computeForPriceParams(
      savedReplayK20D001,
      shared,
      DEFAULT_SLOPE,
      ZERO_POINTS[0],
      0,
      savedOddsInfoK20D001.dailyOddsImplied,
      savedOddsInfoK20D001.dailyNextFixtureId,
      driftMaps
    );
    driftResult.k = 20;
    driftResult.decay = 0.001;
    driftResult.prematchWeight = -1; // marker for drift baseline
    results.push(driftResult);
    log.info(`  Drift baseline: ${driftResult.composite} (${Date.now() - dt0}ms)`);
  }

  // Sort by composite
  results.sort((a, b) => b.composite - a.composite);

  log.info("");
  log.info("TOP 10:");
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    const pwLabel = r.prematchWeight === -1 ? "DRIFT" : `pw=${r.prematchWeight}`;
    log.info(
      `  #${i + 1}  K=${r.k} decay=${r.decay} ${pwLabel} → score ${r.composite}`
    );
    log.info(
      `        R²=${r.surpriseR2Score} Drift=${r.driftScore} Floor=${r.floorHitScore} Kurt=${r.kurtosisScore} Vol=${r.volUniScore} MR=${r.meanRevScore} Info=${r.infoScore} OddsR=${r.oddsResponsivenessScore} Venue=${r.venueStabilityScore} BtwnV=${r.betweenMatchVolScore}`
    );
  }

  // Show drift baseline position
  const driftIdx = results.findIndex((r) => r.prematchWeight === -1);
  if (driftIdx >= 0) {
    log.info(`\nDrift baseline rank: #${driftIdx + 1} / ${results.length} (score: ${results[driftIdx].composite})`);
  }

  // Show w=0 best
  const bestW0 = results.find((r) => r.prematchWeight === 0.0);
  if (bestW0) {
    const w0Idx = results.indexOf(bestW0);
    log.info(`Best w=0.0 rank: #${w0Idx + 1} (score: ${bestW0.composite})`);
  }
  log.info("");

  // Phase 4: Write to Supabase
  log.info("Phase 4: Writing results...");

  const sb = getSupabase();
  const { error: delError } = await sb
    .from("measureme_results")
    .delete()
    .neq("id", 0);
  if (delError) log.warn("Could not clear old results:", delError.message);

  const rows = results.map((r) => ({
    run_id: runId,
    slope: r.slope,
    k_factor: r.k,
    decay: r.decay,
    zero_point: r.zeroPoint,
    prematch_weight: r.prematchWeight,
    composite_score: r.composite,
    surprise_r2: round4(r.surpriseR2),
    drift_neutrality: round4(r.driftNeutrality),
    floor_hit_pct: round4(r.floorHitPct),
    kurtosis: round4(r.kurtosis),
    vol_uniformity_ratio: round4(r.volUniformityRatio),
    mean_rev_sharpe: round4(r.meanRevSharpe),
    info_ratio: round4(r.infoRatio),
    odds_responsiveness: round4(r.oddsResponsiveness),
    odds_responsiveness_score: r.oddsResponsivenessScore,
    venue_stability: round4(r.venueStability),
    venue_stability_score: r.venueStabilityScore,
    between_match_vol: round4(r.betweenMatchVol),
    between_match_vol_score: r.betweenMatchVolScore,
    surprise_r2_score: r.surpriseR2Score,
    drift_score: r.driftScore,
    floor_hit_score: r.floorHitScore,
    kurtosis_score: r.kurtosisScore,
    vol_uni_score: r.volUniScore,
    mean_rev_score: r.meanRevScore,
    info_score: r.infoScore,
    avg_match_move_pct: round4(r.avgMatchMovePct),
    avg_annual_vol: round4(r.avgAnnualVol),
    total_matches_evaluated: r.totalMatches,
    total_teams: r.totalTeams,
    teams_at_floor: r.teamsAtFloor,
  }));

  const { inserted, failed } = await upsertBatched(
    "measureme_results",
    rows,
    "id"
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log.info(`Written ${inserted} rows (${failed} failed)`);
  log.info(`Total time: ${elapsed}s`);
}

main().catch((err) => {
  log.error("MeasureMe FATAL", err instanceof Error ? err.message : err);
  process.exit(1);
});
