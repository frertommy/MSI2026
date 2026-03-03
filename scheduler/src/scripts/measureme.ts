/**
 * MeasureMe v2 — Parameter Grid Search
 *
 * Runs 3,120 (slope × K × decay × zeroPoint) configs against real match + odds data.
 * Scores each with 7 objective indices. ALL indices use percentage PRICE returns.
 *
 * Optimized: 52 Elo replays (K × decay), then 60 price conversions (slope × zeroPoint).
 *
 * Usage:  cd scheduler && npm run measureme
 */
import "dotenv/config";
import { getSupabase, upsertBatched } from "../api/supabase-client.js";
import { log } from "../logger.js";
import { INITIAL_ELO } from "../config.js";

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
  Sevilla: "Sevilla FC",
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
const SLOPES = [3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 8, 9, 10];
const KS = [20, 25, 28, 30, 32, 35, 38, 40, 42, 45, 48, 50, 55];
const DECAYS = [0.001, 0.0015, 0.002, 0.003];
const ZERO_POINTS = [800, 850, 900, 950, 1000];
const MA_WINDOW = 45;
const ELO_REPLAYS = KS.length * DECAYS.length; // 52
const PRICE_COMBOS = SLOPES.length * ZERO_POINTS.length; // 60
const TOTAL = ELO_REPLAYS * PRICE_COMBOS; // 3120

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

interface RawMatchInfo {
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  odds: NormOdds | null;
}

interface MatchEvent {
  dateIdx: number;
  team: string;
  surprise: number;
  actualScore: number; // 1=win, 0.5=draw, 0=loss
}

interface SharedData {
  allTeams: string[];
  teamLeague: Map<string, string>;
  startingElos: Map<string, number>;
  matchesByDate: Map<string, RawMatchInfo[]>;
  dates: string[];
  teamStartingEloTier: Map<string, "top" | "mid" | "bot">;
  teamPoints: Map<string, number>;
}

interface EloReplayResult {
  // dailyElos[team][0] = starting Elo, [i+1] = end of dates[i]
  dailyElos: Map<string, number[]>;
  matchEvents: MatchEvent[];
}

interface ConfigResult {
  slope: number;
  k: number;
  decay: number;
  zeroPoint: number;
  composite: number;
  surpriseR2: number;
  driftNeutrality: number;
  floorHitPct: number;
  kurtosis: number;
  volUniformityRatio: number;
  meanRevSharpe: number;
  infoRatio: number;
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
  const accum = new Map<
    number,
    { home: number[]; draw: number[]; away: number[] }
  >();

  const BATCH = 50;
  for (let i = 0; i < fixtureIds.length; i += BATCH) {
    const batch = fixtureIds.slice(i, i + BATCH);
    const { data, error } = await sb
      .from("odds_snapshots")
      .select("fixture_id, home_odds, away_odds, draw_odds")
      .in("fixture_id", batch)
      .eq("days_before_kickoff", 1);

    if (error || !data) continue;

    for (const row of data) {
      const ho = row.home_odds as number | null;
      const ao = row.away_odds as number | null;
      const dw = row.draw_odds as number | null;
      if (!ho || !ao || !dw || ho <= 1 || ao <= 1 || dw <= 1) continue;
      if (!accum.has(row.fixture_id))
        accum.set(row.fixture_id, { home: [], draw: [], away: [] });
      const e = accum.get(row.fixture_id)!;
      e.home.push(1 / ho);
      e.draw.push(1 / dw);
      e.away.push(1 / ao);
    }
  }

  // Mean probabilities per fixture, normalized
  const result = new Map<number, NormOdds>();
  for (const [fid, { home, draw, away }] of accum) {
    const meanH = home.reduce((a, b) => a + b, 0) / home.length;
    const meanD = draw.reduce((a, b) => a + b, 0) / draw.length;
    const meanA = away.reduce((a, b) => a + b, 0) / away.length;
    const total = meanH + meanD + meanA;
    if (total <= 0) continue;
    result.set(fid, {
      homeProb: meanH / total,
      drawProb: meanD / total,
      awayProb: meanA / total,
    });
  }

