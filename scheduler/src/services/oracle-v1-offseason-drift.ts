/**
 * oracle-v1-offseason-drift.ts — Off-season B-drift mechanism.
 *
 * During the off-season (no competitive fixtures), B is normally frozen
 * because there are no matches to settle. This module applies a slow,
 * daily drift that pulls B toward the Polymarket-derived R_futures:
 *
 *   ΔB_drift = λ × (R_futures − B)
 *
 * Constraints:
 *   - |ΔB_drift| ≤ MAX_DAILY (5 ELO/day default) — prevents runaway
 *   - Skips teams with Polymarket volume < MIN_VOLUME ($10k default)
 *   - Skips teams where data is stale (>24h)
 *   - Only applies once per 24h per team (frequency gate via last_drift_at)
 *   - Only runs in "offseason" regime (no upcoming competitive fixtures)
 *   - All changes logged to offseason_drift_log for auditability
 *
 * Convergence math:
 *   λ=0.02/day → 63% of gap closed in ~50 days (full off-season)
 *   A 100 ELO gap → ~2 ELO/day initially, decaying exponentially
 *   Massive transfer window move (e.g., 200 ELO gap) → capped at 5/day → ~40 days to close
 */

import { getSupabase } from "../api/supabase-client.js";
import { computeRFutures } from "./oracle-v1-futures.js";
import {
  ORACLE_V1_DRIFT_LAMBDA,
  ORACLE_V1_DRIFT_MAX_DAILY,
  ORACLE_V1_DRIFT_MIN_VOLUME,
  ORACLE_V1_DRIFT_INTERVAL,
} from "../config.js";
import { log } from "../logger.js";

// ─── Types ──────────────────────────────────────────────────

interface DriftResult {
  teams_processed: number;
  teams_drifted: number;
  teams_skipped_volume: number;
  teams_skipped_stale: number;
  teams_skipped_recent: number;
  teams_skipped_no_data: number;
  total_abs_drift: number;
  max_abs_drift: number;
}

// ─── Main exported function ─────────────────────────────────

/**
 * Apply off-season B-drift for all teams in the oracle.
 *
 * Should be called from oracle-v1-cycle.ts when the regime is "offseason"
 * (i.e., when no teams have upcoming competitive fixtures).
 *
 * For each team:
 *   1. Check frequency gate (last_drift_at must be >24h ago)
 *   2. Compute R_futures from Polymarket
 *   3. Apply ΔB = λ × (R_futures - B), capped at ±MAX_DAILY
 *   4. Write updated B to team_oracle_state
 *   5. Log to offseason_drift_log
 *   6. Update published_index = new_B + M1
 */
