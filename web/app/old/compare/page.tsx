import { supabase } from "@/lib/supabase";
import { CompareClient } from "./compare-client";

async function getTeamsWithLeagues(): Promise<{
  teams: string[];
  teamLeagues: Record<string, string>;
}> {
  // Fetch the most recent oracle date, then get one row per team
  const { data: latest } = await supabase
    .from("team_prices")
    .select("date")
    .eq("model", "oracle")
    .order("date", { ascending: false })
    .limit(1);

  const latestDate = latest?.[0]?.date;
  if (!latestDate) return { teams: [], teamLeagues: {} };

  const { data, error } = await supabase
    .from("team_prices")
    .select("team, league")
    .eq("model", "oracle")
    .eq("date", latestDate)
    .order("team");

  if (error) {
    console.error("Failed to fetch teams:", error.message);
    return { teams: [], teamLeagues: {} };
  }

  const teams: string[] = [];
  const teamLeagues: Record<string, string> = {};
  for (const r of data ?? []) {
    teams.push(r.team);
    teamLeagues[r.team] = r.league;
  }

  return { teams, teamLeagues };
}

export const revalidate = 300;

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ team?: string }>;
}) {
  const { teams, teamLeagues } = await getTeamsWithLeagues();
  const params = await searchParams;
  const initialTeam =
    params.team && teams.includes(params.team) ? params.team : teams[0] ?? "";

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
            Team Detail
          </h1>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <CompareClient
          teams={teams}
          initialTeam={initialTeam}
          teamLeagues={teamLeagues}
        />
      </main>
    </div>
  );
}
