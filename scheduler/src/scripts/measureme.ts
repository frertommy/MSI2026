/**
 * MeasureMe — Parameter Grid Search
 *
 * Runs 624 (slope × K × decay) configs against real match + odds data.
 * Scores each with 7 objective indices. Writes to measureme_results table.
 *
 * Usage:  cd scheduler && npm run measureme
 */
import "dotenv/config";
import { getSupabase, fetchAllRows, upsertBatched } from "../api/supabase-client.js";
import { log } from "../logger.js";
import { loadXgData, type XgEntry } from "../services/understat-poller.js";
import { INITIAL_ELO, XG_FLOOR, XG_CEILING } from "../config.js";

// ─── Legacy Elo name map (from pricing-engine.ts) ───────────
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
const TOTAL = SLOPES.length * KS.length * DECAYS.length;
const MA_WINDOW = 45;

// ─── Types ───────────────────────────────────────────────────
interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
}

interface OddsRow {
  fixture_id: number;
  home_odds: number | null;
  away_odds: number | null;
  draw_odds: number | null;
}

interface NormOdds {
  homeProb: number;
  drawProb: number;
  awayProb: number;
}

interface MatchInfo {
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  homeProb: number;
  drawProb: number;
  awayProb: number;
  homeXgMult: number;
  awayXgMult: number;
}

interface DailyRecord {
  price: number;
  isMatchDay: boolean;
  priceChange: number; // absolute pct change
  surprise: number; // |actual - expected| (only on match days)
}

