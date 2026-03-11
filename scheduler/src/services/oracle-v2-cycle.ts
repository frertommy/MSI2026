/**
 * oracle-v2-cycle.ts — Main orchestration cycle for Oracle V2.
 *
 * Steps:
 *   1. Settle newly-finished matches (with gravity formula)
 *   2. Identify frozen teams (currently mid-match)
 *   2b. If ORACLE_V2_LIVE_ENABLED: compute L for live teams, lock M1 at kickoff value
 *   3. Refresh M1 for all non-frozen teams (parallel, max concurrency 5)
 *   4. No feedback F (stub)
 *
 * Reads/writes team_oracle_v2_state.
 * Settlement checks oracle_version='v2' in settlement_log.
 */

import { getSupabase } from "../api/supabase-client.js";
import { settleFixtureV2 } from "./oracle-v2-settlement.js";
import { refreshM1V2 } from "./oracle-v2-market.js";
import { computeLiveLayerV2 } from "./oracle-v2-live.js";
import { ORACLE_V2_ENABLED, ORACLE_V2_LIVE_ENABLED, ORACLE_V2_SETTLEMENT_START_DATE } from "../config.js";
import { log } from "../logger.js";

// ─── Types ──────────────────────────────────────────────────

interface V2CycleResult {
  ran: boolean;
  skipped_reason?: string;
  settled_count: number;
  settled_errors: number;
  m1_refreshed: number;
  m1_skipped: number;
  m1_errors: number;
  frozen_teams: string[];
  live_updated: number;
  live_frozen: number;
  elapsed_ms: number;
}

// ─── Constants ──────────────────────────────────────────────

const M1_CONCURRENCY = 5;

// ─── Concurrency helper ─────────────────────────────────────

async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

// ─── Main cycle ─────────────────────────────────────────────

