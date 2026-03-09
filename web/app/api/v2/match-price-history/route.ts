import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

interface PriceHistoryRow {
  id: number;
  team: string;
  league: string;
  timestamp: string;
  B_value: number;
  M1_value: number;
  published_index: number;
  confidence_score: number | null;
  source_fixture_id: number | null;
  publish_reason: string;
}

interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
  commence_time: string | null;
}

const SELECT =
  "id, team, league, timestamp, B_value:b_value, M1_value:m1_value, published_index, confidence_score, source_fixture_id, publish_reason";

// V2 publish reasons
const V2_REASONS = ["bootstrap_v2", "settlement_v2", "market_refresh_v2", "live_update"];

/**
 * GET /api/v2/match-price-history?fixture_id=123
 *
 * Returns V2 oracle_price_history for both teams in a match,
 * filtered to a 48h window around kickoff.
 * market_refresh_v2 rows are downsampled to 1 per 15-min bucket.
 */
export async function GET(req: NextRequest) {
  const fixtureIdStr = req.nextUrl.searchParams.get("fixture_id");
  if (!fixtureIdStr) {
    return NextResponse.json(
      { error: "fixture_id parameter required" },
      { status: 400 }
    );
  }

  const fixtureId = parseInt(fixtureIdStr, 10);
  if (isNaN(fixtureId)) {
    return NextResponse.json(
      { error: "fixture_id must be a number" },
      { status: 400 }
    );
  }

  const { data: matchData, error: matchErr } = await supabase
    .from("matches")
    .select(
      "fixture_id, date, league, home_team, away_team, score, status, commence_time"
    )
    .eq("fixture_id", fixtureId)
    .single();

  if (matchErr || !matchData) {
    return NextResponse.json(
      { error: "Match not found" },
      { status: 404 }
    );
  }

  const match = matchData as MatchRow;

  const kickoffStr =
    match.commence_time ?? `${match.date}T12:00:00Z`;
  const kickoff = new Date(kickoffStr);
  const windowStart = new Date(kickoff.getTime() - 24 * 60 * 60 * 1000);
  const windowEnd = new Date(kickoff.getTime() + 24 * 60 * 60 * 1000);

  const windowStartISO = windowStart.toISOString();
  const windowEndISO = windowEnd.toISOString();

  const [homeRows, awayRows] = await Promise.all([
    fetchTeamWindow(match.home_team, windowStartISO, windowEndISO),
    fetchTeamWindow(match.away_team, windowStartISO, windowEndISO),
  ]);

  const homeDownsampled = downsample(homeRows);
  const awayDownsampled = downsample(awayRows);

  return NextResponse.json({
    match,
    home: homeDownsampled,
    away: awayDownsampled,
  });
}

async function fetchTeamWindow(
  team: string,
  from: string,
  to: string
): Promise<PriceHistoryRow[]> {
  const all: PriceHistoryRow[] = [];
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("oracle_price_history")
      .select(SELECT)
      .eq("team", team)
      .in("publish_reason", V2_REASONS)
      .gte("timestamp", from)
      .lte("timestamp", to)
      .order("timestamp", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error(`v2 match-price-history fetch error for ${team}:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as unknown as PriceHistoryRow[]));
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return all;
}

function downsample(rows: PriceHistoryRow[]): PriceHistoryRow[] {
  const keep: PriceHistoryRow[] = [];
  const buckets = new Map<string, PriceHistoryRow>();

  for (const row of rows) {
    if (row.publish_reason !== "market_refresh_v2") {
      keep.push(row);
      continue;
    }

    const ts = new Date(row.timestamp);
    const bucketMs =
      Math.floor(ts.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
    const bucketKey = `${row.team}:${bucketMs}`;

    const existing = buckets.get(bucketKey);
    if (!existing || row.timestamp > existing.timestamp) {
      buckets.set(bucketKey, row);
    }
  }

  for (const row of buckets.values()) {
    keep.push(row);
  }

  keep.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return keep;
}
