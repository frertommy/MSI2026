import { supabase } from "@/lib/supabase";
import { CompareClient } from "./compare-client";

async function getTeams(): Promise<string[]> {
  // team_prices has ~16k rows (96 teams × 57 days × 3 models).
  // Supabase defaults to 1000-row limit, so we must paginate to get all team names.
  const allTeams = new Set<string>();
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("team_prices")
      .select("team")
      .order("team")
      .range(from, from + pageSize - 1);

    if (error) {
      console.error("Failed to fetch teams:", error.message);
      break;
    }
    if (!data || data.length === 0) break;

    for (const r of data) {
      allTeams.add(r.team);
    }

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return [...allTeams].sort();
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
