import { supabase } from "@/lib/supabase";
import { OracleClient } from "./oracle-client";

// ─── Types ─────────────────────────────────────────────────
export interface OraclePriceRow {
  team: string;
  league: string;
  date: string;
  dollar_price: number;
  ema_dollar_price: number | null;
  implied_elo: number;
}

export interface MatchInfo {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
}

export interface PmPrice {
  team: string;
  impliedPrice: number;
  impliedProb: number;
}

export const dynamic = "force-dynamic";

// ─── Paginated fetch ────────────────────────────────────────
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

// ─── Polymarket implied price computation ───────────────────
const N_PER_LEAGUE: Record<string, number> = {
  "Premier League": 20,
  "La Liga": 20,
  Bundesliga: 18,
  "Serie A": 20,
  "Ligue 1": 18,
};

function computePmPrices(
  pmRaw: { league: string; team: string; implied_prob: number; snapshot_time: string }[]
): PmPrice[] {
  // Dedupe: keep latest per team (data is sorted DESC by snapshot_time)
  const pmByTeam = new Map<string, { implied_prob: number; league: string }>();
  for (const r of pmRaw) {
    if (!pmByTeam.has(r.team)) {
      pmByTeam.set(r.team, { implied_prob: r.implied_prob, league: r.league });
    }
  }

  const prices: PmPrice[] = [];
  for (const [team, data] of pmByTeam) {
    if (data.implied_prob <= 0) continue;
    const N = N_PER_LEAGUE[data.league] ?? 20;
    const baselineProb = 1 / N;
    const impliedElo = 1500 + 400 * Math.log10(data.implied_prob / baselineProb);
    const impliedPrice = Math.max(10, (impliedElo - 1000) / 5);
    prices.push({
      team,
      impliedPrice: Math.round(impliedPrice * 100) / 100,
      impliedProb: data.implied_prob,
    });
  }
  return prices;
}

// ─── Server component ──────────────────────────────────────
export default async function OraclePage() {
  const [priceHistory, matches, pmRawResult] = await Promise.all([
    fetchAll<OraclePriceRow>(
      "team_prices",
      "team, league, date, dollar_price, ema_dollar_price, implied_elo",
      { model: "oracle" },
      "date"
    ),
    fetchAll<MatchInfo>(
      "matches",
      "fixture_id, date, league, home_team, away_team, score",
      undefined,
      "date"
    ),
    supabase
      .from("polymarket_futures")
      .select("league, team, implied_prob, snapshot_time")
      .order("snapshot_time", { ascending: false }),
  ]);

  const pmPrices = computePmPrices(
    (pmRawResult.data ?? []) as { league: string; team: string; implied_prob: number; snapshot_time: string }[]
  );

  // Determine date range
  const dates = priceHistory.map((r) => r.date);
  const minDate = dates.length > 0 ? dates[0] : "—";
  const maxDate = dates.length > 0 ? dates[dates.length - 1] : "—";
  const teams = new Set(priceHistory.map((r) => r.team));

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto max-w-7xl flex items-center gap-4">
          <div className="h-2 w-2 rounded-full bg-accent-green animate-pulse" />
          <h1 className="text-lg font-bold tracking-wider text-foreground uppercase">
            Oracle Pricing
          </h1>
          <span className="text-xs text-muted font-mono ml-auto">
            {teams.size} teams &middot; {minDate} → {maxDate} &middot;{" "}
            {matches.filter((m) => m.score && m.score.includes("-")).length} matches
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <OracleClient priceHistory={priceHistory} matches={matches} pmPrices={pmPrices} />
      </main>
    </div>
  );
}
