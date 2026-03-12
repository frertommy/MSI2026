/**
 * oracle-v3-market.ts — Per-league Bradley-Terry market refresh for Oracle V3.
 *
 * Two modes of operation:
 *   1. solveBTForLeague() — Full BT re-solve. Runs ONLY after a settlement.
 *      Collects past 30d of played fixtures (frozen odds) + upcoming fixtures
 *      (live odds) → simultaneous BT MAP solve → R_network per team.
 *      Then computes R_next, R_market, M1, published for all teams.
 *
 *   2. refreshRNextForLeague() — R_next-only refresh. Runs every cycle.
 *      Uses stored R_network (frozen since last settlement), recomputes
 *      R_next from live odds for each team's next fixture, then updates
 *      R_market, M1, published. BT does NOT re-solve.
 *
 * Formula:
 *   R_market = (1 − w_next) × R_network + w_next × R_next
 *   M1       = clamp(α × (R_market − B), −120, +120)
 *   published = B + M1 = 0.6×B + 0.4×R_market
 *
 * R_next = R_network_opponent + 400 × log10(ES_team / (1 − ES_team))
 *          adjusted for home advantage
 *   If no next fixture or no odds: R_next = R_network (silent fallback)
 */

import { getSupabase } from "../api/supabase-client.js";
import { powerDevigOdds, median } from "./odds-blend.js";
import { solveBT, type BTFixture, type BTSolveResult } from "./bradley-terry.js";
import { deriveSeason } from "../utils/derive-season.js";
import {
  ORACLE_V3_BT_SIGMA_PRIOR,
  ORACLE_V3_BT_HOME_ADV,
  ORACLE_V3_BT_WINDOW_DAYS,
  ORACLE_V3_BT_WINDOW_EXPAND,
  ORACLE_V3_BT_MIN_FIXTURES,
  ORACLE_V3_BT_SPARSE_SIGMA,
  ORACLE_V3_BT_SIGMA_MAX,
  ORACLE_V3_BT_PAST_DECAY_HL,
  ORACLE_V3_BT_FWD_DECAY_HL,
  ORACLE_V3_ALPHA,
  ORACLE_V3_W_NEXT,
  ORACLE_V3_M1_CLAMP,
} from "../config.js";
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

interface WindowFixture {
  fixture_id: number;
  date: string;
  home_team: string;
  away_team: string;
  commence_time: string | null;
  status: string;
  league: string;
}

export interface LeagueBTResult {
  league: string;
  updated: boolean;
  skipped_reason?: string;
  fixtures_used: number;
  past_fixtures: number;
  upcoming_fixtures: number;
  teams_count: number;
  window_days: number;
  sigma_used: number;
  bt_result?: BTSolveResult;
  teams_updated: number;
}

export interface MarketRefreshResult {
  league: string;
  updated: boolean;
  skipped_reason?: string;
  teams_refreshed: number;
  teams_with_r_next: number;
}

interface FixtureES {
  homeES: number;
  latestSnapshotMs: number;
}

interface NextFixtureInfo {
  fixture_id: number;
  home_team: string;
  away_team: string;
  isHome: boolean;
  teamES: number;
  opponentId: string;
}

// ─── 1. Full BT Re-solve (runs after settlement) ───────────

/**
 * Run a simultaneous Bradley-Terry solve for a league, then compute
 * R_next, R_market, M1, published for every team.
 *
 * Called after settlement only — not every cycle.
 */
