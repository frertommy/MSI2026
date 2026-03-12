/**
 * oracle-v3-live.ts — Live layer (L) for the V3 Oracle.
 *
 * Ported from oracle-v2-live.ts — identical logic, uses ORACLE_V3_K.
 *
 * L(t) = K × (E_live(t) − E_KR)
 *
 * Where:
 *   E_live(t)  = expected score from latest post-kickoff (in-play) odds
 *   E_KR       = expected score from frozen kickoff reference (oracle_kr_snapshots)
 *   K          = ORACLE_V3_K (30)
 *
 * During a live match:
 *   published_index = 0.6 × (B + L) + 0.4 × R_market_frozen
 *
 * At full time:
 *   L resets to 0, B updates via settlement, M_locked & R_market_frozen clear.
 *
 * Constraints:
 *   - Only reads post-kickoff snapshots (snapshot_time > commence_time)
 *   - Staleness: rejects bookmaker snapshots older than 3 minutes
 *   - Falls back to L=0 if fewer than 2 non-stale bookmakers
 *   - Uses power de-vig + median consensus
 *   - Reuses freezeKR from V1 settlement (oracle_kr_snapshots is shared)
 */

import { getSupabase } from "../api/supabase-client.js";
import { powerDevigOdds, median } from "./odds-blend.js";
import { freezeKR } from "./oracle-v1-settlement.js";
import { ORACLE_V3_K } from "../config.js";
import { log } from "../logger.js";

// ─── Types ──────────────────────────────────────────────────

interface OddsSnapshotRow {
  fixture_id: number;
  bookmaker: string;
  home_odds: number | null;
  draw_odds: number | null;
  away_odds: number | null;
  snapshot_time: string;
}

export interface LiveLayerResult {
  L: number;
  E_live: number | null;
  E_KR: number;
  bookmaker_count: number;
  frozen: boolean;
  freeze_reason: string | null;
}

// ─── Constants ──────────────────────────────────────────────

/** Maximum staleness for a live odds snapshot — 3 minutes (2+ missed polls) */
const STALE_THRESHOLD_MS = 3 * 60 * 1000;

// ─── Main function ──────────────────────────────────────────

/**
 * Compute the live layer L for a single team during a live match.
 *
 * @param fixtureId The fixture currently in play
 * @param teamId The team to compute L for
 * @param isHome Whether this team is the home side
 * @returns LiveLayerResult with L value, metadata, and freeze status
 */
