/**
 * MeasureMe V1.4 — Oracle Pipeline Diagnostic Dashboard
 *
 * Server component: fetches settlement, KR, team state, price history, matches
 * in parallel, then passes to MeasureMeClient for interactive analysis.
 */

import { supabase } from "@/lib/supabase";
import { MeasureMeClient } from "./measureme-client";

// ─── Types (shared with client) ─────────────────────────────

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
}

export interface KRSnapshotRow {
  fixture_id: number;
  bookmaker_count: number;
  freeze_timestamp: string;
  home_prob: number;
  draw_prob: number;
  away_prob: number;
  home_expected_score: number;
  away_expected_score: number;
  kr_degraded: boolean;
  method: string;
}

export interface TeamStateRow {
  team_id: string;
  B_value: number;
  M1_value: number;
  published_index: number;
  confidence_score: number | null;
  last_market_refresh_ts: string | null;
  updated_at: string;
}

export interface PriceHistoryRow {
  team: string;
  league: string;
  timestamp: string;
  B_value: number;
  M1_value: number;
  published_index: number;
  publish_reason: string;
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

export const dynamic = "force-dynamic";

// ─── Paginated fetch ────────────────────────────────────────
async function fetchAll<T>(
  table: string,
  select: string,
  orderCol?: string,
  ascending = true
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
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

// Filtered fetch for price history (settlement + bootstrap only)
async function fetchPriceHistory(): Promise<PriceHistoryRow[]> {
  const all: PriceHistoryRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("oracle_price_history")
      .select("team, league, timestamp, B_value:b_value, M1_value:m1_value, published_index, publish_reason")
      .in("publish_reason", ["settlement", "bootstrap"])
      .range(from, from + pageSize - 1)
      .order("timestamp", { ascending: true });
    if (error) {
      console.error("oracle_price_history fetch error:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as PriceHistoryRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ─── Raw settlement type (before error filter) ──────────────
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
export default async function MeasureMePage() {
  const [rawSettlements, krSnapshots, teamStates, priceHistory, matches] =
    await Promise.all([
      fetchAll<RawSettlementRow>(
        "settlement_log",
        "settlement_id, fixture_id, team_id, E_KR:e_kr, actual_score_S:actual_score_s, delta_B:delta_b, B_before:b_before, B_after:b_after, settled_at",
        "settled_at",
        true
      ),
      fetchAll<KRSnapshotRow>(
        "oracle_kr_snapshots",
        "fixture_id, bookmaker_count, freeze_timestamp, home_prob, draw_prob, away_prob, home_expected_score, away_expected_score, kr_degraded, method",
        "freeze_timestamp",
        true
      ),
      fetchAll<TeamStateRow>(
        "team_oracle_state",
        "team_id, B_value:b_value, M1_value:m1_value, published_index, confidence_score, last_market_refresh_ts, updated_at"
      ),
      fetchPriceHistory(),
      fetchAll<MatchRow>(
        "matches",
        "fixture_id, date, league, home_team, away_team, score, status",
        "date",
        true
      ),
    ]);

  // Filter out error settlements (delta_b=0 AND b_before=0)
  const settlements: SettlementRow[] = rawSettlements.filter(
    (s) => !(Number(s.delta_B) === 0 && Number(s.B_before) === 0)
  );

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto max-w-7xl flex items-center gap-4">
          <div className="h-2 w-2 rounded-full bg-accent-amber animate-pulse" />
          <h1 className="text-lg font-bold tracking-wider text-foreground uppercase">
            MeasureMe
          </h1>
          <span className="text-xs text-muted font-mono">Oracle V1.4 Diagnostics</span>
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
