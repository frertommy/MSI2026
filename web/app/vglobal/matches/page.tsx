/**
 * vGlobal Matches — Champions League Fixtures with Price Impact
 *
 * Shows upcoming and recent CL matches with Oracle V3 price impact predictions.
 * CL settlement uses γ=0 (no gravity), so impact is purely K × (S - E_KR).
 */

import { supabase, batchedIn } from "@/lib/supabase";
import { VGlobalMatchesClient } from "./vglobal-matches-client";

// ─── Types ───────────────────────────────────────────────────

export interface CLMatchData {
  fixture_id: number;
  date: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
  commence_time: string | null;
  home_index: number;
  away_index: number;
  home_price: number;
  away_price: number;
  home_B: number;
  away_B: number;
  bookmaker_home_prob: number | null;
  bookmaker_draw_prob: number | null;
  bookmaker_away_prob: number | null;
  bookmaker_count: number;
  // Settlement data (for finished matches)
  home_delta_B: number | null;
  away_delta_B: number | null;
}

interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
  commence_time: string | null;
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

interface SettlementRow {
  fixture_id: number;
  team_id: string;
  delta_b: number;
}

/** Oracle V1.4: price = (published_index - 800) / 5 */
function indexToPrice(index: number): number {
  return Math.round(((index - 800) / 5) * 100) / 100;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ─── Fetch helpers ───────────────────────────────────────────

async function fetchCLMatches(): Promise<MatchRow[]> {
  const all: MatchRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("matches")
      .select("fixture_id, date, league, home_team, away_team, score, status, commence_time")
      .eq("league", "Champions League")
      .order("date", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) { console.error("CL matches fetch error:", error.message); break; }
    if (!data || data.length === 0) break;
    all.push(...(data as MatchRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function fetchOracleV3State(): Promise<Map<string, { index: number; b: number; m1: number }>> {
  const map = new Map<string, { index: number; b: number; m1: number }>();
  const { data, error } = await supabase
    .from("team_oracle_v3_state")
    .select("team_id, published_index, b_value, m1_value");
  if (error) { console.error("team_oracle_v3_state fetch error:", error.message); return map; }
  for (const row of (data ?? []) as OracleStateRow[]) {
    map.set(row.team_id, {
      index: Number(row.published_index),
      b: Number(row.b_value),
      m1: Number(row.m1_value),
    });
  }
  return map;
}

async function fetchOddsForFixtures(
  fixtureIds: number[]
): Promise<Map<number, { homeProb: number; drawProb: number; awayProb: number; count: number }>> {
  const map = new Map<number, { homeProb: number; drawProb: number; awayProb: number; count: number }>();
  if (fixtureIds.length === 0) return map;

  const allOdds = await batchedIn<OddsRow>(
    "latest_odds", "fixture_id, home_odds, away_odds, draw_odds", "fixture_id", fixtureIds
  );

  const grouped = new Map<number, OddsRow[]>();
  for (const row of allOdds) {
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
    map.set(fid, {
      homeProb: rawHome / total,
      drawProb: rawDraw / total,
      awayProb: rawAway / total,
      count: rows.length,
    });
  }

  return map;
}

async function fetchCLSettlements(fixtureIds: number[]): Promise<Map<number, Map<string, number>>> {
  const map = new Map<number, Map<string, number>>();
  if (fixtureIds.length === 0) return map;

  const allSettlements = await batchedIn<SettlementRow>(
    "settlement_log",
    "fixture_id, team_id, delta_b",
    "fixture_id",
    fixtureIds,
    { filters: [{ column: "oracle_version", op: "eq", value: "v3" }] }
  );

  for (const s of allSettlements) {
    if (!map.has(s.fixture_id)) map.set(s.fixture_id, new Map());
    map.get(s.fixture_id)!.set(s.team_id, Number(s.delta_b));
  }

  return map;
}

// ─── Page ────────────────────────────────────────────────────
export const dynamic = "force-dynamic";

export default async function VGlobalMatchesPage() {
  const [rawMatches, stateMap] = await Promise.all([
    fetchCLMatches(),
    fetchOracleV3State(),
  ]);

  const fixtureIds = rawMatches.map(m => m.fixture_id);
  const [oddsMap, settlementsMap] = await Promise.all([
    fetchOddsForFixtures(fixtureIds),
    fetchCLSettlements(fixtureIds),
  ]);

  // Build match data
  const matchData: CLMatchData[] = [];
  for (const m of rawMatches) {
    const home = stateMap.get(m.home_team);
    const away = stateMap.get(m.away_team);
    // Include match even if one team doesn't have oracle state (external CL opponent)
    const odds = oddsMap.get(m.fixture_id);
    const settlements = settlementsMap.get(m.fixture_id);

    matchData.push({
      fixture_id: m.fixture_id,
      date: m.date,
      home_team: m.home_team,
      away_team: m.away_team,
      score: m.score,
      status: m.status,
      commence_time: m.commence_time,
      home_index: home?.index ?? 0,
      away_index: away?.index ?? 0,
      home_price: home ? indexToPrice(home.index) : 0,
      away_price: away ? indexToPrice(away.index) : 0,
      home_B: home?.b ?? 0,
      away_B: away?.b ?? 0,
      bookmaker_home_prob: odds?.homeProb ?? null,
      bookmaker_draw_prob: odds?.drawProb ?? null,
      bookmaker_away_prob: odds?.awayProb ?? null,
      bookmaker_count: odds?.count ?? 0,
      home_delta_B: settlements?.get(m.home_team) ?? null,
      away_delta_B: settlements?.get(m.away_team) ?? null,
    });
  }

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
        <h1 className="text-lg font-bold tracking-wider text-foreground uppercase">
          CL Matches
        </h1>
        <span className="text-xs text-amber-400 font-mono">vGlobal &middot; &gamma;=0</span>
        <span className="text-xs text-muted font-mono ml-auto">
          {matchData.length} fixtures
        </span>
      </div>
      <VGlobalMatchesClient matches={matchData} />
    </main>
  );
}
