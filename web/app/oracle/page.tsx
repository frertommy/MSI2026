/**
 * Oracle V1 — Server Component
 *
 * Data fetched on page load (initial payload):
 *   - team_oracle_state: ~125 rows (team rankings table)
 *   - settlement_log: ~2,500 rows (without trace_payload — stripped for perf)
 *   - matches: ~4,800 rows (fixture lookup for chart enrichment)
 *
 * Data fetched on demand (lazy, per team click):
 *   - oracle_price_history: ~30–100 rows per team via GET /api/price-history?team=X
 *     (market_refresh rows deduplicated server-side — only latest per date)
 *
 * Estimated initial payload reduction:
 *   - Removed oracle_price_history from SSR props: ~10,000+ rows eliminated
 *   - Removed trace_payload JSON blobs from settlements: ~500KB–1MB eliminated
 *
 * Remaining large fetches that could be further optimized:
 *   - matches table (~4,800 rows) — could be reduced to only teams in team_oracle_state
 *   - settlement_log (~2,500 rows) — could paginate or lazy-load per team
 */

import { supabase } from "@/lib/supabase";
import { OracleV1Client } from "./oracle-v1-client";

// ─── Types (shared with client) ─────────────────────────────
export interface TeamOracleRow {
  team_id: string;
  season: string | null;
  B_value: number;
  M1_value: number;
  published_index: number;
  confidence_score: number | null;
  next_fixture_id: number | null;
  last_market_refresh_ts: string | null;
  updated_at: string;
}

export interface SettlementRow {
  settlement_id: number;
  fixture_id: number;
  team_id: string;
  E_KR: number;
  actual_score_S: number;
  delta_B: number;
  B_before: number;
  B_after: number;
  settled_at: string;
  has_error: boolean;
}

export interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
  commence_time: string | null;
}

export interface PriceHistoryRow {
  id: number;
  team: string;
  league: string;
  timestamp: string;
  B_value: number;
  M1_value: number;
  published_index: number;
  confidence_score: number | null;
  source_fixture_id: number | null;
  publish_reason: string;
}

export const dynamic = "force-dynamic";

// ─── Paginated fetch ────────────────────────────────────────
async function fetchAll<T>(
  table: string,
  select: string,
  filters?: Record<string, string | number>,
  orderCol?: string,
  ascending = true
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (filters) {
      for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    }
    if (orderCol) q = q.order(orderCol, { ascending });
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

// ─── Raw settlement type (before has_error transform) ───────
interface RawSettlementRow {
  settlement_id: number;
  fixture_id: number;
  team_id: string;
  E_KR: number;
  actual_score_S: number;
  delta_B: number;
  B_before: number;
  B_after: number;
  settled_at: string;
}

// ─── Server component ──────────────────────────────────────
export default async function OracleV1Page() {
  const [teamStates, rawSettlements, matches] = await Promise.all([
    fetchAll<TeamOracleRow>(
      "team_oracle_state",
      "team_id, season, B_value:b_value, M1_value:m1_value, published_index, confidence_score, next_fixture_id, last_market_refresh_ts, updated_at"
    ),
    fetchAll<RawSettlementRow>(
      "settlement_log",
      "settlement_id, fixture_id, team_id, E_KR:e_kr, actual_score_S:actual_score_s, delta_B:delta_b, B_before:b_before, B_after:b_after, settled_at",
      undefined,
      "settled_at",
      false // most recent first
    ),
    fetchAll<MatchRow>(
      "matches",
      "fixture_id, date, league, home_team, away_team, score, status, commence_time",
      undefined,
      "date",
      true
    ),
  ]);

  // Compute has_error server-side (replaces trace_payload.error check)
  // Error settlements have delta_b = 0 and b_before = 0
  const settlements: SettlementRow[] = rawSettlements.map((s) => ({
    ...s,
    has_error: Number(s.delta_B) === 0 && Number(s.B_before) === 0,
  }));

  const teamCount = teamStates.length;
  const settlementCount = settlements.filter((s) => !s.has_error).length;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto max-w-7xl flex items-center gap-4">
          <div className="h-2 w-2 rounded-full bg-accent-green animate-pulse" />
          <h1 className="text-lg font-bold tracking-wider text-foreground uppercase">
            Oracle V1
          </h1>
          <span className="text-xs text-muted font-mono ml-auto">
            {teamCount} teams &middot; {settlementCount} settlements
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        {teamCount === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="text-muted text-sm font-mono mb-2">
              Oracle v1 not yet active
            </div>
            <div className="text-muted/60 text-xs font-mono max-w-md">
              Set ORACLE_V1_ENABLED=true in your environment to start the settlement + M1 cycle.
              Team data will appear here once the first matches are settled.
            </div>
          </div>
        ) : (
          <OracleV1Client
            teamStates={teamStates}
            settlements={settlements}
            matches={matches}
          />
        )}
      </main>
    </div>
  );
}