export async function solveBTForLeague(
  league: string,
  triggerType: string = "settlement",
  triggerFixtureId?: number
): Promise<LeagueBTResult> {
  const sb = getSupabase();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // ── Step 1: Fetch PAST fixtures (played, backward window) ─
  const windowStart = new Date(now.getTime() - ORACLE_V3_BT_WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);

  const { data: pastFixtures, error: pastErr } = await sb
    .from("matches")
    .select("fixture_id, date, home_team, away_team, commence_time, status, league")
    .eq("league", league)
    .eq("status", "finished")
    .gte("date", windowStart)
    .lte("date", today)
    .order("date", { ascending: false })
    .limit(200);

  if (pastErr) {
    log.error(`V3 BT: past fixture query failed for ${league}: ${pastErr.message}`);
    return mkBTResult(league, false, "past_fixture_query_error");
  }

  let windowDays = ORACLE_V3_BT_WINDOW_DAYS;
  let pastList = (pastFixtures ?? []) as WindowFixture[];

  // Expand window if insufficient
  if (pastList.length < ORACLE_V3_BT_MIN_FIXTURES) {
    const expandedStart = new Date(now.getTime() - ORACLE_V3_BT_WINDOW_EXPAND * 24 * 3600 * 1000)
      .toISOString().slice(0, 10);
    const { data: expanded } = await sb
      .from("matches")
      .select("fixture_id, date, home_team, away_team, commence_time, status, league")
      .eq("league", league)
      .eq("status", "finished")
      .gte("date", expandedStart)
      .lte("date", today)
      .order("date", { ascending: false })
      .limit(200);
    if (expanded && expanded.length > pastList.length) {
      pastList = expanded as WindowFixture[];
      windowDays = ORACLE_V3_BT_WINDOW_EXPAND;
    }
  }

  // ── Step 2: Fetch UPCOMING fixtures (with odds, forward window) ─
  const forwardEnd = new Date(now.getTime() + ORACLE_V3_BT_WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);

  const { data: upcomingFixtures } = await sb
    .from("matches")
    .select("fixture_id, date, home_team, away_team, commence_time, status, league")
    .eq("league", league)
    .in("status", ["scheduled", "not_started", "tbd"])
    .gte("date", today)
    .lte("date", forwardEnd)
    .order("date", { ascending: true })
    .limit(100);

  const upcomingList = (upcomingFixtures ?? []) as WindowFixture[];

  // ── Step 3: Build BT fixtures with proper weighting ────────
  // Batch-load odds data to avoid N+1 queries (PERF-1)
  const pastFids = pastList.map(f => f.fixture_id);
  const upcomingFids = upcomingList.map(f => f.fixture_id);

  const [krBatch, pastOddsBatch, upOddsBatch] = await Promise.all([
    batchLoadKR(sb, pastFids),
    batchLoadOdds(sb, pastFids),
    batchLoadOdds(sb, upcomingFids),
  ]);

  const btFixtures: BTFixture[] = [];

  // Past fixtures: try frozen KR first, then batch odds, then individual fallback
  for (const fix of pastList) {
    let es = krBatch.get(fix.fixture_id) ?? null;
    if (!es) {
      const odds = pastOddsBatch.get(fix.fixture_id);
      if (odds && odds.length > 0) es = processOddsToES(odds);
    }
    if (!es) es = await loadFixtureES_fallback(sb, fix);
    if (!es) continue;
    const fixDateMs = new Date(fix.commence_time ?? fix.date + "T12:00:00Z").getTime();
    const daysAgo = Math.max(0, (now.getTime() - fixDateMs) / (24 * 3600 * 1000));
    const weight = 1 / (1 + daysAgo / ORACLE_V3_BT_PAST_DECAY_HL);
    btFixtures.push({
      homeTeam: fix.home_team, awayTeam: fix.away_team,
      homeES: es.homeES, weight, fixtureId: fix.fixture_id,
    });
  }

  const pastCount = btFixtures.length;

  // Upcoming fixtures: batch odds first, then individual fallback
  for (const fix of upcomingList) {
    const odds = upOddsBatch.get(fix.fixture_id);
    let es = (odds && odds.length > 0) ? processOddsToES(odds) : null;
    if (!es) es = await loadFixtureES_fallback(sb, fix);
    if (!es) continue;
    const fixDateMs = new Date(fix.commence_time ?? fix.date + "T12:00:00Z").getTime();
    const daysForward = Math.max(0, (fixDateMs - now.getTime()) / (24 * 3600 * 1000));
    const weight = 1 / (1 + daysForward / ORACLE_V3_BT_FWD_DECAY_HL);
    btFixtures.push({
      homeTeam: fix.home_team, awayTeam: fix.away_team,
      homeES: es.homeES, weight, fixtureId: fix.fixture_id,
    });
  }

  const upcomingCount = btFixtures.length - pastCount;
  const totalFixtures = btFixtures.length;

  if (totalFixtures <= 2) {
    log.debug(`V3 BT: ${league} — only ${totalFixtures} fixtures with odds, zeroing M1`);
    await zeroMarketForLeague(sb, league);
    return mkBTResult(league, true, "insufficient_fixtures", totalFixtures, pastCount, upcomingCount, 0, windowDays);
  }

  // ── Step 4: Determine sigma ────────────────────────────────
  const sigmaPrior = totalFixtures < ORACLE_V3_BT_MIN_FIXTURES
    ? ORACLE_V3_BT_SPARSE_SIGMA
    : ORACLE_V3_BT_SIGMA_PRIOR;

  // ── Step 5: Load B values for all teams in fixture set ─────
  const teamSet = new Set<string>();
  for (const f of btFixtures) { teamSet.add(f.homeTeam); teamSet.add(f.awayTeam); }
  const teamIds = [...teamSet];

  const { data: stateRows, error: stateErr } = await sb
    .from("team_oracle_v3_state")
    .select("team_id, b_value")
    .in("team_id", teamIds);

  if (stateErr) {
    log.error(`V3 BT: state query failed for ${league}: ${stateErr.message}`);
    return mkBTResult(league, false, "state_query_error", totalFixtures, pastCount, upcomingCount, teamIds.length, windowDays);
  }

  const priorMeans = new Map<string, number>();
  for (const row of (stateRows ?? [])) priorMeans.set(row.team_id, Number(row.b_value));
  for (const t of teamIds) { if (!priorMeans.has(t)) priorMeans.set(t, 1500); }

  // ── Step 6: Run BT solver ─────────────────────────────────
  const btResult = solveBT({
    fixtures: btFixtures, priorMeans, sigmaPrior,
    homeAdv: ORACLE_V3_BT_HOME_ADV,
  });

  if (!btResult.converged) {
    log.warn(`V3 BT: solver did not converge for ${league} after ${btResult.iterations} iters (maxStep=${btResult.maxStep.toFixed(4)})`);
  }

  // ── Step 7: Store R_network + compute R_next, R_market, M1 ─
  const rNetworkMap = btResult.ratings;
  const nowIso = now.toISOString();
  let teamsUpdated = 0;

  const nextFixtureMap = await loadNextFixturesForLeague(sb, league, teamIds);
  const stateUpserts: Record<string, unknown>[] = [];
  const priceHistoryRows: Record<string, unknown>[] = [];

  for (const teamId of teamIds) {
    const R_network = rNetworkMap.get(teamId) ?? priorMeans.get(teamId) ?? 1500;
    const sigma_BT = btResult.stdErrors.get(teamId) ?? ORACLE_V3_BT_SIGMA_MAX;
    const B = priorMeans.get(teamId) ?? 1500;

    const R_next = computeRNext(teamId, R_network, rNetworkMap, nextFixtureMap.get(teamId) ?? null);
    const R_market = (1 - ORACLE_V3_W_NEXT) * R_network + ORACLE_V3_W_NEXT * R_next;
    const M1_raw = ORACLE_V3_ALPHA * (R_market - B);
    const M1 = Math.max(-ORACLE_V3_M1_CLAMP, Math.min(ORACLE_V3_M1_CLAMP, M1_raw));
    const published_index = B + M1;
    const conf = Math.max(0, Math.min(1, 1 - sigma_BT / ORACLE_V3_BT_SIGMA_MAX));

    stateUpserts.push({
      team_id: teamId,
      league,
      r_network: Number(R_network.toFixed(4)),
      r_next: Number(R_next.toFixed(4)),
      r_market: Number(R_market.toFixed(4)),
      m1_value: Number(M1.toFixed(4)),
      published_index: Number(published_index.toFixed(4)),
      confidence_score: Number(conf.toFixed(4)),
      bt_std_error: Number(sigma_BT.toFixed(4)),
      next_fixture_id: nextFixtureMap.get(teamId)?.fixture_id ?? null,
      last_bt_solve_ts: nowIso,
      last_market_refresh_ts: nowIso,
      updated_at: nowIso,
    });

    priceHistoryRows.push({
      team: teamId, league, timestamp: nowIso,
      b_value: Number(B.toFixed(4)), m1_value: Number(M1.toFixed(4)),
      l_value: 0,
      published_index: Number(published_index.toFixed(4)),
      confidence_score: Number(conf.toFixed(4)),
      source_fixture_id: triggerFixtureId ?? null,
      publish_reason: "market_refresh_v3",
    });
    teamsUpdated++;
  }

  // Batch write state updates — use upsert directly to handle missing rows
  for (const row of stateUpserts) {
    const { error: upsertErr } = await sb
      .from("team_oracle_v3_state")
      .upsert([{
        team_id: row.team_id,
        season: deriveSeason(new Date().toISOString()),
        league: row.league,
        r_network: row.r_network, r_next: row.r_next, r_market: row.r_market,
        m1_value: row.m1_value, published_index: row.published_index,
        confidence_score: row.confidence_score, bt_std_error: row.bt_std_error,
        next_fixture_id: row.next_fixture_id, last_bt_solve_ts: row.last_bt_solve_ts,
        last_market_refresh_ts: row.last_market_refresh_ts, updated_at: row.updated_at,
        b_value: priorMeans.get(row.team_id as string) ?? 1500,
      }], { onConflict: "team_id" });

    if (upsertErr) log.error(`V3 BT: state upsert failed for ${row.team_id}: ${upsertErr.message}`);
  }

  // Write price history
  if (priceHistoryRows.length > 0) {
    const { error: phErr } = await sb.from("oracle_price_history").insert(priceHistoryRows);
    if (phErr) log.warn(`V3 BT: price history insert failed for ${league}: ${phErr.message}`);
  }

  // ── Step 8: Write BT snapshot audit trail ─────────────────
  const ratingsObj: Record<string, number> = {};
  const stdErrorsObj: Record<string, number> = {};
  const priorMeansObj: Record<string, number> = {};
  const fixturesDetail: Record<string, unknown>[] = [];

  for (const [t, r] of btResult.ratings) ratingsObj[t] = Number(r.toFixed(4));
  for (const [t, s] of btResult.stdErrors) stdErrorsObj[t] = Number(s.toFixed(4));
  for (const [t, m] of priorMeans) priorMeansObj[t] = Number(m.toFixed(4));
  for (const f of btFixtures) {
    fixturesDetail.push({
      fixture_id: f.fixtureId, home: f.homeTeam, away: f.awayTeam,
      homeES: Number(f.homeES.toFixed(6)), weight: Number(f.weight.toFixed(4)),
    });
  }

  const { error: snapErr } = await sb.from("oracle_bt_snapshots").insert([{
    league, solve_timestamp: nowIso, trigger_type: triggerType,
    trigger_fixture_id: triggerFixtureId ?? null,
    fixtures_used: totalFixtures, teams_count: teamIds.length,
    iterations: btResult.iterations, max_step: Number(btResult.maxStep.toFixed(6)),
    converged: btResult.converged, sigma_prior: sigmaPrior,
    home_adv: ORACLE_V3_BT_HOME_ADV, window_days: windowDays,
    ratings: ratingsObj, std_errors: stdErrorsObj,
    prior_means: priorMeansObj, fixtures_detail: fixturesDetail,
  }]);

  if (snapErr) log.warn(`V3 BT: snapshot insert failed for ${league}: ${snapErr.message}`);

  log.info(
    `V3 BT: ${league} — ${pastCount} past + ${upcomingCount} upcoming = ${totalFixtures} fixtures, ` +
    `${teamIds.length} teams, σ=${sigmaPrior}, ${btResult.iterations} iters, ` +
    `converged=${btResult.converged}, trigger=${triggerType}`
  );

  return {
    league, updated: true, fixtures_used: totalFixtures,
    past_fixtures: pastCount, upcoming_fixtures: upcomingCount,
    teams_count: teamIds.length, window_days: windowDays,
    sigma_used: sigmaPrior, bt_result: btResult, teams_updated: teamsUpdated,
  };
}

