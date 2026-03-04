import { supabase } from '@/lib/supabase';
import type { Match, TeamRow } from '@/lib/types';

export async function fetchLatestPrices(): Promise<Map<string, { price: number; elo: number }>> {
  const map = new Map<string, { price: number; elo: number }>();

  const { data: latest } = await supabase
    .from('team_prices')
    .select('date')
    .eq('model', 'oracle')
    .order('date', { ascending: false })
    .limit(1);

  const latestDate = latest?.[0]?.date;
  if (!latestDate) { return map; }

  const { data, error } = await supabase
    .from('team_prices')
    .select('team, dollar_price, implied_elo')
    .eq('model', 'oracle')
    .eq('date', latestDate);

  if (error) {
    console.error('team_prices fetch error:', error.message);
    return map;
  }

  for (const row of data ?? []) {
    map.set(row.team, { price: row.dollar_price, elo: row.implied_elo });
  }

  return map;
}

export async function fetchAllMatches(): Promise<Match[]> {
  const all: Match[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('matches')
      .select('fixture_id, date, league, home_team, away_team, score, status')
      .order('date', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('matches fetch error:', error.message);
      break;
    }
    if (!data || data.length === 0) { break; }
    all.push(...data);
    if (data.length < pageSize) { break; }
    from += pageSize;
  }

  return all;
}

function parseScore(score: string): [number, number] | null {
  const parts = score.split('-');
  if (parts.length !== 2) { return null; }
  const h = parseInt(parts[0].trim());
  const a = parseInt(parts[1].trim());
  if (isNaN(h) || isNaN(a)) { return null; }
  return [h, a];
}

export function computeTeamRows(
  matches: Match[],
  priceMap: Map<string, { price: number; elo: number }>
): TeamRow[] {
  const teamStats = new Map<
    string,
    { league: string; played: number; wins: number; draws: number; losses: number; latestDate: string }
  >();

  function getOrCreate(team: string, league: string) {
    if (!teamStats.has(team)) {
      teamStats.set(team, { league, played: 0, wins: 0, draws: 0, losses: 0, latestDate: '' });
    }
    return teamStats.get(team)!;
  }

  for (const m of matches) {
    const parsed = parseScore(m.score);
    if (!parsed) { continue; }
    const [hg, ag] = parsed;

    const home = getOrCreate(m.home_team, m.league);
    home.played++;
    if (m.date > home.latestDate) { home.latestDate = m.date; }
    if (hg > ag) { home.wins++; }
    else if (hg === ag) { home.draws++; }
    else { home.losses++; }

    const away = getOrCreate(m.away_team, m.league);
    away.played++;
    if (m.date > away.latestDate) { away.latestDate = m.date; }
    if (ag > hg) { away.wins++; }
    else if (ag === hg) { away.draws++; }
    else { away.losses++; }
  }

  const rows: TeamRow[] = [];
  for (const [team, stats] of teamStats) {
    const teamData = priceMap.get(team);
    rows.push({
      rank: 0,
      team,
      league: stats.league,
      played: stats.played,
      wins: stats.wins,
      draws: stats.draws,
      losses: stats.losses,
      latestDate: stats.latestDate,
      dollarPrice: teamData?.price ?? null,
      impliedElo: teamData?.elo ?? null,
    });
  }

  rows.sort((a, b) => (b.impliedElo ?? 0) - (a.impliedElo ?? 0));
  rows.forEach((r, i) => (r.rank = i + 1));

  return rows;
}
