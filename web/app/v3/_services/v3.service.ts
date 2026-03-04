import { supabase } from '@/lib/supabase';
import type { MatchRow, OddsConsensus, PriceHistoryRow, XgRow } from '../_types';
import { LEGACY_NAME_MAP } from '../_utils/legacy-map';

const LEGACY_URL = 'https://raw.githubusercontent.com/frertommy/MSI/main/data/msi_daily.json';

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

export async function fetchLegacyElos(): Promise<Record<string, number>> {
  try {
    const res = await fetch(LEGACY_URL, { cache: 'no-store' });
    if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
    const data: Record<string, Array<{ date: string; rating: number }>> = await res.json();

    const result: Record<string, number> = {};
    for (const [legacyName, entries] of Object.entries(data)) {
      if (!entries || entries.length === 0) { continue; }
      const last = entries[entries.length - 1];
      const apiName = LEGACY_NAME_MAP[legacyName] ?? legacyName;
      result[apiName] = last.rating;
    }
    return result;
  } catch (err) {
    console.error('Legacy Elo fetch failed:', err);
    return {};
  }
}

export async function fetchMatches(): Promise<MatchRow[]> {
  return fetchAllPages<MatchRow>('matches', 'fixture_id, date, league, home_team, away_team, score, status', undefined, 'date');
}

export async function fetchPriceHistory(): Promise<PriceHistoryRow[]> {
  return fetchAllPages<PriceHistoryRow>('team_prices', 'team, league, date, dollar_price, implied_elo', { model: 'oracle' }, 'date');
}

export interface XgData {
  byFixtureId: Map<number, XgRow>;
  byKey: Map<string, XgRow>;
}

export async function fetchXgData(): Promise<XgData> {
  const rows = await fetchAllPages<XgRow>('match_xg', 'fixture_id, date, home_team, away_team, home_xg, away_xg, home_goals, away_goals');

  const byFixtureId = new Map<number, XgRow>();
  const byKey = new Map<string, XgRow>();
  for (const r of rows) {
    if (r.fixture_id) { byFixtureId.set(r.fixture_id, r); }
    byKey.set(`${r.date}|${r.home_team}|${r.away_team}`, r);
  }

  return { byFixtureId, byKey };
}

export async function fetchClosingOdds(fixtureIds: number[]): Promise<OddsConsensus[]> {
  const grouped = new Map<number, { home: number[]; draw: number[]; away: number[] }>();

  for (let i = 0; i < fixtureIds.length; i += 100) {
    const batch = fixtureIds.slice(i, i + 100);
    const { data, error } = await supabase
      .from('odds_snapshots')
      .select('fixture_id, home_odds, away_odds, draw_odds')
      .in('fixture_id', batch)
      .eq('days_before_kickoff', 1);

    if (error || !data) { continue; }

    for (const row of data as { fixture_id: number; home_odds: number | null; away_odds: number | null; draw_odds: number | null }[]) {
      if (!row.home_odds || !row.away_odds || !row.draw_odds) { continue; }
      if (row.home_odds <= 0 || row.away_odds <= 0 || row.draw_odds <= 0) { continue; }
      if (!grouped.has(row.fixture_id)) { grouped.set(row.fixture_id, { home: [], draw: [], away: [] }); }
      const entry = grouped.get(row.fixture_id)!;
      entry.home.push(1 / row.home_odds);
      entry.draw.push(1 / row.draw_odds);
      entry.away.push(1 / row.away_odds);
    }
  }

  const result: OddsConsensus[] = [];
  for (const [fid, { home, draw, away }] of grouped) {
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const rawHome = avg(home); const rawDraw = avg(draw); const rawAway = avg(away);
    const total = rawHome + rawDraw + rawAway;
    result.push({ fixture_id: fid, homeProb: rawHome / total, drawProb: rawDraw / total, awayProb: rawAway / total });
  }

  return result;
}