// ─── 2. R_next-only Refresh (runs every cycle) ─────────────

/**
 * Refresh R_next from live odds for each team's next fixture,
 * then recompute R_market, M1, published. No BT re-solve.
 *
 * R_network is read from stored state (frozen since last settlement).
 */
export async function refreshRNextForLeague(league: string): Promise<MarketRefreshResult> {
  const sb = getSupabase();
  const nowIso = new Date().toISOString();

  // Find league teams from recent matches
  const { data: leagueMatches } = await sb
    .from("matches")
    .select("home_team, away_team")
    .eq("league", league)
    .order("date", { ascending: false })
    .limit(100);

  if (!leagueMatches || leagueMatches.length === 0) {
    return { league, updated: false, skipped_reason: "no_matches", teams_refreshed: 0, teams_with_r_next: 0 };
  }

  const teamSet = new Set<string>();
  for (const m of leagueMatches) { teamSet.add(m.home_team); teamSet.add(m.away_team); }
  const teamIds = [...teamSet];

  // Load current state
  const { data: stateRows, error: stateErr } = await sb
    .from("team_oracle_v3_state")
    .select("team_id, b_value, r_network, r_market_frozen, m1_locked")
    .in("team_id", teamIds);

  if (stateErr || !stateRows || stateRows.length === 0) {
    return { league, updated: false, skipped_reason: "state_query_error", teams_refreshed: 0, teams_with_r_next: 0 };
  }

  // Build R_network map + identify frozen teams
  const rNetworkMap = new Map<string, number>();
  const bMap = new Map<string, number>();
  const frozenTeams = new Set<string>();

  for (const row of stateRows) {
    rNetworkMap.set(row.team_id, row.r_network != null ? Number(row.r_network) : Number(row.b_value));
    bMap.set(row.team_id, Number(row.b_value));
    if (row.m1_locked != null || row.r_market_frozen != null) frozenTeams.add(row.team_id);
  }

  const activeTeamIds = teamIds.filter(t => !frozenTeams.has(t) && rNetworkMap.has(t));
  const nextFixtureMap = await loadNextFixturesForLeague(sb, league, activeTeamIds);

  let teamsRefreshed = 0;
  let teamsWithRNext = 0;
  const priceHistoryRows: Record<string, unknown>[] = [];

  for (const teamId of activeTeamIds) {
    const R_network = rNetworkMap.get(teamId)!;
    const B = bMap.get(teamId)!;

    const R_next = computeRNext(teamId, R_network, rNetworkMap, nextFixtureMap.get(teamId) ?? null);
    if (Math.abs(R_next - R_network) > 0.01) teamsWithRNext++;

    const R_market = (1 - ORACLE_V3_W_NEXT) * R_network + ORACLE_V3_W_NEXT * R_next;
    const M1_raw = ORACLE_V3_ALPHA * (R_market - B);
    const M1 = Math.max(-ORACLE_V3_M1_CLAMP, Math.min(ORACLE_V3_M1_CLAMP, M1_raw));
    const published_index = B + M1;

    const { error: updateErr } = await sb
      .from("team_oracle_v3_state")
      .update({
        r_next: Number(R_next.toFixed(4)),
        r_market: Number(R_market.toFixed(4)),
        m1_value: Number(M1.toFixed(4)),
        published_index: Number(published_index.toFixed(4)),
        next_fixture_id: nextFixtureMap.get(teamId)?.fixture_id ?? null,
        last_market_refresh_ts: nowIso,
        updated_at: nowIso,
      })
      .eq("team_id", teamId);

    if (updateErr) { log.error(`V3 R_next: update failed for ${teamId}: ${updateErr.message}`); continue; }

    priceHistoryRows.push({
      team: teamId, league, timestamp: nowIso,
      b_value: Number(B.toFixed(4)), m1_value: Number(M1.toFixed(4)),
      l_value: 0,
      published_index: Number(published_index.toFixed(4)),
      confidence_score: null, source_fixture_id: null,
      publish_reason: "market_refresh_v3",
    });
    teamsRefreshed++;
  }

  if (priceHistoryRows.length > 0) {
    const { error: phErr } = await sb.from("oracle_price_history").insert(priceHistoryRows);
    if (phErr) log.warn(`V3 R_next: price history insert failed for ${league}: ${phErr.message}`);
  }

  return { league, updated: true, teams_refreshed: teamsRefreshed, teams_with_r_next: teamsWithRNext };
}