interface ConfigResult {
  slope: number;
  k: number;
  decay: number;
  surpriseR2: number;
  driftNeutrality: number;
  matchVarShare: number;
  kurtosis: number;
  volUniformityRatio: number;
  meanRevSharpe: number;
  infoRatio: number;
  surpriseR2Score: number;
  driftScore: number;
  matchShareScore: number;
  kurtosisScore: number;
  volUniScore: number;
  meanRevScore: number;
  infoScore: number;
  composite: number;
  avgMatchMovePct: number;
  avgAnnualVol: number;
  totalMatches: number;
  totalTeams: number;
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

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─── Data Loading ────────────────────────────────────────────
async function loadMatches(): Promise<MatchRow[]> {
  const rows = await fetchAllRows<MatchRow>(
    "matches",
    "fixture_id, date, league, home_team, away_team, score",
    undefined,
    { column: "date", ascending: true }
  );
  return rows.filter((r) => parseScore(r.score) !== null);
}

async function loadLegacyElos(): Promise<Map<string, number>> {
  try {
    const resp = await fetch(LEGACY_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as Record<
      string,
      { date: string; rating: number }[]
    >;
    const map = new Map<string, number>();
    for (const [legacyName, entries] of Object.entries(data)) {
      if (!entries || entries.length === 0) continue;
      const lastRating = entries[entries.length - 1].rating;
      const apiName = LEGACY_NAME_MAP[legacyName] ?? legacyName;
      map.set(apiName, lastRating);
    }
    log.info(`  Legacy Elos: ${map.size} teams`);
    return map;
  } catch (err) {
    log.warn(
      "Legacy Elo fetch failed",
      err instanceof Error ? err.message : err
    );
    return new Map();
  }
}

async function loadClosingOdds(
  fixtureIds: number[]
): Promise<Map<number, NormOdds>> {
  const sb = getSupabase();
  const accum = new Map<
    number,
    { home: number[]; draw: number[]; away: number[] }
  >();

  const BATCH = 100;
  for (let i = 0; i < fixtureIds.length; i += BATCH) {
    const batch = fixtureIds.slice(i, i + BATCH);
    const { data, error } = await sb
      .from("odds_snapshots")
      .select("fixture_id, home_odds, away_odds, draw_odds")
      .in("fixture_id", batch)
      .eq("days_before_kickoff", 1);

    if (error || !data) continue;

    for (const row of data as OddsRow[]) {
      if (!row.home_odds || !row.away_odds || !row.draw_odds) continue;
      if (row.home_odds <= 0 || row.away_odds <= 0 || row.draw_odds <= 0)
        continue;
      if (!accum.has(row.fixture_id))
        accum.set(row.fixture_id, { home: [], draw: [], away: [] });
      const e = accum.get(row.fixture_id)!;
      e.home.push(1 / row.home_odds);
      e.draw.push(1 / row.draw_odds);
      e.away.push(1 / row.away_odds);
    }
  }

  const result = new Map<number, NormOdds>();
  for (const [fid, { home, draw, away }] of accum) {
    const rh = median(home);
    const rd = median(draw);
    const ra = median(away);
    const total = rh + rd + ra;
    if (total <= 0) continue;
    result.set(fid, {
      homeProb: rh / total,
      drawProb: rd / total,
      awayProb: ra / total,
    });
  }

  log.info(`  Closing odds: ${result.size} fixtures with day-1 odds`);
  return result;
}

// ─── Precompute shared data ──────────────────────────────────
interface SharedData {
  allTeams: string[];
  teamLeague: Map<string, string>;
  startingElos: Map<string, number>;
  matchesByDate: Map<string, MatchInfo[]>;
  dates: string[];
  teamStartingEloTier: Map<string, "top" | "mid" | "bot">; // for vol uniformity
  teamPoints: Map<string, number>; // for info ratio
}

function precompute(
  matches: MatchRow[],
  oddsMap: Map<number, NormOdds>,
  legacyElos: Map<string, number>,
  xgByFixtureId: Map<number, XgEntry>,
  xgByKey: Map<string, XgEntry>
): SharedData {
  // Discover teams and leagues
  const teamLeague = new Map<string, string>();
  for (const m of matches) {
    if (!teamLeague.has(m.home_team)) teamLeague.set(m.home_team, m.league);
    if (!teamLeague.has(m.away_team)) teamLeague.set(m.away_team, m.league);
  }
  const allTeams = [...teamLeague.keys()].sort();

  // Starting Elos
  const startingElos = new Map<string, number>();
  for (const t of allTeams) {
    startingElos.set(t, legacyElos.get(t) ?? INITIAL_ELO);
  }

  // Pre-group matches by date with all resolved data
  const matchesByDate = new Map<string, MatchInfo[]>();
  const teamPoints = new Map<string, number>();
  for (const t of allTeams) teamPoints.set(t, 0);

  for (const m of matches) {
    const sc = parseScore(m.score)!;
    const [hg, ag] = sc;
    const odds = oddsMap.get(m.fixture_id) ?? {
      homeProb: 0.45,
      drawProb: 0.27,
      awayProb: 0.28,
    };

    // xG multipliers
    let homeXgMult = 1.0;
    let awayXgMult = 1.0;
    const xg =
      xgByFixtureId.get(m.fixture_id) ??
      xgByKey.get(`${m.date}|${m.home_team}|${m.away_team}`);
    if (xg) {
      const goalDiff = hg - ag;
      const homeSign = goalDiff > 0 ? 1 : goalDiff < 0 ? -1 : 0;
      const homeXgDiff = xg.home_xg - xg.away_xg;
      homeXgMult = Math.max(
        XG_FLOOR,
        Math.min(XG_CEILING, 1.0 + 0.3 * homeXgDiff * homeSign)
      );
      const awaySign = -homeSign;
      const awayXgDiff = -homeXgDiff;
      awayXgMult = Math.max(
        XG_FLOOR,
        Math.min(XG_CEILING, 1.0 + 0.3 * awayXgDiff * awaySign)
      );
    }

    if (!matchesByDate.has(m.date)) matchesByDate.set(m.date, []);
    matchesByDate.get(m.date)!.push({
      fixtureId: m.fixture_id,
      homeTeam: m.home_team,
      awayTeam: m.away_team,
      homeGoals: hg,
      awayGoals: ag,
      homeProb: odds.homeProb,
      drawProb: odds.drawProb,
      awayProb: odds.awayProb,
      homeXgMult,
      awayXgMult,
    });

    // Track league points for info ratio
    const hp = hg > ag ? 3 : hg === ag ? 1 : 0;
    const ap = ag > hg ? 3 : hg === ag ? 1 : 0;
    teamPoints.set(m.home_team, (teamPoints.get(m.home_team) ?? 0) + hp);
    teamPoints.set(m.away_team, (teamPoints.get(m.away_team) ?? 0) + ap);
  }

  // Build date list
  const sortedDates = [...matchesByDate.keys()].sort();
  const startDate = sortedDates[0];
  const endDate = sortedDates[sortedDates.length - 1];
  const dates: string[] = [];
  let d = startDate;
  while (d <= endDate) {
    dates.push(d);
    d = addDays(d, 1);
  }

  // Tier teams by starting Elo for vol uniformity
  const sortedByElo = allTeams
    .map((t) => ({ team: t, elo: startingElos.get(t) ?? INITIAL_ELO }))
    .sort((a, b) => b.elo - a.elo);
  const topCut = Math.floor(sortedByElo.length * 0.25);
  const botCut = Math.floor(sortedByElo.length * 0.75);
  const teamStartingEloTier = new Map<string, "top" | "mid" | "bot">();
  for (let i = 0; i < sortedByElo.length; i++) {
    if (i < topCut) teamStartingEloTier.set(sortedByElo[i].team, "top");
    else if (i >= botCut)
      teamStartingEloTier.set(sortedByElo[i].team, "bot");
    else teamStartingEloTier.set(sortedByElo[i].team, "mid");
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

// ─── Simulation engine (per config) ─────────────────────────
function simulateConfig(
  slope: number,
  K: number,
  decayRate: number,
  shared: SharedData
): {
  teamDailySeries: Map<string, DailyRecord[]>;
  finalElos: Map<string, number>;
} {
  const { allTeams, matchesByDate, dates, startingElos } = shared;

  // Clone starting Elos
  const elo = new Map<string, number>();
  const eloHistory = new Map<string, number[]>();
  const lastMatchDate = new Map<string, string>();
  for (const t of allTeams) {
    const e = startingElos.get(t)!;
    elo.set(t, e);
    eloHistory.set(t, [e]);
  }

  const teamDailySeries = new Map<string, DailyRecord[]>();
  for (const t of allTeams) teamDailySeries.set(t, []);

  for (const date of dates) {
    const todaysMatches = matchesByDate.get(date) ?? [];
    const playingToday = new Set<string>();
    for (const m of todaysMatches) {
      playingToday.add(m.homeTeam);
      playingToday.add(m.awayTeam);
    }

    // 1. Carry decay for non-playing teams
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
      const factor = Math.max(0.5, 1 - decayRate * daysSince);
      elo.set(t, ma + (elo.get(t)! - ma) * factor);
    }

    // 2. Match shocks
    // Track pre-match Elos for price change measurement
    const preMatchElo = new Map<string, number>();
    for (const m of todaysMatches) {
      if (!preMatchElo.has(m.homeTeam))
        preMatchElo.set(m.homeTeam, elo.get(m.homeTeam)!);
      if (!preMatchElo.has(m.awayTeam))
        preMatchElo.set(m.awayTeam, elo.get(m.awayTeam)!);
    }

    for (const m of todaysMatches) {
      const homeActual = m.homeGoals > m.awayGoals ? 1 : m.homeGoals === m.awayGoals ? 0.5 : 0;
      const awayActual = 1 - homeActual;
      const homeExpected = m.homeProb * 1 + m.drawProb * 0.5;
      const awayExpected = m.awayProb * 1 + m.drawProb * 0.5;

      let homeShock = K * (homeActual - homeExpected);
      let awayShock = K * (awayActual - awayExpected);

      // xG multipliers
      homeShock *= m.homeXgMult;
      awayShock *= m.awayXgMult;

      elo.set(m.homeTeam, elo.get(m.homeTeam)! + homeShock);
      elo.set(m.awayTeam, elo.get(m.awayTeam)! + awayShock);

      lastMatchDate.set(m.homeTeam, date);
      lastMatchDate.set(m.awayTeam, date);
    }

    // 3. Re-center to mean 1500
    let sum = 0;
    for (const t of allTeams) sum += elo.get(t)!;
    const shift = 1500 - sum / allTeams.length;
    for (const t of allTeams) elo.set(t, elo.get(t)! + shift);

    // 4. Record daily data
    for (const t of allTeams) {
      const e = elo.get(t)!;
      const price = Math.max(10, (e - 1000) / slope);
      const series = teamDailySeries.get(t)!;
      const prevPrice = series.length > 0 ? series[series.length - 1].price : price;
      const priceChange =
        prevPrice > 0 ? Math.abs(price - prevPrice) / prevPrice : 0;

      // Surprise for this team (on match day)
      let surprise = 0;
      const isMatch = playingToday.has(t);
      if (isMatch) {
        for (const m of todaysMatches) {
          if (m.homeTeam === t) {
            const homeActual = m.homeGoals > m.awayGoals ? 1 : m.homeGoals === m.awayGoals ? 0.5 : 0;
            const homeExpected = m.homeProb * 1 + m.drawProb * 0.5;
            surprise = Math.abs(homeActual - homeExpected);
          } else if (m.awayTeam === t) {
            const awayActual = m.awayGoals > m.homeGoals ? 1 : m.homeGoals === m.awayGoals ? 0.5 : 0;
            const awayExpected = m.awayProb * 1 + m.drawProb * 0.5;
            surprise = Math.abs(awayActual - awayExpected);
          }
        }
      }

      series.push({ price, isMatchDay: isMatch, priceChange, surprise });

      // Update elo history
      const hist = eloHistory.get(t)!;
      hist.push(e);
      if (hist.length > MA_WINDOW + 30) {
        hist.splice(0, hist.length - MA_WINDOW - 10);
      }
    }
  }

  return { teamDailySeries, finalElos: elo };
}

// ─── Index computations ──────────────────────────────────────

function computeSurpriseR2(
  teamSeries: Map<string, DailyRecord[]>
): { r2: number; avgMatchMove: number } {
  const surprises: number[] = [];
  const moves: number[] = [];

  for (const series of teamSeries.values()) {
    for (const d of series) {
      if (d.isMatchDay && d.surprise > 0) {
        surprises.push(d.surprise);
        moves.push(d.priceChange);
      }
    }
  }

  if (surprises.length < 10) return { r2: 0, avgMatchMove: 0 };

  const n = surprises.length;
  const meanX = surprises.reduce((a, b) => a + b, 0) / n;
  const meanY = moves.reduce((a, b) => a + b, 0) / n;
  let ssXY = 0,
    ssXX = 0,
    ssYY = 0;
  for (let i = 0; i < n; i++) {
    const dx = surprises[i] - meanX;
    const dy = moves[i] - meanY;
    ssXY += dx * dy;
    ssXX += dx * dx;
    ssYY += dy * dy;
  }
  const r2 = ssXX > 0 && ssYY > 0 ? (ssXY * ssXY) / (ssXX * ssYY) : 0;
  const avgMatchMove = meanY * 100; // as percentage

  return { r2, avgMatchMove };
}

function computeDriftNeutrality(
  teamSeries: Map<string, DailyRecord[]>
): number {
  let totalReturn = 0;
  let count = 0;
  for (const series of teamSeries.values()) {
    for (let i = 1; i < series.length; i++) {
      if (series[i - 1].price > 0) {
        totalReturn +=
          (series[i].price - series[i - 1].price) / series[i - 1].price;
        count++;
      }
    }
  }
  return count > 0 ? totalReturn / count : 0;
}

function computeMatchVarShare(
  teamSeries: Map<string, DailyRecord[]>
): number {
  let matchSqSum = 0;
  let allSqSum = 0;
  for (const series of teamSeries.values()) {
    for (let i = 1; i < series.length; i++) {
      if (series[i - 1].price <= 0) continue;
      const ret =
        (series[i].price - series[i - 1].price) / series[i - 1].price;
      const sq = ret * ret;
      allSqSum += sq;
      if (series[i].isMatchDay) matchSqSum += sq;
    }
  }
  return allSqSum > 0 ? matchSqSum / allSqSum : 0;
}

function computeKurtosis(teamSeries: Map<string, DailyRecord[]>): number {
  const returns: number[] = [];
  for (const series of teamSeries.values()) {
    for (let i = 1; i < series.length; i++) {
      if (series[i - 1].price > 0) {
        returns.push(
          (series[i].price - series[i - 1].price) / series[i - 1].price
        );
      }
    }
  }
  if (returns.length < 20) return 3;
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  let m2 = 0,
    m4 = 0;
  for (const r of returns) {
    const d = r - mean;
    m2 += d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m4 /= n;
  return m2 > 0 ? m4 / (m2 * m2) : 3;
}

function computeVolUniformity(
  teamSeries: Map<string, DailyRecord[]>,
  tiers: Map<string, "top" | "mid" | "bot">
): number {
  const tierVols: Record<string, number[]> = { top: [], mid: [], bot: [] };

  for (const [team, series] of teamSeries) {
    const tier = tiers.get(team) ?? "mid";
    const returns: number[] = [];
    for (let i = 1; i < series.length; i++) {
      if (series[i - 1].price > 0) {
        returns.push(
          (series[i].price - series[i - 1].price) / series[i - 1].price
        );
      }
    }
    if (returns.length < 10) continue;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
    const annVol = Math.sqrt(variance) * Math.sqrt(365) * 100;
    tierVols[tier].push(annVol);
  }

  const tierAvg: number[] = [];
  for (const tier of ["top", "mid", "bot"] as const) {
    if (tierVols[tier].length === 0) continue;
    tierAvg.push(
      tierVols[tier].reduce((a, b) => a + b, 0) / tierVols[tier].length
    );
  }

  if (tierAvg.length < 2) return 1;
  return Math.max(...tierAvg) / Math.min(...tierAvg.filter((v) => v > 0));
}

function computeMeanRevSharpe(
  teamSeries: Map<string, DailyRecord[]>
): number {
  // Strategy: after a loss (match day where price dropped), go long for 3 days
  //           after a win (match day where price rose), go short for 3 days
  const dailyPnl: number[] = [];

  for (const series of teamSeries.values()) {
    let position = 0; // +1 long, -1 short, 0 flat
    let holdDays = 0;

    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1];
      const curr = series[i];
      if (prev.price <= 0) continue;

      const ret = (curr.price - prev.price) / prev.price;

      // If we have a position, record PnL
      if (position !== 0) {
        dailyPnl.push(position * ret);
        holdDays--;
        if (holdDays <= 0) position = 0;
      }

      // Check if today is match day → set new position
      if (curr.isMatchDay && curr.priceChange > 0.001) {
        // price went down → loss → go long
        if (curr.price < prev.price) {
          position = 1;
          holdDays = 3;
        } else {
          position = -1;
          holdDays = 3;
        }
      }
    }
  }

  if (dailyPnl.length < 30) return 0;
  const mean = dailyPnl.reduce((a, b) => a + b, 0) / dailyPnl.length;
  const std = Math.sqrt(
    dailyPnl.reduce((a, r) => a + (r - mean) ** 2, 0) / dailyPnl.length
  );
  return std > 0 ? (mean / std) * Math.sqrt(365) : 0;
}

function computeInfoRatio(
  finalElos: Map<string, number>,
  teamPoints: Map<string, number>,
  teamLeague: Map<string, string>
): number {
  // Spearman rank correlation: final price rank vs actual points rank
  // Compute per league, then average
  const leagues = new Set(teamLeague.values());
  const correlations: number[] = [];

  for (const league of leagues) {
    const teams = [...teamLeague.entries()]
      .filter(([, l]) => l === league)
      .map(([t]) => t);
    if (teams.length < 5) continue;

    // Rank by final Elo (descending)
    const byElo = [...teams].sort(
      (a, b) => (finalElos.get(b) ?? 0) - (finalElos.get(a) ?? 0)
    );
    const eloRank = new Map<string, number>();
    byElo.forEach((t, i) => eloRank.set(t, i + 1));

    // Rank by points (descending)
    const byPoints = [...teams].sort(
      (a, b) => (teamPoints.get(b) ?? 0) - (teamPoints.get(a) ?? 0)
    );
    const ptsRank = new Map<string, number>();
    byPoints.forEach((t, i) => ptsRank.set(t, i + 1));

    // Spearman correlation
    let dSq = 0;
    for (const t of teams) {
      const d = (eloRank.get(t) ?? 0) - (ptsRank.get(t) ?? 0);
      dSq += d * d;
    }
    const n = teams.length;
    const rho = 1 - (6 * dSq) / (n * (n * n - 1));
    correlations.push(rho);
  }

  return correlations.length > 0
    ? correlations.reduce((a, b) => a + b, 0) / correlations.length
    : 0;
}

// ─── Scoring functions (user's exact formulas) ──────────────
function scoreR2(r2: number): number {
  return Math.min(100, Math.round(r2 * 150));
}

function scoreDrift(meanDailyReturn: number): number {
  return Math.max(0, Math.round(100 * (1 - Math.abs(meanDailyReturn) / 0.1)));
}

function scoreMatchShare(share: number): number {
  const pct = share * 100;
  if (pct >= 50 && pct <= 80) return 100;
  if (pct >= 35 && pct <= 90) return 70;
  if (pct >= 20 && pct <= 95) return 40;
  return 10;
}

function scoreKurtosis(k: number): number {
  if (k >= 4 && k <= 10) return 100;
  if (k >= 3 && k <= 15) return 70;
  if (k >= 2 && k <= 20) return 40;
  return 10;
}

function scoreVolUni(ratio: number): number {
  if (ratio < 1.5) return 100;
  if (ratio < 2.0) return 85;
  if (ratio < 2.5) return 65;
  if (ratio < 3.0) return 40;
  return 15;
}

function scoreMeanRev(sharpe: number): number {
  const abs = Math.abs(sharpe);
  if (abs < 0.3) return 100;
  if (abs < 0.5) return 70;
  if (abs < 0.8) return 40;
  return 15;
}

function scoreInfo(corr: number): number {
  return Math.min(100, Math.max(0, Math.round(corr * 110)));
}

function computeAvgAnnualVol(
  teamSeries: Map<string, DailyRecord[]>
): number {
  const vols: number[] = [];
  for (const series of teamSeries.values()) {
    const returns: number[] = [];
    for (let i = 1; i < series.length; i++) {
      if (series[i - 1].price > 0) {
        returns.push(
          (series[i].price - series[i - 1].price) / series[i - 1].price
        );
      }
    }
    if (returns.length < 10) continue;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
    vols.push(Math.sqrt(variance) * Math.sqrt(365) * 100);
  }
  return vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const runId = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  log.info("═══ MeasureMe Grid Search ═══");
  log.info(`Run ID: ${runId}`);
  log.info(`Grid: ${SLOPES.length} slopes × ${KS.length} Ks × ${DECAYS.length} decays = ${TOTAL} configs`);
  log.info("");

  // Phase 1: Load data
  log.info("Phase 1: Loading data...");
  const [matches, legacyElos, xgData] = await Promise.all([
    loadMatches(),
    loadLegacyElos(),
    loadXgData(),
  ]);
  log.info(`  Matches: ${matches.length} played`);

  const fixtureIds = matches.map((m) => m.fixture_id);
  const oddsMap = await loadClosingOdds(fixtureIds);

  // Phase 2: Precompute
  log.info("Phase 2: Precomputing shared data...");
  const shared = precompute(
    matches,
    oddsMap,
    legacyElos,
    xgData.byFixtureId,
    xgData.byKey
  );
  log.info(`  Teams: ${shared.allTeams.length}`);
  log.info(`  Date range: ${shared.dates[0]} → ${shared.dates[shared.dates.length - 1]} (${shared.dates.length} days)`);
  log.info("");

  // Phase 3: Grid search
  log.info(`Phase 3: Running ${TOTAL} simulations...`);
  const results: ConfigResult[] = [];
  let done = 0;

  for (const slope of SLOPES) {
    for (const k of KS) {
      for (const decay of DECAYS) {
        const { teamDailySeries, finalElos } = simulateConfig(
          slope,
          k,
          decay,
          shared
        );

        // Compute indices
        const { r2, avgMatchMove } = computeSurpriseR2(teamDailySeries);
        const drift = computeDriftNeutrality(teamDailySeries);
        const matchShare = computeMatchVarShare(teamDailySeries);
        const kurt = computeKurtosis(teamDailySeries);
        const volRatio = computeVolUniformity(
          teamDailySeries,
          shared.teamStartingEloTier
        );
        const mrSharpe = computeMeanRevSharpe(teamDailySeries);
        const info = computeInfoRatio(
          finalElos,
          shared.teamPoints,
          shared.teamLeague
        );
        const avgVol = computeAvgAnnualVol(teamDailySeries);

        // Score each index
        const s1 = scoreR2(r2);
        const s2 = scoreDrift(drift);
        const s3 = scoreMatchShare(matchShare);
        const s4 = scoreKurtosis(kurt);
        const s5 = scoreVolUni(volRatio);
        const s6 = scoreMeanRev(mrSharpe);
        const s7 = scoreInfo(info);

        // Composite
        const composite = Math.round(
          s1 * 0.25 +
            s2 * 0.15 +
            s3 * 0.15 +
            s4 * 0.1 +
            s5 * 0.1 +
            s6 * 0.15 +
            s7 * 0.1
        );

        results.push({
          slope,
          k,
          decay,
          surpriseR2: r2,
          driftNeutrality: drift,
          matchVarShare: matchShare,
          kurtosis: kurt,
          volUniformityRatio: volRatio,
          meanRevSharpe: mrSharpe,
          infoRatio: info,
          surpriseR2Score: s1,
          driftScore: s2,
          matchShareScore: s3,
          kurtosisScore: s4,
          volUniScore: s5,
          meanRevScore: s6,
          infoScore: s7,
          composite,
          avgMatchMovePct: avgMatchMove,
          avgAnnualVol: avgVol,
          totalMatches: matches.length,
          totalTeams: shared.allTeams.length,
        });

        done++;
        if (done % 50 === 0 || done === TOTAL) {
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          log.info(
            `  [${done}/${TOTAL}] slope=${slope} K=${k} decay=${decay} → composite=${composite}  (${elapsed}s)`
          );
        }
      }
    }
  }

  // Sort by composite
  results.sort((a, b) => b.composite - a.composite);
  const best = results[0];

  log.info("");
  log.info(
    `BEST: slope=${best.slope} K=${best.k} decay=${best.decay} → composite=${best.composite}`
  );
  log.info(
    `  R²=${round4(best.surpriseR2)}  drift=${best.driftScore}  match%=${round4(best.matchVarShare * 100)}  kurt=${round4(best.kurtosis)}  vol=${round4(best.volUniformityRatio)}×  MR=${round4(best.meanRevSharpe)}  info=${round4(best.infoRatio)}`
  );
  log.info("");

  // Phase 4: Write to Supabase
  log.info("Phase 4: Writing results...");
  const rows = results.map((r) => ({
    run_id: runId,
    slope: r.slope,
    k_factor: r.k,
    decay: r.decay,
    composite_score: r.composite,
    surprise_r2: round4(r.surpriseR2),
    drift_neutrality: round4(r.driftNeutrality),
    match_variance_share: round4(r.matchVarShare),
    kurtosis: round4(r.kurtosis),
    vol_uniformity_ratio: round4(r.volUniformityRatio),
    mean_rev_sharpe: round4(r.meanRevSharpe),
    info_ratio: round4(r.infoRatio),
    surprise_r2_score: r.surpriseR2Score,
    drift_score: r.driftScore,
    match_share_score: r.matchShareScore,
    kurtosis_score: r.kurtosisScore,
    vol_uni_score: r.volUniScore,
    mean_rev_score: r.meanRevScore,
    info_score: r.infoScore,
    avg_match_move_pct: round4(r.avgMatchMovePct),
    avg_annual_vol: round4(r.avgAnnualVol),
    total_matches_evaluated: r.totalMatches,
    total_teams: r.totalTeams,
  }));

  const { inserted, failed } = await upsertBatched(
    "measureme_results",
    rows,
    "id"
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log.info(`Written ${inserted} rows to measureme_results (${failed} failed)`);
  log.info(`Run ID: ${runId}`);
  log.info(`Total time: ${elapsed}s`);
}

main().catch((err) => {
  log.error("MeasureMe FATAL", err instanceof Error ? err.message : err);
  process.exit(1);
});
