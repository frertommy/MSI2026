/**
 * oracle-v2-market.ts — M1 market layer for Oracle V2.
 *
 * Identical logic to V1 market (oracle-v1-market.ts) but reads/writes
 * team_oracle_v2_state instead of team_oracle_state.
 *
 * M1 = c(t) × (R_market_fixture − B_value)
 * Price history tagged with publish_reason: "market_refresh_v2"
 */

import { getSupabase } from "../api/supabase-client.js";
import { powerDevigOdds, median, oddsImpliedStrength } from "./odds-blend.js";
import { computeRFutures } from "./oracle-v1-futures.js";
import { ORACLE_V1_OFFSEASON_ENABLED } from "../config.js";
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

interface RefreshM1V2Result {
  updated: boolean;
  skipped_reason?: string;
  M1_value?: number;
  confidence?: number;
  published_index?: number;
  next_fixture_id?: number | null;
}

// ─── Constants ──────────────────────────────────────────────

const HOME_ADVANTAGE_ELO = 65;
const MAX_M1_ABS = 120;

// ─── Main function ──────────────────────────────────────────

/**
 * Refresh the M1 (market overlay) layer for a single team in V2.
 * Same logic as V1 but reads/writes team_oracle_v2_state.
 */
export async function refreshM1V2(team: string): Promise<RefreshM1V2Result> {
  const sb = getSupabase();

  // ── Step 1: Guard — no live match ────────────────────────
  const { data: liveMatches, error: liveErr } = await sb
    .from("matches")
    .select("fixture_id, status")
    .or(`home_team.eq.${team},away_team.eq.${team}`)
    .eq("status", "live");

  if (liveErr) {
    log.error(`V2 M1 refresh: live match query failed for ${team}: ${liveErr.message}`);
    return { updated: false, skipped_reason: "live_query_error" };
  }

  if (liveMatches && liveMatches.length > 0) {
    log.debug(`V2 M1 refresh skipped — match live for ${team}`);
    return { updated: false, skipped_reason: "match_live" };
  }

  // ── Step 2: Find next competitive fixture ────────────────
  const today = new Date().toISOString().slice(0, 10);

  const { data: nextFixtures, error: nextErr } = await sb
    .from("matches")
    .select("fixture_id, date, home_team, away_team, commence_time, league")
    .or(`home_team.eq.${team},away_team.eq.${team}`)
    .eq("status", "upcoming")
    .gte("date", today)
    .order("date", { ascending: true })
    .order("commence_time", { ascending: true, nullsFirst: true })
    .limit(1);

  if (nextErr) {
    log.error(`V2 M1 refresh: next fixture query failed for ${team}: ${nextErr.message}`);
    return { updated: false, skipped_reason: "next_fixture_query_error" };
  }

  // Load the team's current V2 b_value
  const { data: teamState } = await sb
    .from("team_oracle_v2_state")
    .select("b_value")
    .eq("team_id", team)
    .single();

  const B_value = teamState ? Number(teamState.b_value) : 0;

  // No upcoming fixture → try futures-based offseason regime, else M1 = 0
  if (!nextFixtures || nextFixtures.length === 0) {
    if (ORACLE_V1_OFFSEASON_ENABLED) {
      const teamLeague = await getTeamLeague(sb, team);
      const futures = await computeRFutures(team, teamLeague);

      if (futures && !futures.stale && futures.confidence > 0) {
        const M_raw = futures.R_futures - B_value;
        const M_unclamped = futures.confidence * M_raw;
        const M = Math.max(-MAX_M1_ABS, Math.min(MAX_M1_ABS, M_unclamped));
        const published_index = B_value + M;

        await writeM1V2State(sb, team, {
          m1_value: M,
          published_index,
          confidence_score: futures.confidence,
          next_fixture_id: null,
        });

        await writePriceHistoryV2(sb, team, {
          b_value: B_value,
          m1_value: M,
          published_index,
          confidence_score: futures.confidence,
          source_fixture_id: null,
          publish_reason: "market_refresh_v2",
        });

        log.debug(
          `V2 M1 refresh (offseason): ${team} — R_futures=${futures.R_futures.toFixed(1)} ` +
          `B=${B_value.toFixed(1)} M=${M.toFixed(2)} c=${futures.confidence.toFixed(3)}`
        );

        return {
          updated: true,
          M1_value: M,
          confidence: futures.confidence,
          published_index,
          next_fixture_id: null,
        };
      }
    }

    // Fallback: no fixtures AND no futures → M = 0
    await writeM1V2State(sb, team, {
      m1_value: 0,
      published_index: B_value,
      confidence_score: 0,
      next_fixture_id: null,
    });

    await writePriceHistoryV2(sb, team, {
      b_value: B_value,
      m1_value: 0,
      published_index: B_value,
      confidence_score: 0,
      source_fixture_id: null,
      publish_reason: "market_refresh_v2",
    });

    log.debug(`V2 M1 refresh: ${team} — no upcoming fixture, no futures, M1=0`);
    return {
      updated: true,
      M1_value: 0,
      confidence: 0,
      published_index: B_value,
      next_fixture_id: null,
    };
  }

  const nextFixture = nextFixtures[0] as {
    fixture_id: number;
    date: string;
    home_team: string;
    away_team: string;
    commence_time: string | null;
    league: string;
  };

  const isHome = nextFixture.home_team === team;
  const opponent = isHome ? nextFixture.away_team : nextFixture.home_team;
  const kickoffTs = nextFixture.commence_time ?? `${nextFixture.date}T23:59:59Z`;

  // ── Step 3: Load prematch odds consensus ─────────────────
  const { data: prekoData, error: prekoErr } = await sb
    .from("latest_preko_odds")
    .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
    .eq("fixture_id", nextFixture.fixture_id);

  if (prekoErr) {
    log.error(`V2 M1 refresh: latest_preko_odds query failed for fixture ${nextFixture.fixture_id}: ${prekoErr.message}`);
    return { updated: false, skipped_reason: "odds_query_error" };
  }

  let allSnapshots = (prekoData ?? []) as OddsSnapshotRow[];

  // Fallback: fixture ID mismatch (same as V1)
  if (allSnapshots.length === 0) {
    const matchDate = nextFixture.date;
    const dayBefore = new Date(new Date(matchDate).getTime() - 3 * 86400000).toISOString().slice(0, 10);
    const dayAfter = new Date(new Date(matchDate).getTime() + 3 * 86400000).toISOString().slice(0, 10);

    const { data: altFixtures } = await sb
      .from("matches")
      .select("fixture_id, home_team, away_team")
      .eq("home_team", nextFixture.home_team)
      .eq("away_team", nextFixture.away_team)
      .gte("date", dayBefore)
      .lte("date", dayAfter)
      .neq("fixture_id", nextFixture.fixture_id);

    if (altFixtures && altFixtures.length > 0) {
      for (const alt of altFixtures) {
        const altId = alt.fixture_id as number;
        const { data: altPreko } = await sb
          .from("latest_preko_odds")
          .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
          .eq("fixture_id", altId);

        if (altPreko && altPreko.length > 0) {
          allSnapshots = altPreko as OddsSnapshotRow[];
          log.info(`V2 M1 fixture fallback: ${team} — using alt ${altId} (${allSnapshots.length} bookmakers)`);
          break;
        }
      }
    }
  }

  // Latest valid snapshot per bookmaker
  const latestByBook = new Map<string, OddsSnapshotRow>();
  for (const snap of allSnapshots) {
    if (latestByBook.has(snap.bookmaker)) continue;
    if (snap.home_odds == null || snap.draw_odds == null || snap.away_odds == null) continue;
    if (snap.home_odds < 1.01 || snap.draw_odds < 1.01 || snap.away_odds < 1.01) continue;
    latestByBook.set(snap.bookmaker, snap);
  }

  // De-vig each bookmaker
  const bookmakerProbs: {
    bookmaker: string;
    homeProb: number;
    drawProb: number;
    awayProb: number;
    snapshot_time: string;
  }[] = [];

  for (const [bookmaker, snap] of latestByBook) {
    const probs = powerDevigOdds(snap.home_odds!, snap.draw_odds!, snap.away_odds!);
    if (probs.homeProb <= 0 || probs.drawProb <= 0 || probs.awayProb <= 0) continue;
    if (probs.homeProb >= 1 || probs.drawProb >= 1 || probs.awayProb >= 1) continue;

    bookmakerProbs.push({
      bookmaker,
      homeProb: probs.homeProb,
      drawProb: probs.drawProb,
      awayProb: probs.awayProb,
      snapshot_time: snap.snapshot_time,
    });
  }

  // ── Step 4: Compute confidence scalar c(t) ───────────────
  const bookmakerCount = bookmakerProbs.length;

  if (bookmakerCount < 2) {
    await writeM1V2State(sb, team, {
      m1_value: 0,
      published_index: B_value,
      confidence_score: 0,
      next_fixture_id: nextFixture.fixture_id,
    });

    await writePriceHistoryV2(sb, team, {
      b_value: B_value,
      m1_value: 0,
      published_index: B_value,
      confidence_score: 0,
      source_fixture_id: nextFixture.fixture_id,
      publish_reason: "market_refresh_v2",
    });

    log.debug(`V2 M1 refresh: ${team} — only ${bookmakerCount} bookmaker(s), M1=0`);
    return {
      updated: true,
      M1_value: 0,
      confidence: 0,
      published_index: B_value,
      next_fixture_id: nextFixture.fixture_id,
    };
  }

  const c_books = Math.min(bookmakerCount / 5, 1);

  const teamWinProbs = bookmakerProbs.map(b => isHome ? b.homeProb : b.awayProb);
  const spread = Math.max(...teamWinProbs) - Math.min(...teamWinProbs);
  const c_dispersion = 1 - Math.min(spread / 0.08, 1);

  const latestSnapshotTime = bookmakerProbs
    .map(b => new Date(b.snapshot_time).getTime())
    .reduce((a, b) => Math.max(a, b), 0);
  const hoursSinceLatest = (Date.now() - latestSnapshotTime) / (1000 * 3600);
  const c_recency = 1 - Math.min(hoursSinceLatest / 48, 1);

  const confidence = c_books * c_dispersion * c_recency;

  // ── Step 5: Compute R_market_fixture ─────────────────────
  const rawHome = median(bookmakerProbs.map(b => b.homeProb));
  const rawDraw = median(bookmakerProbs.map(b => b.drawProb));
  const rawAway = median(bookmakerProbs.map(b => b.awayProb));
  const probTotal = rawHome + rawDraw + rawAway;
  const consensusHomeProb = rawHome / probTotal;
  const consensusDrawProb = rawDraw / probTotal;
  const consensusAwayProb = rawAway / probTotal;

  const teamExpectedScore = isHome
    ? consensusHomeProb + 0.5 * consensusDrawProb
    : consensusAwayProb + 0.5 * consensusDrawProb;

  // Opponent's current V2 b_value
  const { data: opponentState } = await sb
    .from("team_oracle_v2_state")
    .select("b_value")
    .eq("team_id", opponent)
    .single();

  const opponentB = opponentState ? Number(opponentState.b_value) : 0;

  const R_market_fixture = oddsImpliedStrength(
    teamExpectedScore,
    opponentB,
    isHome,
    HOME_ADVANTAGE_ELO
  );

  // ── Step 6: Compute M1 ──────────────────────────────────
  const M1_raw = R_market_fixture - B_value;

  const HORIZON_DAYS = 21;
  const kickoffMs = new Date(kickoffTs).getTime();
  let c_horizon = 1.0;

  if (isNaN(kickoffMs)) {
    c_horizon = 0;
  } else {
    const daysToKickoff = Math.max(0, (kickoffMs - Date.now()) / (24 * 3600 * 1000));
    c_horizon = Math.max(0, Math.min(1, 1 - daysToKickoff / HORIZON_DAYS));
  }

  const eff_conf = confidence * c_horizon;

  const M1_unclamped = eff_conf * M1_raw;
  const M1 = Math.max(-MAX_M1_ABS, Math.min(MAX_M1_ABS, M1_unclamped));
  const published_index = B_value + M1;

  if (Math.abs(M1 - M1_unclamped) > 0.01) {
    log.warn(
      `V2 M1 CLAMPED: ${team} raw=${M1_unclamped.toFixed(2)} clamped=${M1.toFixed(2)}`
    );
  }

  // ── Step 7: Write outputs ────────────────────────────────
  await writeM1V2State(sb, team, {
    m1_value: M1,
    published_index,
    confidence_score: eff_conf,
    next_fixture_id: nextFixture.fixture_id,
  });

  await writePriceHistoryV2(sb, team, {
    b_value: B_value,
    m1_value: M1,
    published_index,
    confidence_score: eff_conf,
    source_fixture_id: nextFixture.fixture_id,
    publish_reason: "market_refresh_v2",
  });

  log.debug(
    `V2 M1 refresh: ${team} — ` +
    `R_mkt=${R_market_fixture.toFixed(1)} B=${B_value.toFixed(1)} ` +
    `M1=${M1.toFixed(2)} c=${eff_conf.toFixed(3)} ` +
    `[${bookmakerCount} books, vs ${opponent} (${isHome ? "H" : "A"})]`
  );

  return {
    updated: true,
    M1_value: M1,
    confidence: eff_conf,
    published_index,
    next_fixture_id: nextFixture.fixture_id,
  };
}

