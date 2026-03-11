import { supabase } from "@/lib/supabase";
import { MatchDetailClient } from "./match-detail-client";
import { notFound } from "next/navigation";

// ─── Types ───────────────────────────────────────────────────
export interface MatchInfo {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string | null;
  status: string;
  commence_time: string | null;
}

export interface OracleState {
  team_id: string;
  published_index: number;
  b_value: number;
  m1_value: number;
}

export interface PriceHistoryPoint {
  team: string;
  timestamp: string;
  published_index: number;
  b_value: number;
  m1_value: number;
  publish_reason: string;
}

export interface OddsData {
  homeProb: number;
  drawProb: number;
  awayProb: number;
}

/** Oracle V1.4: price = (published_index - 800) / 5 */
export function indexToPrice(index: number): number {
  return Math.round(((index - 800) / 5) * 100) / 100;
}

// ─── Fetch helpers ───────────────────────────────────────────
async function fetchMatch(fixtureId: number): Promise<MatchInfo | null> {
  const { data, error } = await supabase
    .from("matches")
    .select("fixture_id, date, league, home_team, away_team, score, status, commence_time")
    .eq("fixture_id", fixtureId)
    .limit(1)
    .single();

  if (error || !data) return null;
  return data as MatchInfo;
}

async function fetchOracleState(teams: string[]): Promise<Map<string, OracleState>> {
  const map = new Map<string, OracleState>();

  const { data, error } = await supabase
    .from("team_oracle_state")
    .select("team_id, published_index, b_value, m1_value")
    .in("team_id", teams);

  if (error || !data) return map;

  for (const row of data as OracleState[]) {
    map.set(row.team_id, {
      ...row,
      published_index: Number(row.published_index),
      b_value: Number(row.b_value),
      m1_value: Number(row.m1_value),
    });
  }

  return map;
}

async function fetchPriceHistory(
  teams: string[],
  match: MatchInfo,
): Promise<PriceHistoryPoint[]> {
  // Use 48h window centered on kickoff (KO-24h to KO+24h)
  const kickoffStr = match.commence_time ?? `${match.date}T12:00:00Z`;
  const kickoff = new Date(kickoffStr);
  const windowStart = new Date(kickoff.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const windowEnd = new Date(kickoff.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const all: PriceHistoryPoint[] = [];
  for (const team of teams) {
    const { data, error } = await supabase
      .from("oracle_price_history")
      .select("team, timestamp, published_index, b_value, m1_value, publish_reason")
      .eq("team", team)
      .gte("timestamp", windowStart)
      .lte("timestamp", windowEnd)
      .order("timestamp", { ascending: true });

    if (error) {
      console.error("price history fetch error:", error.message);
      continue;
    }
    if (data) {
      all.push(
        ...(data as PriceHistoryPoint[]).map((r) => ({
          ...r,
          published_index: Number(r.published_index),
          b_value: Number(r.b_value),
          m1_value: Number(r.m1_value),
        }))
      );
    }
  }
  return all;
}

async function fetchOdds(fixtureId: number, match: MatchInfo): Promise<OddsData | null> {
  const { data, error } = await supabase
    .from("latest_odds")
    .select("home_odds, away_odds, draw_odds")
    .eq("fixture_id", fixtureId);

  let rows = data;

  // Fallback: fixture ID mismatch (API-Football vs Odds API)
  if ((!error && (!data || data.length === 0)) && match) {
    const dayBefore = new Date(new Date(match.date).getTime() - 3 * 86400000).toISOString().slice(0, 10);
    const dayAfter = new Date(new Date(match.date).getTime() + 3 * 86400000).toISOString().slice(0, 10);

    const { data: alts } = await supabase
      .from("matches")
      .select("fixture_id")
      .eq("home_team", match.home_team)
      .eq("away_team", match.away_team)
      .gte("date", dayBefore)
      .lte("date", dayAfter)
      .neq("fixture_id", fixtureId);

    if (alts && alts.length > 0) {
      for (const alt of alts) {
        const { data: altOdds } = await supabase
          .from("latest_odds")
          .select("home_odds, away_odds, draw_odds")
          .eq("fixture_id", alt.fixture_id);

        if (altOdds && altOdds.length > 0) {
          rows = altOdds;
          break;
        }
      }
    }
  }

  if (error || !rows || rows.length === 0) return null;

  const valid = rows.filter(
    (r: { home_odds: number | null; away_odds: number | null; draw_odds: number | null }) =>
      r.home_odds && r.away_odds && r.draw_odds &&
      r.home_odds > 0 && r.away_odds > 0 && r.draw_odds > 0
  );
  if (valid.length === 0) return null;

  const homeProbs = valid.map((r: { home_odds: number }) => 1 / r.home_odds);
  const drawProbs = valid.map((r: { draw_odds: number }) => 1 / r.draw_odds);
  const awayProbs = valid.map((r: { away_odds: number }) => 1 / r.away_odds);

  const rawHome = homeProbs.reduce((a: number, b: number) => a + b, 0) / homeProbs.length;
  const rawDraw = drawProbs.reduce((a: number, b: number) => a + b, 0) / drawProbs.length;
  const rawAway = awayProbs.reduce((a: number, b: number) => a + b, 0) / awayProbs.length;

  const total = rawHome + rawDraw + rawAway;
  return {
    homeProb: rawHome / total,
    drawProb: rawDraw / total,
    awayProb: rawAway / total,
  };
}

// ─── Page ────────────────────────────────────────────────────
export const revalidate = 300;

export default async function MatchDetailPage({
  params,
}: {
  params: Promise<{ fixture_id: string }>;
}) {
  const { fixture_id } = await params;
  const fixtureId = parseInt(fixture_id, 10);
  if (isNaN(fixtureId)) notFound();

  const match = await fetchMatch(fixtureId);
  if (!match) notFound();

  const teams = [match.home_team, match.away_team];

  const [stateMap, priceHistory, odds] = await Promise.all([
    fetchOracleState(teams),
    fetchPriceHistory(teams, match),
    fetchOdds(fixtureId, match),
  ]);

  const homeState = stateMap.get(match.home_team) ?? null;
  const awayState = stateMap.get(match.away_team) ?? null;

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <MatchDetailClient
        match={match}
        homeState={homeState}
        awayState={awayState}
        priceHistory={priceHistory}
        odds={odds}
      />
    </main>
  );
}
