import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * GET /api/v3/health
 *
 * Health check for Oracle V3.
 * Returns team count, last settlement, last market refresh, last BT solve.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=30",
};

export async function GET() {
  try {
    // Count teams in V3 state + get latest market refresh
    const { data: stateRows, error: stateErr } = await supabase
      .from("team_oracle_v3_state")
      .select("team_id, last_market_refresh_ts");

    if (stateErr) {
      console.error("v3/health state fetch error:", stateErr.message);
      return NextResponse.json(
        { error: "Failed to fetch team state" },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const rows =
      (stateRows as unknown as {
        team_id: string;
        last_market_refresh_ts: string | null;
      }[]) ?? [];

    const teamCount = rows.length;

    // Find latest market refresh across all teams
    let lastMarketRefresh: string | null = null;
    for (const r of rows) {
      if (
        r.last_market_refresh_ts &&
        (!lastMarketRefresh ||
          r.last_market_refresh_ts > lastMarketRefresh)
      ) {
        lastMarketRefresh = r.last_market_refresh_ts;
      }
    }

    // Last V3 settlement
    const { data: settlementData } = await supabase
      .from("settlement_log")
      .select("settled_at")
      .eq("oracle_version", "v3")
      .order("settled_at", { ascending: false })
      .limit(1);

    const lastSettlement =
      (
        settlementData as unknown as { settled_at: string }[] | null
      )?.[0]?.settled_at ?? null;

    // Last BT solve
    const { data: btData } = await supabase
      .from("oracle_bt_snapshots")
      .select("solve_timestamp, league, converged")
      .order("solve_timestamp", { ascending: false })
      .limit(1);

    const lastBTSolve = btData?.[0] ?? null;

    return NextResponse.json(
      {
        status: "ok",
        oracle_version: "v3",
        team_count: teamCount,
        last_settlement: lastSettlement,
        last_market_refresh: lastMarketRefresh,
        last_bt_solve: lastBTSolve,
      },
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    console.error("v3/health unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
