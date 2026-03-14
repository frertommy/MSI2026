/**
 * oracle-kr-freeze.ts — Freeze pre-kickoff odds consensus into oracle_kr_snapshots.
 *
 * Shared utility used by V1, V2, and V3 oracle systems.
 * Previously lived in oracle-v1-settlement.ts — extracted to remove
 * cross-version dependencies.
 *
 * freezeKR(fixtureId):
 *   1. Check if already frozen (idempotent — returns cached row)
 *   2. Load pre-kickoff odds from latest_preko_odds (primary) or odds_snapshots (fallback)
 *   3. Power de-vig each bookmaker, compute median consensus
 *   4. Write frozen consensus to oracle_kr_snapshots
 *
 * Constraints:
 *   - Idempotent: second call returns the existing row
 *   - Race-safe: unique constraint + retry on conflict
 *   - Requires >= 2 valid bookmakers
 *   - Prefers 6h pre-kickoff window, falls back to all pre-kickoff
 */

import { getSupabase } from "../api/supabase-client.js";
import { powerDevigOdds, median } from "./odds-blend.js";
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

export interface BookmakerKR {
  bookmaker: string;
  homeProb: number;
  drawProb: number;
  awayProb: number;
  k: number | null;
  snapshot_time: string;
}

export interface FrozenKR {
  fixture_id: number;
  bookmaker_count: number;
  home_prob: number;
  draw_prob: number;
  away_prob: number;
  home_expected_score: number;
  away_expected_score: number;
  raw_snapshots: BookmakerKR[];
}

// ─── KR Freeze ──────────────────────────────────────────────

/**
 * Freeze the pre-kickoff odds consensus for a fixture into oracle_kr_snapshots.
 * Idempotent — if a row already exists, returns it without recomputing.
 *
 * @returns FrozenKR or null if insufficient bookmaker data
 */
