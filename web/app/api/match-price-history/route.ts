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

/**
 * GET /api/match-price-history?fixture_id=123
 *
 * Returns oracle_price_history for both teams in a match,
 * filtered to a 48h window around kickoff (commence_time - 24h to commence_time + 24h).
 *
 * market_refresh rows are downsampled to 1 per 15-min bucket.
 * live_update and settlement rows are kept in full.
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

  // 1. Look up the match
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

  // Use commence_time or fallback to date + noon
  const kickoffStr =
    match.commence_time ?? `${match.date}T12:00:00Z`;
  const kickoff = new Date(kickoffStr);
  const windowStart = new Date(kickoff.getTime() - 24 * 60 * 60 * 1000);
  const windowEnd = new Date(kickoff.getTime() + 24 * 60 * 60 * 1000);

  const windowStartISO = windowStart.toISOString();
  const windowEndISO = windowEnd.toISOString();

  // 2. Fetch price history for both teams in the time window
  const [homeRows, awayRows] = await Promise.all([
    fetchTeamWindow(match.home_team, windowStartISO, windowEndISO),
    fetchTeamWindow(match.away_team, windowStartISO, windowEndISO),
  ]);

  // 3. Downsample market_refresh rows (keep 1 per 15-min bucket)
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
      .gte("timestamp", from)
      .lte("timestamp", to)
      .order("timestamp", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error(`match-price-history fetch error for ${team}:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as unknown as PriceHistoryRow[]));
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return all;
}

/**
 * Downsample market_refresh rows: keep latest per 15-min bucket.
 * Keep ALL live_update, settlement, bootstrap rows untouched.
 */
function downsample(rows: PriceHistoryRow[]): PriceHistoryRow[] {
  const keep: PriceHistoryRow[] = [];
  const buckets = new Map<string, PriceHistoryRow>();

  for (const row of rows) {
    if (row.publish_reason !== "market_refresh") {
      // Flush any pending bucket before adding non-refresh row
      keep.push(row);
      continue;
    }

    // 15-min bucket key
    const ts = new Date(row.timestamp);
    const bucketMs =
      Math.floor(ts.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
    const bucketKey = `${row.team}:${bucketMs}`;

    const existing = buckets.get(bucketKey);
    if (!existing || row.timestamp > existing.timestamp) {
      buckets.set(bucketKey, row);
    }
  }

  // Add all bucket winners
  for (const row of buckets.values()) {
    keep.push(row);
  }

  // Sort chronologically
  keep.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return keep;
}
