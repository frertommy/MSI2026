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
  DOMESTIC_LEAGUES,
} from "../config.js";
import { log } from "../logger.js";

// ─── Types ──────────────────────────────────────────────────

interface FrozenTeamState {
  b_value: number;
  r_market_frozen: number;
  m1_locked: number;
}

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

// ─── Cache: CL fixtures where neither team has V3 state ─────
// These are retried once per cycle otherwise (5 DB queries each, no-op).
// Cache is cleared after 24h so new teams can be picked up if state is added.
const skippedUntrackedCL = new Map<number, number>(); // fixture_id → timestamp
const SKIP_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
  const leagueByFixture = new Map<number, string>();
  for (const m of finishedMatches) leagueByFixture.set(m.fixture_id, m.league);
  let unsettledFixtures: number[] = [];

  if (finishedIds.length > 0) {
    const settledRows = await fetchV3SettlementEntries(sb, finishedIds);

    if (settledRows !== null) {
      const countByFixture = new Map<number, number>();
      for (const row of settledRows) {
        countByFixture.set(row.fixture_id, (countByFixture.get(row.fixture_id) ?? 0) + 1);
      }
      // CL fixtures may only need 1 settlement (external opponent has no V3 state).
      // Domestic fixtures need 2. Use league to determine expected count.
      unsettledFixtures = finishedIds.filter(fid => {
        const count = countByFixture.get(fid) ?? 0;
        const league = leagueByFixture.get(fid) ?? "";
        const isCL = !DOMESTIC_LEAGUES.has(league);
        // CL: need at least 1 settlement (our tracked team). Domestic: need 2.
        const expectedMin = isCL ? 1 : 2;
        return count < expectedMin;
      });
      unsettledFixtures.sort((a, b) => a - b);
    }
  }

  let settledCount = 0;
  let settledErrors = 0;
  const leaguesSettled = new Set<string>();
  const leagueSettleTriggers = new Map<string, number>(); // league → latest settled fixture ID

  // Evict expired entries from skip cache
  const now = Date.now();
  for (const [fid, ts] of skippedUntrackedCL) {
    if (now - ts > SKIP_CACHE_TTL_MS) skippedUntrackedCL.delete(fid);
  }

  // Settle sequentially to avoid B_value race conditions
  for (const fixtureId of unsettledFixtures) {
    // Skip CL fixtures where neither team has V3 state (cached from prior cycles)
    if (skippedUntrackedCL.has(fixtureId)) continue;

    try {
      const result = await settleFixtureV3(fixtureId);
      if (result.settled) {
        settledCount++;
        if (result.league) {
          leaguesSettled.add(result.league);
          leagueSettleTriggers.set(result.league, fixtureId);
        }
      } else if (result.skipped_reason === "missing_v3_state") {
        // Neither team has V3 state — cache to avoid retrying every cycle
        skippedUntrackedCL.set(fixtureId, Date.now());
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
  // CL excluded: BT stays league-only to avoid cross-contamination.
  // Retry once on failure (RISK-1) to recover from transient errors.
  let btResolves = 0;
  const domesticLeaguesSettled = [...leaguesSettled].filter(l => DOMESTIC_LEAGUES.has(l));

  await Promise.all(domesticLeaguesSettled.map(async (league) => {
    const triggerFixtureId = leagueSettleTriggers.get(league);
    let resolved = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await solveBTForLeague(league, "settlement", triggerFixtureId);
        btResolves++;
        resolved = true;
        break;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (attempt < 2) {
          log.warn(`Oracle V3 cycle: BT re-solve attempt ${attempt}/2 failed for ${league}: ${errMsg} — retrying`);
          await new Promise(r => setTimeout(r, 1000));
        } else {
          log.error(`Oracle V3 cycle: BT re-solve failed for ${league} after 2 attempts: ${errMsg}`);
        }
      }
    }
    if (!resolved) {
      log.error(`Oracle V3 cycle: DEGRADED — BT ratings stale for ${league}. Will re-try on next settlement.`);
    }
  }));

  if (btResolves > 0) {
    log.info(`Oracle V3 BT re-solve: ${btResolves}/${domesticLeaguesSettled.length} domestic leagues` +
      (leaguesSettled.size > domesticLeaguesSettled.length ? ` (${leaguesSettled.size - domesticLeaguesSettled.length} CL skipped)` : ""));
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
    const liveResults = await Promise.all((liveMatches ?? []).map(async (m) => {
      let updated = 0;
      let frozen = 0;

      // Freeze R_market at kickoff (first time only) + get state for live writes
      const frozenState = await handleKickoffFreezeV3(sb, m.fixture_id, m.home_team, m.away_team);

      // Compute L for each team
      for (const [teamId, isHome] of [[m.home_team, true], [m.away_team, false]] as [string, boolean][]) {
        try {
          const result = await computeLiveLayerV3(m.fixture_id, teamId, isHome);
          if (!result.frozen) {
            const teamState = frozenState.get(teamId as string);
            if (teamState) {
              await writeLiveStateV3(sb, teamId, m.fixture_id, result.L, teamState.b_value, teamState.r_market_frozen, teamState.m1_locked);
              updated++;
            } else {
              log.warn(`V3 cycle: no frozen state for ${teamId}, skipping live write`);
              frozen++;
            }
          } else {
            frozen++;
          }
        } catch (err) {
          frozen++;
          log.error(
            `Oracle V3 cycle: live layer failed for ${teamId}: ` +
            (err instanceof Error ? err.message : String(err))
          );
        }
      }
      return { updated, frozen };
    }));

    for (const r of liveResults) {
      liveUpdated += r.updated;
      liveFrozen += r.frozen;
    }

    if (liveUpdated > 0 || liveFrozen > 0) {
      log.info(`Oracle V3 live layer: ${liveUpdated} updated, ${liveFrozen} frozen`);
    }
  }

  // ── Step 3: R_next-only refresh for non-frozen teams ───────
  // No BT re-solve — only R_next updates from live odds
  // R_next is domestic-only: CL fixtures don't contribute to next-fixture pricing
  const domesticLeagues = Object.keys(LEAGUE_SPORT_KEYS).filter(l => DOMESTIC_LEAGUES.has(l));
  let rnextRefreshed = 0;

  const leaguesToRefresh = domesticLeagues.filter(l => !leaguesSettled.has(l));
  const rnextResults = await Promise.all(leaguesToRefresh.map(async (league) => {
    try {
      const result = await refreshRNextForLeague(league);
      return result.updated ? result.teams_refreshed : 0;
    } catch (err) {
      log.error(
        `Oracle V3 cycle: R_next refresh failed for ${league}: ` +
        (err instanceof Error ? err.message : String(err))
      );
      return 0;
    }
  }));
  rnextRefreshed = rnextResults.reduce((a, b) => a + b, 0);

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

/** Fetch recently-finished matches (last 7 days, paginated).
 *  Matches unsettled for >7 days need manual investigation.
 *  Returns fixture_id + league so CL vs domestic threshold can be applied.
 */
async function fetchAllFinished(
  sb: ReturnType<typeof getSupabase>
): Promise<{ fixture_id: number; league: string }[] | null> {
  const all: { fixture_id: number; league: string }[] = [];
  const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // Use the later of ORACLE_V3_SETTLEMENT_START_DATE and 7-day cutoff
  const effectiveFrom = recentCutoff > ORACLE_V3_SETTLEMENT_START_DATE ? recentCutoff : ORACLE_V3_SETTLEMENT_START_DATE;
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("fixture_id, league")
      .eq("status", "finished")
      .gte("date", effectiveFrom)
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
 * Returns a Map of team → { b_value, r_market_frozen, m1_locked } for use by writeLiveStateV3.
 */
async function handleKickoffFreezeV3(
  sb: ReturnType<typeof getSupabase>,
  fixtureId: number, homeTeam: string, awayTeam: string
): Promise<Map<string, FrozenTeamState>> {
  const result = new Map<string, FrozenTeamState>();

  for (const teamId of [homeTeam, awayTeam]) {
    const { data: state, error: stateErr } = await sb
      .from("team_oracle_v3_state")
      .select("m1_value, m1_locked, r_market_frozen, r_market, b_value")
      .eq("team_id", teamId)
      .maybeSingle();

    if (stateErr || !state) continue;

    const bValue = Number(state.b_value);

    // Only freeze once per match
    if (state.m1_locked === null || state.m1_locked === undefined) {
      const m1Raw = Number(state.m1_value);
      const m1Value = isNaN(m1Raw) ? 0 : m1Raw;
      const rMarketRaw = state.r_market != null ? Number(state.r_market) : NaN;
      const rMarketAtKickoff = isNaN(rMarketRaw)
        ? (bValue + m1Value)
        : rMarketRaw;

      const frozenRMarket = Number(rMarketAtKickoff.toFixed(4));

      const { error: lockErr } = await sb
        .from("team_oracle_v3_state")
        .update({
          m1_locked: m1Value,
          r_market_frozen: frozenRMarket,
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

      result.set(teamId, { b_value: bValue, r_market_frozen: frozenRMarket, m1_locked: m1Value });
    } else {
      // Already frozen — return existing frozen values
      // Note: freeze is team-global, not fixture-scoped. This is safe because
      // a team cannot have two concurrent live matches. Settlement clears the freeze.
      const existingRFrozen = state.r_market_frozen != null ? Number(state.r_market_frozen) : bValue;
      const existingM1 = Number(state.m1_locked);
      result.set(teamId, { b_value: bValue, r_market_frozen: existingRFrozen, m1_locked: isNaN(existingM1) ? 0 : existingM1 });
      log.debug(`V3 kickoff freeze: ${teamId} already frozen (fixture ${fixtureId}), M1_locked=${existingM1.toFixed(2)}, R_frozen=${existingRFrozen.toFixed(2)}`);
    }
  }

  return result;
}

/**
 * Write live state: published = 0.6 × (B + L) + 0.4 × R_market_frozen
 * L goes INSIDE the 0.6 bracket (spec Section 12.1).
 * Accepts pre-fetched state from handleKickoffFreezeV3 to avoid redundant DB read.
 */
async function writeLiveStateV3(
  sb: ReturnType<typeof getSupabase>,
  teamId: string, fixtureId: number, L: number,
  B: number, R_market_frozen: number, m1_locked: number
): Promise<void> {
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
  const liveCompetition = (league && DOMESTIC_LEAGUES.has(league)) ? "league" : "champions_league";
  const { error: phErr } = await sb
    .from("oracle_price_history")
    .insert([{
      team: teamId, league: league ?? "unknown", timestamp: now,
      b_value: B, m1_value: m1_locked, l_value: Number(L.toFixed(4)),
      published_index: Number(publishedIndex.toFixed(4)),
      confidence_score: null, source_fixture_id: fixtureId,
      publish_reason: "live_update_v3",
      competition: liveCompetition,
    }]);

  if (phErr) log.warn(`V3 writeLiveState: price history insert failed for ${teamId}: ${phErr.message}`);
}

/** In-memory cache for team → league mapping, cleared every hour. */
const teamLeagueCache = new Map<string, string | null>();
let teamLeagueCacheLastClear = 0;
const TEAM_LEAGUE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getTeamLeagueCached(
  sb: ReturnType<typeof getSupabase>, teamId: string
): Promise<string | null> {
  const now = Date.now();
  if (now - teamLeagueCacheLastClear > TEAM_LEAGUE_CACHE_TTL_MS) {
    teamLeagueCache.clear();
    teamLeagueCacheLastClear = now;
  }
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
