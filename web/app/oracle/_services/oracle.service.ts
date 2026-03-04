import { supabase } from '@/lib/supabase';
import type { OraclePriceRow, MatchInfo } from '../_types';

async function fetchAllPages<T>(
  table: string,
  select: string,
  filters?: Record<string, string | number>,
  orderCol?: string,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (filters) { for (const [k, v] of Object.entries(filters)) { q = q.eq(k, v); } }
    if (orderCol) { q = q.order(orderCol, { ascending: true }); }
    const { data, error } = await q;
    if (error) { console.error(`${table} fetch error:`, error.message); break; }
    if (!data || data.length === 0) { break; }
    all.push(...(data as T[]));
    if (data.length < pageSize) { break; }
    from += pageSize;
  }

  return all;
}

interface PmRawRow {
  league: string;
  team: string;
  implied_prob: number;
  snapshot_time: string;
}

export async function fetchOracleData(): Promise<{
  priceHistory: OraclePriceRow[];
  matches: MatchInfo[];
  pmRaw: PmRawRow[];
}> {
  const [priceHistory, matches, pmResult] = await Promise.all([
    fetchAllPages<OraclePriceRow>(
      'team_prices',
      'team, league, date, dollar_price, ema_dollar_price, implied_elo',
      { model: 'oracle' },
      'date',
    ),
    fetchAllPages<MatchInfo>(
      'matches',
      'fixture_id, date, league, home_team, away_team, score',
      undefined,
      'date',
    ),
    supabase
      .from('polymarket_futures')
      .select('league, team, implied_prob, snapshot_time')
      .order('snapshot_time', { ascending: false }),
  ]);

  return {
    priceHistory,
    matches,
    pmRaw: (pmResult.data ?? []) as PmRawRow[],
  };
}
