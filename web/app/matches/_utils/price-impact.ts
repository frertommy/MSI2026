import type { UpcomingMatch, MatchImpacts, MatchProbs, EnrichedMatch, OutcomeImpact } from '../_types';

const INITIAL_ELO = 1500;
const DOLLAR_SPREAD = 220;
const HOME_ADVANTAGE = 70;
const K_BASE = 20;

function logistic(elo: number): number {
  return 100 / (1 + Math.exp(-(elo - INITIAL_ELO) / DOLLAR_SPREAD));
}

function computeImpacts(
  teamElo: number,
  opponentElo: number,
  teamPrice: number,
  leagueMean: number,
  winProb: number,
  drawProb: number,
  lossProb: number,
): MatchImpacts {
  const expected = 3 * winProb + 1 * drawProb + 0 * lossProb;
  const effectiveK = K_BASE * (1 + (opponentElo - leagueMean) / 400);

  const outcomes = [
    { label: 'Win', actual: 3 },
    { label: 'Draw', actual: 1 },
    { label: 'Loss', actual: 0 },
  ] as const;

  const win: OutcomeImpact = { label: '', delta: 0, pctDelta: 0 };
  const draw: OutcomeImpact = { label: '', delta: 0, pctDelta: 0 };
  const loss: OutcomeImpact = { label: '', delta: 0, pctDelta: 0 };

  for (const o of outcomes) {
    const surprise = o.actual - expected;
    const newElo = teamElo + effectiveK * surprise;
    const newPrice = logistic(newElo);
    const delta = Math.round((newPrice - teamPrice) * 100) / 100;
    const pctDelta = teamPrice > 0 ? Math.round((delta / teamPrice) * 10000) / 100 : 0;
    const impact: OutcomeImpact = { label: o.label, delta, pctDelta };
    if (o.label === 'Win') { Object.assign(win, impact); }
    else if (o.label === 'Draw') { Object.assign(draw, impact); }
    else { Object.assign(loss, impact); }
  }

  return { win, draw, loss };
}

function computeModelProbs(homeElo: number, awayElo: number): { home: number; draw: number; away: number } {
  const homeExpected = 1 / (1 + Math.pow(10, (awayElo - homeElo - HOME_ADVANTAGE) / 400));
  const eloDiff = Math.abs(homeElo - awayElo);
  const drawBase = 0.26 - (eloDiff / 3000);
  const drawProb = Math.max(0.10, Math.min(0.32, drawBase));
  const homeProb = homeExpected * (1 - drawProb);
  const awayProb = (1 - homeExpected) * (1 - drawProb);
  return { home: homeProb, draw: drawProb, away: awayProb };
}

export function enrichMatch(match: UpcomingMatch): EnrichedMatch {
  const modelProbs = computeModelProbs(match.home_elo, match.away_elo);

  const hasBookmaker = match.bookmaker_home_prob !== null;
  const probs: MatchProbs = hasBookmaker
    ? {
        home: match.bookmaker_home_prob!,
        draw: match.bookmaker_draw_prob!,
        away: match.bookmaker_away_prob!,
        source: 'odds',
      }
    : { ...modelProbs, source: 'elo' };

  const homeImpacts = computeImpacts(
    match.home_elo, match.away_elo, match.home_price, match.league_mean_elo,
    probs.home, probs.draw, probs.away,
  );
  const awayImpacts = computeImpacts(
    match.away_elo, match.home_elo, match.away_price, match.league_mean_elo,
    probs.away, probs.draw, probs.home,
  );

  return { ...match, homeImpacts, awayImpacts, probs };
}
