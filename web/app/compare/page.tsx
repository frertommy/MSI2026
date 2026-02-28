import { supabase } from "@/lib/supabase";
import { CompareClient } from "./compare-client";

async function getTeams(): Promise<string[]> {
  // Fetch the most recent oracle date, then get exactly one row per team
  // for that date. This returns ~96 rows instead of 22k+.
  const { data: latest } = await supabase
    .from("team_prices")
    .select("date")
    .eq("model", "oracle")
    .order("date", { ascending: false })
    .limit(1);

  const latestDate = latest?.[0]?.date;
  if (!latestDate) return [];

  const { data, error } = await supabase
    .from("team_prices")
    .select("team")
    .eq("model", "oracle")
    .eq("date", latestDate)
    .order("team");

  if (error) {
    console.error("Failed to fetch teams:", error.message);
    return [];
  }

  return (data ?? []).map((r) => r.team);
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
