import { supabase } from "@/lib/supabase";
import { TeamTable } from "./team-table";
import { CreditBar } from "./credit-bar";
import type { Match, TeamRow } from "@/lib/types";

/** Oracle V1.4: price = (published_index - 800) / 5 */
function indexToPrice(index: number): number {
  return Math.round(((index - 800) / 5) * 100) / 100;
}

// Fetch current oracle state from team_oracle_state (the live V1.4 table)
async function fetchOracleState(): Promise<Map<string, { index: number; league: string }>> {
  const map = new Map<string, { index: number; league: string }>();

  const { data, error } = await supabase
    .from("team_oracle_state")
    .select("team_id, published_index");

  if (error) {
    console.error("team_oracle_state fetch error:", error.message);
    return map;
  }

  // Get league from oracle_price_history (most recent per team)
  const { data: leagueData } = await supabase
    .from("oracle_price_history")
    .select("team, league")
    .order("timestamp", { ascending: false });

  const leagueMap = new Map<string, string>();
  for (const row of leagueData ?? []) {
    if (!leagueMap.has(row.team)) leagueMap.set(row.team, row.league);
  }

  for (const row of data ?? []) {
    map.set(row.team_id, {
      index: Number(row.published_index),
      league: leagueMap.get(row.team_id) ?? "",
    });
  }

  return map;
}

async function fetchAllMatches(): Promise<Match[]> {
  const all: Match[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("matches")
      .select("fixture_id, date, league, home_team, away_team, score, status")
      .order("date", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      console.error("matches fetch error:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
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
  stateMap: Map<string, { index: number; league: string }>
): TeamRow[] {
  const teamStats = new Map<
    string,
    {
      league: string;
      played: number;
      wins: number;
      draws: number;
      losses: number;
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
        latestDate: "",
      });
    }
    return teamStats.get(team)!;
  }

  for (const m of matches) {
    const parsed = parseScore(m.score);
    if (!parsed) continue;
    const [hg, ag] = parsed;

    // Home team
    const home = getOrCreate(m.home_team, m.league);
    home.played++;
    if (m.date > home.latestDate) home.latestDate = m.date;
    if (hg > ag) home.wins++;
    else if (hg === ag) home.draws++;
    else home.losses++;

    // Away team
    const away = getOrCreate(m.away_team, m.league);
    away.played++;
    if (m.date > away.latestDate) away.latestDate = m.date;
    if (ag > hg) away.wins++;
    else if (ag === hg) away.draws++;
    else away.losses++;
  }

  const rows: TeamRow[] = [];
  for (const [team, stats] of teamStats) {
    const state = stateMap.get(team);
    const idx = state?.index ?? null;
    rows.push({
      rank: 0,
      team,
      league: state?.league || stats.league,
      played: stats.played,
      wins: stats.wins,
      draws: stats.draws,
      losses: stats.losses,
      latestDate: stats.latestDate,
      dollarPrice: idx !== null ? indexToPrice(idx) : null,
      publishedIndex: idx,
    });
  }

  // Sort by published index descending
  rows.sort((a, b) => (b.publishedIndex ?? 0) - (a.publishedIndex ?? 0));
  rows.forEach((r, i) => (r.rank = i + 1));

  return rows;
}

export const dynamic = "force-dynamic";

export default async function Home() {
  const [matches, stateMap] = await Promise.all([
    fetchAllMatches(),
    fetchOracleState(),
  ]);

  // Identify teams with live matches
  const liveTeams = new Set<string>();
  for (const m of matches) {
    if (m.status === "live") {
      liveTeams.add(m.home_team);
      liveTeams.add(m.away_team);
    }
  }

  const teams = computeTeamRows(matches, stateMap);
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
            <span className="text-xs text-muted font-mono">
              {teams.length} teams &middot; {matches.length} matches
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <TeamTable teams={teams} leagues={leagues} liveTeams={liveTeams} />
      </main>
    </div>
  );
}