// ─── R_next Computation ─────────────────────────────────────

/**
 * R_next = R_network_opponent + 400 × log10(ES_team / (1 − ES_team))
 * adjusted for home advantage (strip venue effect → neutral strength)
 *
 * If no next fixture or no odds: R_next = R_network (silent fallback).
 */
function computeRNext(
  teamId: string, teamRNetwork: number,
  rNetworkMap: Map<string, number>,
  nextFixture: NextFixtureInfo | null,
): number {
  if (!nextFixture) return teamRNetwork;
  const opponentRNetwork = rNetworkMap.get(nextFixture.opponentId);
  if (opponentRNetwork == null) return teamRNetwork;

  const es = Math.max(0.01, Math.min(0.99, nextFixture.teamES));
  const rawImplied = opponentRNetwork + 400 * Math.log10(es / (1 - es));
  // Strip home advantage to get neutral team strength
  return nextFixture.isHome ? rawImplied - ORACLE_V3_BT_HOME_ADV : rawImplied + ORACLE_V3_BT_HOME_ADV;
}

// ─── Helpers ────────────────────────────────────────────────

/** Load next upcoming fixture for each team in the league. */
async function loadNextFixturesForLeague(
  sb: ReturnType<typeof getSupabase>,
  league: string, teamIds: string[],
): Promise<Map<string, NextFixtureInfo>> {
  const result = new Map<string, NextFixtureInfo>();
  const today = new Date().toISOString().slice(0, 10);

  const { data: upcoming } = await sb
    .from("matches")
    .select("fixture_id, date, home_team, away_team, commence_time")
    .eq("league", league)
    .in("status", ["scheduled", "not_started", "tbd"])
    .gte("date", today)
    .order("date", { ascending: true })
    .limit(100);

  if (!upcoming || upcoming.length === 0) return result;

  // First upcoming fixture per team
  const teamNextFixture = new Map<string, typeof upcoming[0]>();
  for (const fix of upcoming) {
    if (!teamNextFixture.has(fix.home_team)) teamNextFixture.set(fix.home_team, fix);
    if (!teamNextFixture.has(fix.away_team)) teamNextFixture.set(fix.away_team, fix);
  }

  // Batch-load odds for needed fixtures (avoids N+1 queries)
  const fixtureIdsNeeded = new Set<number>();
  for (const teamId of teamIds) {
    const fix = teamNextFixture.get(teamId);
    if (fix) fixtureIdsNeeded.add(fix.fixture_id);
  }

  const neededFids = [...fixtureIdsNeeded];
  const oddsBatch = await batchLoadOdds(sb, neededFids);

  const fixtureOddsCache = new Map<number, FixtureES>();
  for (const fid of neededFids) {
    const odds = oddsBatch.get(fid);
    let es = (odds && odds.length > 0) ? processOddsToES(odds) : null;
    if (!es) {
      // Individual fallback for fixture ID mismatch
      const actualFix = upcoming.find(f => f.fixture_id === fid);
      if (actualFix) {
        const fix: WindowFixture = { fixture_id: fid, date: actualFix.date, home_team: actualFix.home_team, away_team: actualFix.away_team, commence_time: actualFix.commence_time, status: "scheduled", league };
        es = await loadFixtureES_fallback(sb, fix);
      }
    }
    if (es) fixtureOddsCache.set(fid, es);
  }

  // Build result
  for (const teamId of teamIds) {
    const fix = teamNextFixture.get(teamId);
    if (!fix) continue;
    const es = fixtureOddsCache.get(fix.fixture_id);
    if (!es) continue;

    const isHome = fix.home_team === teamId;
    const teamES = isHome ? es.homeES : (1 - es.homeES);

    result.set(teamId, {
      fixture_id: fix.fixture_id,
      home_team: fix.home_team, away_team: fix.away_team,
      isHome, teamES,
      opponentId: isHome ? fix.away_team : fix.home_team,
    });
  }

  return result;
}

