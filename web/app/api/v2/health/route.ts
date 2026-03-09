import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * GET /api/v2/health
 *
 * Health check for Oracle V2.
 * Returns team count (EPL + La Liga only), last settlement, last market refresh.
 *
 * Notes:
 *   - team_oracle_v2_state has NO league column — filter by team_id list
 *   - last_settlement may be null (V2 settlement cycle hasn't run yet)
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=30",
};

// Hardcoded EPL + La Liga team lists (20 + 20 = 40, stable within a season)
const EPL_TEAMS = [
  "Arsenal",
  "Aston Villa",
  "Bournemouth",
  "Brentford",
  "Brighton",
  "Burnley",
  "Chelsea",
  "Crystal Palace",
  "Everton",
  "Fulham",
  "Leeds",
  "Liverpool",
  "Manchester City",
  "Manchester United",
  "Newcastle",
  "Nottingham Forest",
  "Sunderland",
  "Tottenham",
  "West Ham",
  "Wolves",
];

const LALIGA_TEAMS = [
  "Alaves",
  "Athletic Club",
  "Atletico Madrid",
  "Barcelona",
  "Celta Vigo",
  "Elche",
  "Espanyol",
  "Getafe",
  "Girona",
  "Levante",
  "Mallorca",
  "Osasuna",
  "Oviedo",
  "Rayo Vallecano",
  "Real Betis",
  "Real Madrid",
  "Real Sociedad",
  "Sevilla",
  "Valencia",
  "Villarreal",
];

const ALL_TEAMS = [...EPL_TEAMS, ...LALIGA_TEAMS];

export async function GET() {
  try {
    // Count EPL + La Liga teams in state + get latest market refresh
    const { data: stateRows, error: stateErr } = await supabase
      .from("team_oracle_v2_state")
      .select("team_id, last_market_refresh_ts")
      .in("team_id", ALL_TEAMS);

    if (stateErr) {
      console.error("v2/health state fetch error:", stateErr.message);
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

    // Last V2 settlement (may be null — V2 settlements haven't run yet)
    const { data: settlementData } = await supabase
      .from("settlement_log")
      .select("settled_at")
      .eq("oracle_version", "v2")
      .order("settled_at", { ascending: false })
      .limit(1);

    const lastSettlement =
      (
        settlementData as unknown as { settled_at: string }[] | null
      )?.[0]?.settled_at ?? null;

    return NextResponse.json(
      {
        status: "ok",
        oracle_version: "v2",
        leagues: ["Premier League", "La Liga"],
        team_count: teamCount,
        last_settlement: lastSettlement,
        last_market_refresh: lastMarketRefresh,
      },
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    console.error("v2/health unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