// ─── League lookup ──────────────────────────────────────────

const leagueCache = new Map<string, string>();

async function getTeamLeague(
  sb: ReturnType<typeof getSupabase>,
  team: string
): Promise<string> {
  const cached = leagueCache.get(team);
  if (cached) return cached;

  const { data } = await sb
    .from("matches")
    .select("league")
    .or(`home_team.eq.${team},away_team.eq.${team}`)
    .order("date", { ascending: false })
    .limit(1)
    .single();

  const league = data?.league ?? "Unknown";
  leagueCache.set(team, league);
  return league;
}

// ─── Price history writer ────────────────────────────────────

async function writePriceHistoryV2(
  sb: ReturnType<typeof getSupabase>,
  team: string,
  data: {
    b_value: number;
    m1_value: number;
    published_index: number;
    confidence_score: number;
    source_fixture_id: number | null;
    publish_reason: string;
  }
): Promise<void> {
  const { error } = await sb
    .from("oracle_price_history")
    .insert([{
      team,
      league: await getTeamLeague(sb, team),
      timestamp: new Date().toISOString(),
      b_value: Number(data.b_value.toFixed(4)),
      m1_value: Number(data.m1_value.toFixed(4)),
      published_index: Number(data.published_index.toFixed(4)),
      confidence_score: Number(data.confidence_score.toFixed(4)),
      source_fixture_id: data.source_fixture_id,
      publish_reason: data.publish_reason,
    }]);

  if (error) {
    log.warn(`V2 M1 price history insert failed for ${team}: ${error.message}`);
  }
}

