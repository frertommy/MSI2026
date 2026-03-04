import type { PmPrice } from '../_types';

const N_PER_LEAGUE: Record<string, number> = {
  'Premier League': 20,
  'La Liga': 20,
  Bundesliga: 18,
  'Serie A': 20,
  'Ligue 1': 18,
};

interface PmRawRow {
  league: string;
  team: string;
  implied_prob: number;
  snapshot_time: string;
}

export function computePmPrices(pmRaw: PmRawRow[]): PmPrice[] {
  const pmByTeam = new Map<string, { implied_prob: number; league: string }>();
  for (const r of pmRaw) {
    if (!pmByTeam.has(r.team)) { pmByTeam.set(r.team, { implied_prob: r.implied_prob, league: r.league }); }
  }

  const prices: PmPrice[] = [];
  for (const [team, data] of pmByTeam) {
    if (data.implied_prob <= 0) { continue; }
    const N = N_PER_LEAGUE[data.league] ?? 20;
    const baselineProb = 1 / N;
    const impliedElo = 1500 + 400 * Math.log10(data.implied_prob / baselineProb);
    const impliedPrice = Math.max(10, (impliedElo - 1000) / 5);
    prices.push({ team, impliedPrice: Math.round(impliedPrice * 100) / 100, impliedProb: data.implied_prob });
  }

  return prices;
}
