import { supabase } from "@/lib/supabase";
import { MeasureMeClient } from "./measureme-client";

// ─── Types ─────────────────────────────────────────────────
export interface MeasureMeRow {
  id: number;
  run_id: string;
  slope: number;
  k_factor: number;
  decay: number;
  zero_point: number;
  composite_score: number;

  prematch_weight: number;

  // Raw index values
  surprise_r2: number;
  drift_neutrality: number;
  floor_hit_pct: number;
  kurtosis: number;
  vol_uniformity_ratio: number;
  mean_rev_sharpe: number;
  info_ratio: number;
  odds_responsiveness: number;
  venue_stability: number;
  between_match_vol: number;

  // Index scores (0-100)
  surprise_r2_score: number;
  drift_score: number;
  floor_hit_score: number;
  kurtosis_score: number;
  vol_uni_score: number;
  mean_rev_score: number;
  info_score: number;
  odds_responsiveness_score: number;
  venue_stability_score: number;
  between_match_vol_score: number;

  // Summary stats
  avg_match_move_pct: number;
  avg_annual_vol: number;
  total_matches_evaluated: number;
  total_teams: number;
  teams_at_floor: number;
}

export interface TeamEloRow {
  team: string;
  implied_elo: number;
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
      .select("*")
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

  // Fetch latest team Elos from team_prices for Price Implications
  let teamElos: TeamEloRow[] = [];
  const { data: latestDate } = await supabase
    .from("team_prices")
    .select("date")
    .eq("model", "oracle")
    .order("date", { ascending: false })
    .limit(1);

  if (latestDate?.[0]?.date) {
    const { data: eloData } = await supabase
      .from("team_prices")
      .select("team, implied_elo")
      .eq("model", "oracle")
      .eq("date", latestDate[0].date)
      .order("implied_elo", { ascending: false });
    teamElos = (eloData ?? []) as TeamEloRow[];
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
              href="/old/v3"
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
        <MeasureMeClient
          results={allRows}
          runId={runId}
          teamElos={teamElos}
        />
      </main>
    </div>
  );
}
