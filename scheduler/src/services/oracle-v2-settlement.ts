/**
 * oracle-v2-settlement.ts — B-layer settlement for Oracle V2.
 *
 * Same as V1 settlement but with gravity-on-settlement:
 *   ΔB = K × (S − E_KR) + γ × (R_market − B)
 *
 * Where:
 *   γ = ORACLE_V2_GRAVITY_GAMMA (0.05) — gravity pull toward market consensus
 *   R_market = odds-implied team strength from frozen pre-kickoff odds
 *   B = team's current V2 B-value
 *
 * Gravity nudge is hidden inside settlement noise — no predictable daily drift.
 *
 * Reads/writes team_oracle_v2_state (not team_oracle_state).
 * Writes oracle_version='v2' and gravity_component to settlement_log.
 * Reuses oracle_kr_snapshots (same frozen odds, shared with V1).
 */

import { getSupabase } from "../api/supabase-client.js";
import { powerDevigOdds, median, oddsImpliedStrength } from "./odds-blend.js";
import { ORACLE_V2_K, ORACLE_V2_GRAVITY_GAMMA } from "../config.js";
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

interface BookmakerKR {
  bookmaker: string;
  homeProb: number;
  drawProb: number;
  awayProb: number;
  k: number | null;
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

export interface V2SettlementResult {
  settled: boolean;
  skipped_reason?: string;
  home_team?: string;
  away_team?: string;
  home_delta_B?: number;
  away_delta_B?: number;
  home_gravity?: number;
  away_gravity?: number;
}

// ─── Constants ──────────────────────────────────────────────

const HOME_ADVANTAGE_ELO = 65;

// ─── Score parsing ──────────────────────────────────────────

function parseScore(score: string): [number, number] | null {
  if (!score || score === "N/A") return null;
  const m = score.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

// ─── Main V2 settlement function ────────────────────────────

/**
 * Settle a finished fixture for the V2 Oracle B layer.
 *
 * Same flow as V1 but:
 * - Reads/writes team_oracle_v2_state
 * - Adds gravity component: γ × (R_market − B)
 * - Writes oracle_version='v2' and gravity_component to settlement_log
 * - Reuses oracle_kr_snapshots (KR freeze is shared with V1)
 *
 * Idempotent — checks settlement_log WHERE oracle_version='v2'.
 */
export async function settleFixtureV2(fixtureId: number): Promise<V2SettlementResult> {
  const sb = getSupabase();

  // ── Step 0: Idempotency check (V2 only) ──────────────────
  const { data: existingSettlements, error: settleCheckErr } = await sb
    .from("settlement_log")
    .select("team_id")
    .eq("fixture_id", fixtureId)
    .eq("oracle_version", "v2");

  if (settleCheckErr) {
    throw new Error(`V2 settlement_log check failed: ${settleCheckErr.message}`);
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
    log.debug(`V2 Settlement: fixture ${fixtureId} already settled for both teams — skipping`);
    return { settled: false, skipped_reason: "already_settled", home_team: match.home_team, away_team: match.away_team };
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

  // ── Step 3: Read frozen KR from oracle_kr_snapshots ───────
  // Reuse V1's frozen KR — same match, same odds, no need to re-freeze
  const { data: krData, error: krErr } = await sb
    .from("oracle_kr_snapshots")
    .select("fixture_id, bookmaker_count, home_prob, draw_prob, away_prob, home_expected_score, away_expected_score, raw_snapshots")
    .eq("fixture_id", fixtureId)
    .maybeSingle();

  if (krErr) {
    log.error(`V2 Settlement: KR query failed for fixture ${fixtureId}: ${krErr.message}`);
    return { settled: false, skipped_reason: "kr_query_error", home_team: match.home_team, away_team: match.away_team };
  }

  if (!krData) {
    // KR not frozen yet — V1 cycle should have frozen it. Skip for now.
    log.warn(`V2 Settlement: fixture ${fixtureId} has no frozen KR — skipping (V1 may not have run yet)`);
    return { settled: false, skipped_reason: "no_frozen_kr", home_team: match.home_team, away_team: match.away_team };
  }

  const frozenKR: FrozenKR = {
    fixture_id: krData.fixture_id,
    bookmaker_count: krData.bookmaker_count,
    home_prob: Number(krData.home_prob),
    draw_prob: Number(krData.draw_prob),
    away_prob: Number(krData.away_prob),
    home_expected_score: Number(krData.home_expected_score),
    away_expected_score: Number(krData.away_expected_score),
    raw_snapshots: krData.raw_snapshots as BookmakerKR[],
  };

  const E_KR_home = frozenKR.home_expected_score;
  const E_KR_away = frozenKR.away_expected_score;

  // ── Step 4: Load current V2 B + M1 values ────────────────
  const { data: homeState } = await sb
    .from("team_oracle_v2_state")
    .select("b_value, m1_value")
    .eq("team_id", match.home_team)
    .single();

  const { data: awayState } = await sb
    .from("team_oracle_v2_state")
    .select("b_value, m1_value")
    .eq("team_id", match.away_team)
    .single();

  if (!homeState || !awayState) {
    log.warn(
      `V2 Settlement: missing V2 state for ${!homeState ? match.home_team : match.away_team} — ` +
      `run reseed-v2 first. Skipping fixture ${fixtureId}`
    );
    return { settled: false, skipped_reason: "missing_v2_state", home_team: match.home_team, away_team: match.away_team };
  }

  const B_before_home = Number(homeState.b_value);
  const B_before_away = Number(awayState.b_value);
  const M1_carry_home = Number(homeState.m1_value);
  const M1_carry_away = Number(awayState.m1_value);

  // ── Step 5: Compute R_market for gravity ──────────────────
  // R_market = odds-implied team strength, using frozen pre-KO consensus
  const R_market_home = oddsImpliedStrength(E_KR_home, B_before_away, true, HOME_ADVANTAGE_ELO);
  const R_market_away = oddsImpliedStrength(E_KR_away, B_before_home, false, HOME_ADVANTAGE_ELO);

  // ── Step 6: Compute delta_B with gravity ──────────────────
  const std_delta_home = ORACLE_V2_K * (S_home - E_KR_home);
  const std_delta_away = ORACLE_V2_K * (S_away - E_KR_away);

  const gravity_home = ORACLE_V2_GRAVITY_GAMMA * (R_market_home - B_before_home);
  const gravity_away = ORACLE_V2_GRAVITY_GAMMA * (R_market_away - B_before_away);

  const delta_B_home = std_delta_home + gravity_home;
  const delta_B_away = std_delta_away + gravity_away;

  const B_after_home = B_before_home + delta_B_home;
  const B_after_away = B_before_away + delta_B_away;

  // ── Step 7: Build trace payload ───────────────────────────
  const tracePayload = {
    oracle_version: "v2",
    K: ORACLE_V2_K,
    gamma: ORACLE_V2_GRAVITY_GAMMA,
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
      k: b.k !== null ? Number(b.k.toFixed(6)) : null,
      snapshot_time: b.snapshot_time,
    })),
    consensus: {
      homeProb: Number(frozenKR.home_prob.toFixed(6)),
      drawProb: Number(frozenKR.draw_prob.toFixed(6)),
      awayProb: Number(frozenKR.away_prob.toFixed(6)),
    },
    gravity: {
      R_market_home: Number(R_market_home.toFixed(4)),
      R_market_away: Number(R_market_away.toFixed(4)),
      gravity_home: Number(gravity_home.toFixed(6)),
      gravity_away: Number(gravity_away.toFixed(6)),
      std_delta_home: Number(std_delta_home.toFixed(6)),
      std_delta_away: Number(std_delta_away.toFixed(6)),
    },
  };