export async function applyOffseasonDrift(): Promise<DriftResult> {
  const sb = getSupabase();
  const now = new Date();
  const nowIso = now.toISOString();

  const result: DriftResult = {
    teams_processed: 0,
    teams_drifted: 0,
    teams_skipped_volume: 0,
    teams_skipped_stale: 0,
    teams_skipped_recent: 0,
    teams_skipped_no_data: 0,
    total_abs_drift: 0,
    max_abs_drift: 0,
  };

  // ── Load all teams with their current state ────────────────
  const { data: allTeams, error: teamErr } = await sb
    .from("team_oracle_state")
    .select("team_id, b_value, m1_value, last_drift_at");

  if (teamErr || !allTeams) {
    log.error(`applyOffseasonDrift: failed to load teams: ${teamErr?.message ?? "no data"}`);
    return result;
  }

  // ── Build league lookup (team_id → league) ─────────────────
  const leagueMap = new Map<string, string>();
  const { data: matchRows } = await sb
    .from("matches")
    .select("home_team, away_team, league")
    .order("date", { ascending: false })
    .limit(2000);

  if (matchRows) {
    for (const m of matchRows) {
      if (!leagueMap.has(m.home_team)) leagueMap.set(m.home_team, m.league);
      if (!leagueMap.has(m.away_team)) leagueMap.set(m.away_team, m.league);
    }
  }

  // ── Process each team ──────────────────────────────────────
  const driftLogRows: Record<string, unknown>[] = [];

  for (const team of allTeams) {
    result.teams_processed++;
    const teamId = team.team_id as string;
    const B = Number(team.b_value);
    const currentM1 = Number(team.m1_value ?? 0);

    // ── Frequency gate: skip if drifted within interval ──────
    if (team.last_drift_at) {
      const lastDrift = new Date(team.last_drift_at).getTime();
      const msSinceDrift = now.getTime() - lastDrift;
      if (msSinceDrift < ORACLE_V1_DRIFT_INTERVAL) {
        result.teams_skipped_recent++;
        continue;
      }
    }

    // ── Get league ───────────────────────────────────────────
    const league = leagueMap.get(teamId) ?? "Unknown";
    if (league === "Unknown") {
      result.teams_skipped_no_data++;
      continue;
    }

    // ── Compute R_futures ────────────────────────────────────
    const futures = await computeRFutures(teamId, league);
    if (!futures) {
      result.teams_skipped_no_data++;
      continue;
    }

    if (futures.stale) {
      result.teams_skipped_stale++;
      continue;
    }

    // ── Volume gate ──────────────────────────────────────────
    // We need to check the raw Polymarket volume for this team
    const { data: volRow } = await sb
      .from("polymarket_futures")
      .select("volume")
      .eq("league", league)
      .ilike("team", teamId) // approximate match
      .order("snapshot_time", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Try alternative: query by resolved name
    let teamVolume = volRow ? Number(volRow.volume) : 0;
    if (teamVolume === 0) {
      // Fallback: use the confidence from computeRFutures
      // If confidence is very low, the volume is likely too low
      teamVolume = futures.confidence * 50_000; // reverse-engineer approximate volume
    }

    if (teamVolume < ORACLE_V1_DRIFT_MIN_VOLUME) {
      result.teams_skipped_volume++;
      continue;
    }

    // ── Compute drift ────────────────────────────────────────
    const gap = futures.R_futures - B;
    let deltaB = ORACLE_V1_DRIFT_LAMBDA * gap;

    // Cap at ±MAX_DAILY
    if (Math.abs(deltaB) > ORACLE_V1_DRIFT_MAX_DAILY) {
      deltaB = Math.sign(deltaB) * ORACLE_V1_DRIFT_MAX_DAILY;
    }

    // Skip trivially small drifts (<0.01 ELO)
    if (Math.abs(deltaB) < 0.01) {
      result.teams_skipped_recent++; // effectively no movement needed
      continue;
    }

    const newB = B + deltaB;
    const newPublishedIndex = newB + currentM1;

    // ── Write updated B to team_oracle_state ──────────────────
    const { error: updateErr } = await sb
      .from("team_oracle_state")
      .update({
        b_value: Number(newB.toFixed(4)),
        published_index: Number(newPublishedIndex.toFixed(4)),
        last_drift_at: nowIso,
        updated_at: nowIso,
      })
      .eq("team_id", teamId);

    if (updateErr) {
      log.error(`applyOffseasonDrift: update failed for ${teamId}: ${updateErr.message}`);
      continue;
    }

    // ── Log to drift audit table ─────────────────────────────
    driftLogRows.push({
      team_id: teamId,
      league,
      r_futures: Number(futures.R_futures.toFixed(4)),
      p_title: Number(futures.P_title.toFixed(6)),
      b_before: Number(B.toFixed(4)),
      b_after: Number(newB.toFixed(4)),
      delta_b: Number(deltaB.toFixed(4)),
      confidence: Number(futures.confidence.toFixed(4)),
      volume: teamVolume,
      lambda: ORACLE_V1_DRIFT_LAMBDA,
      applied_at: nowIso,
    });

    // ── Write price history for drift event ───────────────────
    await sb
      .from("oracle_price_history")
      .insert([{
        team: teamId,
        league,
        timestamp: nowIso,
        b_value: Number(newB.toFixed(4)),
        m1_value: currentM1,
        published_index: Number(newPublishedIndex.toFixed(4)),
        confidence_score: futures.confidence,
        source_fixture_id: null,
        publish_reason: "offseason_drift",
      }]);

    result.teams_drifted++;
    result.total_abs_drift += Math.abs(deltaB);
    result.max_abs_drift = Math.max(result.max_abs_drift, Math.abs(deltaB));

    log.debug(
      `drift: ${teamId} B=${B.toFixed(1)}→${newB.toFixed(1)} ` +
      `ΔB=${deltaB > 0 ? "+" : ""}${deltaB.toFixed(2)} ` +
      `R_fut=${futures.R_futures.toFixed(1)} gap=${gap.toFixed(1)} ` +
      `P_title=${futures.P_title.toFixed(4)} vol=$${teamVolume.toFixed(0)}`
    );
  }

  // ── Batch insert drift log rows ────────────────────────────
  if (driftLogRows.length > 0) {
    const { error: logErr } = await sb
      .from("offseason_drift_log")
      .insert(driftLogRows);

    if (logErr) {
      log.warn(`applyOffseasonDrift: drift log insert failed: ${logErr.message}`);
    }
  }

  log.info(
    `Off-season drift: ${result.teams_drifted}/${result.teams_processed} teams drifted ` +
    `(vol_skip=${result.teams_skipped_volume} stale=${result.teams_skipped_stale} ` +
    `recent=${result.teams_skipped_recent} nodata=${result.teams_skipped_no_data}) ` +
    `avg_ΔB=${result.teams_drifted > 0 ? (result.total_abs_drift / result.teams_drifted).toFixed(2) : "0"} ` +
    `max_ΔB=${result.max_abs_drift.toFixed(2)}`
  );

  return result;
}