/**
 * Process raw odds snapshots into a home expected score.
 * Filters invalid/stale odds, de-vigs, median consensus, renormalize.
 * Returns null if < 2 valid bookmakers or NaN result.
 */
function processOddsToES(allSnapshots: OddsSnapshotRow[]): FixtureES | null {
  // Latest per bookmaker
  const latestByBook = new Map<string, OddsSnapshotRow>();
  for (const snap of allSnapshots) {
    if (latestByBook.has(snap.bookmaker)) continue;
    if (snap.home_odds == null || snap.draw_odds == null || snap.away_odds == null) continue;
    if (snap.home_odds < 1.01 || snap.draw_odds < 1.01 || snap.away_odds < 1.01) continue;
    latestByBook.set(snap.bookmaker, snap);
  }

  // De-vig + median consensus
  const bookmakerProbs: { homeProb: number; drawProb: number; awayProb: number; snapshotMs: number }[] = [];
  for (const [, snap] of latestByBook) {
    const probs = powerDevigOdds(snap.home_odds!, snap.draw_odds!, snap.away_odds!);
    if (probs.homeProb <= 0 || probs.drawProb <= 0 || probs.awayProb <= 0) continue;
    if (probs.homeProb >= 1 || probs.drawProb >= 1 || probs.awayProb >= 1) continue;
    bookmakerProbs.push({
      homeProb: probs.homeProb, drawProb: probs.drawProb, awayProb: probs.awayProb,
      snapshotMs: new Date(snap.snapshot_time).getTime(),
    });
  }

  if (bookmakerProbs.length < 2) return null;

  const rawHome = median(bookmakerProbs.map(b => b.homeProb));
  const rawDraw = median(bookmakerProbs.map(b => b.drawProb));
  const rawAway = median(bookmakerProbs.map(b => b.awayProb));
  const probTotal = rawHome + rawDraw + rawAway;
  if (probTotal === 0 || isNaN(probTotal)) return null;
  const consensusHome = rawHome / probTotal;
  const consensusDraw = rawDraw / probTotal;

  const homeES = consensusHome + 0.5 * consensusDraw;
  // NaN guard (RISK-7): reject if computation produced invalid result
  if (isNaN(homeES)) return null;
  const latestSnapshotMs = Math.max(...bookmakerProbs.map(b => b.snapshotMs));

  return { homeES: Math.max(0.01, Math.min(0.99, homeES)), latestSnapshotMs };
}

