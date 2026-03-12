/**
 * oracle-v3-settlement.ts — B-layer settlement for Oracle V3.
 *
 * Formula:
 *   ΔB_result  = K × (S − E_KR)
 *   ΔB_gravity = γ × (R_market_frozen − B)
 *   ΔB_raw     = ΔB_result + ΔB_gravity
 *
 *   Cause-effect clamp:
 *     If S > E_KR (better than expected): ΔB = max(0, ΔB_raw)
 *     If S < E_KR (worse than expected):  ΔB = min(0, ΔB_raw)
 *     If S ≈ E_KR (draw-ish):            ΔB = 0
 *
 *   B_after = B_before + ΔB
 *
 * Key V3 differences from V2:
 *   - Cause-effect clamp: win never moves price down, loss never moves price up
 *   - Gravity target = r_market_frozen (R_market at kickoff, includes R_next)
 *   - γ = 0.08 (stronger gravity)
 *   - After both teams settled → triggers BT re-solve for the league
 *   - Writes oracle_version='v3' to settlement_log
 */

import { getSupabase } from "../api/supabase-client.js";
import { ORACLE_V3_K, ORACLE_V3_GRAVITY_GAMMA, ORACLE_V3_ALPHA } from "../config.js";
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

export interface V3SettlementResult {
  settled: boolean;
  skipped_reason?: string;
  league?: string;
  home_team?: string;
  away_team?: string;
  home_delta_B?: number;
  away_delta_B?: number;
  home_gravity?: number;
  away_gravity?: number;
  home_clamp_applied?: boolean;
  away_clamp_applied?: boolean;
}

// ─── Score parsing ──────────────────────────────────────────

