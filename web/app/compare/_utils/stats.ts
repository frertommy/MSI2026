import type { PriceRow, ProbRow, EnrichedMatch, HeaderStats, TradingStats, HistogramBucket } from '../_types';
import { parseScore } from './enrichment';

export function computeHeaderStats(
  prices: PriceRow[],
  filteredPrices: PriceRow[],
  enrichedMatches: EnrichedMatch[],
): HeaderStats {
  if (filteredPrices.length === 0) {
    return { currentPrice: 0, currentElo: 0, seasonReturn: null, return7d: null, return30d: null, record: { w: 0, d: 0, l: 0 } };
  }

  const latest = prices[prices.length - 1];
  const first = prices[0];
  const currentPrice = latest?.dollar_price ?? 0;
  const currentElo = latest?.implied_elo ?? 0;

  const seasonReturn = first && first.dollar_price > 0
    ? ((currentPrice - first.dollar_price) / first.dollar_price) * 100
    : null;

  const d7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const priceAtOrBefore = (target: string): PriceRow | null => {
    let best: PriceRow | null = null;
    for (const p of prices) {
      if (p.date <= target) { best = p; } else { break; }
    }
    return best;
  };

  const p7 = priceAtOrBefore(d7);
  const p30 = priceAtOrBefore(d30);
  const return7d = p7 && p7.dollar_price > 0 ? ((currentPrice - p7.dollar_price) / p7.dollar_price) * 100 : null;
  const return30d = p30 && p30.dollar_price > 0 ? ((currentPrice - p30.dollar_price) / p30.dollar_price) * 100 : null;

  const allFinished = enrichedMatches.filter((m) => m.status === 'finished' && parseScore(m.score) !== null);
  const record = { w: 0, d: 0, l: 0 };
  for (const m of allFinished) {
    if (m.result === 'W') { record.w++; }
    else if (m.result === 'D') { record.d++; }
    else { record.l++; }
  }

  return { currentPrice, currentElo, seasonReturn, return7d, return30d, record };
}

function computeDailyReturns(filteredPrices: PriceRow[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < filteredPrices.length; i++) {
    const prev = filteredPrices[i - 1].dollar_price;
    if (prev > 0) { returns.push(((filteredPrices[i].dollar_price - prev) / prev) * 100); }
  }
  return returns;
}

export function computeTradingStats(
  filteredPrices: PriceRow[],
  finishedMatches: EnrichedMatch[],
  probByFixture: Map<number, ProbRow>,
): TradingStats {
  const returns = computeDailyReturns(filteredPrices);

  let annVol: number | null = null;
  if (returns.length >= 10) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    annVol = Math.sqrt(variance) * Math.sqrt(365);
  }

  const finishedSorted = [...finishedMatches].sort((a, b) => a.date.localeCompare(b.date));
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let tmpWin = 0;
  let tmpLoss = 0;
  for (const m of finishedSorted) {
    if (m.result === 'W') { tmpWin++; tmpLoss = 0; if (tmpWin > maxWinStreak) { maxWinStreak = tmpWin; } }
    else if (m.result === 'L') { tmpLoss++; tmpWin = 0; if (tmpLoss > maxLossStreak) { maxLossStreak = tmpLoss; } }
    else { tmpWin = 0; tmpLoss = 0; }
  }

  let currentStreak = '';
  let currentStreakLen = 0;
  for (let i = finishedSorted.length - 1; i >= 0; i--) {
    const r = finishedSorted[i].result;
    if (currentStreak === '') { currentStreak = r; currentStreakLen = 1; }
    else if (r === currentStreak) { currentStreakLen++; }
    else { break; }
  }

  let meanReversion: number | null = null;
  if (returns.length >= 10) {
    const n = returns.length - 1;
    const xMean = returns.slice(0, n).reduce((a, b) => a + b, 0) / n;
    const yMean = returns.slice(1).reduce((a, b) => a + b, 0) / n;
    let num = 0; let denX = 0; let denY = 0;
    for (let i = 0; i < n; i++) {
      const dx = returns[i] - xMean;
      const dy = returns[i + 1] - yMean;
      num += dx * dy; denX += dx * dx; denY += dy * dy;
    }
    const denom = Math.sqrt(denX * denY);
    meanReversion = denom > 0 ? num / denom : 0;
  }

  let oddsAccuracy: number | null = null;
  const withProbs = finishedMatches.filter((m) => m.surprise !== null);
  if (withProbs.length > 0) {
    let totalEdge = 0;
    for (const m of withProbs) {
      const prob = probByFixture.get(m.fixture_id);
      if (prob) {
        totalEdge += (Math.abs(prob.implied_home_win - prob.bookmaker_home_win) +
          Math.abs(prob.implied_draw - prob.bookmaker_draw) +
          Math.abs(prob.implied_away_win - prob.bookmaker_away_win)) / 3;
      }
    }
    oddsAccuracy = totalEdge / withProbs.length;
  }

  let xgLuck: number | null = null;
  const withXg = finishedMatches.filter((m) => m.teamXg !== null && m.opponentXg !== null);
  if (withXg.length > 0) {
    let totalLuck = 0;
    for (const m of withXg) {
      const teamGoals = m.isHome ? m.homeGoals : m.awayGoals;
      totalLuck += teamGoals - m.teamXg!;
    }
    xgLuck = totalLuck / withXg.length;
  }

  const withSurprise = finishedMatches.filter((m) => m.surprise !== null);
  let avgSurprise = 0;
  let upsetPct = 0;
  if (withSurprise.length > 0) {
    avgSurprise = withSurprise.reduce((a, m) => a + Math.abs(m.surprise!), 0) / withSurprise.length;
    upsetPct = (withSurprise.filter((m) => Math.abs(m.surprise!) > 0.2).length / withSurprise.length) * 100;
  }

  return {
    annVol,
    currentStreak: currentStreakLen > 0 ? `${currentStreakLen}${currentStreak}` : '—',
    maxWinStreak,
    maxLossStreak,
    meanReversion,
    oddsAccuracy,
    xgLuck,
    avgSurprise,
    upsetPct,
  };
}

export function computeHistogram(filteredPrices: PriceRow[]): HistogramBucket[] {
  const returns: number[] = [];
  for (let i = 1; i < filteredPrices.length; i++) {
    const prev = filteredPrices[i - 1].dollar_price;
    if (prev > 0) { returns.push(((filteredPrices[i].dollar_price - prev) / prev) * 100); }
  }

  const buckets: HistogramBucket[] = [];
  for (let b = -5; b < 5; b += 0.5) {
    const lo = b;
    const hi = b + 0.5;
    const label = `${lo >= 0 ? '+' : ''}${lo.toFixed(1)}%`;
    const count = returns.filter((r) => r >= lo && r < hi).length;
    buckets.push({ bin: label, count, midpoint: (lo + hi) / 2 });
  }

  return buckets;
}