/**
 * Batch-load odds from latest_preko_odds for multiple fixture IDs.
 * Returns Map of fixture_id → OddsSnapshotRow[].
 */
async function batchLoadOdds(
  sb: ReturnType<typeof getSupabase>,
  fixtureIds: number[],
): Promise<Map<number, OddsSnapshotRow[]>> {
  const result = new Map<number, OddsSnapshotRow[]>();
  if (fixtureIds.length === 0) return result;

  const { data, error } = await sb
    .from("latest_preko_odds")
    .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
    .in("fixture_id", fixtureIds);

  if (error) {
    log.error(`batchLoadOdds: query failed: ${error.message}`);
    return result;
  }

  for (const row of (data ?? []) as OddsSnapshotRow[]) {
    const arr = result.get(row.fixture_id) ?? [];
    arr.push(row);
    result.set(row.fixture_id, arr);
  }

  return result;
}

/**
 * Batch-load frozen KR snapshots for multiple fixture IDs.
 * Returns Map of fixture_id → FixtureES.
 */
async function batchLoadKR(
  sb: ReturnType<typeof getSupabase>,
  fixtureIds: number[],
): Promise<Map<number, FixtureES>> {
  const result = new Map<number, FixtureES>();
  if (fixtureIds.length === 0) return result;

  const { data, error } = await sb
    .from("oracle_kr_snapshots")
    .select("fixture_id, home_expected_score, freeze_timestamp")
    .in("fixture_id", fixtureIds);

  if (error) {
    log.error(`batchLoadKR: query failed: ${error.message}`);
    return result;
  }

  for (const kr of (data ?? []) as { fixture_id: number; home_expected_score: number; freeze_timestamp: string }[]) {
    result.set(kr.fixture_id, {
      homeES: Number(kr.home_expected_score),
      latestSnapshotMs: new Date(kr.freeze_timestamp).getTime(),
    });
  }

  return result;
}

