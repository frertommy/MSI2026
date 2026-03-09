import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * GET /api/v2/matches
 *
 * Returns upcoming and recent settled matches with price impact predictions.
 * Query params:
 *   league (optional): "epl" | "laliga"
 *   status (optional): "upcoming" | "settled" | "all" (default "all")
 *   limit (optional): default 20, max 50
 *
 * Notes:
 *   - Match status values in DB: "upcoming", "finished", "cancelled" (no "scheduled")
 *   - Predictions use K=30 and exclude gravity nudge (~0.05 × drift)
 *   - V2 settlements (oracle_version='v2') may not exist yet — settled section returns empty
 */

const LEAGUE_MAP: Record<string, string> = {
  epl: "Premier League",
  laliga: "La Liga",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=60",
};

const K = 30;

interface MatchRow {
  fixture_id: number;
  league: string;
  home_team: string;
  away_team: string;
  commence_time: string | null;
  status: string;
  score: string | null;
}

interface KRRow {
  fixture_id: number;
  home_expected_score: number;
  away_expected_score: number;
}

interface StateRow {
  team_id: string;
  published_index: number;
}

interface SettlementRow {
  fixture_id: number;
  team_id: string;
  E_KR: number;
  actual_score_S: number;
  delta_B: number;
  B_before: number;
  B_after: number;
  settled_at: string;
  gravity_component: number | null;
}

