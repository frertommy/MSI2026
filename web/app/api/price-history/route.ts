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

/**
 * GET /api/price-history?team={teamId}
 *
 * Returns oracle_price_history rows for a single team, ordered by timestamp ASC.
 * market_refresh rows are deduplicated server-side: only the LATEST per date is kept.
 * This avoids sending dozens of intra-day M1 refreshes to the client.
 */
export async function GET(req: NextRequest) {
  const team = req.nextUrl.searchParams.get("team");
  if (!team) {
    return NextResponse.json({ error: "team parameter required" }, { status: 400 });
  }

  // Fetch all non-market_refresh rows (bootstrap, settlement, live_update)
  const nonRefreshPromise = fetchPaginated(team, ["bootstrap", "settlement", "live_update"]);

  // Fetch market_refresh rows — we'll deduplicate server-side
  const refreshPromise = fetchPaginated(team, ["market_refresh"]);

  const [nonRefresh, refresh] = await Promise.all([nonRefreshPromise, refreshPromise]);

  // Deduplicate market_refresh: keep only the LATEST row per date
  const latestByDate = new Map<string, PriceHistoryRow>();
  for (const row of refresh) {
    const dateKey = row.timestamp.slice(0, 10);
    const existing = latestByDate.get(dateKey);
    if (!existing || row.timestamp > existing.timestamp) {
      latestByDate.set(dateKey, row);
    }
  }
  const dedupedRefresh = Array.from(latestByDate.values());

  // Merge and sort chronologically
  const all = [...nonRefresh, ...dedupedRefresh].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );

  return NextResponse.json(all);
}

// ─── Paginated fetch helper ──────────────────────────────────

const SELECT =
  "id, team, league, timestamp, B_value:b_value, M1_value:m1_value, published_index, confidence_score, source_fixture_id, publish_reason";

async function fetchPaginated(
  team: string,
  publishReasons: string[]
): Promise<PriceHistoryRow[]> {
  const all: PriceHistoryRow[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("oracle_price_history")
      .select(SELECT)
      .eq("team", team)
      .in("publish_reason", publishReasons)
      .order("timestamp", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      console.error(`price-history fetch error:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as unknown as PriceHistoryRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return all;
}
