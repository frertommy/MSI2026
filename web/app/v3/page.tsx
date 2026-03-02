import { supabase } from "@/lib/supabase";
import { V3Client } from "./v3-client";

// ─── Types ─────────────────────────────────────────────────
export interface StartingElo {
  team: string;
  league: string;
  implied_elo: number;
  dollar_price: number;
  date: string;
}

export interface PriceHistoryRow {
  team: string;
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
  status: string;
}

export interface OddsConsensus {
  fixture_id: number;
  homeProb: number;
  drawProb: number;
  awayProb: number;
}

// ─── Paginated fetch helper ────────────────────────────────
async function fetchAll<T>(
  table: string,
  select: string,
  filters?: Record<string, string | number>,
  orderCol?: string
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (filters) {
      for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    }
    if (orderCol) q = q.order(orderCol, { ascending: true });
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

// ─── Fetch starting Elos (earliest oracle date) ────────────
async function fetchStartingElos(): Promise<StartingElo[]> {
  const { data: earliest } = await supabase
    .from("team_prices")
    .select("date")
    .eq("model", "oracle")
    .order("date", { ascending: true })
    .limit(1);

  const startDate = earliest?.[0]?.date;
  if (!startDate) return [];

  const { data, error } = await supabase
    .from("team_prices")
    .select("team, league, implied_elo, dollar_price")
    .eq("model", "oracle")
    .eq("date", startDate);

  if (error) {
    console.error("starting elos fetch error:", error.message);
    return [];
  }

  return (data ?? []).map((r) => ({ ...r, date: startDate })) as StartingElo[];
}

// ─── Fetch closing odds and compute consensus ──────────────
async function fetchClosingOddsConsensus(): Promise<OddsConsensus[]> {
  interface OddsRow {
    fixture_id: number;
    home_odds: number | null;
    away_odds: number | null;
    draw_odds: number | null;
  }

  const rawOdds = await fetchAll<OddsRow>(
    "odds_snapshots",
    "fixture_id, home_odds, away_odds, draw_odds",
    { days_before_kickoff: 1 }
  );

  // Group by fixture and average
  const grouped = new Map<number, { home: number[]; draw: number[]; away: number[] }>();
  for (const row of rawOdds) {
    if (!row.home_odds || !row.away_odds || !row.draw_odds) continue;
    if (row.home_odds <= 0 || row.away_odds <= 0 || row.draw_odds <= 0) continue;

    if (!grouped.has(row.fixture_id)) {
      grouped.set(row.fixture_id, { home: [], draw: [], away: [] });
    }
    const entry = grouped.get(row.fixture_id)!;
    entry.home.push(1 / row.home_odds);
    entry.draw.push(1 / row.draw_odds);
    entry.away.push(1 / row.away_odds);
  }

  const result: OddsConsensus[] = [];
  for (const [fid, { home, draw, away }] of grouped) {
    const rawHome = home.reduce((a, b) => a + b, 0) / home.length;
    const rawDraw = draw.reduce((a, b) => a + b, 0) / draw.length;
    const rawAway = away.reduce((a, b) => a + b, 0) / away.length;
    const total = rawHome + rawDraw + rawAway;
    result.push({
      fixture_id: fid,
      homeProb: rawHome / total,
      drawProb: rawDraw / total,
      awayProb: rawAway / total,
    });
  }

  return result;
}

// ─── Server component ──────────────────────────────────────
export const revalidate = 300;

export default async function V3Page() {
  const [startingElos, priceHistory, matches, oddsConsensus] = await Promise.all([
    fetchStartingElos(),
    fetchAll<PriceHistoryRow>(
      "team_prices",
      "team, date, dollar_price, implied_elo",
      { model: "oracle" },
      "date"
    ),
    fetchAll<MatchRow>(
      "matches",
      "fixture_id, date, league, home_team, away_team, score, status",
      undefined,
      "date"
    ),
    fetchClosingOddsConsensus(),
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
            Simulation
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
            <a
              href="/v2"
              className="text-xs text-accent-green hover:text-foreground transition-colors font-mono uppercase tracking-wider"
            >
              V2 Pricing &rarr;
            </a>
            <span className="text-xs text-muted font-mono">
              {startingElos.length} teams &middot; {matches.length} matches &middot;{" "}
              {oddsConsensus.length} odds fixtures
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <V3Client
          startingElos={startingElos}
          priceHistory={priceHistory}
          matches={matches}
          oddsConsensus={oddsConsensus}
        />
      </main>
    </div>
  );
}
