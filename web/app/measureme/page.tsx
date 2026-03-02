import { supabase } from "@/lib/supabase";
import { MeasureMeClient } from "./measureme-client";

// ─── Types ─────────────────────────────────────────────────
export interface MeasureMeRow {
  id: number;
  run_id: string;
  slope: number;
  k_factor: number;
  decay: number;
  composite_score: number;

  // Raw index values
  surprise_r2: number;
  drift_neutrality: number;
  match_variance_share: number;
  kurtosis: number;
  vol_uniformity_ratio: number;
  mean_rev_sharpe: number;
  info_ratio: number;

  // Index scores (0-100)
  surprise_r2_score: number;
  drift_score: number;
  match_share_score: number;
  kurtosis_score: number;
  vol_uni_score: number;
  mean_rev_score: number;
  info_score: number;

  // Summary stats
  avg_match_move_pct: number;
  avg_annual_vol: number;
  total_matches_evaluated: number;
  total_teams: number;
}

export const dynamic = "force-dynamic";

export default async function MeasureMePage() {
  // Get the latest run_id
  const { data: latestRun } = await supabase
    .from("measureme_results")
    .select("run_id")
    .order("created_at", { ascending: false })
    .limit(1);

  const runId = latestRun?.[0]?.run_id;

  if (!runId) {
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
              MeasureMe
            </h1>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-20 text-center">
          <p className="text-muted font-mono text-sm">
            No results yet. Run{" "}
            <code className="text-accent-green">
              cd scheduler && npm run measureme
            </code>{" "}
            to generate grid search results.
          </p>
        </main>
      </div>
    );
  }

  // Fetch all rows for the latest run, ordered by composite_score DESC
  const allRows: MeasureMeRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("measureme_results")
      .select(
        "id, run_id, slope, k_factor, decay, composite_score, surprise_r2, drift_neutrality, match_variance_share, kurtosis, vol_uniformity_ratio, mean_rev_sharpe, info_ratio, surprise_r2_score, drift_score, match_share_score, kurtosis_score, vol_uni_score, mean_rev_score, info_score, avg_match_move_pct, avg_annual_vol, total_matches_evaluated, total_teams"
      )
      .eq("run_id", runId)
      .order("composite_score", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) {
      console.error("measureme fetch error:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    allRows.push(...(data as MeasureMeRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }

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
            MeasureMe
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
              href="/v3"
              className="text-xs text-accent-green hover:text-foreground transition-colors font-mono uppercase tracking-wider"
            >
              Simulation &rarr;
            </a>
            <span className="text-xs text-muted font-mono">
              {allRows.length} configs &middot; run {runId.slice(0, 16)}
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <MeasureMeClient results={allRows} runId={runId} />
      </main>
    </div>
  );
}
