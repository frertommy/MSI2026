import { supabase } from "@/lib/supabase";
import { V3Client } from "./v3-client";

// ─── Types ─────────────────────────────────────────────────
export interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
}

export interface OddsConsensus {
  fixture_id: number;
  homeProb: number;
  drawProb: number;
  awayProb: number;
}

export interface PriceHistoryRow {
  team: string;
  league: string;
  date: string;
  dollar_price: number;
  implied_elo: number;
}

export interface V2Point {
  date: string;
  elo: number;
  price: number;
}

interface XgRow {
  fixture_id: number | null;
  date: string;
  home_team: string;
  away_team: string;
  home_xg: number;
  away_xg: number;
  home_goals: number;
  away_goals: number;
}

// ─── Legacy name map (copied from pricing-engine.ts) ───────
export const LEGACY_NAME_MAP: Record<string, string> = {
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

// ─── Paginated fetch helper ────────────────────────────────
async function fetchAll<T>(
  table: string,
  select: string,
  filters?: Record<string, string | number>,
  orderCol?: string
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (filters) {
      for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    }
    if (orderCol) q = q.order(orderCol, { ascending: true });
    const { data, error } = await q;
    if (error) {
      console.error(`${table} fetch error:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ─── Fetch legacy Elos from GitHub ─────────────────────────
async function fetchLegacyElos(): Promise<Record<string, number>> {
  try {
    const res = await fetch(LEGACY_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: Record<string, Array<{ date: string; rating: number }>> =
      await res.json();

    const result: Record<string, number> = {};
    for (const [legacyName, entries] of Object.entries(data)) {
      if (!entries || entries.length === 0) continue;
      const last = entries[entries.length - 1];
      const apiName = LEGACY_NAME_MAP[legacyName] ?? legacyName;
      result[apiName] = last.rating;
    }
    return result;
  } catch (err) {
    console.error("Legacy Elo fetch failed:", err);
    return {};
  }
}

// ─── Fetch closing odds by fixture batches (fast) ───────────
async function fetchClosingOddsConsensus(
  fixtureIds: number[]
): Promise<OddsConsensus[]> {
  interface OddsRow {
    fixture_id: number;
    home_odds: number | null;
    away_odds: number | null;
    draw_odds: number | null;
  }

  const grouped = new Map<number, { home: number[]; draw: number[]; away: number[] }>();

  // Batch by 100 fixture IDs at a time — much faster than scanning whole table
  const BATCH = 100;
  for (let i = 0; i < fixtureIds.length; i += BATCH) {
    const batch = fixtureIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from("odds_snapshots")
      .select("fixture_id, home_odds, away_odds, draw_odds")
      .in("fixture_id", batch)
      .eq("days_before_kickoff", 1);

    if (error) {
      console.error("odds batch error:", error.message);
      continue;
    }
    if (!data) continue;

    for (const row of data as OddsRow[]) {
      if (!row.home_odds || !row.away_odds || !row.draw_odds) continue;
      if (row.home_odds <= 0 || row.away_odds <= 0 || row.draw_odds <= 0) continue;
      if (!grouped.has(row.fixture_id)) {
        grouped.set(row.fixture_id, { home: [], draw: [], away: [] });
      }
      const entry = grouped.get(row.fixture_id)!;
      entry.home.push(1 / row.home_odds);
      entry.draw.push(1 / row.draw_odds);
      entry.away.push(1 / row.away_odds);
    }
  }

  const result: OddsConsensus[] = [];
  for (const [fid, { home, draw, away }] of grouped) {
    const rawHome = home.reduce((a, b) => a + b, 0) / home.length;
    const rawDraw = draw.reduce((a, b) => a + b, 0) / draw.length;
    const rawAway = away.reduce((a, b) => a + b, 0) / away.length;
    const total = rawHome + rawDraw + rawAway;
    result.push({
      fixture_id: fid,
      homeProb: rawHome / total,
      drawProb: rawDraw / total,
      awayProb: rawAway / total,
    });
  }

  return result;
}

// ─── Fetch xG data ─────────────────────────────────────────
async function fetchXgData(): Promise<{
  byFixtureId: Map<number, XgRow>;
  byKey: Map<string, XgRow>;
}> {
  const rows = await fetchAll<XgRow>(
    "match_xg",
    "fixture_id, date, home_team, away_team, home_xg, away_xg, home_goals, away_goals"
  );

  const byFixtureId = new Map<number, XgRow>();
  const byKey = new Map<string, XgRow>();

  for (const r of rows) {
    if (r.fixture_id) byFixtureId.set(r.fixture_id, r);
    byKey.set(`${r.date}|${r.home_team}|${r.away_team}`, r);
  }

  return { byFixtureId, byKey };
}

// ─── V2 Engine Helpers ─────────────────────────────────────
function parseScore(score: string): [number, number] | null {
  const parts = score.split("-");
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0].trim());
  const a = parseInt(parts[1].trim());
  if (isNaN(h) || isNaN(a)) return null;
  return [h, a];
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── V2 Price Engine ───────────────────────────────────────
const V2_K = 40;
const V2_DECAY_RATE = 0.0015;
const V2_MA_WINDOW = 45;
const V2_XG_FLOOR = 0.4;
const V2_XG_CEILING = 1.8;

function computeV2Prices(
  startingElosArr: { team: string; league: string; startingElo: number }[],
  matches: MatchRow[],
  oddsMap: Map<number, OddsConsensus>,
  xgByFixtureId: Map<number, XgRow>,
  xgByKey: Map<string, XgRow>
): Record<string, V2Point[]> {
  // State
  const teamElo = new Map<string, number>();
  const teamLeague = new Map<string, string>();
  const teamSeries = new Map<string, V2Point[]>();
  const teamEloHistory = new Map<string, number[]>(); // rolling buffer for MA
  const teamLastMatch = new Map<string, string>();

  for (const t of startingElosArr) {
    teamElo.set(t.team, t.startingElo);
    teamLeague.set(t.team, t.league);
    teamSeries.set(t.team, []);
    teamEloHistory.set(t.team, [t.startingElo]);
  }

  // Filter to played matches only, sorted by date
  const playedMatches = matches
    .filter((m) => parseScore(m.score) !== null)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (playedMatches.length === 0) {
    const result: Record<string, V2Point[]> = {};
    for (const [team, pts] of teamSeries) result[team] = pts;
    return result;
  }

  const startDate = playedMatches[0].date;
  const lastMatchDate = playedMatches[playedMatches.length - 1].date;

  // Group matches by date
  const matchesByDate = new Map<string, MatchRow[]>();
  for (const m of playedMatches) {
    if (!matchesByDate.has(m.date)) matchesByDate.set(m.date, []);
    matchesByDate.get(m.date)!.push(m);
  }

  // Day-by-day loop
  let currentDate = startDate;
  while (currentDate <= lastMatchDate) {
    const todaysMatches = matchesByDate.get(currentDate) ?? [];
    const playingToday = new Set<string>();
    for (const m of todaysMatches) {
      playingToday.add(m.home_team);
      playingToday.add(m.away_team);
    }

    // Compute league means for K-weighting
    const leagueMeans = new Map<string, number>();
    const leagueTeams = new Map<string, number[]>();
    for (const [team, elo] of teamElo) {
      const league = teamLeague.get(team) ?? "";
      if (!leagueTeams.has(league)) leagueTeams.set(league, []);
      leagueTeams.get(league)!.push(elo);
    }
    for (const [league, elos] of leagueTeams) {
      leagueMeans.set(league, elos.reduce((a, b) => a + b, 0) / elos.length);
    }

    // 1. Carry decay for non-playing teams
    for (const [team, elo] of teamElo) {
      if (playingToday.has(team)) continue;

      const lastMatch = teamLastMatch.get(team);
      if (!lastMatch) continue; // no decay before first match

      const daysSince = Math.round(
        (new Date(currentDate).getTime() - new Date(lastMatch).getTime()) /
          (1000 * 60 * 60 * 24)
      );
      if (daysSince <= 0) continue;

      // 45-day MA anchor
      const history = teamEloHistory.get(team) ?? [elo];
      const maSlice = history.slice(-V2_MA_WINDOW);
      const ma45 = maSlice.reduce((a, b) => a + b, 0) / maSlice.length;

      const decayFactor = Math.max(0.5, 1 - V2_DECAY_RATE * daysSince);
      const newElo = ma45 + (elo - ma45) * decayFactor;
      teamElo.set(team, newElo);
    }

    // 2. Match shocks
    for (const m of todaysMatches) {
      const sc = parseScore(m.score);
      if (!sc) continue;
      const [hg, ag] = sc;

      const homeElo = teamElo.get(m.home_team) ?? 1500;
      const awayElo = teamElo.get(m.away_team) ?? 1500;
      const leagueMean = leagueMeans.get(m.league) ?? 1500;

      // Consensus odds
      const odds = oddsMap.get(m.fixture_id);
      let homeProb = 0.45;
      let drawProb = 0.27;
      let awayProb = 0.28;
      if (odds) {
        homeProb = odds.homeProb;
        drawProb = odds.drawProb;
        awayProb = odds.awayProb;
      }

      // Actual points (3-1-0)
      const homeActual = hg > ag ? 3 : hg === ag ? 1 : 0;
      const awayActual = ag > hg ? 3 : hg === ag ? 1 : 0;

      // Expected points
      const homeExpected = 3 * homeProb + 1 * drawProb;
      const awayExpected = 3 * awayProb + 1 * drawProb;

      // Opponent-strength-weighted K
      const homeEffK = V2_K * (1 + (awayElo - leagueMean) / 400);
      const awayEffK = V2_K * (1 + (homeElo - leagueMean) / 400);

      // Raw shocks
      let homeShock = homeEffK * (homeActual - homeExpected);
      let awayShock = awayEffK * (awayActual - awayExpected);

      // xG multiplier
      const xg =
        xgByFixtureId.get(m.fixture_id) ??
        xgByKey.get(`${m.date}|${m.home_team}|${m.away_team}`);

      if (xg) {
        const homeGoalDiff = hg - ag;
        const awayGoalDiff = ag - hg;

        // Home xG multiplier
        const homeXgDiff = xg.home_xg - xg.away_xg;
        const homeSign = homeGoalDiff > 0 ? 1 : homeGoalDiff < 0 ? -1 : 0;
        const homeMultRaw = 1.0 + 0.3 * homeXgDiff * homeSign;
        const homeMult = Math.max(V2_XG_FLOOR, Math.min(V2_XG_CEILING, homeMultRaw));

        // Away xG multiplier
        const awayXgDiff = xg.away_xg - xg.home_xg;
        const awaySign = awayGoalDiff > 0 ? 1 : awayGoalDiff < 0 ? -1 : 0;
        const awayMultRaw = 1.0 + 0.3 * awayXgDiff * awaySign;
        const awayMult = Math.max(V2_XG_FLOOR, Math.min(V2_XG_CEILING, awayMultRaw));

        homeShock *= homeMult;
        awayShock *= awayMult;
      }

      // Apply shocks directly
      teamElo.set(m.home_team, homeElo + homeShock);
      teamElo.set(m.away_team, awayElo + awayShock);

      // Update last match date
      teamLastMatch.set(m.home_team, currentDate);
      teamLastMatch.set(m.away_team, currentDate);
    }

    // 3. Re-center all Elos to mean 1500
    const allElos = [...teamElo.values()];
    const globalMean = allElos.reduce((a, b) => a + b, 0) / allElos.length;
    const shift = 1500 - globalMean;
    for (const [team, elo] of teamElo) {
      teamElo.set(team, elo + shift);
    }

    // 4. Record data points and update history
    for (const [team, elo] of teamElo) {
      const price = Math.max(10, (elo - 1000) / 5);
      teamSeries.get(team)?.push({ date: currentDate, elo, price });

      const history = teamEloHistory.get(team)!;
      history.push(elo);
      // Keep only last MA_WINDOW + some buffer
      if (history.length > V2_MA_WINDOW + 30) {
        history.splice(0, history.length - V2_MA_WINDOW - 10);
      }
    }

    currentDate = addDays(currentDate, 1);
  }

  // Convert to plain object
  const result: Record<string, V2Point[]> = {};
  for (const [team, pts] of teamSeries) result[team] = pts;
  return result;
}

// ─── Server component ──────────────────────────────────────
export const dynamic = "force-dynamic"; // skip build-time generation (heavy V2 computation + large odds queries)

export default async function V3Page() {
  // Phase 1: fetch matches + independent data in parallel
  const [legacyElos, matches, priceHistory, xgData] =
    await Promise.all([
      fetchLegacyElos(),
      fetchAll<MatchRow>(
        "matches",
        "fixture_id, date, league, home_team, away_team, score, status",
        undefined,
        "date"
      ),
      fetchAll<PriceHistoryRow>(
        "team_prices",
        "team, league, date, dollar_price, implied_elo",
        { model: "oracle" },
        "date"
      ),
      fetchXgData(),
    ]);

  // Phase 2: fetch odds by fixture IDs (needs matches first)
  const fixtureIds = matches.map((m) => m.fixture_id);
  const oddsConsensus = await fetchClosingOddsConsensus(fixtureIds);

  // Determine all teams from matches
  const teamLeagues = new Map<string, string>();
  for (const m of matches) {
    if (!teamLeagues.has(m.home_team)) teamLeagues.set(m.home_team, m.league);
    if (!teamLeagues.has(m.away_team)) teamLeagues.set(m.away_team, m.league);
  }

  // Build starting elos: legacy if available, else 1500
  const startingElosArr = [...teamLeagues.entries()].map(([team, league]) => ({
    team,
    league,
    startingElo: legacyElos[team] ?? 1500,
  }));

  // Build odds map
  const oddsMap = new Map<number, OddsConsensus>();
  for (const o of oddsConsensus) oddsMap.set(o.fixture_id, o);

  // Compute V2 prices server-side
  const v2Series = computeV2Prices(
    startingElosArr,
    matches,
    oddsMap,
    xgData.byFixtureId,
    xgData.byKey
  );

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto max-w-7xl flex items-center gap-4">
          <a
            href="/"
            className="text-muted hover:text-foreground transition-colors text-sm"
          >
            &larr; Rankings
          </a>
          <div className="h-2 w-2 rounded-full bg-accent-green animate-pulse" />
          <h1 className="text-lg font-bold tracking-wider text-foreground uppercase">
            Price Comparison
          </h1>
          <div className="flex items-center gap-4 ml-auto">
            <a
              href="/matches"
              className="text-xs text-accent-green hover:text-foreground transition-colors font-mono uppercase tracking-wider"
            >
              Matches &rarr;
            </a>
            <a
              href="/analytics"
              className="text-xs text-accent-green hover:text-foreground transition-colors font-mono uppercase tracking-wider"
            >
              Analytics &rarr;
            </a>
            <a
              href="/v2"
              className="text-xs text-accent-green hover:text-foreground transition-colors font-mono uppercase tracking-wider"
            >
              V2 Pricing &rarr;
            </a>
            <a
              href="/measureme"
              className="text-xs text-accent-green hover:text-foreground transition-colors font-mono uppercase tracking-wider"
            >
              MeasureMe &rarr;
            </a>
            <span className="text-xs text-muted font-mono">
              {startingElosArr.length} teams &middot; {matches.length} matches
              &middot; {oddsConsensus.length} odds
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <V3Client
          startingElos={startingElosArr}
          priceHistory={priceHistory}
          v2Series={v2Series}
        />
      </main>
    </div>
  );
}