/**
 * Load odds for a single fixture with alt-fixture fallback.
 * Used as fallback when batch loading finds no odds for a fixture.
 */
async function loadFixtureES_fallback(
  sb: ReturnType<typeof getSupabase>,
  fixture: WindowFixture,
): Promise<FixtureES | null> {
  if (!fixture.home_team || !fixture.away_team) return null;

  const dayBefore = new Date(new Date(fixture.date).getTime() - 3 * 86400000).toISOString().slice(0, 10);
  const dayAfter = new Date(new Date(fixture.date).getTime() + 3 * 86400000).toISOString().slice(0, 10);

  const { data: altFixtures } = await sb
    .from("matches")
    .select("fixture_id, home_team, away_team")
    .eq("home_team", fixture.home_team)
    .eq("away_team", fixture.away_team)
    .gte("date", dayBefore)
    .lte("date", dayAfter)
    .neq("fixture_id", fixture.fixture_id);

  if (altFixtures) {
    for (const alt of altFixtures) {
      const { data: altPreko } = await sb
        .from("latest_preko_odds")
        .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
        .eq("fixture_id", alt.fixture_id as number);
      if (altPreko && altPreko.length > 0) {
        return processOddsToES(altPreko as OddsSnapshotRow[]);
      }
    }
  }

  return null;
}

