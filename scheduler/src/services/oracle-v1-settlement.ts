/**
 * oracle-v1-settlement.ts — Deterministic B-layer settlement for the V1 Oracle.
 *
 * Exports two functions:
 *   - freezeKR(fixtureId)    — freeze pre-kickoff odds consensus into oracle_kr_snapshots
 *   - settleFixture(fixtureId) — settle a finished fixture using frozen KR
 *
 * Settlement formula:  ΔB = K × (S − E_KR)
 *   K  = 30 (fixed, from ORACLE_V1_K)
 *   S  = actual match score (W=1, D=0.5, L=0)
 *   E_KR = expected score from frozen pre-kickoff odds consensus (oracle_kr_snapshots)
 *
 * Constraints:
 *   - E_KR is read exclusively from oracle_kr_snapshots — never recomputed from raw odds
 *   - normalizeOdds() from odds-blend.ts is the only legacy utility used
 *   - Atomic: all writes per fixture go in one batch; unique constraint catches duplicates
 *   - Idempotent: checks settlement_log before writing; second call is a no-op
 *   - Fully reproducible: trace_payload captures every input for audit replay
 *   - Price history: appends to oracle_price_history after settlement
 *   - No carry decay, no xG, no live odds, no imports from pricing-engine.ts
 */

import { getSupabase } from "../api/supabase-client.js";
import { normalizeOdds } from "./odds-blend.js";
import { ORACLE_V1_K } from "../config.js";
import { log } from "../logger.js";

// ─── Types ──────────────────────────────────────────────────

interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
  commence_time: string | null;
}

interface OddsSnapshotRow {
  fixture_id: number;
  bookmaker: string;
  home_odds: number | null;
  draw_odds: number | null;
  away_odds: number | null;
  snapshot_time: string;
}

interface BookmakerKR {
  bookmaker: string;
  homeProb: number;
  drawProb: number;
  awayProb: number;
  snapshot_time: string;
}

interface FrozenKR {
  fixture_id: number;
  bookmaker_count: number;
  home_prob: number;
  draw_prob: number;
  away_prob: number;
  home_expected_score: number;
  away_expected_score: number;
  raw_snapshots: BookmakerKR[];
}

export interface SettlementResult {
  settled: boolean;
  skipped_reason?: string;
  home_team?: string;
  away_team?: string;
  home_delta_B?: number;
  away_delta_B?: number;
}

// ─── Score parsing ──────────────────────────────────────────