export async function freezeKR(fixtureId: number): Promise<FrozenKR | null> {
  const sb = getSupabase();

  // Check if already frozen
  const { data: existing, error: existErr } = await sb
    .from("oracle_kr_snapshots")
    .select("fixture_id, bookmaker_count, home_prob, draw_prob, away_prob, home_expected_score, away_expected_score, raw_snapshots")
    .eq("fixture_id", fixtureId)
    .maybeSingle();

  if (existErr) {
    log.error(`freezeKR: query failed for fixture ${fixtureId}: ${existErr.message}`);
    return null;
  }

  if (existing) {
    return {
      fixture_id: existing.fixture_id,
      bookmaker_count: existing.bookmaker_count,
      home_prob: Number(existing.home_prob),
      draw_prob: Number(existing.draw_prob),
      away_prob: Number(existing.away_prob),
      home_expected_score: Number(existing.home_expected_score),
      away_expected_score: Number(existing.away_expected_score),
      raw_snapshots: existing.raw_snapshots as BookmakerKR[],
    };
  }

  // Load match to get kickoff timestamp
  const { data: matchData, error: matchErr } = await sb
    .from("matches")
    .select("fixture_id, date, commence_time, home_team, away_team")
    .eq("fixture_id", fixtureId)
    .single();

  if (matchErr || !matchData) {
    log.error(`freezeKR: match ${fixtureId} not found: ${matchErr?.message ?? "no data"}`);
    return null;
  }

  const kickoffTs = matchData.commence_time ?? `${matchData.date}T23:59:59Z`;

  // Primary: read from latest_preko_odds serving table (one row per bookmaker, pre-KO only)
  const { data: prekoData, error: prekoErr } = await sb
    .from("latest_preko_odds")
    .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
    .eq("fixture_id", fixtureId);

  let allSnapshots: OddsSnapshotRow[];

  if (prekoErr || !prekoData || prekoData.length === 0) {
    // Fallback: archive query with DISTINCT ON logic (one per bookmaker, newest first)
    // This is scoped to a single fixture_id so it's fast even on large tables
    if (prekoErr) {
      log.warn(`freezeKR: latest_preko_odds query failed, falling back to archive: ${prekoErr.message}`);
    } else {
      log.warn(`freezeKR: fixture ${fixtureId} — no rows in latest_preko_odds, falling back to archive`);
    }

    const { data: oddsData, error: oddsErr } = await sb
      .from("odds_snapshots")
      .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
      .eq("fixture_id", fixtureId)
      .lt("snapshot_time", kickoffTs)
      .order("snapshot_time", { ascending: false });

    if (oddsErr) {
      log.error(`freezeKR: archive odds query failed for fixture ${fixtureId}: ${oddsErr.message}`);
      return null;
    }

    allSnapshots = (oddsData ?? []) as OddsSnapshotRow[];

    // Fallback: fixture ID mismatch (API-Football vs Odds API)
    if (allSnapshots.length === 0) {
      const dayBefore = new Date(new Date(matchData.date).getTime() - 3 * 86400000).toISOString().slice(0, 10);
      const dayAfter = new Date(new Date(matchData.date).getTime() + 3 * 86400000).toISOString().slice(0, 10);

      const { data: altFixtures } = await sb
        .from("matches")
        .select("fixture_id")
        .eq("home_team", matchData.home_team ?? "")
        .eq("away_team", matchData.away_team ?? "")
        .gte("date", dayBefore)
        .lte("date", dayAfter)
        .neq("fixture_id", fixtureId);

      if (altFixtures && altFixtures.length > 0) {
        for (const alt of altFixtures) {
          const altId = alt.fixture_id as number;
          // Try serving table for alt
          const { data: altPreko } = await sb
            .from("latest_preko_odds")
            .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
            .eq("fixture_id", altId);

          if (altPreko && altPreko.length > 0) {
            allSnapshots = altPreko as OddsSnapshotRow[];
            log.info(`freezeKR fallback: fixture ${fixtureId} had 0 odds, using alt ${altId} (${allSnapshots.length} bookmakers)`);
            break;
          }

          // Last resort: archive for alt
          const { data: altArchive } = await sb
            .from("odds_snapshots")
            .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
            .eq("fixture_id", altId)
            .lt("snapshot_time", kickoffTs)
            .order("snapshot_time", { ascending: false });

          if (altArchive && altArchive.length > 0) {
            allSnapshots = altArchive as OddsSnapshotRow[];
            log.info(`freezeKR fallback (archive): fixture ${fixtureId} had 0 odds, using alt ${altId} (${allSnapshots.length} snapshots)`);
            break;
          }
        }
      }
    }
  } else {
    allSnapshots = prekoData as OddsSnapshotRow[];
  }

  // Latest valid snapshot per bookmaker
  // For latest_preko_odds: already one-per-bookmaker, but still validate quality
  // For archive fallback: dedup to one-per-bookmaker (results ordered by snapshot_time DESC)
  const latestByBook = new Map<string, OddsSnapshotRow>();
  for (const snap of allSnapshots) {
    if (latestByBook.has(snap.bookmaker)) continue;
    if (snap.home_odds == null || snap.draw_odds == null || snap.away_odds == null) continue;
    if (snap.home_odds < 1.01 || snap.draw_odds < 1.01 || snap.away_odds < 1.01) continue;
    latestByBook.set(snap.bookmaker, snap);
  }

  // Prefer snapshots within 6h of kickoff for better KR quality
  const SIX_HOURS_MS = 6 * 3600 * 1000;
  const kickoffMs = new Date(kickoffTs).getTime();

  const recentByBook = new Map<string, OddsSnapshotRow>();
  for (const [book, snap] of latestByBook) {
    const snapMs = new Date(snap.snapshot_time).getTime();
    if (kickoffMs - snapMs <= SIX_HOURS_MS) {
      recentByBook.set(book, snap);
    }
  }

  // Use 6h window if ≥2 books available; otherwise fall back to all pre-kickoff
  const selectedBooks = recentByBook.size >= 2 ? recentByBook : latestByBook;
  const krDegraded = recentByBook.size < 2;

  if (krDegraded) {
    log.warn(
      `freezeKR: fixture ${fixtureId} — only ${recentByBook.size} book(s) in 6h window, ` +
      `falling back to all ${latestByBook.size} pre-kickoff snapshots`
    );
  }

  // De-vig each bookmaker (power de-vig)
  const bookmakerKRs: BookmakerKR[] = [];
  for (const [bookmaker, snap] of selectedBooks) {
    const probs = powerDevigOdds(snap.home_odds!, snap.draw_odds!, snap.away_odds!);
    if (probs.homeProb <= 0 || probs.drawProb <= 0 || probs.awayProb <= 0) continue;
    if (probs.homeProb >= 1 || probs.drawProb >= 1 || probs.awayProb >= 1) continue;

    bookmakerKRs.push({
      bookmaker,
      homeProb: probs.homeProb,
      drawProb: probs.drawProb,
      awayProb: probs.awayProb,
      k: probs.k,
      snapshot_time: snap.snapshot_time,
    });
  }

  // Insufficient bookmakers
  if (bookmakerKRs.length < 2) {
    log.error(
      `freezeKR: fixture ${fixtureId} — only ${bookmakerKRs.length} valid bookmaker(s), need ≥2`
    );
    return null;
  }

  // Compute consensus via median (robust to outlier bookmakers) + renormalize
  const n = bookmakerKRs.length;
  const rawHome = median(bookmakerKRs.map(b => b.homeProb));
  const rawDraw = median(bookmakerKRs.map(b => b.drawProb));
  const rawAway = median(bookmakerKRs.map(b => b.awayProb));
  const total = rawHome + rawDraw + rawAway;
  const homeProb = rawHome / total;
  const drawProb = rawDraw / total;
  const awayProb = rawAway / total;

  // Raw 2-outcome Elo expected score (stored for audit)
  const homeExpectedScoreRaw = homeProb + 0.5 * drawProb;
  const awayExpectedScoreRaw = awayProb + 0.5 * drawProb;

  // Draw-corrected E_KR: fixes ~25 Elo/season systematic bias from 3-outcome mismatch
  // E_corrected = E_raw + pDraw × (0.5 − E_raw)
  const homeExpectedScore = homeExpectedScoreRaw + drawProb * (0.5 - homeExpectedScoreRaw);
  const awayExpectedScore = awayExpectedScoreRaw + drawProb * (0.5 - awayExpectedScoreRaw);

  // Write to oracle_kr_snapshots
  const row = {
    fixture_id: fixtureId,
    bookmaker_count: n,
    bookmakers_used: bookmakerKRs.map(b => b.bookmaker),
    home_prob: Number(homeProb.toFixed(6)),
    draw_prob: Number(drawProb.toFixed(6)),
    away_prob: Number(awayProb.toFixed(6)),
    home_expected_score: Number(homeExpectedScore.toFixed(6)),
    away_expected_score: Number(awayExpectedScore.toFixed(6)),
    home_expected_score_raw: Number(homeExpectedScoreRaw.toFixed(6)),
    away_expected_score_raw: Number(awayExpectedScoreRaw.toFixed(6)),
    raw_snapshots: bookmakerKRs.map(b => ({
      bookmaker: b.bookmaker,
      homeProb: Number(b.homeProb.toFixed(6)),
      drawProb: Number(b.drawProb.toFixed(6)),
      awayProb: Number(b.awayProb.toFixed(6)),
      k: b.k !== null ? Number(b.k.toFixed(6)) : null,
      snapshot_time: b.snapshot_time,
    })),
    method: "power_devig_median_v1.5_draw_corrected",
    kr_degraded: krDegraded,
  };

  const { error: insertErr } = await sb
    .from("oracle_kr_snapshots")
    .insert([row]);

  if (insertErr) {
    // Might be a race — another process froze it first. Try reading again.
    if (insertErr.code === "23505") {
      log.debug(`freezeKR: fixture ${fixtureId} already frozen (race), reading back`);
      return freezeKR(fixtureId);
    }
    log.error(`freezeKR: insert failed for fixture ${fixtureId}: ${insertErr.message}`);
    return null;
  }

  log.debug(
    `freezeKR: fixture ${fixtureId} frozen with ${n} bookmakers` +
    `${krDegraded ? ' (DEGRADED — no 6h window)' : ''}`
  );

  return {
    fixture_id: fixtureId,
    bookmaker_count: n,
    home_prob: Number(homeProb.toFixed(6)),
    draw_prob: Number(drawProb.toFixed(6)),
    away_prob: Number(awayProb.toFixed(6)),
    home_expected_score: Number(homeExpectedScore.toFixed(6)),
    away_expected_score: Number(awayExpectedScore.toFixed(6)),
    raw_snapshots: bookmakerKRs,
  };
}
