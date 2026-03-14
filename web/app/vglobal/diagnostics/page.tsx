/**
 * vGlobal Diagnostics — CL Pipeline Diagnostic Dashboard
 *
 * Reads CL-specific data:
 * - settlement_log WHERE competition='champions_league'
 * - oracle_kr_snapshots for CL fixtures
 * - oracle_price_history WHERE competition='champions_league'
 * - matches WHERE league='Champions League'
 *
 * No BT section (CL doesn't trigger BT re-solves).
 */

import { supabase } from "@/lib/supabase";
import { VGlobalDiagnosticsClient } from "./vglobal-diagnostics-client";
import type {
  CLSettlementRow,
  CLKRSnapshotRow,
  CLPriceHistoryRow,
  CLMatchRow,
} from "./vglobal-diagnostics-client";

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

// Fetch KR snapshots for CL fixtures only
async function fetchCLKRSnapshots(clFixtureIds: number[]): Promise<CLKRSnapshotRow[]> {
  if (clFixtureIds.length === 0) return [];
  const all: CLKRSnapshotRow[] = [];
  const chunkSize = 100;
  for (let i = 0; i < clFixtureIds.length; i += chunkSize) {
    const chunk = clFixtureIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("oracle_kr_snapshots")
      .select("fixture_id, bookmaker_count, freeze_timestamp, home_prob, draw_prob, away_prob, home_expected_score, away_expected_score, home_expected_score_raw, away_expected_score_raw, kr_degraded, method")
      .in("fixture_id", chunk);
    if (error) { console.error("oracle_kr_snapshots CL fetch error:", error.message); continue; }
    if (data) all.push(...(data as CLKRSnapshotRow[]));
  }
  return all;
}

// CL price history
async function fetchCLPriceHistory(): Promise<CLPriceHistoryRow[]> {
  const all: CLPriceHistoryRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("oracle_price_history")
      .select("team, league, timestamp, B_value:b_value, M1_value:m1_value, published_index, publish_reason")
      .eq("competition", "champions_league")
      .range(from, from + pageSize - 1)
      .order("timestamp", { ascending: true });
    if (error) { console.error("oracle_price_history CL fetch error:", error.message); break; }
    if (!data || data.length === 0) break;
    all.push(...(data as CLPriceHistoryRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ─── Server component ──────────────────────────────────────
export default async function VGlobalDiagnosticsPage() {
  // Fetch CL matches first to get fixture IDs for KR lookup
  const clMatches = await fetchAll<CLMatchRow>(
    "matches",
    "fixture_id, date, league, home_team, away_team, score, status",
    [{ column: "league", value: "Champions League" }],
    "date",
    true
  );

  const clFixtureIds = clMatches.map(m => m.fixture_id);

  const [rawSettlements, krSnapshots, priceHistory] = await Promise.all([
    fetchAll<CLSettlementRow>(
      "settlement_log",
      "settlement_id, fixture_id, team_id, E_KR:e_kr, actual_score_S:actual_score_s, delta_B:delta_b, B_before:b_before, B_after:b_after, settled_at, gravity_component",
      [{ column: "oracle_version", value: "v3" }, { column: "competition", value: "champions_league" }],
      "settled_at",
      true
    ),
    fetchCLKRSnapshots(clFixtureIds),
    fetchCLPriceHistory(),
  ]);

  // Filter out error settlements
  const settlements = rawSettlements.filter(
    (s) => !(Number(s.delta_B) === 0 && Number(s.B_before) === 0)
  );

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto max-w-7xl flex items-center gap-4">
          <div className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
          <h1 className="text-lg font-bold tracking-wider text-foreground uppercase">
            CL Diagnostics
          </h1>
          <span className="text-xs text-amber-400 font-mono">
            vGlobal &middot; &gamma;=0 &middot; no BT
          </span>
          <span className="text-xs text-muted font-mono ml-auto">
            {settlements.length} settlements &middot; {krSnapshots.length} KR snapshots &middot; {clMatches.length} matches
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <VGlobalDiagnosticsClient
          settlements={settlements}
          krSnapshots={krSnapshots}
          priceHistory={priceHistory}
          matches={clMatches}
        />
      </main>
    </div>
  );
}