// ─── State writer ───────────────────────────────────────────

async function writeM1V2State(
  sb: ReturnType<typeof getSupabase>,
  team: string,
  data: {
    m1_value: number;
    published_index: number;
    confidence_score: number;
    next_fixture_id: number | null;
  }
): Promise<void> {
  const now = new Date().toISOString();

  const { error } = await sb
    .from("team_oracle_v2_state")
    .update({
      m1_value: Number(data.m1_value.toFixed(4)),
      published_index: Number(data.published_index.toFixed(4)),
      confidence_score: Number(data.confidence_score.toFixed(4)),
      next_fixture_id: data.next_fixture_id,
      last_market_refresh_ts: now,
      updated_at: now,
    })
    .eq("team_id", team);

  if (error) {
    // Row might not exist yet — try upsert
    if (error.code === "PGRST116" || error.message.includes("0 rows")) {
      const { error: upsertErr } = await sb
        .from("team_oracle_v2_state")
        .upsert([{
          team_id: team,
          m1_value: Number(data.m1_value.toFixed(4)),
          published_index: Number(data.published_index.toFixed(4)),
          confidence_score: Number(data.confidence_score.toFixed(4)),
          next_fixture_id: data.next_fixture_id,
          last_market_refresh_ts: now,
          updated_at: now,
        }], { onConflict: "team_id" });

      if (upsertErr) {
        log.error(`V2 M1 state upsert failed for ${team}: ${upsertErr.message}`);
      }
    } else {
      log.error(`V2 M1 state update failed for ${team}: ${error.message}`);
    }
  }
}
