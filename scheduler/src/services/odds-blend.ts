/**
 * Odds Blend — shared functions for pricing engine and MeasureMe.
 *
 * Provides:
 *   - normalizeOdds()         — decimal odds → implied probabilities
 *   - oddsImpliedStrength()   — invert Elo expected-score formula
 *   - findNextMatch()         — next fixture strictly after a date
 *   - getLatestOddsForFixture() — latest snapshot as of date, prefer Pinnacle
 *   - findLiveMatch()         — find a team's current live match
 *   - getCurrentMatchOdds()   — latest odds snapshot (no date filter)
 *   - calibrateHomeAdvantage() — empirical home win rate → Elo advantage
 */
import type { DriftSnapshot } from "../types.js";

// ─── Odds normalization ──────────────────────────────────────
/**
 * Convert decimal odds to implied probabilities with overround removed.
 */
export function normalizeOdds(
  homeOdds: number,
  drawOdds: number,
  awayOdds: number
): { homeProb: number; drawProb: number; awayProb: number } {
  const rH = 1 / homeOdds;
  const rD = 1 / drawOdds;
  const rA = 1 / awayOdds;
  const total = rH + rD + rA;
  return {
    homeProb: rH / total,
    drawProb: rD / total,
    awayProb: rA / total,
  };
}

// ─── Power de-vig ───────────────────────────────────────────
/**
 * Power de-vig: find exponent k such that (1/H)^k + (1/D)^k + (1/A)^k = 1.
 * Corrects favorite-longshot bias that basic proportional normalization misses.
 * Falls back to normalizeOdds() if any odds < 1.01 or solver fails.
 */
export function powerDevigOdds(
  homeOdds: number,
  drawOdds: number,
  awayOdds: number
): { homeProb: number; drawProb: number; awayProb: number; k: number | null } {
  const rH = 1 / homeOdds;
  const rD = 1 / drawOdds;
  const rA = 1 / awayOdds;

  // Guard: degenerate odds → fall back
  if (homeOdds < 1.01 || drawOdds < 1.01 || awayOdds < 1.01) {
    const fallback = normalizeOdds(homeOdds, drawOdds, awayOdds);
    return { ...fallback, k: null };
  }

  // Bisection: find k where f(k) = rH^k + rD^k + rA^k - 1 = 0
  // f(k) is monotonically decreasing (all r_i < 1, so higher k → smaller r_i^k)
  let lo = 0.01;
  let hi = 10.0;
  let mid = 1.0;
  const TOL = 1e-10;
  const MAX_ITER = 100;

  const f = (k: number) => rH ** k + rD ** k + rA ** k - 1;

  // Verify bracket: f(lo) should be > 0, f(hi) should be < 0
  if (f(lo) < 0 || f(hi) > 0) {
    const fallback = normalizeOdds(homeOdds, drawOdds, awayOdds);
    return { ...fallback, k: null };
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

// ─── Find next match ─────────────────────────────────────────
/**
 * Find a team's next upcoming match STRICTLY AFTER currentDate.
 * On match day, today's match is already settled into matchElo via shock —
 * we want the NEXT fixture for forward-looking odds blend.
 *
 * @param matches Must be sorted by date ascending.
 * @param lookaheadDays How far ahead to search (default 14).
 */
export function findNextMatch<
  M extends { date: string; home_team: string; away_team: string; fixture_id: number }
>(
  team: string,
  currentDate: string,
  matches: M[],
  lookaheadDays: number = 14
): M | null {
  // Compute cutoff date string (YYYY-MM-DD)
  const cutoffDate = new Date(currentDate);
  cutoffDate.setDate(cutoffDate.getDate() + lookaheadDays);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  for (const m of matches) {
    if (m.date <= currentDate) continue; // STRICTLY AFTER
    if (m.date > cutoff) break; // matches are sorted by date
    if (m.home_team === team || m.away_team === team) return m;
  }
  return null;
}

// ─── Get latest odds for a fixture ───────────────────────────
/**
 * Find the latest odds snapshot for a fixture as of a given date.
 * Prefers Pinnacle but won't scan >20 entries past the best non-Pinnacle.
 *
 * Returns raw decimal odds (not probabilities) — caller normalizes.
 */
export function getLatestOddsForFixture(
  fixtureId: number,
  asOfDate: string,
  oddsIndex: Map<number, DriftSnapshot[]>
): { homeOdds: number; drawOdds: number; awayOdds: number } | null {
  const snapshots = oddsIndex.get(fixtureId);
  if (!snapshots?.length) return null;

  const cutoff = asOfDate + "T23:59:59Z";

  let bestPinnacle: DriftSnapshot | null = null;
  let bestAny: DriftSnapshot | null = null;
  let scannedPastBestAny = 0;

  // Scan backwards (most recent first)
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i];
    if (s.snapshot_time > cutoff) continue;

    if (!bestAny) bestAny = s;

    if (s.bookmaker === "pinnacle") {
      bestPinnacle = s;
      break;
    }

    // Don't scan forever looking for Pinnacle
    if (bestAny) {
      scannedPastBestAny++;
      if (scannedPastBestAny > 20) break;
    }
  }

  const pick = bestPinnacle ?? bestAny;
  if (!pick || !pick.home_odds || !pick.draw_odds || !pick.away_odds) return null;

  return {
    homeOdds: pick.home_odds,
    drawOdds: pick.draw_odds,
    awayOdds: pick.away_odds,
  };
}

