import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * GET /api/v3/prices/[teamId]
 *
 * Returns current price + recent history + recent settlements for a single team (V3).
 * Query params:
 *   history (optional): hours of price history, default 24, max 168 (1 week)
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=5",
};

const V3_REASONS = ["bootstrap_v3", "settlement_v3", "market_refresh_v3", "live_update_v3"];

interface PriceHistoryRow {
  id: number;
  team: string;
  league: string;
  timestamp: string;
  B_value: number;
  M1_value: number;
  published_index: number;
  confidence_score: number | null;
  publish_reason: string;
}

interface SettlementRow {
  settlement_id: number;
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

const HISTORY_SELECT =
  "id, team, league, timestamp, B_value:b_value, M1_value:m1_value, published_index, confidence_score, publish_reason";

const SETTLEMENT_SELECT =
  "settlement_id, fixture_id, team_id, E_KR:e_kr, actual_score_S:actual_score_s, delta_B:delta_b, B_before:b_before, B_after:b_after, settled_at, gravity_component";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ teamId: string }> }
) {
  try {
    const { teamId } = await params;
    const decodedTeamId = decodeURIComponent(teamId);

    const historyParam = req.nextUrl.searchParams.get("history");
    let historyHours = 24;
    if (historyParam) {
      const parsed = parseInt(historyParam, 10);
      if (!isNaN(parsed) && parsed >= 1) {
        historyHours = Math.min(parsed, 168);
      }
    }

    const { data: stateData, error: stateErr } = await supabase
      .from("team_oracle_v3_state")
      .select(
        "team_id, b_value, m1_value, l_value, f_value, published_index, confidence_score, bt_std_error, updated_at"
      )
      .eq("team_id", decodedTeamId)
      .single();

    if (stateErr || !stateData) {
      return NextResponse.json(
        { error: "Team not found", team_id: decodedTeamId },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const state = stateData as unknown as {
      team_id: string;
      b_value: number;
      m1_value: number;
      l_value: number;
      f_value: number;
      published_index: number;
      confidence_score: number | null;
      bt_std_error: number | null;
      updated_at: string;
    };

    const { data: leagueRow } = await supabase
      .from("oracle_price_history")
      .select("league")
      .eq("team", decodedTeamId)
      .order("timestamp", { ascending: false })
      .limit(1)
      .single();

    const league =
      (leagueRow as unknown as { league: string } | null)?.league ?? "Unknown";

    const historyFrom = new Date(
      Date.now() - historyHours * 60 * 60 * 1000
    ).toISOString();

    const [historyRows, settlementRows] = await Promise.all([
      fetchHistory(decodedTeamId, historyFrom),
      fetchSettlements(decodedTeamId),
    ]);

    const downsampled = downsampleHourly(historyRows);

    const idx = Math.round(Number(state.published_index) * 100) / 100;
    const current = {
      index: idx,
      price: Math.round(((idx - 800) / 5) * 100) / 100,
      components: {
        b: Math.round(Number(state.b_value) * 100) / 100,
        m1: Math.round(Number(state.m1_value) * 100) / 100,
        l: Math.round(Number(state.l_value ?? 0) * 100) / 100,
        f: Math.round(Number(state.f_value ?? 0) * 100) / 100,
      },
      confidence:
        Math.round(Number(state.confidence_score ?? 0) * 100) / 100,
      bt_std_error:
        state.bt_std_error != null
          ? Math.round(Number(state.bt_std_error) * 100) / 100
          : null,
      updated_at: state.updated_at,
    };

    const history = downsampled.map((r) => {
      const rIdx = Math.round(Number(r.published_index) * 100) / 100;
      return {
        timestamp: r.timestamp,
        index: rIdx,
        price: Math.round(((rIdx - 800) / 5) * 100) / 100,
        reason: r.publish_reason,
      };
    });

    const recent_settlements = settlementRows.map((r) => ({
      fixture_id: r.fixture_id,
      settled_at: r.settled_at,
      result_s: Number(r.actual_score_S),
      e_kr: Math.round(Number(r.E_KR) * 100) / 100,
      delta_b: Math.round(Number(r.delta_B) * 100) / 100,
      gravity: Math.round(Number(r.gravity_component ?? 0) * 100) / 100,
      b_before: Math.round(Number(r.B_before) * 100) / 100,
      b_after: Math.round(Number(r.B_after) * 100) / 100,
    }));

    return NextResponse.json(
      {
        team_id: decodedTeamId,
        league,
        current,
        history,
        recent_settlements,
      },
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    console.error("v3/prices/[teamId] unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────

async function fetchHistory(
  team: string,
  fromTs: string
): Promise<PriceHistoryRow[]> {
  const all: PriceHistoryRow[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("oracle_price_history")
      .select(HISTORY_SELECT)
      .eq("team", team)
      .in("publish_reason", V3_REASONS)
      .gte("timestamp", fromTs)
      .order("timestamp", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) {
      console.error(
        "v3/prices/[teamId] history fetch error:",
        error.message
      );
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as unknown as PriceHistoryRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return all;
}

async function fetchSettlements(team: string): Promise<SettlementRow[]> {
  const { data, error } = await supabase
    .from("settlement_log")
    .select(SETTLEMENT_SELECT)
    .eq("team_id", team)
    .eq("oracle_version", "v3")
    .order("settled_at", { ascending: false })
    .limit(5);

  if (error) {
    console.error(
      "v3/prices/[teamId] settlement fetch error:",
      error.message
    );
    return [];
  }

  return (data as unknown as SettlementRow[]) ?? [];
}

function downsampleHourly(rows: PriceHistoryRow[]): PriceHistoryRow[] {
  if (rows.length <= 50) return rows;

  const hourMs = 60 * 60 * 1000;
  const kept = new Map<string, PriceHistoryRow>();

  for (const row of rows) {
    const ts = new Date(row.timestamp).getTime();
    const bucketKey = String(Math.floor(ts / hourMs) * hourMs);
    const existing = kept.get(bucketKey);
    if (!existing || row.timestamp > existing.timestamp) {
      kept.set(bucketKey, row);
    }
  }

  return Array.from(kept.values()).sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp)
  );
}