function parseScore(score: string): [number, number] | null {
  if (!score || score === "N/A") return null;
  const m = score.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

// ─── Main V3 settlement function ────────────────────────────

/**
 * Settle a finished fixture for the V3 Oracle B layer.
 *
 * Idempotent — checks settlement_log WHERE oracle_version='v3'.
 * Returns league in result so the cycle can trigger BT re-solve.
 */
export async function settleFixtureV3(fixtureId: number): Promise<V3SettlementResult> {
  const sb = getSupabase();

  // ── Step 0: Idempotency check (V3 only) ──────────────────
  const { data: existingSettlements, error: settleCheckErr } = await sb
    .from("settlement_log")
    .select("team_id")
    .eq("fixture_id", fixtureId)
    .eq("oracle_version", "v3");

  if (settleCheckErr) {
    throw new Error(`V3 settlement_log check failed: ${settleCheckErr.message}`);
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
    throw new Error(`Match ${fixtureId} (${match.home_team} vs ${match.away_team}) not finished — status="${match.status}"`);
  }

  const scoreParsed = parseScore(match.score);
  if (!scoreParsed) {
    throw new Error(`Match ${fixtureId} (${match.home_team} vs ${match.away_team}) unparseable score="${match.score}"`);
  }

  const [scoreHome, scoreAway] = scoreParsed;

  // Both already settled?
  if (alreadySettled.has(match.home_team) && alreadySettled.has(match.away_team)) {
    return { settled: false, skipped_reason: "already_settled", league: match.league, home_team: match.home_team, away_team: match.away_team };
  }

  // ── Step 2: Determine S (actual scores) ──────────────────
  let S_home: number;
  let S_away: number;
  if (scoreHome > scoreAway) { S_home = 1.0; S_away = 0.0; }
  else if (scoreHome === scoreAway) { S_home = 0.5; S_away = 0.5; }
  else { S_home = 0.0; S_away = 1.0; }

  // ── Step 3: Read frozen KR ───────────────────────────────
  const { data: krData, error: krErr } = await sb
    .from("oracle_kr_snapshots")
    .select("fixture_id, bookmaker_count, home_prob, draw_prob, away_prob, home_expected_score, away_expected_score, raw_snapshots")
    .eq("fixture_id", fixtureId)
    .maybeSingle();

  if (krErr) {
    log.error(`V3 Settlement: KR query failed for fixture ${fixtureId}: ${krErr.message}`);
    return { settled: false, skipped_reason: "kr_query_error", league: match.league, home_team: match.home_team, away_team: match.away_team };
  }

  if (!krData) {
    log.warn(`V3 Settlement: fixture ${fixtureId} has no frozen KR — skipping`);
    return { settled: false, skipped_reason: "no_frozen_kr", league: match.league, home_team: match.home_team, away_team: match.away_team };
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

  // ── Step 4: Load current V3 state ─────────────────────────
  const { data: homeState } = await sb
    .from("team_oracle_v3_state")
    .select("b_value, m1_value, r_market_frozen, r_market")
    .eq("team_id", match.home_team)
    .single();

  const { data: awayState } = await sb
    .from("team_oracle_v3_state")
    .select("b_value, m1_value, r_market_frozen, r_market")
    .eq("team_id", match.away_team)
    .single();

  if (!homeState || !awayState) {
    log.warn(`V3 Settlement: missing V3 state for ${!homeState ? match.home_team : match.away_team} — run reseed first. Skipping fixture ${fixtureId}`);
    return { settled: false, skipped_reason: "missing_v3_state", league: match.league, home_team: match.home_team, away_team: match.away_team };
  }

  const B_before_home = Number(homeState.b_value);
  const B_before_away = Number(awayState.b_value);
  const M1_carry_home = Number(homeState.m1_value);
  const M1_carry_away = Number(awayState.m1_value);

  // ── Step 5: Gravity using R_market_frozen ──────────────────
  // r_market_frozen = R_market at kickoff (includes R_next). Fallback to current r_market, then B.
  const R_mkt_frozen_home = homeState.r_market_frozen != null ? Number(homeState.r_market_frozen)
    : (homeState.r_market != null ? Number(homeState.r_market) : B_before_home);
  const R_mkt_frozen_away = awayState.r_market_frozen != null ? Number(awayState.r_market_frozen)
    : (awayState.r_market != null ? Number(awayState.r_market) : B_before_away);

  // ── Step 6: Compute ΔB with cause-effect clamp ─────────────
  const computeDeltaB = (S: number, E_KR: number, B: number, R_mkt_frozen: number) => {
    const delta_result = ORACLE_V3_K * (S - E_KR);
    const delta_gravity = ORACLE_V3_GRAVITY_GAMMA * (R_mkt_frozen - B);
    const delta_raw = delta_result + delta_gravity;

    // Cause-effect clamp: win → ΔB ≥ 0, loss → ΔB ≤ 0
    let delta_final: number;
    let clamp_applied = false;
    const EPS = 0.001;
    if (S > E_KR + EPS) {
      // Better than expected: ΔB must be ≥ 0
      delta_final = Math.max(0, delta_raw);
      clamp_applied = delta_raw < 0;
    } else if (S < E_KR - EPS) {
      // Worse than expected: ΔB must be ≤ 0
      delta_final = Math.min(0, delta_raw);
      clamp_applied = delta_raw > 0;
    } else {
      // Exactly as expected (within tolerance)
      delta_final = 0;
      clamp_applied = Math.abs(delta_raw) > EPS;
    }

    return { delta_result, delta_gravity, delta_raw, delta_final, clamp_applied };
  };

  const home = computeDeltaB(S_home, E_KR_home, B_before_home, R_mkt_frozen_home);
  const away = computeDeltaB(S_away, E_KR_away, B_before_away, R_mkt_frozen_away);

  const B_after_home = B_before_home + home.delta_final;
  const B_after_away = B_before_away + away.delta_final;

  // ── Step 7: Build trace payload ───────────────────────────
  const tracePayload = {
    oracle_version: "v3",
    K: ORACLE_V3_K,
    gamma: ORACLE_V3_GRAVITY_GAMMA,
    alpha: ORACLE_V3_ALPHA,
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
    settlement_detail: {
      home: {
        S: S_home, E_KR: E_KR_home, B_before: B_before_home, B_after: B_after_home,
        R_market_frozen: R_mkt_frozen_home,
        delta_result: home.delta_result, delta_gravity: home.delta_gravity,
        delta_raw: home.delta_raw, delta_final: home.delta_final,
        clamp_applied: home.clamp_applied,
      },
      away: {
        S: S_away, E_KR: E_KR_away, B_before: B_before_away, B_after: B_after_away,
        R_market_frozen: R_mkt_frozen_away,
        delta_result: away.delta_result, delta_gravity: away.delta_gravity,
        delta_raw: away.delta_raw, delta_final: away.delta_final,
        clamp_applied: away.clamp_applied,
      },
    },
  };

  // ── Step 8: Atomic writes ─────────────────────────────────
  const now = new Date().toISOString();
  const logRows: Record<string, unknown>[] = [];
  const stateUpserts: Record<string, unknown>[] = [];
  const priceHistoryRows: Record<string, unknown>[] = [];

  if (!alreadySettled.has(match.home_team)) {
    logRows.push({
      fixture_id: fixtureId, team_id: match.home_team,
      e_kr: Number(E_KR_home.toFixed(6)), actual_score_s: S_home,
      delta_b: Number(home.delta_final.toFixed(6)),
      b_before: Number(B_before_home.toFixed(6)),
      b_after: Number(B_after_home.toFixed(6)),
      oracle_version: "v3",
      gravity_component: Number(home.delta_gravity.toFixed(6)),
      trace_payload: { ...tracePayload, perspective: "home" },
    });
    stateUpserts.push({
      team_id: match.home_team,
      season: deriveSeason(match.date),
      b_value: Number(B_after_home.toFixed(4)),
      m1_value: Number(M1_carry_home.toFixed(4)),
      l_value: 0,
      m1_locked: null,
      r_market_frozen: null,
      published_index: Number((B_after_home + M1_carry_home).toFixed(4)),
      confidence_score: 0,
      last_kr_fixture_id: fixtureId,
      last_settlement_ts: now,
      updated_at: now,
    });
    priceHistoryRows.push({
      team: match.home_team, league: match.league, timestamp: now,
      b_value: Number(B_after_home.toFixed(4)),
      m1_value: Number(M1_carry_home.toFixed(4)),
      published_index: Number((B_after_home + M1_carry_home).toFixed(4)),
      confidence_score: null, source_fixture_id: fixtureId,
      publish_reason: "settlement_v3",
    });
  }

  if (!alreadySettled.has(match.away_team)) {
    logRows.push({
      fixture_id: fixtureId, team_id: match.away_team,
      e_kr: Number(E_KR_away.toFixed(6)), actual_score_s: S_away,
      delta_b: Number(away.delta_final.toFixed(6)),
      b_before: Number(B_before_away.toFixed(6)),
      b_after: Number(B_after_away.toFixed(6)),
      oracle_version: "v3",
      gravity_component: Number(away.delta_gravity.toFixed(6)),
      trace_payload: { ...tracePayload, perspective: "away" },
    });
    stateUpserts.push({
      team_id: match.away_team,
      season: deriveSeason(match.date),
      b_value: Number(B_after_away.toFixed(4)),
      m1_value: Number(M1_carry_away.toFixed(4)),
      l_value: 0,
      m1_locked: null,
      r_market_frozen: null,
      published_index: Number((B_after_away + M1_carry_away).toFixed(4)),
      confidence_score: 0,
      last_kr_fixture_id: fixtureId,
      last_settlement_ts: now,
      updated_at: now,
    });
    priceHistoryRows.push({
      team: match.away_team, league: match.league, timestamp: now,
      b_value: Number(B_after_away.toFixed(4)),
      m1_value: Number(M1_carry_away.toFixed(4)),
      published_index: Number((B_after_away + M1_carry_away).toFixed(4)),
      confidence_score: null, source_fixture_id: fixtureId,
      publish_reason: "settlement_v3",
    });
  }

  // Write settlement_log first (idempotency gate — if this succeeds, we MUST complete state writes)
  if (logRows.length > 0) {
    const { error: logErr } = await sb.from("settlement_log").insert(logRows);
    if (logErr) {
      if (logErr.message.includes("uq_settlement_log_fixture_team_version")) {
        log.debug(`V3 Settlement: fixture ${fixtureId} — duplicate caught by constraint, skipping`);
        return { settled: false, skipped_reason: "already_settled", league: match.league, home_team: match.home_team, away_team: match.away_team };
      }
      throw new Error(`V3 settlement_log insert failed for fixture ${fixtureId}: ${logErr.message}`);
    }
  }

  // Upsert team_oracle_v3_state — retry up to 3 times on failure since log is already written
  for (const row of stateUpserts) {
    let stateWritten = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error: stateErr } = await sb
        .from("team_oracle_v3_state")
        .upsert([row], { onConflict: "team_id" });
      if (!stateErr) { stateWritten = true; break; }
      log.warn(`V3 Settlement: state upsert attempt ${attempt}/3 failed for ${row.team_id}: ${stateErr.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
    }
    if (!stateWritten) {
      log.error(`V3 Settlement: CRITICAL — settlement_log written but state upsert failed for ${row.team_id} fixture ${fixtureId}. B may be stale. Manual intervention needed.`);
    }
  }

  // Append price history (non-critical — warn only)
  if (priceHistoryRows.length > 0) {
    const { error: phErr } = await sb.from("oracle_price_history").insert(priceHistoryRows);
    if (phErr) log.warn(`V3 Price history insert failed for fixture ${fixtureId}: ${phErr.message}`);
  }

  log.info(
    `V3 Settlement: ${match.home_team} (ΔB=${home.delta_final > 0 ? "+" : ""}${home.delta_final.toFixed(2)}` +
    `${home.clamp_applied ? " CLAMPED" : ""}, grav=${home.delta_gravity > 0 ? "+" : ""}${home.delta_gravity.toFixed(2)}) ` +
    `vs ${match.away_team} (ΔB=${away.delta_final > 0 ? "+" : ""}${away.delta_final.toFixed(2)}` +
    `${away.clamp_applied ? " CLAMPED" : ""}, grav=${away.delta_gravity > 0 ? "+" : ""}${away.delta_gravity.toFixed(2)}) ` +
    `[${match.score}, ${frozenKR.bookmaker_count} books, E_KR=${E_KR_home.toFixed(3)}/${E_KR_away.toFixed(3)}]`
  );

  return {
    settled: true,
    league: match.league,
    home_team: match.home_team,
    away_team: match.away_team,
    home_delta_B: home.delta_final,
    away_delta_B: away.delta_final,
    home_gravity: home.delta_gravity,
    away_gravity: away.delta_gravity,
    home_clamp_applied: home.clamp_applied,
    away_clamp_applied: away.clamp_applied,
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
