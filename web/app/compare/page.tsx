import { supabase } from "@/lib/supabase";
import { CompareClient } from "./compare-client";

async function getTeams(): Promise<string[]> {
  // Fetch only one row per team (latest oracle price) instead of all 22k rows.
  // Filter to a single model and recent date to minimize the result set.
  const { data, error } = await supabase
    .from("team_prices")
    .select("team")
    .eq("model", "oracle")
    .order("team");

  if (error) {
    console.error("Failed to fetch teams:", error.message);
    return [];
  }

  // Deduplicate (multiple dates per team, but far fewer rows than all models × all dates)
  const teams = new Set<string>();
  for (const r of data ?? []) teams.add(r.team);
  return [...teams].sort();
}

export const revalidate = 300;

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ team?: string }>;
}) {
  const teams = await getTeams();
  const params = await searchParams;
  const initialTeam = params.team && teams.includes(params.team)
    ? params.team
    : teams[0] ?? "";

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
            Oracle Compare
          </h1>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <CompareClient teams={teams} initialTeam={initialTeam} />
      </main>
    </div>
  );
}