export async function GET(req: NextRequest) {
  try {
    const leagueParam = req.nextUrl.searchParams.get("league");
    const statusParam = req.nextUrl.searchParams.get("status") ?? "all";
    const limitParam = req.nextUrl.searchParams.get("limit");

    // Validate league
    if (leagueParam && !LEAGUE_MAP[leagueParam]) {
      return NextResponse.json(
        {
          error: `Invalid league param: "${leagueParam}". Use "epl" or "laliga".`,
        },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // Validate status
    if (!["upcoming", "settled", "all"].includes(statusParam)) {
      return NextResponse.json(
        {
          error: `Invalid status param: "${statusParam}". Use "upcoming", "settled", or "all".`,
        },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    let limit = 20;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed >= 1) limit = Math.min(parsed, 50);
    }

    const leagues = leagueParam
      ? [LEAGUE_MAP[leagueParam]]
      : ["Premier League", "La Liga"];

    const results: unknown[] = [];

    // ─── Upcoming matches ─────────────────────────────────────
    if (statusParam === "upcoming" || statusParam === "all") {
      const upcomingMatches = await fetchUpcomingMatches(leagues, limit);

      if (upcomingMatches.length > 0) {
        const fixtureIds = upcomingMatches.map((m) => m.fixture_id);
        const teamIds = [
          ...new Set(
            upcomingMatches.flatMap((m) => [m.home_team, m.away_team])
          ),
        ];

        // Fetch KR snapshots + current team state in parallel
        const [krMap, stateMap] = await Promise.all([
          fetchKRSnapshots(fixtureIds),
          fetchTeamState(teamIds),
        ]);

        for (const match of upcomingMatches) {
          const homeState = stateMap.get(match.home_team);
          const awayState = stateMap.get(match.away_team);
          const kr = krMap.get(match.fixture_id);

          const homeIdx = homeState
            ? round2(Number(homeState.published_index))
            : null;
          const awayIdx = awayState
            ? round2(Number(awayState.published_index))
            : null;

          const entry: Record<string, unknown> = {
            fixture_id: match.fixture_id,
            league: match.league,
            home: {
              team_id: match.home_team,
              index: homeIdx,
              price:
                homeIdx !== null
                  ? round2((homeIdx - 800) / 5)
                  : null,
            },
            away: {
              team_id: match.away_team,
              index: awayIdx,
              price:
                awayIdx !== null
                  ? round2((awayIdx - 800) / 5)
                  : null,
            },
            kickoff: match.commence_time,
            status: "upcoming",
          };

          // Add predictions if KR snapshot exists
          if (kr) {
            const eHome = Number(kr.home_expected_score);
            const eAway = Number(kr.away_expected_score);

            entry.predictions = {
              home_win: {
                delta_price_home: round2((K * (1.0 - eHome)) / 5),
                delta_price_away: round2((K * (0.0 - eAway)) / 5),
              },
              draw: {
                delta_price_home: round2((K * (0.5 - eHome)) / 5),
                delta_price_away: round2((K * (0.5 - eAway)) / 5),
              },
              away_win: {
                delta_price_home: round2((K * (0.0 - eHome)) / 5),
                delta_price_away: round2((K * (1.0 - eAway)) / 5),
              },
              note: "Predictions exclude gravity nudge (~0.05 * drift).",
            };
          }

          results.push(entry);
        }
      }
    }

    // ─── Settled matches ──────────────────────────────────────
    if (statusParam === "settled" || statusParam === "all") {
      const remaining = limit - results.length;
      if (remaining > 0) {
        const settled = await fetchSettledMatches(leagues, remaining);
        results.push(...settled);
      }
    }

    return NextResponse.json(
      { matches: results },
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    console.error("v2/matches unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function fetchUpcomingMatches(
  leagues: string[],
  limit: number
): Promise<MatchRow[]> {
  // DB status is "upcoming" (no "scheduled" exists)
  const { data, error } = await supabase
    .from("matches")
    .select(
      "fixture_id, league, home_team, away_team, commence_time, status, score"
    )
    .eq("status", "upcoming")
    .in("league", leagues)
    .order("commence_time", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("v2/matches upcoming fetch error:", error.message);
    return [];
  }

  return (data as unknown as MatchRow[]) ?? [];
}

async function fetchKRSnapshots(
  fixtureIds: number[]
): Promise<Map<number, KRRow>> {
  if (fixtureIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("oracle_kr_snapshots")
    .select("fixture_id, home_expected_score, away_expected_score")
    .in("fixture_id", fixtureIds);

  if (error) {
    console.error("v2/matches KR fetch error:", error.message);
    return new Map();
  }

  const map = new Map<number, KRRow>();
  for (const row of (data as unknown as KRRow[]) ?? []) {
    map.set(row.fixture_id, row);
  }
  return map;
}

async function fetchTeamState(
  teamIds: string[]
): Promise<Map<string, StateRow>> {
  if (teamIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("team_oracle_v2_state")
    .select("team_id, published_index")
    .in("team_id", teamIds);

  if (error) {
    console.error("v2/matches state fetch error:", error.message);
    return new Map();
  }

  const map = new Map<string, StateRow>();
  for (const row of (data as unknown as StateRow[]) ?? []) {
    map.set(row.team_id, row);
  }
  return map;
}

async function fetchSettledMatches(
  leagues: string[],
  limit: number
): Promise<unknown[]> {
  // Get recent V2 settlements from settlement_log
  // Note: oracle_version='v2' may have 0 rows if V2 settlement hasn't run yet
  const { data: settlements, error: settErr } = await supabase
    .from("settlement_log")
    .select(
      "fixture_id, team_id, E_KR:e_kr, actual_score_S:actual_score_s, delta_B:delta_b, B_before:b_before, B_after:b_after, settled_at, gravity_component"
    )
    .eq("oracle_version", "v2")
    .order("settled_at", { ascending: false })
    .limit(limit * 2); // Each match has 2 teams (home + away)

  if (settErr || !settlements || settlements.length === 0) {
    return [];
  }

  const settRows = settlements as unknown as SettlementRow[];

  // Group by fixture_id
  const byFixture = new Map<number, SettlementRow[]>();
  for (const s of settRows) {
    const arr = byFixture.get(s.fixture_id) ?? [];
    arr.push(s);
    byFixture.set(s.fixture_id, arr);
  }

  const fixtureIds = [...byFixture.keys()];

  // Fetch match metadata, filtered to target leagues
  const { data: matchData } = await supabase
    .from("matches")
    .select(
      "fixture_id, league, home_team, away_team, commence_time, score, status"
    )
    .in("fixture_id", fixtureIds)
    .in("league", leagues);

  if (!matchData) return [];

  const matches = matchData as unknown as MatchRow[];
  const results: unknown[] = [];

  for (const match of matches) {
    const setts = byFixture.get(match.fixture_id) ?? [];
    const homeSett = setts.find((s) => s.team_id === match.home_team);
    const awaySett = setts.find((s) => s.team_id === match.away_team);

    results.push({
      fixture_id: match.fixture_id,
      league: match.league,
      home: {
        team_id: match.home_team,
        delta_b: homeSett ? round2(Number(homeSett.delta_B)) : null,
        delta_price: homeSett
          ? round2(Number(homeSett.delta_B) / 5)
          : null,
        gravity: homeSett
          ? round2(Number(homeSett.gravity_component ?? 0))
          : null,
        b_before: homeSett ? round2(Number(homeSett.B_before)) : null,
        b_after: homeSett ? round2(Number(homeSett.B_after)) : null,
      },
      away: {
        team_id: match.away_team,
        delta_b: awaySett ? round2(Number(awaySett.delta_B)) : null,
        delta_price: awaySett
          ? round2(Number(awaySett.delta_B) / 5)
          : null,
        gravity: awaySett
          ? round2(Number(awaySett.gravity_component ?? 0))
          : null,
        b_before: awaySett ? round2(Number(awaySett.B_before)) : null,
        b_after: awaySett ? round2(Number(awaySett.B_after)) : null,
      },
      kickoff: match.commence_time,
      score: match.score,
      status: "settled",
      settled_at:
        homeSett?.settled_at ?? awaySett?.settled_at ?? null,
    });

    if (results.length >= limit) break;
  }

  return results;
}
