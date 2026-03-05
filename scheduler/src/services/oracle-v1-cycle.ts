/**
 * oracle-v1-cycle.ts — Main orchestration cycle for the V1 Oracle.
 *
 * Exports one function: runOracleV1Cycle()
 *
 * Called once per scheduler poll (every ~1 min) when ORACLE_V1_ENABLED=true.
 *
 * Steps:
 *   1. Settle any newly-finished matches (sequential, idempotent)
 *   2. Identify frozen teams (currently mid-match)
 *   2b. If ORACLE_V1_LIVE_ENABLED: compute L for live teams, lock M1 at kickoff value
 *   3. Refresh M1 for all non-frozen teams (parallel, max concurrency 5)
 *   4. Log cycle summary
 *
 * Constraints:
 *   - Frozen teams skip M1 refresh but get live layer updates if enabled
 *   - Settlement is sequential to avoid race conditions on B_value
 *   - M1 refreshes are parallel (capped) since they're independent per team
 *   - No imports from pricing-engine.ts
 *   - Feature-flagged: does nothing if ORACLE_V1_ENABLED is false
 */

import { getSupabase } from "../api/supabase-client.js";
import { settleFixture } from "./oracle-v1-settlement.js";
import { refreshM1 } from "./oracle-v1-market.js";
import { computeLiveLayer } from "./oracle-v1-live.js";
import { ORACLE_V1_ENABLED, ORACLE_V1_BASELINE_ELO, ORACLE_V1_SETTLEMENT_START_DATE, ORACLE_V1_LIVE_ENABLED } from "../config.js";
import { log } from "../logger.js";

// ─── Types ──────────────────────────────────────────────────