/**
 * Load odds for a fixture, de-vig, compute home ES.
 * Past: tries oracle_kr_snapshots (frozen) first, then latest_preko_odds.
 * Upcoming: uses latest_preko_odds (live).
 * Returns null if < 2 bookmakers.
 *
 * NOTE: For batch contexts (solveBTForLeague), prefer batchLoadKR + batchLoadOdds
 * + processOddsToES + loadFixtureES_fallback to avoid N+1 queries.
 */
async function loadFixtureES(
  sb: ReturnType<typeof getSupabase>,
  fixture: WindowFixture, mode: "past" | "upcoming"
): Promise<FixtureES | null> {
  // Past fixtures: try frozen KR first
  if (mode === "past") {
    const { data: krData } = await sb
      .from("oracle_kr_snapshots")
      .select("home_expected_score, away_expected_score, freeze_timestamp")
      .eq("fixture_id", fixture.fixture_id)
      .maybeSingle();

    if (krData) {
      return {
        homeES: Number(krData.home_expected_score),
        latestSnapshotMs: new Date(krData.freeze_timestamp).getTime(),
      };
    }
  }

  // Fall through to latest_preko_odds
  let { data: prekoData } = await sb
    .from("latest_preko_odds")
    .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
    .eq("fixture_id", fixture.fixture_id);

  let allSnapshots = (prekoData ?? []) as OddsSnapshotRow[];

  // Fallback: fixture ID mismatch (±3 day window, same teams)
  if (allSnapshots.length === 0 && fixture.home_team && fixture.away_team) {
    return loadFixtureES_fallback(sb, fixture);
  }

  return processOddsToES(allSnapshots);
}

/** Zero M1 for all teams in a league when insufficient fixtures. */
async function zeroMarketForLeague(
  sb: ReturnType<typeof getSupabase>, league: string
): Promise<void> {
  const { data: leagueMatches } = await sb
    .from("matches").select("home_team, away_team")
    .eq("league", league).order("date", { ascending: false }).limit(100);
  if (!leagueMatches) return;

  const leagueTeamSet = new Set<string>();
  for (const m of leagueMatches) { leagueTeamSet.add(m.home_team); leagueTeamSet.add(m.away_team); }

  const { data: teams } = await sb
    .from("team_oracle_v3_state").select("team_id, b_value")
    .in("team_id", [...leagueTeamSet]);
  if (!teams || teams.length === 0) return;

  const nowIso = new Date().toISOString();
  for (const row of teams) {
    const B = Number(row.b_value);
    await sb.from("team_oracle_v3_state").update({
      m1_value: 0, r_market: B, r_next: B,
      published_index: Number(B.toFixed(4)),
      confidence_score: 0, bt_std_error: null,
      last_market_refresh_ts: nowIso, updated_at: nowIso,
    }).eq("team_id", row.team_id);
  }
}

function mkBTResult(
  league: string, updated: boolean, skipped_reason?: string,
  fixtures_used = 0, past_fixtures = 0, upcoming_fixtures = 0,
  teams_count = 0, window_days = 0, sigma_used = 0,
): LeagueBTResult {
  return {
    league, updated, skipped_reason, fixtures_used, past_fixtures,
    upcoming_fixtures, teams_count, window_days, sigma_used, teams_updated: 0,
  };
}
