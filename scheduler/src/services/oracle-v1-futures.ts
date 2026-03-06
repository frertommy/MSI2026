/**
 * oracle-v1-futures.ts — Futures-based market strength for offseason regime.
 *
 * When no competitive fixtures exist, derives team strength from
 * outright league winner odds.
 *
 * R_futures = 1500 + 200 × (P_title_consensus − 0.5)
 *
 * STATUS: DISABLED — ORACLE_V1_OFFSEASON_ENABLED=false
 * TODO: Rebuild data source using Polymarket futures (polymarket_futures table)
 *       instead of the retired outright_odds table (dropped in cleanup).
 *       The Polymarket poller already collects this data every 10 min.
 *
 * Constraints:
 *   - Feature-flagged: only called when ORACLE_V1_OFFSEASON_ENABLED=true
 *   - Uses basic normalization (not power de-vig) for N-way outright markets
 *   - Confidence = c_books × c_recency (no c_dispersion/c_horizon in offseason)
 */

import { log } from "../logger.js";

// ─── Main exported function ─────────────────────────────────

/**
 * Compute R_futures from outright league winner odds for a team.
 *
 * Currently returns null — data source (outright_odds) was dropped.
 * Will be rebuilt to use polymarket_futures when offseason regime is enabled.
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
  log.debug(
    `computeRFutures: skipped for ${teamId} — outright_odds dropped, ` +
    `awaiting Polymarket futures integration`
  );
  return null;
}
