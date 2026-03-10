import { supabase } from "@/lib/supabase";
import { MatchesClient } from "./matches-client";

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

interface TeamPriceRow {
  team: string;
  league: string;
  date: string;
  dollar_price: number;
  implied_elo: number;
}

interface OddsRow {
  fixture_id: number;
  home_odds: number | null;
  away_odds: number | null;
  draw_odds: number | null;
}

export interface UpcomingMatch {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  home_elo: number;
  away_elo: number;
  home_price: number;
  away_price: number;
  league_mean_elo: number;
  bookmaker_home_prob: number | null;
  bookmaker_draw_prob: number | null;
  bookmaker_away_prob: number | null;
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

async function fetchLatestOraclePrices(): Promise<Map<string, { price: number; elo: number; league: string }>> {
  const map = new Map<string, { price: number; elo: number; league: string }>();

  // Get the most recent oracle date (1 row), then fetch that date only (~96 rows)
  const { data: latest } = await supabase
    .from("team_prices")
    .select("date")
    .eq("model", "oracle")
    .order("date", { ascending: false })
    .limit(1);

  const latestDate = latest?.[0]?.date;
  if (!latestDate) return map;

  const { data, error } = await supabase
    .from("team_prices")
    .select("team, league, dollar_price, implied_elo")
    .eq("model", "oracle")
    .eq("date", latestDate);

  if (error) {
    console.error("team_prices fetch error:", error.message);
    return map;
  }

  for (const row of data ?? []) {
    map.set(row.team, { price: row.dollar_price, elo: row.implied_elo, league: (row as TeamPriceRow).league });
  }

  return map;
}

async function fetchOddsForFixtures(fixtureIds: number[]): Promise<Map<number, { homeProb: number; drawProb: number; awayProb: number }>> {
  const map = new Map<number, { homeProb: number; drawProb: number; awayProb: number }>();
  if (fixtureIds.length === 0) return map;

  // Fetch in batches of 10 (stay under Supabase 1000-row default limit)
  for (let i = 0; i < fixtureIds.length; i += 10) {
    const batch = fixtureIds.slice(i, i + 10);
    const { data, error } = await supabase
      .from("odds_snapshots")
      .select("fixture_id, home_odds, away_odds, draw_odds")
      .in("fixture_id", batch);

    if (error || !data) continue;

    // Group odds by fixture and average
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

      // Normalize to sum to 1
      const total = rawHome + rawDraw + rawAway;
      map.set(fid, {
        homeProb: rawHome / total,
        drawProb: rawDraw / total,
        awayProb: rawAway / total,
      });
    }
  }
  return map;
}

// ─── Build data ──────────────────────────────────────────────
function buildUpcomingMatches(
  matches: MatchRow[],
  priceMap: Map<string, { price: number; elo: number; league: string }>,
  oddsMap: Map<number, { homeProb: number; drawProb: number; awayProb: number }>
): UpcomingMatch[] {
  // Deduplicate: same home_team + away_team + date → keep first (has odds if available)
  const seen = new Set<string>();
  const deduped: MatchRow[] = [];

  // Sort to prefer fixtures that have odds
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

  // Re-sort by date
  deduped.sort((a, b) => a.date.localeCompare(b.date));

  // Compute league mean Elo
  const leagueElos = new Map<string, number[]>();
  for (const { elo, league } of priceMap.values()) {
    if (!leagueElos.has(league)) leagueElos.set(league, []);
    leagueElos.get(league)!.push(elo);
  }
  const leagueMeans = new Map<string, number>();
  for (const [league, elos] of leagueElos) {
    leagueMeans.set(league, elos.reduce((a, b) => a + b, 0) / elos.length);
  }

  const result: UpcomingMatch[] = [];
  for (const m of deduped) {
    const home = priceMap.get(m.home_team);
    const away = priceMap.get(m.away_team);
    if (!home || !away) continue; // skip if no price data

    const odds = oddsMap.get(m.fixture_id);

    result.push({
      fixture_id: m.fixture_id,
      date: m.date,
      league: m.league,
      home_team: m.home_team,
      away_team: m.away_team,
      home_elo: home.elo,
      away_elo: away.elo,
      home_price: home.price,
      away_price: away.price,
      league_mean_elo: leagueMeans.get(m.league) ?? 1500,
      bookmaker_home_prob: odds?.homeProb ?? null,
      bookmaker_draw_prob: odds?.drawProb ?? null,
      bookmaker_away_prob: odds?.awayProb ?? null,
    });
  }

  return result;
}

// ─── Page ────────────────────────────────────────────────────
export const revalidate = 300; // revalidate every 5 min

export default async function MatchesPage() {
  const [rawMatches, priceMap] = await Promise.all([
    fetchUpcomingMatches(),
    fetchLatestOraclePrices(),
  ]);

  // Get fixture IDs for odds fetch
  const fixtureIds = rawMatches.map(m => m.fixture_id);
  const oddsMap = await fetchOddsForFixtures(fixtureIds);

  const matches = buildUpcomingMatches(rawMatches, priceMap, oddsMap);

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
            Upcoming Matches
          </h1>
          <div className="flex items-center gap-4 ml-auto">
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
              href="/old/v3"
              className="text-xs text-accent-green hover:text-foreground transition-colors font-mono uppercase tracking-wider"
            >
              Simulation &rarr;
            </a>
            <span className="text-xs text-muted font-mono">
              {matches.length} fixtures
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <MatchesClient matches={matches} />
      </main>
    </div>
  );
}
