/**
 * oracle-v3-cycle.ts — Main orchestration cycle for Oracle V3.
 *
 * Architecture:
 *   1. Settle newly-finished matches → triggers BT re-solve per league
 *   2. Identify frozen teams (mid-match) → compute L inside 0.6 bracket
 *   3. For non-frozen teams: R_next-only refresh (no BT re-solve)
 *
 * Key V3 principles:
 *   - BT re-solves ONLY at settlement, not every cycle
 *   - Between settlements, only R_next updates from live odds
 *   - Live formula: published = 0.6 × (B + L) + 0.4 × R_market_frozen
 *   - r_market_frozen stores R_market at kickoff (not B + M1)
 *
 * Reads/writes team_oracle_v3_state.
 * Settlement checks oracle_version='v3' in settlement_log.
 */

import { getSupabase } from "../api/supabase-client.js";
import { settleFixtureV3 } from "./oracle-v3-settlement.js";
import { solveBTForLeague, refreshRNextForLeague } from "./oracle-v3-market.js";
import { computeLiveLayerV3 } from "./oracle-v3-live.js";
import {
  ORACLE_V3_ENABLED,
  ORACLE_V3_LIVE_ENABLED,
  ORACLE_V3_SETTLEMENT_START_DATE,
  LEAGUE_SPORT_KEYS,
} from "../config.js";
import { log } from "../logger.js";

// ─── Types ──────────────────────────────────────────────────

interface V3CycleResult {
  ran: boolean;
  skipped_reason?: string;
  settled_count: number;
  settled_errors: number;
  bt_resolves: number;
  rnext_refreshed: number;
  frozen_teams: string[];
  live_updated: number;
  live_frozen: number;
  elapsed_ms: number;
}

// ─── Main cycle ─────────────────────────────────────────────