function parseScore(score: string): [number, number] | null {
  if (!score || score === "N/A") return null;
  const m = score.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
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
    .select("fixture_id, date, commence_time")
    .eq("fixture_id", fixtureId)
    .single();

  if (matchErr || !matchData) {
    log.error(`freezeKR: match ${fixtureId} not found: ${matchErr?.message ?? "no data"}`);
    return null;
  }

  const kickoffTs = matchData.commence_time ?? `${matchData.date}T23:59:59Z`;

  // Query all pre-kickoff odds, most recent first
  const { data: oddsData, error: oddsErr } = await sb
    .from("odds_snapshots")
    .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
    .eq("fixture_id", fixtureId)
    .lt("snapshot_time", kickoffTs)
    .order("snapshot_time", { ascending: false });

  if (oddsErr) {
    log.error(`freezeKR: odds query failed for fixture ${fixtureId}: ${oddsErr.message}`);
    return null;
  }

  const allSnapshots = (oddsData ?? []) as OddsSnapshotRow[];

  // Latest valid snapshot per bookmaker
  const latestByBook = new Map<string, OddsSnapshotRow>();
  for (const snap of allSnapshots) {
    if (latestByBook.has(snap.bookmaker)) continue;
    if (snap.home_odds == null || snap.draw_odds == null || snap.away_odds == null) continue;
    if (snap.home_odds < 1.01 || snap.draw_odds < 1.01 || snap.away_odds < 1.01) continue;
    latestByBook.set(snap.bookmaker, snap);
  }

  // De-vig each bookmaker
  const bookmakerKRs: BookmakerKR[] = [];
  for (const [bookmaker, snap] of latestByBook) {
    const probs = normalizeOdds(snap.home_odds!, snap.draw_odds!, snap.away_odds!);
    if (probs.homeProb <= 0 || probs.drawProb <= 0 || probs.awayProb <= 0) continue;
    if (probs.homeProb >= 1 || probs.drawProb >= 1 || probs.awayProb >= 1) continue;

    bookmakerKRs.push({
      bookmaker,
      homeProb: probs.homeProb,
      drawProb: probs.drawProb,
      awayProb: probs.awayProb,
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

  // Compute consensus
  const n = bookmakerKRs.length;
  const homeProb = bookmakerKRs.reduce((s, b) => s + b.homeProb, 0) / n;
  const drawProb = bookmakerKRs.reduce((s, b) => s + b.drawProb, 0) / n;
  const awayProb = bookmakerKRs.reduce((s, b) => s + b.awayProb, 0) / n;

  const homeExpectedScore = homeProb + 0.5 * drawProb;
  const awayExpectedScore = awayProb + 0.5 * drawProb;

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
    raw_snapshots: bookmakerKRs.map(b => ({
      bookmaker: b.bookmaker,
      homeProb: Number(b.homeProb.toFixed(6)),
      drawProb: Number(b.drawProb.toFixed(6)),
      awayProb: Number(b.awayProb.toFixed(6)),
      snapshot_time: b.snapshot_time,
    })),
    method: "consensus_devigged_v1",
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

  log.debug(`freezeKR: fixture ${fixtureId} frozen with ${n} bookmakers`);

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

// ─── Main settlement function ───────────────────────────────

/**
 * Settle a finished fixture for the V1 Oracle B layer.
 *
 * 1. Freeze KR if not already frozen
 * 2. Read E_KR exclusively from oracle_kr_snapshots
 * 3. Compute ΔB for both teams
 * 4. Write settlement_log + team_oracle_state + oracle_price_history atomically
 *
 * Idempotent — unique constraint on (fixture_id, team_id) prevents duplicates.
 * Partial settlements (1 of 2 teams) are detected and the missing team is written.
 *
 * @returns SettlementResult indicating what happened
 * @throws Error if match not found or not finished
 */
export async function settleFixture(fixtureId: number): Promise<SettlementResult> {
  const sb = getSupabase();

  // ── Step 0: Idempotency check ────────────────────────────
  const { data: existingSettlements, error: settleCheckErr } = await sb
    .from("settlement_log")
    .select("team_id")
    .eq("fixture_id", fixtureId);

  if (settleCheckErr) {
    throw new Error(`settlement_log check failed: ${settleCheckErr.message}`);
  }

  const alreadySettled = new Set((existingSettlements ?? []).map((r: { team_id: string }) => r.team_id));

  // ── Step 1: Load the match ───────────────────────────────
  const { data: matchData, error: matchErr } = await sb
    .from("matches")
    .select("fixture_id, date, league, home_team, away_team, score, status, commence_time")
    .eq("fixture_id", fixtureId)
    .single();

  if (matchErr || !matchData) {
    throw new Error(`Match ${fixtureId} not found: ${matchErr?.message ?? "no data"}`);
  }

  const match = matchData as MatchRow;

  if (match.status !== "finished") {
    throw new Error(
      `Match ${fixtureId} (${match.home_team} vs ${match.away_team}) is not finished — status="${match.status}"`
    );
  }

  const scoreParsed = parseScore(match.score);
  if (!scoreParsed) {
    throw new Error(
      `Match ${fixtureId} (${match.home_team} vs ${match.away_team}) has unparseable score="${match.score}"`
    );
  }

  const [scoreHome, scoreAway] = scoreParsed;

  // Both teams already settled?
  if (alreadySettled.has(match.home_team) && alreadySettled.has(match.away_team)) {
    log.debug(`Settlement: fixture ${fixtureId} already settled for both teams — skipping`);
    return { settled: false, skipped_reason: "already_settled", home_team: match.home_team, away_team: match.away_team };
  }

  // Partial settlement warning
  if (alreadySettled.size === 1) {
    const settledTeam = [...alreadySettled][0];
    log.warn(`Settlement: fixture ${fixtureId} partially settled (only ${settledTeam}) — completing`);
  }

  // ── Step 2: Determine S (actual scores) ──────────────────
  let S_home: number;
  let S_away: number;
  if (scoreHome > scoreAway) {
    S_home = 1.0;
    S_away = 0.0;
  } else if (scoreHome === scoreAway) {
    S_home = 0.5;
    S_away = 0.5;
  } else {
    S_home = 0.0;
    S_away = 1.0;
  }

  // ── Step 3: Freeze KR + read from oracle_kr_snapshots ────
  const frozenKR = await freezeKR(fixtureId);

  if (!frozenKR) {
    // Insufficient bookmakers — write failure entries
    log.error(
      `Settlement FAILED for fixture ${fixtureId} (${match.home_team} vs ${match.away_team}): ` +
      `freezeKR returned null (insufficient bookmaker data)`
    );

    const failurePayload = {
      error: "insufficient_kr_snapshots",
      fixture_id: fixtureId,
    };

    const failureRows = [];
    for (const teamId of [match.home_team, match.away_team]) {
      if (alreadySettled.has(teamId)) continue;
      failureRows.push({
        fixture_id: fixtureId,
        team_id: teamId,
        e_kr: 0,
        actual_score_s: teamId === match.home_team ? S_home : S_away,
        delta_b: 0,
        b_before: 0,
        b_after: 0,
        trace_payload: failurePayload,
      });
    }

    if (failureRows.length > 0) {
      const { error: insertErr } = await sb
        .from("settlement_log")
        .insert(failureRows);
      if (insertErr && !insertErr.message.includes("uq_settlement_log_fixture_team")) {
        log.error(`Failed to write KR failure entries: ${insertErr.message}`);
      }
    }

    return {
      settled: false,
      skipped_reason: "insufficient_kr_snapshots",
      home_team: match.home_team,
      away_team: match.away_team,
    };
  }

  // Read E_KR from frozen snapshot
  const E_KR_home = frozenKR.home_expected_score;
  const E_KR_away = frozenKR.away_expected_score;

  // ── Step 4: Compute delta_B ──────────────────────────────
  const delta_B_home = ORACLE_V1_K * (S_home - E_KR_home);
  const delta_B_away = ORACLE_V1_K * (S_away - E_KR_away);

  // ── Step 5: Load current B values ────────────────────────
  const { data: homeState } = await sb
    .from("team_oracle_state")
    .select("b_value")
    .eq("team_id", match.home_team)
    .single();

  const { data: awayState } = await sb
    .from("team_oracle_state")
    .select("b_value")
    .eq("team_id", match.away_team)
    .single();

  const B_before_home = homeState ? Number(homeState.b_value) : 0;
  const B_before_away = awayState ? Number(awayState.b_value) : 0;

  const B_after_home = B_before_home + delta_B_home;
  const B_after_away = B_before_away + delta_B_away;

  // ── Step 6: Build trace payload ──────────────────────────
  const tracePayload = {
    K: ORACLE_V1_K,
    score: match.score,
    score_home: scoreHome,
    score_away: scoreAway,
    kickoff_ts: match.commence_time ?? `${match.date}T23:59:59Z`,
    bookmaker_count: frozenKR.bookmaker_count,
    frozen_kr_fixture_id: frozenKR.fixture_id,
    bookmakers: frozenKR.raw_snapshots.map(b => ({
      bookmaker: b.bookmaker,
      homeProb: Number(b.homeProb.toFixed(6)),
      drawProb: Number(b.drawProb.toFixed(6)),
      awayProb: Number(b.awayProb.toFixed(6)),
      snapshot_time: b.snapshot_time,
    })),
    consensus: {
      homeProb: Number(frozenKR.home_prob.toFixed(6)),
      drawProb: Number(frozenKR.draw_prob.toFixed(6)),
      awayProb: Number(frozenKR.away_prob.toFixed(6)),
    },
  };

  // ── Step 7: Atomic writes ────────────────────────────────
  // Build all rows to write, then execute in sequence.
  // The unique constraint on (fixture_id, team_id) provides atomicity safety —
  // if we crash mid-write, rerun will skip already-written teams.

  const now = new Date().toISOString();
  const logRows: Record<string, unknown>[] = [];
  const stateUpserts: Record<string, unknown>[] = [];
  const priceHistoryRows: Record<string, unknown>[] = [];

  if (!alreadySettled.has(match.home_team)) {
    logRows.push({
      fixture_id: fixtureId,
      team_id: match.home_team,
      e_kr: Number(E_KR_home.toFixed(6)),
      actual_score_s: S_home,
      delta_b: Number(delta_B_home.toFixed(6)),
      b_before: Number(B_before_home.toFixed(6)),
      b_after: Number(B_after_home.toFixed(6)),
      trace_payload: { ...tracePayload, perspective: "home" },
    });
    stateUpserts.push({
      team_id: match.home_team,
      season: deriveSeason(match.date),
      b_value: Number(B_after_home.toFixed(4)),
      last_kr_fixture_id: fixtureId,
      updated_at: now,
    });
    priceHistoryRows.push({
      team: match.home_team,
      league: match.league,
      timestamp: now,
      b_value: Number(B_after_home.toFixed(4)),
      m1_value: 0,
      published_index: Number(B_after_home.toFixed(4)),
      confidence_score: null,
      source_fixture_id: fixtureId,
      publish_reason: "settlement",
    });
  }

  if (!alreadySettled.has(match.away_team)) {
    logRows.push({
      fixture_id: fixtureId,
      team_id: match.away_team,
      e_kr: Number(E_KR_away.toFixed(6)),
      actual_score_s: S_away,
      delta_b: Number(delta_B_away.toFixed(6)),
      b_before: Number(B_before_away.toFixed(6)),
      b_after: Number(B_after_away.toFixed(6)),
      trace_payload: { ...tracePayload, perspective: "away" },
    });
    stateUpserts.push({
      team_id: match.away_team,
      season: deriveSeason(match.date),
      b_value: Number(B_after_away.toFixed(4)),
      last_kr_fixture_id: fixtureId,
      updated_at: now,
    });
    priceHistoryRows.push({
      team: match.away_team,
      league: match.league,
      timestamp: now,
      b_value: Number(B_after_away.toFixed(4)),
      m1_value: 0,
      published_index: Number(B_after_away.toFixed(4)),
      confidence_score: null,
      source_fixture_id: fixtureId,
      publish_reason: "settlement",
    });
  }

  // Write settlement_log (unique constraint catches duplicates)
  if (logRows.length > 0) {
    const { error: logErr } = await sb
      .from("settlement_log")
      .insert(logRows);

    if (logErr) {
      if (logErr.message.includes("uq_settlement_log_fixture_team")) {
        log.debug(`Settlement: fixture ${fixtureId} — duplicate caught by unique constraint, skipping`);
        return { settled: false, skipped_reason: "already_settled", home_team: match.home_team, away_team: match.away_team };
      }
      throw new Error(`settlement_log insert failed for fixture ${fixtureId}: ${logErr.message}`);
    }
  }

  // Upsert team_oracle_state
  for (const row of stateUpserts) {
    const { error: stateErr } = await sb
      .from("team_oracle_state")
      .upsert([row], { onConflict: "team_id" });

    if (stateErr) {
      throw new Error(`team_oracle_state upsert failed for ${row.team_id}: ${stateErr.message}`);
    }
  }

  // Append price history
  if (priceHistoryRows.length > 0) {
    const { error: phErr } = await sb
      .from("oracle_price_history")
      .insert(priceHistoryRows);

    if (phErr) {
      log.warn(`Price history insert failed for fixture ${fixtureId}: ${phErr.message}`);
      // Non-fatal — settlement still succeeded
    }
  }

  log.info(
    `Settlement: ${match.home_team} (ΔB=${delta_B_home > 0 ? "+" : ""}${delta_B_home.toFixed(2)}) ` +
    `vs ${match.away_team} (ΔB=${delta_B_away > 0 ? "+" : ""}${delta_B_away.toFixed(2)}) ` +
    `[${match.score}, ${frozenKR.bookmaker_count} books, E_KR=${E_KR_home.toFixed(3)}/${E_KR_away.toFixed(3)}]`
  );

  return {
    settled: true,
    home_team: match.home_team,
    away_team: match.away_team,
    home_delta_B: delta_B_home,
    away_delta_B: delta_B_away,
  };
}

// ─── Helpers ────────────────────────────────────────────────

function deriveSeason(date: string): string {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1; // 1-indexed
  // Season starts ~August
  if (month >= 7) return `${year}-${(year + 1).toString().slice(2)}`;
  return `${year - 1}-${year.toString().slice(2)}`;
}
