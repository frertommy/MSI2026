import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * GET /api/v3/bt-snapshots
 *
 * Returns recent Bradley-Terry solve snapshots.
 * Query params:
 *   league (optional): filter by league name
 *   limit (optional): default 50, max 200
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=30",
};

export async function GET(req: NextRequest) {
  try {
    const leagueParam = req.nextUrl.searchParams.get("league");
    const limitParam = req.nextUrl.searchParams.get("limit");

    let limit = 50;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed >= 1) limit = Math.min(parsed, 200);
    }

    let query = supabase
      .from("oracle_bt_snapshots")
      .select("id, league, solve_timestamp, fixtures_used, teams_count, iterations, max_step, converged, sigma_prior, home_adv, window_days, ratings, std_errors, prior_means")
      .order("solve_timestamp", { ascending: false })
      .limit(limit);

    if (leagueParam) {
      query = query.eq("league", leagueParam);
    }

    const { data, error } = await query;

    if (error) {
      console.error("v3/bt-snapshots fetch error:", error.message);
      return NextResponse.json(
        { error: "Failed to fetch BT snapshots" },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(
      { snapshots: data ?? [] },
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    console.error("v3/bt-snapshots unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
