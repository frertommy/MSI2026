import { supabase } from '@/lib/supabase';
import type { MatchRow, UpcomingMatch } from '../_types';

interface PriceEntry {
  price: number;
  elo: number;
  league: string;
}

interface OddsEntry {
  homeProb: number;
  drawProb: number;
  awayProb: number;
}

interface OddsRow {
  fixture_id: number;
  home_odds: number | null;
  away_odds: number | null;
  draw_odds: number | null;
}

async function fetchUpcomingMatchRows(): Promise<MatchRow[]> {
  const all: MatchRow[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('matches')
      .select('fixture_id, date, league, home_team, away_team, score, status')
      .eq('status', 'upcoming')
      .order('date', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) { console.error('matches fetch error:', error.message); break; }
    if (!data || data.length === 0) { break; }
    all.push(...(data as MatchRow[]));
    if (data.length < pageSize) { break; }
    from += pageSize;
  }

  return all;
}

async function fetchOraclePrices(): Promise<Map<string, PriceEntry>> {
  const map = new Map<string, PriceEntry>();

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
    .select('team, league, dollar_price, implied_elo')
    .eq('model', 'oracle')
    .eq('date', latestDate);

  if (error) { console.error('team_prices fetch error:', error.message); return map; }

  for (const row of data ?? []) {
    map.set(row.team, { price: row.dollar_price, elo: row.implied_elo, league: row.league });
  }

  return map;
}

async function fetchOdds(fixtureIds: number[]): Promise<Map<number, OddsEntry>> {
  const map = new Map<number, OddsEntry>();
  if (fixtureIds.length === 0) { return map; }

  for (let i = 0; i < fixtureIds.length; i += 50) {
    const batch = fixtureIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from('odds_snapshots')
      .select('fixture_id, home_odds, away_odds, draw_odds')
      .in('fixture_id', batch);

    if (error || !data) { continue; }

    const grouped = new Map<number, OddsRow[]>();
    for (const row of data as OddsRow[]) {
      if (!row.home_odds || !row.away_odds || !row.draw_odds) { continue; }
      if (row.home_odds <= 0 || row.away_odds <= 0 || row.draw_odds <= 0) { continue; }
      if (!grouped.has(row.fixture_id)) { grouped.set(row.fixture_id, []); }
      grouped.get(row.fixture_id)!.push(row);
    }

    for (const [fid, rows] of grouped) {
      const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const rawHome = avg(rows.map((r) => 1 / r.home_odds!));
      const rawDraw = avg(rows.map((r) => 1 / r.draw_odds!));
      const rawAway = avg(rows.map((r) => 1 / r.away_odds!));
      const total = rawHome + rawDraw + rawAway;
      map.set(fid, { homeProb: rawHome / total, drawProb: rawDraw / total, awayProb: rawAway / total });
    }
  }

  return map;
}

function buildMatches(
  rows: MatchRow[],
  priceMap: Map<string, PriceEntry>,
  oddsMap: Map<number, OddsEntry>,
): UpcomingMatch[] {
  const seen = new Set<string>();
  const deduped = [...rows]
    .sort((a, b) => {
      const aHasOdds = oddsMap.has(a.fixture_id) ? 0 : 1;
      const bHasOdds = oddsMap.has(b.fixture_id) ? 0 : 1;
      if (aHasOdds !== bHasOdds) { return aHasOdds - bHasOdds; }
      return a.date.localeCompare(b.date);
    })
    .filter((m) => {
      const key = `${m.home_team}|${m.away_team}|${m.date}`;
      if (seen.has(key)) { return false; }
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const leagueElos = new Map<string, number[]>();
  for (const [, entry] of priceMap) {
    if (!leagueElos.has(entry.league)) { leagueElos.set(entry.league, []); }
    leagueElos.get(entry.league)!.push(entry.elo);
  }

  const leagueMeans = new Map<string, number>();
  for (const [league, elos] of leagueElos) {
    leagueMeans.set(league, elos.reduce((a, b) => a + b, 0) / elos.length);
  }

  const result: UpcomingMatch[] = [];
  for (const m of deduped) {
    const home = priceMap.get(m.home_team);
    const away = priceMap.get(m.away_team);
    if (!home || !away) { continue; }

    const odds = oddsMap.get(m.fixture_id);
    result.push({
      fixture_id: m.fixture_id,
      date: m.date,
      league: m.league,
      home_team: m.home_team,
      away_team: m.away_team,
      home_elo: home.elo,
      away_elo: away.elo,
      home_price: home.price,
      away_price: away.price,
      league_mean_elo: leagueMeans.get(m.league) ?? 1500,
      bookmaker_home_prob: odds?.homeProb ?? null,
      bookmaker_draw_prob: odds?.drawProb ?? null,
      bookmaker_away_prob: odds?.awayProb ?? null,
    });
  }

  return result;
}

export async function fetchMatches(): Promise<UpcomingMatch[]> {
  const [rawMatches, priceMap] = await Promise.all([
    fetchUpcomingMatchRows(),
    fetchOraclePrices(),
  ]);

  const fixtureIds = rawMatches.map((m) => m.fixture_id);
  const oddsMap = await fetchOdds(fixtureIds);

  return buildMatches(rawMatches, priceMap, oddsMap);
}
