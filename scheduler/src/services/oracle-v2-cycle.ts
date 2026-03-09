/**
 * oracle-v2-cycle.ts — Main orchestration cycle for Oracle V2.
 *
 * Simplified version of V1 cycle:
 *   1. Settle newly-finished matches (with gravity formula)
 *   2. Refresh M1 for all teams (same M1 logic, reads V2 state)
 *   3. No live layer initially (can add later)
 *   4. No feedback F (stub)
 *   5. No offseason drift (gravity handles in-season; offseason TBD)
 *
 * Reads/writes team_oracle_v2_state.
 * Settlement checks oracle_version='v2' in settlement_log.
 */

import { getSupabase } from "../api/supabase-client.js";
import { settleFixtureV2 } from "./oracle-v2-settlement.js";
import { refreshM1V2 } from "./oracle-v2-market.js";
import { ORACLE_V2_ENABLED, ORACLE_V2_SETTLEMENT_START_DATE } from "../config.js";
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
    `frozen=${frozenTeams.size} errors=${settledErrors + m1Errors}`
  );

  return {
    ran: true,
    settled_count: settledCount,
    settled_errors: settledErrors,
    m1_refreshed: m1Refreshed,
    m1_skipped: m1Skipped,
    m1_errors: m1Errors,
    frozen_teams: [...frozenTeams],
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
