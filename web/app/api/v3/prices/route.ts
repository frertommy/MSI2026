import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * GET /api/v3/prices
 *
 * Returns current prices for all teams in V3 state.
 * Query params:
 *   league (optional): "epl" | "laliga"
 */

const LEAGUE_MAP: Record<string, string> = {
  epl: "Premier League",
  laliga: "La Liga",
  bundesliga: "Bundesliga",
  seriea: "Serie A",
  ligue1: "Ligue 1",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=30",
};

async function buildTeamLeagueMap(): Promise<Map<string, string>> {
  const allLeagues = ["Premier League", "La Liga", "Bundesliga", "Serie A", "Ligue 1"];
  const map = new Map<string, string>();
  const pageSize = 1000;
  let from = 0;

  // Paginate to avoid Supabase 1000-row default limit
  while (true) {
    const { data, error } = await supabase
      .from("matches")
      .select("home_team, away_team, league")
      .in("league", allLeagues)
      .range(from, from + pageSize - 1);

    if (error || !data || data.length === 0) break;

    for (const row of data as unknown as { home_team: string; away_team: string; league: string }[]) {
      if (!map.has(row.home_team)) map.set(row.home_team, row.league);
      if (!map.has(row.away_team)) map.set(row.away_team, row.league);
    }

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return map;
}

interface StateRow {
  team_id: string;
  b_value: number;
  m1_value: number;
  l_value: number;
  published_index: number;
  confidence_score: number | null;
  bt_std_error: number | null;
  updated_at: string;
}

export async function GET(req: NextRequest) {
  try {
    const leagueParam = req.nextUrl.searchParams.get("league");

    if (leagueParam && !LEAGUE_MAP[leagueParam]) {
      return NextResponse.json(
        {
          error: `Invalid league param: "${leagueParam}". Use "epl", "laliga", "bundesliga", "seriea", or "ligue1".`,
        },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const leagueFilter = leagueParam ? LEAGUE_MAP[leagueParam] : null;

    const [stateResult, teamLeague] = await Promise.all([
      supabase
        .from("team_oracle_v3_state")
        .select(
          "team_id, b_value, m1_value, l_value, published_index, confidence_score, bt_std_error, updated_at"
        ),
      buildTeamLeagueMap(),
    ]);

    if (stateResult.error) {
      console.error("v3/prices state fetch error:", stateResult.error.message);
      return NextResponse.json(
        { error: "Failed to fetch team state" },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const rows = (stateResult.data as unknown as StateRow[]) ?? [];

    const filtered = rows.filter((r) => {
      const league = teamLeague.get(r.team_id);
      if (!league) return false;
      if (leagueFilter && league !== leagueFilter) return false;
      return true;
    });

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
        },
        confidence:
          Math.round(Number(r.confidence_score ?? 0) * 100) / 100,
        bt_std_error:
          r.bt_std_error != null
            ? Math.round(Number(r.bt_std_error) * 100) / 100
            : null,
        updated_at: r.updated_at,
      };
    });

    return NextResponse.json(
      { timestamp: new Date().toISOString(), teams },
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    console.error("v3/prices unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
