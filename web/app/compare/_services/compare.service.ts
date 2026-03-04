import { supabase } from '@/lib/supabase';
import type { PriceRow, MatchRow, XgRow, ProbRow } from '../_types';

async function fetchAllPages<T>(
  table: string,
  select: string,
  filters: { col: string; op: 'eq' | 'gte'; val: string | number }[],
  orderCol?: string,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    for (const f of filters) {
      if (f.op === 'eq') { q = q.eq(f.col, f.val); }
      else if (f.op === 'gte') { q = q.gte(f.col, f.val); }
    }
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

function dedup<T extends { fixture_id: number }>(arr: T[]): T[] {
  const seen = new Set<number>();
  return arr.filter((r) => {
    if (seen.has(r.fixture_id)) { return false; }
    seen.add(r.fixture_id);
    return true;
  });
}

export interface TeamData {
  prices: PriceRow[];
  matches: MatchRow[];
  xgData: XgRow[];
  probs: ProbRow[];
}

export async function fetchTeamData(team: string): Promise<TeamData> {
  const [
    prices,
    homeMatches,
    awayMatches,
    homeXg,
    awayXg,
    homeProbs,
    awayProbs,
  ] = await Promise.all([
    fetchAllPages<PriceRow>(
      'team_prices',
      'date, dollar_price, implied_elo, drift_elo, confidence, matches_in_window',
      [{ col: 'team', op: 'eq', val: team }, { col: 'model', op: 'eq', val: 'oracle' }],
      'date',
    ),
    fetchAllPages<MatchRow>(
      'matches',
      'fixture_id, date, home_team, away_team, score, status',
      [{ col: 'home_team', op: 'eq', val: team }],
      'date',
    ),
    fetchAllPages<MatchRow>(
      'matches',
      'fixture_id, date, home_team, away_team, score, status',
      [{ col: 'away_team', op: 'eq', val: team }],
      'date',
    ),
    supabase.from('match_xg').select('fixture_id, home_team, away_team, home_xg, away_xg').eq('home_team', team),
    supabase.from('match_xg').select('fixture_id, home_team, away_team, home_xg, away_xg').eq('away_team', team),
    supabase.from('match_probabilities')
      .select('fixture_id, date, home_team, away_team, implied_home_win, implied_draw, implied_away_win, bookmaker_home_win, bookmaker_draw, bookmaker_away_win')
      .eq('model', 'oracle').eq('home_team', team),
    supabase.from('match_probabilities')
      .select('fixture_id, date, home_team, away_team, implied_home_win, implied_draw, implied_away_win, bookmaker_home_win, bookmaker_draw, bookmaker_away_win')
      .eq('model', 'oracle').eq('away_team', team),
  ]);

  const allMatches = dedup([...homeMatches, ...awayMatches]);
  const matchByKey = new Map<string, MatchRow>();
  for (const m of allMatches) {
    const key = `${m.date}|${m.home_team}|${m.away_team}`;
    const existing = matchByKey.get(key);
    const isFinished = m.status === 'finished';
    const hasScore = m.score && m.score !== 'N/A';
    if (!existing) { matchByKey.set(key, m); }
    else if (isFinished && existing.status !== 'finished') { matchByKey.set(key, m); }
    else if (hasScore && (!existing.score || existing.score === 'N/A')) { matchByKey.set(key, m); }
  }

  return {
    prices,
    matches: [...matchByKey.values()],
    xgData: dedup([...((homeXg.data ?? []) as XgRow[]), ...((awayXg.data ?? []) as XgRow[])]),
    probs: dedup([...((homeProbs.data ?? []) as ProbRow[]), ...((awayProbs.data ?? []) as ProbRow[])]),
  };
}

export async function fetchTeamList(): Promise<{ teams: string[]; teamLeagues: Record<string, string> }> {
  const { data: latest } = await supabase
    .from('team_prices').select('date').eq('model', 'oracle').order('date', { ascending: false }).limit(1);

  const latestDate = latest?.[0]?.date;
  if (!latestDate) { return { teams: [], teamLeagues: {} }; }

  const { data, error } = await supabase
    .from('team_prices').select('team, league').eq('model', 'oracle').eq('date', latestDate).order('team');

  if (error) { return { teams: [], teamLeagues: {} }; }

  const teams: string[] = [];
  const teamLeagues: Record<string, string> = {};
  for (const r of data ?? []) {
    teams.push(r.team);
    teamLeagues[r.team] = r.league;
  }

  return { teams, teamLeagues };
}