interface CycleResult {
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

/** Maximum concurrent M1 refreshes to avoid hammering Supabase */
const M1_CONCURRENCY = 5;

// ─── Concurrency helper ─────────────────────────────────────

/**
 * Run async tasks with a concurrency limit.
 * Returns results in the same order as the input.
 */
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

/**
 * Run one full V1 Oracle cycle: settle + freeze + refresh M1.
 *
 * Safe to call every poll — gated by ORACLE_V1_ENABLED.
 * Idempotent: settlement checks settlement_log, M1 skips live teams.
 */
export async function runOracleV1Cycle(): Promise<CycleResult> {
  const cycleStart = Date.now();

  // ── Guard: feature flag ────────────────────────────────────
  if (!ORACLE_V1_ENABLED) {
    return {
      ran: false,
      skipped_reason: "oracle_v1_disabled",
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

  log.info("Oracle V1 cycle starting...");

  // ── Step 1: Settle newly-finished matches ──────────────────
  // Query all finished matches, then left-join settlement_log to find
  // fixtures with < 2 entries (need both home + away settled).
  // This replaces the old "last 200 finished" approach — we now scan ALL
  // finished matches so no fixture is ever missed.

  const finishedMatches = await fetchAllFinished(sb);

  if (finishedMatches === null) {
    log.error("Oracle V1 cycle: finished matches query failed");
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
    // Load all settlement_log entries for finished fixtures (paginated)
    const settledRows = await fetchAllSettlementEntries(sb, finishedIds);

    if (settledRows !== null) {
      // Count settlements per fixture
      const countByFixture = new Map<number, number>();
      for (const row of settledRows) {
        countByFixture.set(row.fixture_id, (countByFixture.get(row.fixture_id) ?? 0) + 1);
      }

      // Unsettled = < 2 entries (need both home + away)
      unsettledFixtures = finishedIds.filter(fid => (countByFixture.get(fid) ?? 0) < 2);

      // Deterministic ordering: settle by fixture_id ascending so results are reproducible
      unsettledFixtures.sort((a, b) => a - b);
    }
  }

  let settledCount = 0;
  let settledErrors = 0;

  // Settle sequentially to avoid B_value race conditions
  for (const fixtureId of unsettledFixtures) {
    try {
      const result = await settleFixture(fixtureId);
      if (result.settled) {
        settledCount++;
      }
    } catch (err) {
      settledErrors++;
      log.error(
        `Oracle V1 cycle: settlement failed for fixture ${fixtureId}: ` +
        (err instanceof Error ? err.message : String(err))
      );
    }
  }

  if (settledCount > 0 || settledErrors > 0) {
    log.info(
      `Oracle V1 settlement: ${settledCount} settled, ${settledErrors} errors, ` +
      `${unsettledFixtures.length - settledCount - settledErrors} skipped`
    );
  }

  // ── Step 2: Identify frozen teams (mid-match) ─────────────
  const { data: liveMatches, error: liveErr } = await sb
    .from("matches")
    .select("fixture_id, home_team, away_team")
    .eq("status", "live");

  const frozenTeams = new Set<string>();
  if (liveErr) {
    log.warn(`Oracle V1 cycle: live match query failed: ${liveErr.message}`);
  } else {
    for (const m of (liveMatches ?? [])) {
      frozenTeams.add(m.home_team);
      frozenTeams.add(m.away_team);
    }
  }

  // ── Step 2b: Live layer updates for frozen teams ──────────
  let liveUpdated = 0;
  let liveFrozen = 0;

  if (ORACLE_V1_LIVE_ENABLED && !liveErr && (liveMatches ?? []).length > 0) {
    for (const m of (liveMatches ?? [])) {
      // Lock M1 at kickoff value for both teams
      await handleKickoffLock(sb, m.fixture_id, m.home_team, m.away_team);

      // Compute L for home team
      try {
        const homeResult = await computeLiveLayer(m.fixture_id, m.home_team, true);
        if (!homeResult.frozen) {
          await writeLiveState(sb, m.home_team, m.fixture_id, homeResult.L, true);
          liveUpdated++;
        } else {
          liveFrozen++;
        }
      } catch (err) {
        liveFrozen++;
        log.error(
          `Oracle V1 cycle: live layer failed for ${m.home_team}: ` +
          (err instanceof Error ? err.message : String(err))
        );
      }

      // Compute L for away team
      try {
        const awayResult = await computeLiveLayer(m.fixture_id, m.away_team, false);
        if (!awayResult.frozen) {
          await writeLiveState(sb, m.away_team, m.fixture_id, awayResult.L, false);
          liveUpdated++;
        } else {
          liveFrozen++;
        }
      } catch (err) {
        liveFrozen++;
        log.error(
          `Oracle V1 cycle: live layer failed for ${m.away_team}: ` +
          (err instanceof Error ? err.message : String(err))
        );
      }
    }

    if (liveUpdated > 0 || liveFrozen > 0) {
      log.info(`Oracle V1 live layer: ${liveUpdated} updated, ${liveFrozen} frozen`);
    }
  }

  // ── Step 3: Refresh M1 for all non-frozen teams ───────────
  // Get all distinct teams from team_oracle_state
  const { data: allTeamRows, error: teamErr } = await sb
    .from("team_oracle_state")
    .select("team_id");

  if (teamErr) {
    log.error(`Oracle V1 cycle: team_oracle_state query failed: ${teamErr.message}`);
    return {
      ran: true,
      settled_count: settledCount,
      settled_errors: settledErrors,
      m1_refreshed: 0,
      m1_skipped: 0,
      m1_errors: 0,
      frozen_teams: [...frozenTeams],
      live_updated: 0,
      live_frozen: 0,
      elapsed_ms: Date.now() - cycleStart,
    };
  }

  const existingTeams = new Set((allTeamRows ?? []).map(r => r.team_id as string));

  // ── Inline bootstrap: ensure every team in `matches` has a row ────
  // Load all distinct teams from matches, bootstrap any missing ones.
  const allMatchTeams = await fetchAllDistinctTeams(sb);
  let bootstrapCount = 0;

  if (allMatchTeams) {
    const missingTeams = allMatchTeams.filter(t => !existingTeams.has(t.team) && !frozenTeams.has(t.team));

    if (missingTeams.length > 0) {
      const now = new Date().toISOString();
      const season = deriveSeason(new Date().toISOString().slice(0, 10));
      const bootstrapRows = missingTeams.map(t => ({
        team_id: t.team,
        season,
        b_value: ORACLE_V1_BASELINE_ELO,
        m1_value: 0,
        published_index: ORACLE_V1_BASELINE_ELO,
        confidence_score: 0,
        next_fixture_id: null,
        last_kr_fixture_id: null,
        last_market_refresh_ts: null,
        updated_at: now,
      }));

      const { error: bsErr } = await sb
        .from("team_oracle_state")
        .upsert(bootstrapRows, { onConflict: "team_id" });

      if (bsErr) {
        log.warn(`Oracle V1 cycle: inline bootstrap failed: ${bsErr.message}`);
      } else {
        bootstrapCount = missingTeams.length;
        // Also write price history for bootstrapped teams
        const phRows = missingTeams.map(t => ({
          team: t.team,
          league: t.league,
          timestamp: now,
          b_value: ORACLE_V1_BASELINE_ELO,
          m1_value: 0,
          published_index: ORACLE_V1_BASELINE_ELO,
          confidence_score: 0,
          source_fixture_id: null,
          publish_reason: "bootstrap",
        }));

        const { error: phErr } = await sb
          .from("oracle_price_history")
          .insert(phRows);

        if (phErr) {
          log.warn(`Oracle V1 cycle: bootstrap price history insert failed: ${phErr.message}`);
        }

        log.info(`Oracle V1 cycle: bootstrapped ${bootstrapCount} new teams at B=${ORACLE_V1_BASELINE_ELO}`);

        // Add to existing set so they get M1 refreshed this cycle
        for (const t of missingTeams) {
          existingTeams.add(t.team);
        }
      }
    }
  }

  const allTeams = [...existingTeams];
  const teamsToRefresh = allTeams.filter(t => !frozenTeams.has(t));
  const m1Skipped = allTeams.length - teamsToRefresh.length;

  let m1Refreshed = 0;
  let m1Errors = 0;

  // Parallel M1 refresh with concurrency limit
  if (teamsToRefresh.length > 0) {
    const results = await parallelLimit(
      teamsToRefresh,
      M1_CONCURRENCY,
      async (team: string) => {
        try {
          const result = await refreshM1(team);
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
          `Oracle V1 cycle: M1 refresh failed for ${r.team}: ` +
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
    `Oracle V1 cycle complete in ${(elapsed / 1000).toFixed(1)}s — ` +
    `settled=${settledCount} bootstrapped=${bootstrapCount} M1=${m1Refreshed}/${teamsToRefresh.length} ` +
    `frozen=${frozenTeams.size} live=${liveUpdated}/${liveUpdated + liveFrozen} errors=${settledErrors + m1Errors}`
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

function deriveSeason(date: string): string {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  if (month >= 7) return `${year}-${(year + 1).toString().slice(2)}`;
  return `${year - 1}-${year.toString().slice(2)}`;
}

/** Fetch ALL finished matches (paginated). Returns null on error. */
async function fetchAllFinished(
  sb: ReturnType<typeof getSupabase>
): Promise<{ fixture_id: number; home_team: string; away_team: string; score: string; date: string }[] | null> {
  const all: { fixture_id: number; home_team: string; away_team: string; score: string; date: string }[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("fixture_id, home_team, away_team, score, date")
      .eq("status", "finished")
      .gte("date", ORACLE_V1_SETTLEMENT_START_DATE)
      .order("date", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      log.error(`fetchAllFinished: ${error.message}`);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/** Fetch settlement_log entries for a set of fixture IDs (paginated, batched). */
async function fetchAllSettlementEntries(
  sb: ReturnType<typeof getSupabase>,
  fixtureIds: number[]
): Promise<{ fixture_id: number; team_id: string }[] | null> {
  const all: { fixture_id: number; team_id: string }[] = [];

  // Supabase `.in()` has a practical limit — batch in chunks of 500
  const chunkSize = 500;
  for (let i = 0; i < fixtureIds.length; i += chunkSize) {
    const chunk = fixtureIds.slice(i, i + chunkSize);

    const { data, error } = await sb
      .from("settlement_log")
      .select("fixture_id, team_id")
      .in("fixture_id", chunk);

    if (error) {
      log.error(`fetchAllSettlementEntries: ${error.message}`);
      return null;
    }
    if (data) all.push(...data);
  }
  return all;
}

/**
 * Lock M1 at kickoff value when a match goes live.
 * Reads current m1_value from team_oracle_state and writes it to m1_locked
 * if m1_locked is currently null (first time this match is seen live).
 */
async function handleKickoffLock(
  sb: ReturnType<typeof getSupabase>,
  fixtureId: number,
  homeTeam: string,
  awayTeam: string
): Promise<void> {
  for (const teamId of [homeTeam, awayTeam]) {
    const { data: state, error: stateErr } = await sb
      .from("team_oracle_state")
      .select("m1_value, m1_locked")
      .eq("team_id", teamId)
      .maybeSingle();

    if (stateErr || !state) continue;

    // Only lock if not already locked (first live cycle for this match)
    if (state.m1_locked === null || state.m1_locked === undefined) {
      const { error: lockErr } = await sb
        .from("team_oracle_state")
        .update({ m1_locked: Number(state.m1_value) ?? 0, updated_at: new Date().toISOString() })
        .eq("team_id", teamId);

      if (lockErr) {
        log.warn(`handleKickoffLock: failed for ${teamId}: ${lockErr.message}`);
      } else {
        log.debug(`handleKickoffLock: locked M1=${state.m1_value} for ${teamId} (fixture ${fixtureId})`);
      }
    }
  }
}

/**
 * Write live state: update l_value and published_index for a team during a live match.
 * published_index = B + M_locked + L
 */
async function writeLiveState(
  sb: ReturnType<typeof getSupabase>,
  teamId: string,
  fixtureId: number,
  L: number,
  isHome: boolean
): Promise<void> {
  // Load current state to compute published_index
  const { data: state, error: stateErr } = await sb
    .from("team_oracle_state")
    .select("b_value, m1_locked")
    .eq("team_id", teamId)
    .single();

  if (stateErr || !state) {
    log.error(`writeLiveState: state not found for ${teamId}: ${stateErr?.message ?? "no data"}`);
    return;
  }

  const B = Number(state.b_value);
  const M_locked = Number(state.m1_locked ?? 0);
  const publishedIndex = B + M_locked + L;
  const now = new Date().toISOString();

  const { error: updateErr } = await sb
    .from("team_oracle_state")
    .update({
      l_value: Number(L.toFixed(4)),
      published_index: Number(publishedIndex.toFixed(4)),
      updated_at: now,
    })
    .eq("team_id", teamId);

  if (updateErr) {
    log.error(`writeLiveState: update failed for ${teamId}: ${updateErr.message}`);
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
      publish_reason: "live_update",
    }]);

  if (phErr) {
    log.warn(`writeLiveState: price history insert failed for ${teamId}: ${phErr.message}`);
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

/** Fetch all distinct teams from matches table with their league. */
async function fetchAllDistinctTeams(
  sb: ReturnType<typeof getSupabase>
): Promise<{ team: string; league: string }[] | null> {
  const teamMap = new Map<string, string>();
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("home_team, away_team, league")
      .range(from, from + pageSize - 1);

    if (error) {
      log.error(`fetchAllDistinctTeams: ${error.message}`);
      return null;
    }
    if (!data || data.length === 0) break;

    for (const m of data) {
      if (!teamMap.has(m.home_team)) teamMap.set(m.home_team, m.league);
      if (!teamMap.has(m.away_team)) teamMap.set(m.away_team, m.league);
    }

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return [...teamMap.entries()].map(([team, league]) => ({ team, league }));
}