  log.info(
    `  Closing odds: ${result.size} / ${fixtureIds.length} fixtures with day-1 odds`
  );
  return result;
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

// ─── Precompute shared data ──────────────────────────────────
function precompute(
  matches: MatchRow[],
  oddsMap: Map<number, NormOdds>,
  legacyElos: Map<string, number>
): SharedData {
  const teamLeague = new Map<string, string>();
  for (const m of matches) {
    if (!teamLeague.has(m.home_team)) teamLeague.set(m.home_team, m.league);
    if (!teamLeague.has(m.away_team)) teamLeague.set(m.away_team, m.league);
  }
  const allTeams = [...teamLeague.keys()].sort();

  // Starting Elos: look up API-Football name → legacy name → rating
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
    if (!matchesByDate.has(m.date)) matchesByDate.set(m.date, []);
    matchesByDate.get(m.date)!.push({
      homeTeam: m.home_team,
      awayTeam: m.away_team,
      homeGoals: sc[0],
      awayGoals: sc[1],
      odds,
    });

    // League points (3W + 1D)
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

  // Tier teams by starting Elo (top 25%, mid 50%, bottom 25%)
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

  return {
    allTeams,
    teamLeague,
    startingElos,
    matchesByDate,
    dates,
    teamStartingEloTier,
    teamPoints,
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

  // dailyElos[team][0] = starting Elo (before first date)
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

      // Expected score: from closing odds if available, else Elo-derived
      let homeExpected: number;
      let awayExpected: number;
      if (m.odds) {
        homeExpected = m.odds.homeProb * 1 + m.odds.drawProb * 0.5;
        awayExpected = m.odds.awayProb * 1 + m.odds.drawProb * 0.5;
      } else {
        homeExpected = eloExpected(homeElo, awayElo);
        awayExpected = 1 - homeExpected;
      }

      const homeShock = K * (homeActual - homeExpected);
      const awayShock = K * (awayActual - awayExpected);

      elo.set(m.homeTeam, homeElo + homeShock);
      elo.set(m.awayTeam, awayElo + awayShock);

      lastMatchDate.set(m.homeTeam, date);
      lastMatchDate.set(m.awayTeam, date);

      // Record events
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

// ─── Price conversion + all 7 indices ────────────────────────
function computeForPriceParams(
  replay: EloReplayResult,
  shared: SharedData,
  slope: number,
  zeroPoint: number
): ConfigResult {
  const { allTeams, dates, teamStartingEloTier, teamLeague, teamPoints } =
    shared;
  const { dailyElos, matchEvents } = replay;

  // Convert Elos → prices and compute daily returns per team
  const teamDailyPrices = new Map<string, number[]>();
  const teamDailyReturns = new Map<string, number[]>();

  for (const team of allTeams) {
    const elos = dailyElos.get(team)!;
    const prices: number[] = new Array(elos.length);
    const returns: number[] = new Array(elos.length - 1);

    for (let i = 0; i < elos.length; i++) {
      prices[i] = linearPrice(elos[i], slope, zeroPoint);
    }
    for (let i = 0; i < returns.length; i++) {
      returns[i] =
        prices[i] > 0 ? (prices[i + 1] - prices[i]) / prices[i] : 0;
    }

    teamDailyPrices.set(team, prices);
    teamDailyReturns.set(team, returns);
  }

  // ── Index 1: Surprise-Response R² (25%) ─────────────
  const surprises: number[] = [];
  const priceMoves: number[] = [];

  for (const event of matchEvents) {
    const prices = teamDailyPrices.get(event.team)!;
    const priceBefore = prices[event.dateIdx]; // prev day close
    const priceAfter = prices[event.dateIdx + 1]; // this day close
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

  // ── Index 2: Drift Neutrality (15%) ─────────────────
  let totalReturn = 0;
  let returnCount = 0;
  for (const returns of teamDailyReturns.values()) {
    for (const r of returns) {
      totalReturn += r;
      returnCount++;
    }
  }
  const meanDailyReturn = returnCount > 0 ? totalReturn / returnCount : 0;

  // ── Index 3: Floor Hit % (15%) ──────────────────────
  let floorCount = 0;
  let totalObs = 0;
  let teamsAtFloor = 0;
  for (const team of allTeams) {
    const prices = teamDailyPrices.get(team)!;
    let teamHitFloor = false;
    for (let i = 1; i < prices.length; i++) {
      totalObs++;
      if (prices[i] <= 10.001) {
        floorCount++;
        teamHitFloor = true;
      }
    }
    if (teamHitFloor) teamsAtFloor++;
  }
  const floorHitPct = totalObs > 0 ? (floorCount / totalObs) * 100 : 0;

  // ── Index 4: Return Kurtosis (10%) ──────────────────
  const allReturns: number[] = [];
  for (const returns of teamDailyReturns.values()) {
    for (const r of returns) allReturns.push(r);
  }
  let kurtosis = 3;
  if (allReturns.length >= 20) {
    const n = allReturns.length;
    const mean = allReturns.reduce((a, b) => a + b, 0) / n;
    let m2 = 0,
      m4 = 0;
    for (const r of allReturns) {
      const d = r - mean;
      m2 += d * d;
      m4 += d * d * d * d;
    }
    m2 /= n;
    m4 /= n;
    kurtosis = m2 > 0 ? m4 / (m2 * m2) : 3;
  }

  // ── Index 5: Vol Uniformity (10%) ───────────────────
  const tierVols: Record<string, number[]> = { top: [], mid: [], bot: [] };
  for (const team of allTeams) {
    const tier = teamStartingEloTier.get(team) ?? "mid";
    const returns = teamDailyReturns.get(team)!;
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
  // Strategy: long 3 days after loss, short 3 days after win
  const teamMatchDays = new Map<string, Map<number, number>>();
  for (const event of matchEvents) {
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

    for (let i = 0; i < returns.length; i++) {
      // Collect P&L for existing position
      if (position !== 0) {
        dailyPnl.push(position * returns[i]);
        holdDays--;
        if (holdDays <= 0) position = 0;
      }

      // Match day → set new position starting NEXT day
      const actual = matchDays.get(i);
      if (actual !== undefined) {
        if (actual === 0) {
          position = 1;
          holdDays = 3;
        } else if (actual === 1) {
          position = -1;
          holdDays = 3;
        }
        // draw: no new position
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
  // Spearman: final PRICE rank vs actual league points rank, per league
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
      const d = (priceRank.get(t) ?? 0) - (ptsRank.get(t) ?? 0);
      dSq += d * d;
    }
    const n = teams.length;
    const rho = 1 - (6 * dSq) / (n * (n * n - 1));
    correlations.push(rho);
  }

  const infoRatio =
    correlations.length > 0
      ? correlations.reduce((a, b) => a + b, 0) / correlations.length
      : 0;

  // ── Avg Annual Vol ──────────────────────────────────
  const vols: number[] = [];
  for (const team of allTeams) {
    const returns = teamDailyReturns.get(team)!;
    if (returns.length < 10) continue;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
    vols.push(Math.sqrt(variance) * Math.sqrt(365) * 100);
  }
  const avgAnnualVol =
    vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;

  // ── Scoring ─────────────────────────────────────────
  const s1 = Math.min(100, r2 * 150);
  const s2 = Math.max(0, 100 * (1 - Math.abs(meanDailyReturn) / 0.1));

  let s3: number;
  if (floorHitPct === 0) s3 = 100;
  else if (floorHitPct < 1) s3 = 80;
  else if (floorHitPct < 3) s3 = 60;
  else if (floorHitPct < 5) s3 = 40;
  else if (floorHitPct < 10) s3 = 20;
  else s3 = 0;

  let s4: number;
  if (kurtosis >= 4 && kurtosis <= 10) s4 = 100;
  else if (kurtosis >= 3 && kurtosis <= 15) s4 = 70;
  else if (kurtosis >= 2 && kurtosis <= 20) s4 = 40;
  else s4 = 10;

  let s5: number;
  if (volRatio < 1.5) s5 = 100;
  else if (volRatio < 2.0) s5 = 85;
  else if (volRatio < 2.5) s5 = 65;
  else if (volRatio < 3.0) s5 = 40;
  else s5 = 15;

  let s6: number;
  const absSharpe = Math.abs(mrSharpe);
  if (absSharpe < 0.3) s6 = 100;
  else if (absSharpe < 0.5) s6 = 70;
  else if (absSharpe < 0.8) s6 = 40;
  else s6 = 15;

  const s7 = Math.min(100, Math.max(0, infoRatio * 110));

  const composite = Math.round(
    s1 * 0.25 +
      s2 * 0.15 +
      s3 * 0.15 +
      s4 * 0.1 +
      s5 * 0.1 +
      s6 * 0.15 +
      s7 * 0.1
  );

  return {
    slope,
    k: 0, // set by caller
    decay: 0, // set by caller
    zeroPoint,
    composite,
    surpriseR2: r2,
    driftNeutrality: meanDailyReturn,
    floorHitPct,
    kurtosis,
    volUniformityRatio: volRatio,
    meanRevSharpe: mrSharpe,
    infoRatio,
    surpriseR2Score: Math.round(s1),
    driftScore: Math.round(s2),
    floorHitScore: Math.round(s3),
    kurtosisScore: Math.round(s4),
    volUniScore: Math.round(s5),
    meanRevScore: Math.round(s6),
    infoScore: Math.round(s7),
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

  log.info("═══ MeasureMe v2 Grid Search ═══");
  log.info(`Run ID: ${runId}`);
  log.info(
    `Grid: ${ELO_REPLAYS} Elo replays × ${PRICE_COMBOS} price combos = ${TOTAL} configs`
  );
  log.info("");

  // Phase 1: Load data
  log.info("Phase 1: Loading data...");
  const [matches, legacyElos] = await Promise.all([
    loadMatches(),
    loadLegacyElos(),
  ]);
  log.info(`  Matches: ${matches.length} completed`);

  const fixtureIds = [...new Set(matches.map((m) => m.fixture_id))];
  const oddsMap = await loadClosingOdds(fixtureIds);

  // Phase 2: Precompute
  log.info("Phase 2: Precomputing...");
  const shared = precompute(matches, oddsMap, legacyElos);
  log.info(`  Teams: ${shared.allTeams.length}`);
  log.info(
    `  Dates: ${shared.dates[0]} → ${shared.dates[shared.dates.length - 1]} (${shared.dates.length} days)`
  );
  log.info("");

  // Phase 3: Grid search
  log.info("Phase 3: Grid search...");
  const results: ConfigResult[] = [];
  let replayNum = 0;

  for (const K of KS) {
    for (const decay of DECAYS) {
      replayNum++;
      const rt0 = Date.now();

      // Run Elo replay once for this (K, decay) pair
      const replay = replayElos(shared, K, decay);
      const replayMs = Date.now() - rt0;

      // Convert to prices for each (slope, zeroPoint) pair
      for (const slope of SLOPES) {
        for (const zeroPoint of ZERO_POINTS) {
          const result = computeForPriceParams(
            replay,
            shared,
            slope,
            zeroPoint
          );
          result.k = K;
          result.decay = decay;
          results.push(result);
        }
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const bestSoFar = results.reduce((a, b) =>
        a.composite > b.composite ? a : b
      );
      log.info(
        `  [${replayNum}/${ELO_REPLAYS}] K=${K} decay=${decay} (${replayMs}ms) → best: ${bestSoFar.composite}  (${elapsed}s)`
      );
    }
  }

  // Sort by composite
  results.sort((a, b) => b.composite - a.composite);

  log.info("");
  log.info("TOP 10:");
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    log.info(
      `  #${i + 1}  slope=${r.slope} K=${r.k} decay=${r.decay} zp=${r.zeroPoint} → score ${r.composite}`
    );
  }
  log.info("");

  // Phase 4: Write to Supabase
  log.info("Phase 4: Writing results...");

  // Clear old data
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
    composite_score: r.composite,
    surprise_r2: round4(r.surpriseR2),
    drift_neutrality: round4(r.driftNeutrality),
    floor_hit_pct: round4(r.floorHitPct),
    kurtosis: round4(r.kurtosis),
    vol_uniformity_ratio: round4(r.volUniformityRatio),
    mean_rev_sharpe: round4(r.meanRevSharpe),
    info_ratio: round4(r.infoRatio),
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
