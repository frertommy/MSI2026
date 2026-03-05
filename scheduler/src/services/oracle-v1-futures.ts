/**
 * oracle-v1-futures.ts — Futures-based market strength for offseason regime.
 *
 * When no competitive fixtures exist, derives team strength from
 * outright league winner odds (already polled every 6h into outright_odds).
 *
 * R_futures = 1500 + 200 × (P_title_consensus − 0.5)
 *
 * This maps:
 *   P_title = 0.50 → R_futures = 1600 (strong title contender)
 *   P_title = 0.10 → R_futures = 1420 (midtable)
 *   P_title = 0.01 → R_futures = 1402 (relegation zone)
 *   P_title = 0.002 → R_futures = 1400 (newly promoted)
 *
 * Constraints:
 *   - No imports from pricing-engine.ts, oracle-v1-settlement.ts, or oracle-v1-live.ts
 *   - Uses basic normalization (not power de-vig) for N-way outright markets
 *   - Confidence = c_books × c_recency (no c_dispersion/c_horizon in offseason)
 *   - Feature-flagged: only called when ORACLE_V1_OFFSEASON_ENABLED=true
 */

import { getSupabase } from "../api/supabase-client.js";
import { median } from "./odds-blend.js";
import { log } from "../logger.js";

// ─── Constants ──────────────────────────────────────────────

/** Staleness threshold: outright snapshots older than 7 days are stale */
const STALE_DAYS = 7;

// ─── Outright normalization helper ──────────────────────────

/**
 * Normalize a single team's outright probability within their league.
 * Loads all teams' outrights for the same bookmaker + league at the same snapshot,
 * sums raw implied probs, divides.
 */
async function normalizeOutrightProb(
  sb: ReturnType<typeof getSupabase>,
  league: string,
  bookmaker: string,
  teamOdds: number,
  snapshotTime: string
): Promise<number | null> {
  // Get all teams' odds from this bookmaker at this snapshot time
  const { data } = await sb
    .from("outright_odds")
    .select("team, outright_odds")
    .eq("league", league)
    .eq("bookmaker", bookmaker)
    .eq("snapshot_time", snapshotTime);

  if (!data || data.length < 5) return null; // need a meaningful market

  const totalRaw = data.reduce((sum, row) => sum + 1 / row.outright_odds, 0);
  if (totalRaw <= 0) return null;

  return (1 / teamOdds) / totalRaw;
}

// ─── Main exported function ─────────────────────────────────

/**
 * Compute R_futures from outright league winner odds for a team.
 *
 * @param teamId - The team identifier
 * @param league - The team's league name (must match outright_odds.league)
 * @returns Futures-based strength or null if insufficient data
 */
export async function computeRFutures(
  teamId: string,
  league: string
): Promise<{
  R_futures: number;
  P_title: number;
  bookmaker_count: number;
  confidence: number;
  stale: boolean;
} | null> {
  const sb = getSupabase();

  // 1. Query outright_odds for the team's league, latest first
  const { data, error } = await sb
    .from("outright_odds")
    .select("team, bookmaker, outright_odds, snapshot_time")
    .eq("league", league)
    .eq("team", teamId)
    .order("snapshot_time", { ascending: false });

  if (error) {
    log.error(`computeRFutures: query failed for ${teamId} in ${league}: ${error.message}`);
    return null;
  }

  if (!data || data.length === 0) {
    return null;
  }

  // 2. Latest per bookmaker (first occurrence wins since sorted descending)
  const latestByBook = new Map<string, { odds: number; snapshot_time: string }>();
  for (const row of data) {
    if (latestByBook.has(row.bookmaker)) continue;
    if (row.outright_odds < 1.01) continue; // reject invalid odds
    latestByBook.set(row.bookmaker, {
      odds: row.outright_odds,
      snapshot_time: row.snapshot_time,
    });
  }

  // 3. Need at least 2 bookmakers
  if (latestByBook.size < 2) {
    return null;
  }

  // 4. Normalize title probabilities per bookmaker
  const bookmakerTitleProbs: number[] = [];
  let latestTimestamp = 0;

  for (const [bookmaker, entry] of latestByBook) {
    const normalizedProb = await normalizeOutrightProb(
      sb,
      league,
      bookmaker,
      entry.odds,
      entry.snapshot_time
    );

    if (normalizedProb !== null && normalizedProb > 0 && normalizedProb < 1) {
      bookmakerTitleProbs.push(normalizedProb);
    }

    const ts = new Date(entry.snapshot_time).getTime();
    if (ts > latestTimestamp) latestTimestamp = ts;
  }

  // Need at least 2 valid bookmakers after normalization
  if (bookmakerTitleProbs.length < 2) {
    return null;
  }

  // 5. Median across bookmakers → P_title
  const P_title = median(bookmakerTitleProbs);

  // 6. Compute confidence
  const n_valid_books = bookmakerTitleProbs.length;
  const c_books = Math.min(n_valid_books / 3, 1); // lower threshold for outrights
  const hoursSinceLatest = (Date.now() - latestTimestamp) / (1000 * 3600);
  const c_recency = Math.max(0, 1 - hoursSinceLatest / 72); // 72h threshold
  const confidence = c_books * c_recency;

  // 7. Check validity
  if (confidence <= 0 || isNaN(P_title) || P_title <= 0) {
    return null;
  }

  // 8. R_futures = 1500 + 200 × (P_title − 0.5)
  const R_futures = 1500 + 200 * (P_title - 0.5);

  // 9. Check staleness: > 7 days old
  const daysSinceLatest = hoursSinceLatest / 24;
  const stale = daysSinceLatest > STALE_DAYS;

  // 10. Return
  return {
    R_futures,
    P_title,
    bookmaker_count: n_valid_books,
    confidence,
    stale,
  };
}
