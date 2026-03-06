/**
 * Odds Blend — shared statistical functions for Oracle V1 pipeline.
 *
 * Provides:
 *   - powerDevigOdds()       — power de-vig: corrects favorite-longshot bias
 *   - median()               — robust consensus across bookmakers
 *   - oddsImpliedStrength()  — invert Elo expected-score formula
 *
 * Legacy functions (normalizeOdds, findNextMatch, getLatestOddsForFixture,
 * findLiveMatch, getCurrentMatchOdds, calibrateHomeAdvantage) removed in
 * cleanup — they only served the retired pricing-engine. See git history.
 */

// ─── Power de-vig ───────────────────────────────────────────
/**
 * Power de-vig: find exponent k such that (1/H)^k + (1/D)^k + (1/A)^k = 1.
 * Corrects favorite-longshot bias that basic proportional normalization misses.
 * Falls back to proportional normalization if any odds < 1.01 or solver fails.
 */
export function powerDevigOdds(
  homeOdds: number,
  drawOdds: number,
  awayOdds: number
): { homeProb: number; drawProb: number; awayProb: number; k: number | null } {
  const rH = 1 / homeOdds;
  const rD = 1 / drawOdds;
  const rA = 1 / awayOdds;

  // Guard: degenerate odds → fall back to proportional
  if (homeOdds < 1.01 || drawOdds < 1.01 || awayOdds < 1.01) {
    const total = rH + rD + rA;
    return { homeProb: rH / total, drawProb: rD / total, awayProb: rA / total, k: null };
  }

  // Bisection: find k where f(k) = rH^k + rD^k + rA^k - 1 = 0
  let lo = 0.01;
  let hi = 10.0;
  let mid = 1.0;
  const TOL = 1e-10;
  const MAX_ITER = 100;

  const f = (k: number) => rH ** k + rD ** k + rA ** k - 1;

  // Verify bracket: f(lo) should be > 0, f(hi) should be < 0
  if (f(lo) < 0 || f(hi) > 0) {
    const total = rH + rD + rA;
    return { homeProb: rH / total, drawProb: rD / total, awayProb: rA / total, k: null };
  }

  for (let i = 0; i < MAX_ITER; i++) {
    mid = (lo + hi) / 2;
    const fMid = f(mid);
    if (Math.abs(fMid) < TOL) break;
    if (fMid > 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const homeProb = rH ** mid;
  const drawProb = rD ** mid;
  const awayProb = rA ** mid;

  return { homeProb, drawProb, awayProb, k: mid };
}

// ─── Median helper ──────────────────────────────────────────
/**
 * Standard median: sort ascending, return middle element
 * (or average of two middle elements for even length).
 */
export function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

// ─── Odds-implied Elo strength ───────────────────────────────
/**
 * Given a team's expected score (from odds) and their opponent's Elo,
 * invert the Elo formula to find the team's implied strength.
 *
 * CRITICAL: strips home advantage to get neutral team strength.
 * Without this, price oscillates 5-10% on home/away fixture transitions.
 *
 * Example:
 *   Arsenal home vs Wolves: 82% → raw 1950 − homeAdv 65 → 1885
 *   Arsenal away at City:   35% → raw 1720 + homeAdv 65 → 1785
 *   The 100-point gap reflects opponent quality, not venue.
 */
export function oddsImpliedStrength(
  teamExpectedScore: number,
  opponentElo: number,
  isHome: boolean,
  homeAdv: number
): number {
  const es = Math.max(0.01, Math.min(0.99, teamExpectedScore));
  const rawImplied = opponentElo + 400 * Math.log10(es / (1 - es));

  // Strip home advantage to get neutral team strength
  return isHome ? rawImplied - homeAdv : rawImplied + homeAdv;
}
