import type { OraclePriceRow, MatchInfo, PmPrice, TeamStats, ChartPoint, MatchPoint } from '../_types';

function parseScore(score: string): [number, number] | null {
  if (!score) { return null; }
  const parts = score.split('-');
  if (parts.length !== 2) { return null; }
  const h = parseInt(parts[0].trim());
  const a = parseInt(parts[1].trim());
  if (isNaN(h) || isNaN(a)) { return null; }
  return [h, a];
}

function getMatchResult(team: string, match: MatchInfo): 'W' | 'D' | 'L' | null {
  const sc = parseScore(match.score);
  if (!sc) { return null; }
  const [hg, ag] = sc;
  const isHome = match.home_team === team;
  const isAway = match.away_team === team;
  if (!isHome && !isAway) { return null; }
  if (hg === ag) { return 'D'; }
  if (isHome) { return hg > ag ? 'W' : 'L'; }
  return ag > hg ? 'W' : 'L';
}

function computeAnnualizedVol(prices: number[]): number | null {
  if (prices.length < 10) { return null; }
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] === 0) { continue; }
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  if (returns.length < 5) { return null; }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

export function computeTeamStats(
  priceHistory: OraclePriceRow[],
  pmPrices: PmPrice[],
): TeamStats[] {
  const pmByTeam = new Map<string, PmPrice>();
  for (const pm of pmPrices) { pmByTeam.set(pm.team, pm); }

  const pricesByTeam = new Map<string, OraclePriceRow[]>();
  for (const r of priceHistory) {
    if (!pricesByTeam.has(r.team)) { pricesByTeam.set(r.team, []); }
    pricesByTeam.get(r.team)!.push(r);
  }

  const stats: TeamStats[] = [];
  for (const [team, rows] of pricesByTeam) {
    if (rows.length === 0) { continue; }
    const prices = rows.map((r) => r.dollar_price);
    const first = prices[0];
    const last = prices[prices.length - 1];
    const lastRow = rows[rows.length - 1];

    let min = Infinity; let max = -Infinity;
    for (const p of prices) {
      if (p < min) { min = p; }
      if (p > max) { max = p; }
    }

    const pm = pmByTeam.get(team);
    const pmImpliedPrice = pm?.impliedPrice ?? null;
    const divergence = pmImpliedPrice !== null ? Math.round((last - pmImpliedPrice) * 100) / 100 : null;

    stats.push({
      team,
      league: lastRow.league,
      currentPrice: last,
      currentElo: lastRow.implied_elo,
      seasonDelta: first > 0 ? ((last - first) / first) * 100 : null,
      annualizedVol: computeAnnualizedVol(prices),
      priceRange: [Math.round(min * 100) / 100, Math.round(max * 100) / 100],
      pmImpliedPrice,
      divergence,
    });
  }

  return stats;
}

export function buildChartData(
  priceHistory: OraclePriceRow[],
  matches: MatchInfo[],
): Map<string, { data: ChartPoint[]; matchPoints: MatchPoint[] }> {
  const pricesByTeam = new Map<string, OraclePriceRow[]>();
  for (const r of priceHistory) {
    if (!pricesByTeam.has(r.team)) { pricesByTeam.set(r.team, []); }
    pricesByTeam.get(r.team)!.push(r);
  }

  const matchesByTeam = new Map<string, MatchInfo[]>();
  for (const m of matches) {
    if (!matchesByTeam.has(m.home_team)) { matchesByTeam.set(m.home_team, []); }
    if (!matchesByTeam.has(m.away_team)) { matchesByTeam.set(m.away_team, []); }
    matchesByTeam.get(m.home_team)!.push(m);
    matchesByTeam.get(m.away_team)!.push(m);
  }

  const result = new Map<string, { data: ChartPoint[]; matchPoints: MatchPoint[] }>();
  for (const [team, rows] of pricesByTeam) {
    const priceMap = new Map<string, number>();
    const data: ChartPoint[] = rows.map((r) => {
      priceMap.set(r.date, r.dollar_price);
      return { date: r.date, price: r.dollar_price };
    });

    const matchPoints: MatchPoint[] = [];
    const teamMatches = matchesByTeam.get(team) ?? [];
    for (const m of teamMatches) {
      const res = getMatchResult(team, m);
      if (!res) { continue; }
      const price = priceMap.get(m.date);
      if (price !== undefined) { matchPoints.push({ date: m.date, price, result: res }); }
    }

    result.set(team, { data, matchPoints });
  }

  return result;
}
