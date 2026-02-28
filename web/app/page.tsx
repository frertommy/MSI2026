import { supabase } from "@/lib/supabase";
import { TeamTable } from "./team-table";
import { CreditBar } from "./credit-bar";
import type { Match, TeamRow } from "@/lib/types";

// Fetch latest oracle dollar_price + implied_elo per team from team_prices
async function fetchLatestPrices(): Promise<Map<string, { price: number; elo: number }>> {
  const map = new Map<string, { price: number; elo: number }>();

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
    .select("team, dollar_price, implied_elo")
    .eq("model", "oracle")
    .eq("date", latestDate);

  if (error) {
    console.error("team_prices fetch error:", error.message);
    return map;
  }

  for (const row of data ?? []) {
    map.set(row.team, { price: row.dollar_price, elo: row.implied_elo });
  }

  return map;
}

// Supabase caps .select() at 1000 rows by default; we need all matches + odds
async function fetchAllMatches(): Promise<Match[]> {
  const { data, error } = await supabase
    .from("matches")
    .select("fixture_id, date, league, home_team, away_team, score, status")
    .order("date", { ascending: true });

  if (error) {
    console.error("matches fetch error:", error.message);
    return [];
  }
  return data ?? [];
}

// Fetch odds — only closest-to-kickoff snapshot (days_before_kickoff = 1) to keep it manageable
async function fetchClosingOdds(): Promise<
  Map<number, { homeProb: number; awayProb: number }>
> {
  // Accumulate all bookmaker probabilities per fixture, then compute true mean
  const accum = new Map<number, { homeProbs: number[]; awayProbs: number[] }>();

  // Paginate — table has ~28k rows
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("odds_snapshots")
      .select("fixture_id, home_odds, away_odds, days_before_kickoff")
      .eq("days_before_kickoff", 1)
      .range(from, from + pageSize - 1);

    if (error) {
      console.error("odds fetch error:", error.message);
      break;
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (!row.home_odds || !row.away_odds || row.home_odds <= 0 || row.away_odds <= 0) continue;

      if (!accum.has(row.fixture_id)) {
        accum.set(row.fixture_id, { homeProbs: [], awayProbs: [] });
      }
      const entry = accum.get(row.fixture_id)!;
      entry.homeProbs.push(1 / row.home_odds);
      entry.awayProbs.push(1 / row.away_odds);
    }

    if (data.length < pageSize) break;
    from += pageSize;
  }

  // Compute true mean across all bookmakers per fixture
  const map = new Map<number, { homeProb: number; awayProb: number }>();
  for (const [fid, { homeProbs, awayProbs }] of accum) {
    map.set(fid, {
      homeProb: homeProbs.reduce((a, b) => a + b, 0) / homeProbs.length,
      awayProb: awayProbs.reduce((a, b) => a + b, 0) / awayProbs.length,
    });
  }

  return map;
}

function parseScore(score: string): [number, number] | null {
  const parts = score.split("-");
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0].trim());
  const a = parseInt(parts[1].trim());
  if (isNaN(h) || isNaN(a)) return null;
  return [h, a];
}

function computeTeamRows(
  matches: Match[],
  oddsMap: Map<number, { homeProb: number; awayProb: number }>,
  priceMap: Map<string, { price: number; elo: number }>
): TeamRow[] {
  const teamStats = new Map<
    string,
    {
      league: string;
      played: number;
      wins: number;
      draws: number;
      losses: number;
      impliedProbs: number[];
      latestDate: string;
    }
  >();

  function getOrCreate(team: string, league: string) {
    if (!teamStats.has(team)) {
      teamStats.set(team, {
        league,
        played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        impliedProbs: [],
        latestDate: "",
      });
    }
    return teamStats.get(team)!;
  }

  for (const m of matches) {
    const parsed = parseScore(m.score);
    if (!parsed) continue;
    const [hg, ag] = parsed;

    const odds = oddsMap.get(m.fixture_id);

    // Home team
    const home = getOrCreate(m.home_team, m.league);
    home.played++;
    if (m.date > home.latestDate) home.latestDate = m.date;
    if (hg > ag) home.wins++;
    else if (hg === ag) home.draws++;
    else home.losses++;
    if (odds) home.impliedProbs.push(odds.homeProb);

    // Away team
    const away = getOrCreate(m.away_team, m.league);
    away.played++;
    if (m.date > away.latestDate) away.latestDate = m.date;
    if (ag > hg) away.wins++;
    else if (ag === hg) away.draws++;
    else away.losses++;
    if (odds) away.impliedProbs.push(odds.awayProb);
  }

  const rows: TeamRow[] = [];
  for (const [team, stats] of teamStats) {
    const avgProb =
      stats.impliedProbs.length > 0
        ? stats.impliedProbs.reduce((a, b) => a + b, 0) /
          stats.impliedProbs.length
        : 0;
    const teamData = priceMap.get(team);
    rows.push({
      rank: 0,
      team,
      league: stats.league,
      avgImpliedWinProb: avgProb,
      played: stats.played,
      wins: stats.wins,
      draws: stats.draws,
      losses: stats.losses,
      latestDate: stats.latestDate,
      dollarPrice: teamData?.price ?? null,
      impliedElo: teamData?.elo ?? null,
    });
  }

  // Sort by implied Elo descending
  rows.sort((a, b) => (b.impliedElo ?? 0) - (a.impliedElo ?? 0));
  rows.forEach((r, i) => (r.rank = i + 1));

  return rows;
}

export const revalidate = 300; // revalidate every 5 min

export default async function Home() {
  const [matches, oddsMap, priceMap] = await Promise.all([
    fetchAllMatches(),
    fetchClosingOdds(),
    fetchLatestPrices(),
  ]);

  const teams = computeTeamRows(matches, oddsMap, priceMap);
  const leagues = [...new Set(teams.map((t) => t.league))].sort();

  return (
    <div className="min-h-screen bg-background">
      <CreditBar />
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto max-w-7xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-2 w-2 rounded-full bg-accent-green animate-pulse" />
            <h1 className="text-lg font-bold tracking-wider text-foreground uppercase">
              MSI 2026
            </h1>
          </div>
          <div className="flex items-center gap-4">
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
            <span className="text-xs text-muted font-mono">
              {teams.length} teams &middot; {matches.length} matches &middot;{" "}
              {oddsMap.size} odds fixtures
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <TeamTable teams={teams} leagues={leagues} />
      </main>
    </div>
  );
}
