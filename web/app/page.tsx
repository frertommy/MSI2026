import { supabase } from "@/lib/supabase";

interface LeagueSummary {
  league: string;
  matchCount: number;
  latestDate: string;
}

async function getLeagueSummaries(): Promise<LeagueSummary[]> {
  const { data, error } = await supabase
    .from("matches")
    .select("league, date");

  if (error) {
    console.error("Failed to fetch matches:", error.message);
    return [];
  }

  // Group by league
  const leagueMap = new Map<
    string,
    { count: number; latestDate: string }
  >();

  for (const row of data) {
    const existing = leagueMap.get(row.league);
    if (existing) {
      existing.count++;
      if (row.date > existing.latestDate) existing.latestDate = row.date;
    } else {
      leagueMap.set(row.league, { count: 1, latestDate: row.date });
    }
  }

  return Array.from(leagueMap.entries())
    .map(([league, { count, latestDate }]) => ({
      league,
      matchCount: count,
      latestDate,
    }))
    .sort((a, b) => b.matchCount - a.matchCount);
}

export const revalidate = 60; // revalidate every 60 seconds

export default async function Home() {
  const leagues = await getLeagueSummaries();
  const totalMatches = leagues.reduce((sum, l) => sum + l.matchCount, 0);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <main className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            MSI 2026
          </h1>
          <p className="mt-2 text-lg text-zinc-500 dark:text-zinc-400">
            Football match intelligence &mdash; {totalMatches} matches across{" "}
            {leagues.length} leagues
          </p>
        </header>

        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            Leagues
          </h2>
          <div className="grid gap-4">
            {leagues.map((league) => (
              <div
                key={league.league}
                className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div>
                  <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                    {league.league}
                  </h3>
                  <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                    Latest: {league.latestDate}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-zinc-100 px-3 py-1 text-sm font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    {league.matchCount} matches
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {leagues.length === 0 && (
          <div className="mt-8 rounded-xl border border-yellow-200 bg-yellow-50 p-6 text-center text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950 dark:text-yellow-200">
            No matches found. Make sure the database is populated and the
            Supabase environment variables are set.
          </div>
        )}
      </main>
    </div>
  );
}
