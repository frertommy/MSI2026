import { supabase } from "@/lib/supabase";
import { MatchesListClient } from "./matches-list-client";

// ─── Types ───────────────────────────────────────────────────
interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
}

interface OracleStateRow {
  team_id: string;
  published_index: number;
  b_value: number;
  m1_value: number;
}

interface OddsRow {
  fixture_id: number;
  home_odds: number | null;
  away_odds: number | null;
  draw_odds: number | null;
}

interface PolymarketRow {
  fixture_id: number | null;
  outcomes: string[];
  outcome_prices: number[];
  volume: string;
}

/** Oracle V1.4: price = (published_index - 800) / 5 */
function indexToPrice(index: number): number {
  return Math.round(((index - 800) / 5) * 100) / 100;
}

export interface BookmakerOdds {
  home: number;
  draw: number;
  away: number;
  count: number;          // number of bookmakers
}

export interface PolymarketOdds {
  homeYes: number;        // 0-1
  drawYes: number;        // 0-1
  awayYes: number;        // 0-1
  volume: number;         // USD
}

export interface UpcomingMatch {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  home_index: number;
  away_index: number;
  home_price: number;
  away_price: number;
  bookmaker_home_prob: number | null;
  bookmaker_draw_prob: number | null;
  bookmaker_away_prob: number | null;
  bookmaker_odds: BookmakerOdds | null;     // median decimal odds
  polymarket: PolymarketOdds | null;        // Polymarket Yes% prices
}

