/**
 * Oracle V3 Diagnostics — Pipeline Diagnostic Dashboard
 *
 * Reads from V3-specific tables:
 * - team_oracle_v3_state
 * - settlement_log WHERE oracle_version='v3' (includes gravity_component)
 * - oracle_price_history with V3 publish reasons
 * - oracle_bt_snapshots (Bradley-Terry solve history)
 *
 * Single scrollable page — no tabs.
 */

import { supabase } from "@/lib/supabase";
import { DiagnosticsV3Client } from "./diagnostics-v3-client";
import type {
  V3SettlementRow,
  KRSnapshotRow,
  TeamStateRow,
  PriceHistoryRow,
  MatchRow,
  BTSnapshotRow,
} from "./diagnostics-v3-client";

export const dynamic = "force-dynamic";

// ─── Paginated fetch ────────────────────────────────────────
async function fetchAll<T>(
  table: string,
  select: string,
  filters?: { column: string; value: string }[],
  orderCol?: string,
  ascending = true
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (filters) {
      for (const f of filters) q = q.eq(f.column, f.value);
    }
    if (orderCol) q = q.order(orderCol, { ascending });
    const { data, error } = await q;
    if (error) { console.error(`${table} fetch error:`, error.message); break; }
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// V3 price history: settlement_v3 + bootstrap_v3
async function fetchV3PriceHistory(): Promise<PriceHistoryRow[]> {
  const all: PriceHistoryRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("oracle_price_history")
      .select("team, league, timestamp, B_value:b_value, M1_value:m1_value, published_index, publish_reason")
      .in("publish_reason", ["settlement_v3", "bootstrap_v3"])
      .range(from, from + pageSize - 1)
      .order("timestamp", { ascending: true });
    if (error) { console.error("oracle_price_history V3 fetch error:", error.message); break; }
    if (!data || data.length === 0) break;
    all.push(...(data as PriceHistoryRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// BT snapshots: latest 100 rows
async function fetchBTSnapshots(): Promise<BTSnapshotRow[]> {
  const { data, error } = await supabase
    .from("oracle_bt_snapshots")
    .select("id, league, solve_timestamp, fixtures_used, teams_count, iterations, max_step, converged, sigma_prior, home_adv, window_days, ratings, std_errors")
    .order("solve_timestamp", { ascending: false })
    .limit(100);
  if (error) { console.error("oracle_bt_snapshots fetch error:", error.message); return []; }
  return (data ?? []) as BTSnapshotRow[];
}

// ─── Server component ──────────────────────────────────────
export default async function DiagnosticsV3Page() {
  const [rawSettlements, krSnapshots, teamStates, priceHistory, matches, btSnapshots] =
    await Promise.all([
      fetchAll<V3SettlementRow>(
        "settlement_log",
        "settlement_id, fixture_id, team_id, E_KR:e_kr, actual_score_S:actual_score_s, delta_B:delta_b, B_before:b_before, B_after:b_after, settled_at, gravity_component",
        [{ column: "oracle_version", value: "v3" }],
        "settled_at",
        true
      ),
      fetchAll<KRSnapshotRow>(
        "oracle_kr_snapshots",
        "fixture_id, bookmaker_count, freeze_timestamp, home_prob, draw_prob, away_prob, home_expected_score, away_expected_score, kr_degraded, method",
        undefined,
        "freeze_timestamp",
        true
      ),
      fetchAll<TeamStateRow>(
        "team_oracle_v3_state",
        "team_id, B_value:b_value, M1_value:m1_value, published_index, confidence_score, last_market_refresh_ts, updated_at"
      ),
      fetchV3PriceHistory(),
      fetchAll<MatchRow>(
        "matches",
        "fixture_id, date, league, home_team, away_team, score, status",
        undefined,
        "date",
        true
      ),
      fetchBTSnapshots(),
    ]);

  // Filter out error settlements
  const settlements = rawSettlements.filter(
    (s) => !(Number(s.delta_B) === 0 && Number(s.B_before) === 0)
  );

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto max-w-7xl flex items-center gap-4">
          <div className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
          <h1 className="text-lg font-bold tracking-wider text-foreground uppercase">
            Diagnostics
          </h1>
          <span className="text-xs text-cyan-400 font-mono">
            Oracle V3 &middot; bradley-terry MAP &middot; &gamma;=0.08
          </span>
          <span className="text-xs text-muted font-mono ml-auto">
            {settlements.length} settlements &middot; {teamStates.length} teams &middot; {krSnapshots.length} KR snapshots
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <DiagnosticsV3Client
          settlements={settlements}
          krSnapshots={krSnapshots}
          teamStates={teamStates}
          priceHistory={priceHistory}
          matches={matches}
          btSnapshots={btSnapshots}
        />
      </main>
    </div>
  );
}
