/**
 * Oracle V2 Diagnostics — Pipeline Diagnostic Dashboard
 *
 * Same structure as V1 MeasureMe but reads from V2 tables:
 * - team_oracle_v2_state instead of team_oracle_state
 * - settlement_log WHERE oracle_version='v2'
 * - oracle_price_history with V2 publish reasons
 */

import { supabase } from "@/lib/supabase";
import { MeasureMeClient } from "../../measureme/measureme-client";
import type {
  SettlementRow,
  KRSnapshotRow,
  TeamStateRow,
  PriceHistoryRow,
  MatchRow,
} from "../../measureme/page";

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
      for (const f of filters) {
        q = q.eq(f.column, f.value);
      }
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

// V2 price history: settlement_v2 + bootstrap_v2
async function fetchV2PriceHistory(): Promise<PriceHistoryRow[]> {
  const all: PriceHistoryRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("oracle_price_history")
      .select("team, league, timestamp, B_value:b_value, M1_value:m1_value, published_index, publish_reason")
      .in("publish_reason", ["settlement_v2", "bootstrap_v2"])
      .range(from, from + pageSize - 1)
      .order("timestamp", { ascending: true });
    if (error) {
      console.error("oracle_price_history V2 fetch error:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as PriceHistoryRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ─── Raw settlement type ──────────────────────────────────
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
export default async function DiagnosticsV2Page() {
  const [rawSettlements, krSnapshots, teamStates, priceHistory, matches] =
    await Promise.all([
      fetchAll<RawSettlementRow>(
        "settlement_log",
        "settlement_id, fixture_id, team_id, E_KR:e_kr, actual_score_S:actual_score_s, delta_B:delta_b, B_before:b_before, B_after:b_after, settled_at",
        [{ column: "oracle_version", value: "v2" }],
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
        "team_oracle_v2_state",
        "team_id, B_value:b_value, M1_value:m1_value, published_index, confidence_score, last_market_refresh_ts, updated_at"
      ),
      fetchV2PriceHistory(),
      fetchAll<MatchRow>(
        "matches",
        "fixture_id, date, league, home_team, away_team, score, status",
        undefined,
        "date",
        true
      ),
    ]);

  // Filter out error settlements
  const settlements: SettlementRow[] = rawSettlements.filter(
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
          <span className="text-xs text-cyan-400 font-mono">Oracle V2 · gravity-on-settlement · &gamma;=0.05</span>
          <span className="text-xs text-muted font-mono ml-auto">
            {settlements.length} settlements &middot; {teamStates.length} teams &middot; {krSnapshots.length} KR snapshots
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <MeasureMeClient
          settlements={settlements}
          krSnapshots={krSnapshots}
          teamStates={teamStates}
          priceHistory={priceHistory}
          matches={matches}
        />
      </main>
    </div>
  );
}