export async function runOracleV3Cycle(): Promise<V3CycleResult> {
  const cycleStart = Date.now();

  if (!ORACLE_V3_ENABLED) {
    return {
      ran: false, skipped_reason: "oracle_v3_disabled",
      settled_count: 0, settled_errors: 0, bt_resolves: 0,
      rnext_refreshed: 0, frozen_teams: [], live_updated: 0,
      live_frozen: 0, elapsed_ms: 0,
    };
  }

  const sb = getSupabase();
  log.info("Oracle V3 cycle starting...");

  // ── Step 1: Settle newly-finished matches ──────────────────
  const finishedMatches = await fetchAllFinished(sb);

  if (finishedMatches === null) {
    log.error("Oracle V3 cycle: finished matches query failed");
    return mkResult(true, 0, 1, 0, 0, [], 0, 0, Date.now() - cycleStart);
  }

  const finishedIds = finishedMatches.map(m => m.fixture_id);
  let unsettledFixtures: number[] = [];

  if (finishedIds.length > 0) {
    const settledRows = await fetchV3SettlementEntries(sb, finishedIds);

    if (settledRows !== null) {
      const countByFixture = new Map<number, number>();
      for (const row of settledRows) {
        countByFixture.set(row.fixture_id, (countByFixture.get(row.fixture_id) ?? 0) + 1);
      }
      unsettledFixtures = finishedIds.filter(fid => (countByFixture.get(fid) ?? 0) < 2);
      unsettledFixtures.sort((a, b) => a - b);
    }
  }

  let settledCount = 0;
  let settledErrors = 0;
  const leaguesSettled = new Set<string>();

  // Settle sequentially to avoid B_value race conditions
  for (const fixtureId of unsettledFixtures) {
    try {
      const result = await settleFixtureV3(fixtureId);
      if (result.settled) {
        settledCount++;
        if (result.league) leaguesSettled.add(result.league);
      }
    } catch (err) {
      settledErrors++;
      log.error(
        `Oracle V3 cycle: settlement failed for fixture ${fixtureId}: ` +
        (err instanceof Error ? err.message : String(err))
      );
    }
  }

  if (settledCount > 0 || settledErrors > 0) {
    log.info(
      `Oracle V3 settlement: ${settledCount} settled, ${settledErrors} errors, ` +
      `${unsettledFixtures.length - settledCount - settledErrors} skipped`
    );
  }

  // ── Step 1b: BT re-solve for leagues that had settlements ──
  // This is the ONLY time BT re-solves. Not on a timer. Not every cycle.
  let btResolves = 0;

  for (const league of leaguesSettled) {
    try {
      await solveBTForLeague(league, "settlement");
      btResolves++;
    } catch (err) {
      log.error(
        `Oracle V3 cycle: BT re-solve failed for ${league}: ` +
        (err instanceof Error ? err.message : String(err))
      );
    }
  }

  if (btResolves > 0) {
    log.info(`Oracle V3 BT re-solve: ${btResolves}/${leaguesSettled.size} leagues`);
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
    log.warn(`Oracle V3 cycle: live match query failed: ${liveErr.message}`);
  } else {
    for (const m of (liveMatches ?? [])) {
      frozenTeams.add(m.home_team);
      frozenTeams.add(m.away_team);
    }
  }

  // ── Step 2b: Live layer for frozen teams ───────────────────
  // published = 0.6 × (B + L) + 0.4 × R_market_frozen
  let liveUpdated = 0;
  let liveFrozen = 0;

  if (ORACLE_V3_LIVE_ENABLED && !liveErr && (liveMatches ?? []).length > 0) {
    for (const m of (liveMatches ?? [])) {
      // Freeze R_market at kickoff (first time only)
      await handleKickoffFreezeV3(sb, m.fixture_id, m.home_team, m.away_team);

      // Compute L for each team
      for (const [teamId, isHome] of [[m.home_team, true], [m.away_team, false]] as [string, boolean][]) {
        try {
          const result = await computeLiveLayerV3(m.fixture_id, teamId, isHome);
          if (!result.frozen) {
            await writeLiveStateV3(sb, teamId, m.fixture_id, result.L);
            liveUpdated++;
          } else {
            liveFrozen++;
          }
        } catch (err) {
          liveFrozen++;
          log.error(
            `Oracle V3 cycle: live layer failed for ${teamId}: ` +
            (err instanceof Error ? err.message : String(err))
          );
        }
      }
    }

    if (liveUpdated > 0 || liveFrozen > 0) {
      log.info(`Oracle V3 live layer: ${liveUpdated} updated, ${liveFrozen} frozen`);
    }
  }

  // ── Step 3: R_next-only refresh for non-frozen teams ───────
  // No BT re-solve — only R_next updates from live odds
  const leagues = Object.keys(LEAGUE_SPORT_KEYS);
  let rnextRefreshed = 0;

  for (const league of leagues) {
    // Skip leagues that just had a BT re-solve (already refreshed)
    if (leaguesSettled.has(league)) continue;

    try {
      const result = await refreshRNextForLeague(league);
      if (result.updated) rnextRefreshed += result.teams_refreshed;
    } catch (err) {
      log.error(
        `Oracle V3 cycle: R_next refresh failed for ${league}: ` +
        (err instanceof Error ? err.message : String(err))
      );
    }
  }

  // ── Step 4: Log cycle summary ─────────────────────────────
  const elapsed = Date.now() - cycleStart;

  log.info(
    `Oracle V3 cycle complete in ${(elapsed / 1000).toFixed(1)}s — ` +
    `settled=${settledCount} BT=${btResolves} R_next=${rnextRefreshed} ` +
    `live=${liveUpdated}/${frozenTeams.size} frozen=${liveFrozen} ` +
    `errors=${settledErrors}`
  );

  return {
    ran: true,
    settled_count: settledCount,
    settled_errors: settledErrors,
    bt_resolves: btResolves,
    rnext_refreshed: rnextRefreshed,
    frozen_teams: [...frozenTeams],
    live_updated: liveUpdated,
    live_frozen: liveFrozen,
    elapsed_ms: elapsed,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function mkResult(
  ran: boolean, settled_count: number, settled_errors: number,
  bt_resolves: number, rnext_refreshed: number, frozen_teams: string[],
  live_updated: number, live_frozen: number, elapsed_ms: number,
): V3CycleResult {
  return {
    ran, settled_count, settled_errors, bt_resolves,
    rnext_refreshed, frozen_teams, live_updated, live_frozen, elapsed_ms,
  };
}

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
      .gte("date", ORACLE_V3_SETTLEMENT_START_DATE)
      .order("date", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) { log.error(`V3 fetchAllFinished: ${error.message}`); return null; }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/** Fetch V3-only settlement_log entries for fixture IDs (paginated, batched). */
async function fetchV3SettlementEntries(
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
      .eq("oracle_version", "v3");

    if (error) { log.error(`V3 fetchSettlementEntries: ${error.message}`); return null; }
    if (data) all.push(...data);
  }
  return all;
}

/**
 * Freeze R_market at kickoff for teams going live.
 * Stores R_market (includes R_next) as gravity target for settlement.
 * Also locks M1 at current value.
 */
async function handleKickoffFreezeV3(
  sb: ReturnType<typeof getSupabase>,
  fixtureId: number, homeTeam: string, awayTeam: string
): Promise<void> {
  for (const teamId of [homeTeam, awayTeam]) {
    const { data: state, error: stateErr } = await sb
      .from("team_oracle_v3_state")
      .select("m1_value, m1_locked, r_market_frozen, r_market, b_value")
      .eq("team_id", teamId)
      .maybeSingle();

    if (stateErr || !state) continue;

    // Only freeze once per match
    if (state.m1_locked === null || state.m1_locked === undefined) {
      const m1Raw = Number(state.m1_value);
      const m1Value = isNaN(m1Raw) ? 0 : m1Raw;
      const rMarketRaw = state.r_market != null ? Number(state.r_market) : NaN;
      const rMarketAtKickoff = isNaN(rMarketRaw)
        ? (Number(state.b_value) + m1Value)
        : rMarketRaw;

      const { error: lockErr } = await sb
        .from("team_oracle_v3_state")
        .update({
          m1_locked: m1Value,
          r_market_frozen: Number(rMarketAtKickoff.toFixed(4)),
          updated_at: new Date().toISOString(),
        })
        .eq("team_id", teamId);

      if (lockErr) {
        log.warn(`V3 kickoff freeze: failed for ${teamId}: ${lockErr.message}`);
      } else {
        log.debug(
          `V3 kickoff freeze: M1=${m1Value.toFixed(2)}, R_market=${rMarketAtKickoff.toFixed(2)} ` +
          `for ${teamId} (fixture ${fixtureId})`
        );
      }
    }
  }
}

/**
 * Write live state: published = 0.6 × (B + L) + 0.4 × R_market_frozen
 * L goes INSIDE the 0.6 bracket (spec Section 12.1).
 */
async function writeLiveStateV3(
  sb: ReturnType<typeof getSupabase>,
  teamId: string, fixtureId: number, L: number
): Promise<void> {
  const { data: state, error: stateErr } = await sb
    .from("team_oracle_v3_state")
    .select("b_value, r_market_frozen")
    .eq("team_id", teamId)
    .single();

  if (stateErr || !state) {
    log.error(`V3 writeLiveState: state not found for ${teamId}: ${stateErr?.message ?? "no data"}`);
    return;
  }

  const B = Number(state.b_value);
  const R_market_frozen = state.r_market_frozen != null ? Number(state.r_market_frozen) : B;

  // published = 0.6 × (B + L) + 0.4 × R_market_frozen
  const publishedIndex = 0.6 * (B + L) + 0.4 * R_market_frozen;
  const now = new Date().toISOString();

  const { error: updateErr } = await sb
    .from("team_oracle_v3_state")
    .update({
      l_value: Number(L.toFixed(4)),
      published_index: Number(publishedIndex.toFixed(4)),
      updated_at: now,
    })
    .eq("team_id", teamId);

  if (updateErr) {
    log.error(`V3 writeLiveState: update failed for ${teamId}: ${updateErr.message}`);
    return;
  }

  const league = await getTeamLeagueCached(sb, teamId);
  const { error: phErr } = await sb
    .from("oracle_price_history")
    .insert([{
      team: teamId, league: league ?? "unknown", timestamp: now,
      b_value: B, m1_value: 0, l_value: Number(L.toFixed(4)),
      published_index: Number(publishedIndex.toFixed(4)),
      confidence_score: null, source_fixture_id: fixtureId,
      publish_reason: "live_update_v3",
    }]);

  if (phErr) log.warn(`V3 writeLiveState: price history insert failed for ${teamId}: ${phErr.message}`);
}

/** In-memory cache for team → league mapping within a cycle. */
const teamLeagueCache = new Map<string, string | null>();

async function getTeamLeagueCached(
  sb: ReturnType<typeof getSupabase>, teamId: string
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
