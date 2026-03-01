import { supabase } from "@/lib/supabase";
import { V2Client } from "./v2-client";

// ─── Types ─────────────────────────────────────────────────
export interface LatestTeamPrice {
  team: string;
  league: string;
  dollar_price: number;
  implied_elo: number;
  ema_dollar_price: number | null;
  date: string;
}

export interface PriceHistoryRow {
  team: string;
  league: string;
  date: string;
  dollar_price: number;
  implied_elo: number;
}

export interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
}

// ─── Paginated fetch helper ────────────────────────────────
async function fetchAll<T>(
  table: string,
  select: string,
  filters?: Record<string, string>
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (filters) {
      for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    }
    const { data, error } = await q;
    if (error) {
      console.error(`${table} fetch error:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ─── Fetch latest oracle prices ────────────────────────────
async function fetchLatestOraclePrices(): Promise<LatestTeamPrice[]> {
  // Get the most recent oracle date
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
    .select("team, league, dollar_price, implied_elo, ema_dollar_price")
    .eq("model", "oracle")
    .eq("date", latestDate);

  if (error) {
    console.error("team_prices fetch error:", error.message);
    return [];
  }

  return (data ?? []).map((r) => ({ ...r, date: latestDate })) as LatestTeamPrice[];
}

// ─── Server component ──────────────────────────────────────
export const revalidate = 300;

export default async function V2Page() {
  const [latestPrices, priceHistory, matches] = await Promise.all([
    fetchLatestOraclePrices(),
    fetchAll<PriceHistoryRow>(
      "team_prices",
      "team, league, date, dollar_price, implied_elo",
      { model: "oracle" }
    ),
    fetchAll<MatchRow>("matches", "fixture_id, date, league, home_team, away_team, score"),
  ]);

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
            V2 Pricing
          </h1>
          <div className="flex items-center gap-4 ml-auto">
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
              {latestPrices.length} teams &middot; {priceHistory.length} price rows
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <V2Client
          latestPrices={latestPrices}
          priceHistory={priceHistory}
          matches={matches}
        />
      </main>
    </div>
  );
}