  // ── Step 8: Atomic writes ─────────────────────────────────
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
      oracle_version: "v2",
      gravity_component: Number(gravity_home.toFixed(6)),
      trace_payload: { ...tracePayload, perspective: "home" },
    });
    stateUpserts.push({
      team_id: match.home_team,
      season: deriveSeason(match.date),
      b_value: Number(B_after_home.toFixed(4)),
      m1_value: Number(M1_carry_home.toFixed(4)),
      l_value: 0,
      m1_locked: null,
      published_index: Number((B_after_home + M1_carry_home).toFixed(4)),
      confidence_score: 0,
      last_kr_fixture_id: fixtureId,
      updated_at: now,
    });
    priceHistoryRows.push({
      team: match.home_team,
      league: match.league,
      timestamp: now,
      b_value: Number(B_after_home.toFixed(4)),
      m1_value: Number(M1_carry_home.toFixed(4)),
      published_index: Number((B_after_home + M1_carry_home).toFixed(4)),
      confidence_score: null,
      source_fixture_id: fixtureId,
      publish_reason: "settlement_v2",
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
      oracle_version: "v2",
      gravity_component: Number(gravity_away.toFixed(6)),
      trace_payload: { ...tracePayload, perspective: "away" },
    });
    stateUpserts.push({
      team_id: match.away_team,
      season: deriveSeason(match.date),
      b_value: Number(B_after_away.toFixed(4)),
      m1_value: Number(M1_carry_away.toFixed(4)),
      l_value: 0,
      m1_locked: null,
      published_index: Number((B_after_away + M1_carry_away).toFixed(4)),
      confidence_score: 0,
      last_kr_fixture_id: fixtureId,
      updated_at: now,
    });
    priceHistoryRows.push({
      team: match.away_team,
      league: match.league,
      timestamp: now,
      b_value: Number(B_after_away.toFixed(4)),
      m1_value: Number(M1_carry_away.toFixed(4)),
      published_index: Number((B_after_away + M1_carry_away).toFixed(4)),
      confidence_score: null,
      source_fixture_id: fixtureId,
      publish_reason: "settlement_v2",
    });
  }

  // Write settlement_log
  if (logRows.length > 0) {
    const { error: logErr } = await sb
      .from("settlement_log")
      .insert(logRows);

    if (logErr) {
      if (logErr.message.includes("uq_settlement_log_fixture_team")) {
        log.debug(`V2 Settlement: fixture ${fixtureId} — duplicate caught by unique constraint, skipping`);
        return { settled: false, skipped_reason: "already_settled", home_team: match.home_team, away_team: match.away_team };
      }
      throw new Error(`V2 settlement_log insert failed for fixture ${fixtureId}: ${logErr.message}`);
    }
  }

  // Upsert team_oracle_v2_state
  for (const row of stateUpserts) {
    const { error: stateErr } = await sb
      .from("team_oracle_v2_state")
      .upsert([row], { onConflict: "team_id" });

    if (stateErr) {
      throw new Error(`team_oracle_v2_state upsert failed for ${row.team_id}: ${stateErr.message}`);
    }
  }

  // Append price history
  if (priceHistoryRows.length > 0) {
    const { error: phErr } = await sb
      .from("oracle_price_history")
      .insert(priceHistoryRows);

    if (phErr) {
      log.warn(`V2 Price history insert failed for fixture ${fixtureId}: ${phErr.message}`);
    }
  }

  log.info(
    `V2 Settlement: ${match.home_team} (ΔB=${delta_B_home > 0 ? "+" : ""}${delta_B_home.toFixed(2)}, ` +
    `grav=${gravity_home > 0 ? "+" : ""}${gravity_home.toFixed(2)}) ` +
    `vs ${match.away_team} (ΔB=${delta_B_away > 0 ? "+" : ""}${delta_B_away.toFixed(2)}, ` +
    `grav=${gravity_away > 0 ? "+" : ""}${gravity_away.toFixed(2)}) ` +
    `[${match.score}, ${frozenKR.bookmaker_count} books, E_KR=${E_KR_home.toFixed(3)}/${E_KR_away.toFixed(3)}] ` +
    `— M1 carried (home=${M1_carry_home.toFixed(2)}, away=${M1_carry_away.toFixed(2)})`
  );

  return {
    settled: true,
    home_team: match.home_team,
    away_team: match.away_team,
    home_delta_B: delta_B_home,
    away_delta_B: delta_B_away,
    home_gravity: gravity_home,
    away_gravity: gravity_away,
  };
}

// ─── Helpers ────────────────────────────────────────────────

function deriveSeason(date: string): string {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  if (month >= 7) return `${year}-${(year + 1).toString().slice(2)}`;
  return `${year - 1}-${year.toString().slice(2)}`;
}
