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
}

export interface TeamPricePoint {
  team: string;
  date: string;
  dollar_price: number;
  implied_elo: number;
}

export interface LatestPrice {
  team: string;
  league: string;
  dollar_price: number;
  implied_elo: number;
}

export interface OddsData {
  homeProb: number;
  drawProb: number;
  awayProb: number;
}

// ─── Fetch helpers ───────────────────────────────────────────
async function fetchMatch(fixtureId: number): Promise<MatchInfo | null> {
  const { data, error } = await supabase
    .from("matches")
    .select("fixture_id, date, league, home_team, away_team, score, status")
    .eq("fixture_id", fixtureId)
    .limit(1)
    .single();

  if (error || !data) return null;
  return data as MatchInfo;
}

async function fetchPriceHistory(teams: string[]): Promise<TeamPricePoint[]> {
  // Get last 3 days of oracle prices for both teams
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 3);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const all: TeamPricePoint[] = [];
  for (const team of teams) {
    const { data, error } = await supabase
      .from("team_prices")
      .select("team, date, dollar_price, implied_elo")
      .eq("model", "oracle")
      .eq("team", team)
      .gte("date", cutoffStr)
      .order("date", { ascending: true });

    if (error) {
      console.error("price history fetch error:", error.message);
      continue;
    }
    if (data) all.push(...(data as TeamPricePoint[]));
  }
  return all;
}

async function fetchLatestOraclePrices(teams: string[]): Promise<Map<string, LatestPrice>> {
  const map = new Map<string, LatestPrice>();

  const { data: latest } = await supabase
    .from("team_prices")
    .select("date")
    .eq("model", "oracle")
    .order("date", { ascending: false })
    .limit(1);

  const latestDate = latest?.[0]?.date;
  if (!latestDate) return map;

  for (const team of teams) {
    const { data } = await supabase
      .from("team_prices")
      .select("team, league, dollar_price, implied_elo")
      .eq("model", "oracle")
      .eq("team", team)
      .eq("date", latestDate)
      .limit(1);

    if (data && data.length > 0) {
      const row = data[0] as LatestPrice;
      map.set(row.team, row);
    }
  }

  return map;
}

async function fetchLeagueMeanElo(league: string): Promise<number> {
  const { data: latest } = await supabase
    .from("team_prices")
    .select("date")
    .eq("model", "oracle")
    .order("date", { ascending: false })
    .limit(1);

  const latestDate = latest?.[0]?.date;
  if (!latestDate) return 1500;

  const { data } = await supabase
    .from("team_prices")
    .select("implied_elo")
    .eq("model", "oracle")
    .eq("date", latestDate)
    .eq("league", league);

  if (!data || data.length === 0) return 1500;

  const elos = data.map((r: { implied_elo: number }) => r.implied_elo);
  return elos.reduce((a: number, b: number) => a + b, 0) / elos.length;
}

async function fetchOdds(fixtureId: number): Promise<OddsData | null> {
  // Read from latest_odds serving table — one row per bookmaker
  const { data, error } = await supabase
    .from("latest_odds")
    .select("home_odds, away_odds, draw_odds")
    .eq("fixture_id", fixtureId);

  if (error || !data || data.length === 0) return null;

  const valid = data.filter(
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

  const [priceHistory, latestPrices, leagueMean, odds] = await Promise.all([
    fetchPriceHistory(teams),
    fetchLatestOraclePrices(teams),
    fetchLeagueMeanElo(match.league),
    fetchOdds(fixtureId),
  ]);

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <MatchDetailClient
        match={match}
        priceHistory={priceHistory}
        latestPrices={Object.fromEntries(latestPrices)}
        leagueMean={leagueMean}
        odds={odds}
      />
    </main>
  );
}