// ─── Find live match ────────────────────────────────────────
/**
 * Find a live match for a team. Scans ALL matches (not date-filtered)
 * to handle late-night matches crossing midnight.
 * Returns the match if status === "live".
 */
export function findLiveMatch<
  M extends { home_team: string; away_team: string; status: string }
>(team: string, matches: M[]): M | null {
  for (const m of matches) {
    if (m.status !== "live") continue;
    if (m.home_team === team || m.away_team === team) return m;
  }
  return null;
}

// ─── Get current in-play odds ───────────────────────────────
/**
 * Get current in-play odds for a live fixture.
 * Uses the most recent snapshot (no asOfDate filter — we want NOW).
 * Prefers Pinnacle, max 20 scan backward.
 */
export function getCurrentMatchOdds(
  fixtureId: number,
  oddsIndex: Map<number, DriftSnapshot[]>
): { homeOdds: number; drawOdds: number; awayOdds: number } | null {
  const snapshots = oddsIndex.get(fixtureId);
  if (!snapshots?.length) return null;

  let bestPinnacle: DriftSnapshot | null = null;
  let bestAny: DriftSnapshot | null = null;
  let scanned = 0;

  // Scan from most recent (no date cutoff — want latest available)
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i];
    if (!bestAny) bestAny = s;
    if (s.bookmaker === "pinnacle") {
      bestPinnacle = s;
      break;
    }
    scanned++;
    if (scanned > 20) break;
  }

  const pick = bestPinnacle ?? bestAny;
  if (!pick || !pick.home_odds || !pick.draw_odds || !pick.away_odds) return null;
  return {
    homeOdds: pick.home_odds,
    drawOdds: pick.draw_odds,
    awayOdds: pick.away_odds,
  };
}

// ─── Calibrate home advantage ────────────────────────────────
/**
 * Compute empirical home advantage in Elo points from match results.
 * Converts home win rate → Elo advantage via logit formula.
 */
export function calibrateHomeAdvantage(
  matches: Array<{ score: string }>
): number {
  let homeWins = 0;
  let total = 0;

  for (const m of matches) {
    const parts = m.score.split("-");
    if (parts.length !== 2) continue;
    const h = parseInt(parts[0].trim());
    const a = parseInt(parts[1].trim());
    if (isNaN(h) || isNaN(a)) continue;
    total++;
    if (h > a) homeWins++;
  }

  const homeWinRate = total > 0 ? homeWins / total : 0.46;
  const prob = Math.max(0.001, Math.min(0.999, homeWinRate));
  return -400 * Math.log10(1 / prob - 1);
}