export async function computeLiveLayerV3(
  fixtureId: number,
  teamId: string,
  isHome: boolean
): Promise<LiveLayerResult> {
  const sb = getSupabase();

  // ── Step 1: Load frozen KR ──────────────────────────────
  const frozenKR = await freezeKR(fixtureId);

  if (!frozenKR) {
    log.warn(`V3 Live layer: fixture ${fixtureId} — no KR available, L=0`);
    return {
      L: 0,
      E_live: null,
      E_KR: 0,
      bookmaker_count: 0,
      frozen: true,
      freeze_reason: "no_kr_available",
    };
  }

  const E_KR = isHome
    ? frozenKR.home_expected_score
    : frozenKR.away_expected_score;

  // ── Step 2: Load commence_time ──────────────────────────
  const { data: matchData, error: matchErr } = await sb
    .from("matches")
    .select("commence_time, date")
    .eq("fixture_id", fixtureId)
    .single();

  if (matchErr || !matchData) {
    log.error(`V3 Live layer: fixture ${fixtureId} — match not found: ${matchErr?.message ?? "no data"}`);
    return { L: 0, E_live: null, E_KR, bookmaker_count: 0, frozen: true, freeze_reason: "match_not_found" };
  }

  const commenceTime = matchData.commence_time ?? `${matchData.date}T00:00:00Z`;

  // ── Step 3: Query live odds from latest_odds serving table ─
  const { data: oddsData, error: oddsErr } = await sb
    .from("latest_odds")
    .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
    .eq("fixture_id", fixtureId);

  if (oddsErr) {
    log.error(`V3 Live layer: odds query failed for fixture ${fixtureId}: ${oddsErr.message}`);
    return { L: 0, E_live: null, E_KR, bookmaker_count: 0, frozen: true, freeze_reason: "odds_query_error" };
  }

  let allSnapshots = (oddsData ?? []) as OddsSnapshotRow[];

  // ── Fallback: fixture ID mismatch ─────────────────────────
  if (allSnapshots.length === 0) {
    const { data: matchRow } = await sb
      .from("matches")
      .select("home_team, away_team, date")
      .eq("fixture_id", fixtureId)
      .single();

    if (matchRow) {
      const dayBefore = new Date(new Date(matchRow.date).getTime() - 3 * 86400000).toISOString().slice(0, 10);
      const dayAfter = new Date(new Date(matchRow.date).getTime() + 3 * 86400000).toISOString().slice(0, 10);

      const { data: altFixtures } = await sb
        .from("matches")
        .select("fixture_id")
        .eq("home_team", matchRow.home_team)
        .eq("away_team", matchRow.away_team)
        .gte("date", dayBefore)
        .lte("date", dayAfter)
        .neq("fixture_id", fixtureId);

      if (altFixtures && altFixtures.length > 0) {
        for (const alt of altFixtures) {
          const altId = alt.fixture_id as number;
          const { data: altOdds } = await sb
            .from("latest_odds")
            .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
            .eq("fixture_id", altId);

          if (altOdds && altOdds.length > 0) {
            allSnapshots = altOdds as OddsSnapshotRow[];
            log.info(
              `V3 Live layer fallback: fixture ${fixtureId} had 0 live odds, using alt ${altId} (${allSnapshots.length} bookmakers)`
            );
            break;
          }
        }
      }
    }
  }
  const commenceMs = new Date(commenceTime).getTime();

  // ── Step 4+5: Filter for post-kickoff + fresh + valid odds ─
  const nowMs = Date.now();
  const freshBooks = new Map<string, OddsSnapshotRow>();
  for (const snap of allSnapshots) {
    if (snap.home_odds == null || snap.draw_odds == null || snap.away_odds == null) continue;
    if (snap.home_odds < 1.01 || snap.draw_odds < 1.01 || snap.away_odds < 1.01) continue;
    const snapMs = new Date(snap.snapshot_time).getTime();
    if (snapMs <= commenceMs) continue;
    if (nowMs - snapMs > STALE_THRESHOLD_MS) continue;
    freshBooks.set(snap.bookmaker, snap);
  }

  // ── Step 6: Insufficient books → freeze ─────────────────
  if (freshBooks.size < 2) {
    log.warn(
      `V3 Live layer: fixture ${fixtureId} team=${teamId} — ` +
      `only ${freshBooks.size} non-stale book(s) (${allSnapshots.length} total), L=0`
    );
    return {
      L: 0,
      E_live: null,
      E_KR,
      bookmaker_count: freshBooks.size,
      frozen: true,
      freeze_reason: "insufficient_live_books",
    };
  }

  // ── Step 7: Power de-vig each bookmaker ─────────────────
  const bookmakerProbs: {
    homeProb: number;
    drawProb: number;
    awayProb: number;
  }[] = [];

  for (const [, snap] of freshBooks) {
    const probs = powerDevigOdds(snap.home_odds!, snap.draw_odds!, snap.away_odds!);
    if (probs.homeProb <= 0 || probs.drawProb <= 0 || probs.awayProb <= 0) continue;
    if (probs.homeProb >= 1 || probs.drawProb >= 1 || probs.awayProb >= 1) continue;
    bookmakerProbs.push({
      homeProb: probs.homeProb,
      drawProb: probs.drawProb,
      awayProb: probs.awayProb,
    });
  }

  if (bookmakerProbs.length < 2) {
    return {
      L: 0,
      E_live: null,
      E_KR,
      bookmaker_count: bookmakerProbs.length,
      frozen: true,
      freeze_reason: "insufficient_valid_books_after_devig",
    };
  }

  // ── Step 8: Median consensus + renormalize ──────────────
  const rawHome = median(bookmakerProbs.map(b => b.homeProb));
  const rawDraw = median(bookmakerProbs.map(b => b.drawProb));
  const rawAway = median(bookmakerProbs.map(b => b.awayProb));
  const total = rawHome + rawDraw + rawAway;
  const consensusHomeProb = rawHome / total;
  const consensusDrawProb = rawDraw / total;
  const consensusAwayProb = rawAway / total;

  // ── Step 9: Compute E_live ──────────────────────────────
  const E_live = isHome
    ? consensusHomeProb + 0.5 * consensusDrawProb
    : consensusAwayProb + 0.5 * consensusDrawProb;

  // ── Step 10: L = K × (E_live − E_KR) ───────────────────
  const L = ORACLE_V3_K * (E_live - E_KR);

  return {
    L,
    E_live,
    E_KR,
    bookmaker_count: bookmakerProbs.length,
    frozen: false,
    freeze_reason: null,
  };
}