// ─── Fetch helpers ───────────────────────────────────────────
async function fetchUpcomingMatches(): Promise<MatchRow[]> {
  const all: MatchRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("matches")
      .select("fixture_id, date, league, home_team, away_team, score, status")
      .eq("status", "upcoming")
      .order("date", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      console.error("matches fetch error:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as MatchRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function fetchOracleState(): Promise<Map<string, { index: number; b: number; m1: number }>> {
  const map = new Map<string, { index: number; b: number; m1: number }>();

  const { data, error } = await supabase
    .from("team_oracle_state")
    .select("team_id, published_index, b_value, m1_value");

  if (error) {
    console.error("team_oracle_state fetch error:", error.message);
    return map;
  }

  for (const row of (data ?? []) as OracleStateRow[]) {
    map.set(row.team_id, {
      index: Number(row.published_index),
      b: Number(row.b_value),
      m1: Number(row.m1_value),
    });
  }

  return map;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface OddsResult {
  homeProb: number;
  drawProb: number;
  awayProb: number;
  bookmakerOdds: BookmakerOdds;
}

async function fetchOddsForFixtures(fixtureIds: number[]): Promise<Map<number, OddsResult>> {
  const map = new Map<number, OddsResult>();
  if (fixtureIds.length === 0) return map;

  // Read from latest_odds serving table — one row per (fixture, bookmaker)
  for (let i = 0; i < fixtureIds.length; i += 50) {
    const batch = fixtureIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from("latest_odds")
      .select("fixture_id, home_odds, away_odds, draw_odds")
      .in("fixture_id", batch);

    if (error || !data) continue;

    const grouped = new Map<number, OddsRow[]>();
    for (const row of data as OddsRow[]) {
      if (!row.home_odds || !row.away_odds || !row.draw_odds) continue;
      if (row.home_odds <= 0 || row.away_odds <= 0 || row.draw_odds <= 0) continue;
      if (!grouped.has(row.fixture_id)) grouped.set(row.fixture_id, []);
      grouped.get(row.fixture_id)!.push(row);
    }

    for (const [fid, rows] of grouped) {
      const homeProbs = rows.map(r => 1 / r.home_odds!);
      const drawProbs = rows.map(r => 1 / r.draw_odds!);
      const awayProbs = rows.map(r => 1 / r.away_odds!);

      const rawHome = homeProbs.reduce((a, b) => a + b, 0) / homeProbs.length;
      const rawDraw = drawProbs.reduce((a, b) => a + b, 0) / drawProbs.length;
      const rawAway = awayProbs.reduce((a, b) => a + b, 0) / awayProbs.length;

      const total = rawHome + rawDraw + rawAway;

      // Median decimal odds for display
      const medHome = Math.round(median(rows.map(r => Number(r.home_odds!))) * 100) / 100;
      const medDraw = Math.round(median(rows.map(r => Number(r.draw_odds!))) * 100) / 100;
      const medAway = Math.round(median(rows.map(r => Number(r.away_odds!))) * 100) / 100;

      map.set(fid, {
        homeProb: rawHome / total,
        drawProb: rawDraw / total,
        awayProb: rawAway / total,
        bookmakerOdds: { home: medHome, draw: medDraw, away: medAway, count: rows.length },
      });
    }
  }
  return map;
}

async function fetchPolymarketForFixtures(
  fixtureIds: number[]
): Promise<Map<number, PolymarketOdds>> {
  const map = new Map<number, PolymarketOdds>();
  if (fixtureIds.length === 0) return map;

  // Get latest moneyline snapshot per fixture
  for (let i = 0; i < fixtureIds.length; i += 50) {
    const batch = fixtureIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from("polymarket_match_odds")
      .select("fixture_id, outcomes, outcome_prices, volume")
      .eq("market_type", "moneyline")
      .in("fixture_id", batch)
      .order("snapshot_time", { ascending: false });

    if (error || !data) continue;

    // Take latest per fixture (ordered desc, so first wins)
    for (const row of data as PolymarketRow[]) {
      if (!row.fixture_id || map.has(row.fixture_id)) continue;
      const outcomes = row.outcomes as string[];
      const prices = row.outcome_prices as number[];
      if (!outcomes || !prices || outcomes.length !== 3 || prices.length !== 3) continue;

      // Outcomes are [Home, Draw, Away] for moneyline
      map.set(row.fixture_id, {
        homeYes: prices[0],
        drawYes: prices[1],
        awayYes: prices[2],
        volume: Number(row.volume) || 0,
      });
    }
  }

  return map;
}

// ─── Build data ──────────────────────────────────────────────
function buildUpcomingMatches(
  matches: MatchRow[],
  stateMap: Map<string, { index: number; b: number; m1: number }>,
  oddsMap: Map<number, OddsResult>,
  polyMap: Map<number, PolymarketOdds>
): UpcomingMatch[] {
  const seen = new Set<string>();
  const deduped: MatchRow[] = [];

  const sorted = [...matches].sort((a, b) => {
    const aHasOdds = oddsMap.has(a.fixture_id) ? 0 : 1;
    const bHasOdds = oddsMap.has(b.fixture_id) ? 0 : 1;
    if (aHasOdds !== bHasOdds) return aHasOdds - bHasOdds;
    return a.date.localeCompare(b.date);
  });

  for (const m of sorted) {
    const key = `${m.home_team}|${m.away_team}|${m.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }

  deduped.sort((a, b) => a.date.localeCompare(b.date));

  const result: UpcomingMatch[] = [];
  for (const m of deduped) {
    const home = stateMap.get(m.home_team);
    const away = stateMap.get(m.away_team);
    if (!home || !away) continue;

    const odds = oddsMap.get(m.fixture_id);
    const poly = polyMap.get(m.fixture_id);

    result.push({
      fixture_id: m.fixture_id,
      date: m.date,
      league: m.league,
      home_team: m.home_team,
      away_team: m.away_team,
      home_index: home.index,
      away_index: away.index,
      home_price: indexToPrice(home.index),
      away_price: indexToPrice(away.index),
      bookmaker_home_prob: odds?.homeProb ?? null,
      bookmaker_draw_prob: odds?.drawProb ?? null,
      bookmaker_away_prob: odds?.awayProb ?? null,
      bookmaker_odds: odds?.bookmakerOdds ?? null,
      polymarket: poly ?? null,
    });
  }

  return result;
}

// ─── Page ────────────────────────────────────────────────────
export const revalidate = 300;

export default async function MatchesPage() {
  const [rawMatches, stateMap] = await Promise.all([
    fetchUpcomingMatches(),
    fetchOracleState(),
  ]);

  const fixtureIds = rawMatches.map(m => m.fixture_id);
  const [oddsMap, polyMap] = await Promise.all([
    fetchOddsForFixtures(fixtureIds),
    fetchPolymarketForFixtures(fixtureIds),
  ]);

  const matches = buildUpcomingMatches(rawMatches, stateMap, oddsMap, polyMap);

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="h-2 w-2 rounded-full bg-accent-green animate-pulse" />
        <h1 className="text-lg font-bold tracking-wider text-foreground uppercase">
          Matches
        </h1>
        <span className="text-xs text-muted font-mono ml-auto">
          {matches.length} fixtures
        </span>
      </div>
      <MatchesListClient matches={matches} />
    </main>
  );
}
