import type { PriceRow, MatchRow, XgRow, ProbRow, EnrichedMatch, ChartDot } from '../_types';
import { RESULT_COLOR } from '../_types';

export function parseScore(score: string): [number, number] | null {
  if (!score) { return null; }
  const parts = score.split('-');
  if (parts.length !== 2) { return null; }
  const h = parseInt(parts[0].trim());
  const a = parseInt(parts[1].trim());
  if (isNaN(h) || isNaN(a)) { return null; }
  return [h, a];
}

export function xgMultiplier(teamXg: number, opponentXg: number, goalDiff: number): number {
  const sign = goalDiff > 0 ? 1 : goalDiff < 0 ? -1 : 0;
  const raw = 1.0 + 0.3 * (teamXg - opponentXg) * sign;
  return Math.max(0.4, Math.min(1.8, raw));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function formatDateTick(dateStr: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(dateStr + 'T00:00:00Z');
  return months[d.getUTCMonth()];
}

export interface EnrichmentResult {
  enrichedMatches: EnrichedMatch[];
  finishedMatches: EnrichedMatch[];
  upcomingMatches: EnrichedMatch[];
  chartData: { date: string; price: number }[];
  matchDots: ChartDot[];
  monthTicks: string[];
  filteredPrices: PriceRow[];
  priceByDate: Map<string, PriceRow>;
  probByFixture: Map<number, ProbRow>;
}

export function enrichTeamData(
  team: string,
  prices: PriceRow[],
  matches: MatchRow[],
  xgData: XgRow[],
  probs: ProbRow[],
  timeRange: number,
): EnrichmentResult {
  const startDate = timeRange >= 9999
    ? '2020-01-01'
    : new Date(Date.now() - timeRange * 86400000).toISOString().slice(0, 10);

  const filteredPrices = prices.filter((p) => p.date >= startDate);

  const priceByDate = new Map<string, PriceRow>();
  for (const p of prices) { priceByDate.set(p.date, p); }

  const xgByFixture = new Map<number, XgRow>();
  for (const x of xgData) { xgByFixture.set(x.fixture_id, x); }

  const probByFixture = new Map<number, ProbRow>();
  for (const p of probs) { probByFixture.set(p.fixture_id, p); }

  const enrichedMatches: EnrichedMatch[] = [];

  for (const m of matches) {
    const sc = parseScore(m.score);
    const isHome = m.home_team === team;
    const opponent = isHome ? m.away_team : m.home_team;

    if (!sc) {
      if (m.status !== 'finished') {
        enrichedMatches.push({
          fixture_id: m.fixture_id, date: m.date, opponent, isHome,
          score: m.score, status: m.status, homeGoals: 0, awayGoals: 0,
          result: 'D', teamXg: null, opponentXg: null, surprise: null, xgMult: null,
          priceImpact: null, postPrice: null,
        });
      }
      continue;
    }

    const [hg, ag] = sc;
    const matchResult: 'W' | 'D' | 'L' = hg === ag ? 'D' : (isHome ? (hg > ag ? 'W' : 'L') : (ag > hg ? 'W' : 'L'));

    const xg = xgByFixture.get(m.fixture_id);
    const teamXg = xg ? (isHome ? xg.home_xg : xg.away_xg) : null;
    const opponentXg = xg ? (isHome ? xg.away_xg : xg.home_xg) : null;

    const prob = probByFixture.get(m.fixture_id);
    let surprise: number | null = null;
    if (prob) {
      const homeExpected = prob.implied_home_win * 1 + prob.implied_draw * 0.5;
      const homeActual = hg > ag ? 1 : hg === ag ? 0.5 : 0;
      surprise = isHome ? homeActual - homeExpected : 1 - homeActual - (1 - homeExpected);
    }

    let xgMult: number | null = null;
    if (teamXg !== null && opponentXg !== null) {
      const goalDiff = isHome ? hg - ag : ag - hg;
      xgMult = xgMultiplier(teamXg, opponentXg, goalDiff);
    }

    const priceOnDate = priceByDate.get(m.date);
    const dateIdx = prices.findIndex((p) => p.date === m.date);
    const prevPrice = dateIdx > 0 ? prices[dateIdx - 1] : null;
    const priceImpact = priceOnDate && prevPrice ? priceOnDate.dollar_price - prevPrice.dollar_price : null;

    enrichedMatches.push({
      fixture_id: m.fixture_id, date: m.date, opponent, isHome,
      score: m.score, status: m.status, homeGoals: hg, awayGoals: ag,
      result: matchResult, teamXg, opponentXg, surprise, xgMult,
      priceImpact, postPrice: priceOnDate?.dollar_price ?? null,
    });
  }

  enrichedMatches.sort((a, b) => b.date.localeCompare(a.date));

  const finishedMatches = enrichedMatches.filter(
    (m) => m.status === 'finished' && m.date >= startDate,
  );
  const upcomingMatches = enrichedMatches
    .filter((m) => m.status !== 'finished')
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);

  const chartData = filteredPrices.map((p) => ({ date: p.date, price: p.dollar_price }));

  const matchDots: ChartDot[] = [];
  for (const m of finishedMatches) {
    const priceRow = priceByDate.get(m.date);
    if (!priceRow) { continue; }
    const absSurprise = m.surprise !== null ? Math.abs(m.surprise) : 0;
    const r = clamp(4 + absSurprise * 12, 4, 10);
    const tipParts = [`${m.date} · ${m.isHome ? 'vs' : '@'} ${m.opponent}`, `Score: ${m.score} (${m.result})`];
    if (m.teamXg !== null && m.opponentXg !== null) { tipParts.push(`xG: ${m.teamXg.toFixed(2)} − ${m.opponentXg.toFixed(2)}`); }
    if (m.surprise !== null) { tipParts.push(`Surprise: ${m.surprise >= 0 ? '+' : ''}${m.surprise.toFixed(3)}`); }
    if (m.xgMult !== null) { tipParts.push(`xG Mult: ${m.xgMult.toFixed(2)}×`); }
    if (m.priceImpact !== null) { tipParts.push(`Impact: ${m.priceImpact >= 0 ? '+' : ''}$${m.priceImpact.toFixed(2)}`); }
    matchDots.push({ date: m.date, price: priceRow.dollar_price, result: m.result, r, tooltip: tipParts.join('\n') });
  }

  const seen = new Set<string>();
  const monthTicks: string[] = [];
  for (const pt of chartData) {
    const ym = pt.date.slice(0, 7);
    if (!seen.has(ym)) { seen.add(ym); monthTicks.push(pt.date); }
  }

  return { enrichedMatches, finishedMatches, upcomingMatches, chartData, matchDots, monthTicks, filteredPrices, priceByDate, probByFixture };
}
