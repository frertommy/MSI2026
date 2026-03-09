import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * GET /api/v2/prices
 *
 * Returns current prices for all EPL & La Liga teams.
 * Query params:
 *   league (optional): "epl" | "laliga"
 */

const LEAGUE_MAP: Record<string, string> = {
  epl: "Premier League",
  laliga: "La Liga",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=30",
};

// team_oracle_v2_state has NO league column.
// Resolve league by querying matches for distinct home_team per league.
async function buildTeamLeagueMap(): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("matches")
    .select("home_team, league")
    .in("league", ["Premier League", "La Liga"]);

  if (error || !data) return new Map();

  const map = new Map<string, string>();
  for (const row of data as unknown as { home_team: string; league: string }[]) {
    if (!map.has(row.home_team)) {
      map.set(row.home_team, row.league);
    }
  }
  return map;
}

interface StateRow {
  team_id: string;
  b_value: number;
  m1_value: number;
  l_value: number;
  f_value: number;
  published_index: number;
  confidence_score: number | null;
  updated_at: string;
}

export async function GET(req: NextRequest) {
  try {
    const leagueParam = req.nextUrl.searchParams.get("league");

    if (leagueParam && !LEAGUE_MAP[leagueParam]) {
      return NextResponse.json(
        {
          error: `Invalid league param: "${leagueParam}". Use "epl" or "laliga".`,
        },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const leagueFilter = leagueParam ? LEAGUE_MAP[leagueParam] : null;

    // Fetch all V2 state rows + team→league mapping in parallel
    const [stateResult, teamLeague] = await Promise.all([
      supabase
        .from("team_oracle_v2_state")
        .select(
          "team_id, b_value, m1_value, l_value, f_value, published_index, confidence_score, updated_at"
        ),
      buildTeamLeagueMap(),
    ]);

    if (stateResult.error) {
      console.error("v2/prices state fetch error:", stateResult.error.message);
      return NextResponse.json(
        { error: "Failed to fetch team state" },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const rows = (stateResult.data as unknown as StateRow[]) ?? [];

    // Filter to EPL/La Liga, optionally to a single league
    const filtered = rows.filter((r) => {
      const league = teamLeague.get(r.team_id);
      if (!league) return false;
      if (leagueFilter && league !== leagueFilter) return false;
      return true;
    });

    // Sort by published_index descending
    filtered.sort(
      (a, b) => Number(b.published_index) - Number(a.published_index)
    );

    const teams = filtered.map((r) => {
      const idx = Math.round(Number(r.published_index) * 100) / 100;
      return {
        team_id: r.team_id,
        league: teamLeague.get(r.team_id)!,
        index: idx,
        price: Math.round(((idx - 800) / 5) * 100) / 100,
        components: {
          b: Math.round(Number(r.b_value) * 100) / 100,
          m1: Math.round(Number(r.m1_value) * 100) / 100,
          l: Math.round(Number(r.l_value ?? 0) * 100) / 100,
          f: Math.round(Number(r.f_value ?? 0) * 100) / 100,
        },
        confidence:
          Math.round(Number(r.confidence_score ?? 0) * 100) / 100,
        updated_at: r.updated_at,
      };
    });

    return NextResponse.json(
      { timestamp: new Date().toISOString(), teams },
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    console.error("v2/prices unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