export async function runOracleV2Cycle(): Promise<V2CycleResult> {
  const cycleStart = Date.now();

  if (!ORACLE_V2_ENABLED) {
    return {
      ran: false,
      skipped_reason: "oracle_v2_disabled",
      settled_count: 0,
      settled_errors: 0,
      m1_refreshed: 0,
      m1_skipped: 0,
      m1_errors: 0,
      frozen_teams: [],
      live_updated: 0,
      live_frozen: 0,
      elapsed_ms: 0,
    };
  }

  const sb = getSupabase();

  log.info("Oracle V2 cycle starting...");

  // ── Step 1: Settle newly-finished matches ──────────────────
  // Load all finished matches from current season
  const finishedMatches = await fetchAllFinished(sb);

  if (finishedMatches === null) {
    log.error("Oracle V2 cycle: finished matches query failed");
    return {
      ran: true,
      settled_count: 0,
      settled_errors: 1,
      m1_refreshed: 0,
      m1_skipped: 0,
      m1_errors: 0,
      frozen_teams: [],
      live_updated: 0,
      live_frozen: 0,
      elapsed_ms: Date.now() - cycleStart,
    };
  }

  const finishedIds = finishedMatches.map(m => m.fixture_id);

  let unsettledFixtures: number[] = [];

  if (finishedIds.length > 0) {
    // Load V2-only settlement_log entries
    const settledRows = await fetchV2SettlementEntries(sb, finishedIds);

    if (settledRows !== null) {
      const countByFixture = new Map<number, number>();
      for (const row of settledRows) {
        countByFixture.set(row.fixture_id, (countByFixture.get(row.fixture_id) ?? 0) + 1);
      }

      // Unsettled = < 2 V2 entries (need both home + away)
      unsettledFixtures = finishedIds.filter(fid => (countByFixture.get(fid) ?? 0) < 2);
      unsettledFixtures.sort((a, b) => a - b);
    }
  }

  let settledCount = 0;
  let settledErrors = 0;

  // Settle sequentially to avoid B_value race conditions
  for (const fixtureId of unsettledFixtures) {
    try {
      const result = await settleFixtureV2(fixtureId);
      if (result.settled) {
        settledCount++;
      }
    } catch (err) {
      settledErrors++;
      log.error(
        `Oracle V2 cycle: settlement failed for fixture ${fixtureId}: ` +
        (err instanceof Error ? err.message : String(err))
      );
    }
  }

  if (settledCount > 0 || settledErrors > 0) {
    log.info(
      `Oracle V2 settlement: ${settledCount} settled, ${settledErrors} errors, ` +
      `${unsettledFixtures.length - settledCount - settledErrors} skipped`
    );
  }

  // ── Step 2: Identify frozen teams (mid-match) ─────────────
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const { data: liveMatches, error: liveErr } = await sb
    .from("matches")
    .select("fixture_id, home_team, away_team")
    .lt("commence_time", new Date().toISOString())
    .gt("commence_time", fourHoursAgo)
    .not("status", "in", '("finished","cancelled")');

  const frozenTeams = new Set<string>();
  if (liveErr) {
    log.warn(`Oracle V2 cycle: live match query failed: ${liveErr.message}`);
  } else {
    for (const m of (liveMatches ?? [])) {
      frozenTeams.add(m.home_team);
      frozenTeams.add(m.away_team);
    }
  }

  // ── Step 2b: Live layer updates for frozen teams ──────────
  let liveUpdated = 0;
  let liveFrozen = 0;

  if (ORACLE_V2_LIVE_ENABLED && !liveErr && (liveMatches ?? []).length > 0) {
    for (const m of (liveMatches ?? [])) {
      // Lock M1 at kickoff value for both teams
      await handleKickoffLockV2(sb, m.fixture_id, m.home_team, m.away_team);

      // Compute L for home team
      try {
        const homeResult = await computeLiveLayerV2(m.fixture_id, m.home_team, true);
        if (!homeResult.frozen) {
          await writeLiveStateV2(sb, m.home_team, m.fixture_id, homeResult.L);
          liveUpdated++;
        } else {
          liveFrozen++;
        }
      } catch (err) {
        liveFrozen++;
        log.error(
          `Oracle V2 cycle: live layer failed for ${m.home_team}: ` +
          (err instanceof Error ? err.message : String(err))
        );
      }

      // Compute L for away team
      try {
        const awayResult = await computeLiveLayerV2(m.fixture_id, m.away_team, false);
        if (!awayResult.frozen) {
          await writeLiveStateV2(sb, m.away_team, m.fixture_id, awayResult.L);
          liveUpdated++;
        } else {
          liveFrozen++;
        }
      } catch (err) {
        liveFrozen++;
        log.error(
          `Oracle V2 cycle: live layer failed for ${m.away_team}: ` +
          (err instanceof Error ? err.message : String(err))
        );
      }
    }

    if (liveUpdated > 0 || liveFrozen > 0) {
      log.info(`Oracle V2 live layer: ${liveUpdated} updated, ${liveFrozen} frozen`);
    }
  }

  // ── Step 3: Refresh M1 for all non-frozen V2 teams ────────
  const { data: allTeamRows, error: teamErr } = await sb
    .from("team_oracle_v2_state")
    .select("team_id");

  if (teamErr) {
    log.error(`Oracle V2 cycle: team_oracle_v2_state query failed: ${teamErr.message}`);
    return {
      ran: true,
      settled_count: settledCount,
      settled_errors: settledErrors,
      m1_refreshed: 0,
      m1_skipped: 0,
      m1_errors: 0,
      frozen_teams: [...frozenTeams],
      live_updated: liveUpdated,
      live_frozen: liveFrozen,
      elapsed_ms: Date.now() - cycleStart,
    };
  }

  const allTeams = (allTeamRows ?? []).map(r => r.team_id as string);
  const teamsToRefresh = allTeams.filter(t => !frozenTeams.has(t));
  const m1Skipped = allTeams.length - teamsToRefresh.length;

  let m1Refreshed = 0;
  let m1Errors = 0;

  if (teamsToRefresh.length > 0) {
    const results = await parallelLimit(
      teamsToRefresh,
      M1_CONCURRENCY,
      async (team: string) => {
        try {
          const result = await refreshM1V2(team);
          return { team, result, error: null };
        } catch (err) {
          return { team, result: null, error: err };
        }
      }
    );

    for (const r of results) {
      if (r.error) {
        m1Errors++;
        log.error(
          `Oracle V2 cycle: M1 refresh failed for ${r.team}: ` +
          (r.error instanceof Error ? r.error.message : String(r.error))
        );
      } else if (r.result?.updated) {
        m1Refreshed++;
      }
    }
  }

  // ── Step 4: Log cycle summary ─────────────────────────────
  const elapsed = Date.now() - cycleStart;

  log.info(
    `Oracle V2 cycle complete in ${(elapsed / 1000).toFixed(1)}s — ` +
    `settled=${settledCount} M1=${m1Refreshed}/${teamsToRefresh.length} ` +
    `live=${liveUpdated}/${frozenTeams.size} frozen=${liveFrozen} ` +
    `errors=${settledErrors + m1Errors}`
  );

  return {
    ran: true,
    settled_count: settledCount,
    settled_errors: settledErrors,
    m1_refreshed: m1Refreshed,
    m1_skipped: m1Skipped,
    m1_errors: m1Errors,
    frozen_teams: [...frozenTeams],
    live_updated: liveUpdated,
    live_frozen: liveFrozen,
    elapsed_ms: elapsed,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

/** Fetch ALL finished matches (paginated). */
async function fetchAllFinished(
  sb: ReturnType<typeof getSupabase>
): Promise<{ fixture_id: number }[] | null> {
  const all: { fixture_id: number }[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("fixture_id")
      .eq("status", "finished")
      .gte("date", ORACLE_V2_SETTLEMENT_START_DATE)
      .order("date", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      log.error(`V2 fetchAllFinished: ${error.message}`);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/** Fetch V2-only settlement_log entries for a set of fixture IDs (paginated, batched). */
async function fetchV2SettlementEntries(
  sb: ReturnType<typeof getSupabase>,
  fixtureIds: number[]
): Promise<{ fixture_id: number; team_id: string }[] | null> {
  const all: { fixture_id: number; team_id: string }[] = [];

  const chunkSize = 500;
  for (let i = 0; i < fixtureIds.length; i += chunkSize) {
    const chunk = fixtureIds.slice(i, i + chunkSize);

    const { data, error } = await sb
      .from("settlement_log")
      .select("fixture_id, team_id")
      .in("fixture_id", chunk)
      .eq("oracle_version", "v2");

    if (error) {
      log.error(`V2 fetchSettlementEntries: ${error.message}`);
      return null;
    }
    if (data) all.push(...data);
  }
  return all;
}

/**
 * Lock M1 at kickoff value when a match goes live.
 * Reads current m1_value from team_oracle_v2_state and writes it to m1_locked
 * if m1_locked is currently null (first time this match is seen live).
 */
async function handleKickoffLockV2(
  sb: ReturnType<typeof getSupabase>,
  fixtureId: number,
  homeTeam: string,
  awayTeam: string
): Promise<void> {
  for (const teamId of [homeTeam, awayTeam]) {
    const { data: state, error: stateErr } = await sb
      .from("team_oracle_v2_state")
      .select("m1_value, m1_locked")
      .eq("team_id", teamId)
      .maybeSingle();

    if (stateErr || !state) continue;

    // Only lock if not already locked (first live cycle for this match)
    if (state.m1_locked === null || state.m1_locked === undefined) {
      const { error: lockErr } = await sb
        .from("team_oracle_v2_state")
        .update({ m1_locked: Number(state.m1_value) ?? 0, updated_at: new Date().toISOString() })
        .eq("team_id", teamId);

      if (lockErr) {
        log.warn(`V2 handleKickoffLock: failed for ${teamId}: ${lockErr.message}`);
      } else {
        log.debug(`V2 handleKickoffLock: locked M1=${state.m1_value} for ${teamId} (fixture ${fixtureId})`);
      }
    }
  }
}

/**
 * Write live state: update l_value and published_index for a team during a live match.
 * published_index = B + M_locked + L
 */
async function writeLiveStateV2(
  sb: ReturnType<typeof getSupabase>,
  teamId: string,
  fixtureId: number,
  L: number
): Promise<void> {
  // Load current state to compute published_index
  const { data: state, error: stateErr } = await sb
    .from("team_oracle_v2_state")
    .select("b_value, m1_locked")
    .eq("team_id", teamId)
    .single();

  if (stateErr || !state) {
    log.error(`V2 writeLiveState: state not found for ${teamId}: ${stateErr?.message ?? "no data"}`);
    return;
  }

  const B = Number(state.b_value);
  const M_locked = Number(state.m1_locked ?? 0);
  const publishedIndex = B + M_locked + L;
  const now = new Date().toISOString();

  const { error: updateErr } = await sb
    .from("team_oracle_v2_state")
    .update({
      l_value: Number(L.toFixed(4)),
      published_index: Number(publishedIndex.toFixed(4)),
      updated_at: now,
    })
    .eq("team_id", teamId);

  if (updateErr) {
    log.error(`V2 writeLiveState: update failed for ${teamId}: ${updateErr.message}`);
    return;
  }

  // Write price history for live update
  const league = await getTeamLeagueCached(sb, teamId);
  const { error: phErr } = await sb
    .from("oracle_price_history")
    .insert([{
      team: teamId,
      league: league ?? "unknown",
      timestamp: now,
      b_value: B,
      m1_value: M_locked,
      l_value: Number(L.toFixed(4)),
      published_index: Number(publishedIndex.toFixed(4)),
      confidence_score: null,
      source_fixture_id: fixtureId,
      publish_reason: "live_update_v2",
    }]);

  if (phErr) {
    log.warn(`V2 writeLiveState: price history insert failed for ${teamId}: ${phErr.message}`);
  }
}

/** Simple in-memory cache for team→league mapping within a single cycle. */
const teamLeagueCache = new Map<string, string | null>();

async function getTeamLeagueCached(
  sb: ReturnType<typeof getSupabase>,
  teamId: string
): Promise<string | null> {
  if (teamLeagueCache.has(teamId)) return teamLeagueCache.get(teamId) ?? null;

  const { data } = await sb
    .from("matches")
    .select("league")
    .or(`home_team.eq.${teamId},away_team.eq.${teamId}`)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();

  const league = data?.league ?? null;
  teamLeagueCache.set(teamId, league);
  return league;
}
