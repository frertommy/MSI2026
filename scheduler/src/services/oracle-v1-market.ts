/**
 * oracle-v1-market.ts — M1 market layer for the V1 Oracle.
 *
 * Exports one function: refreshM1(team)
 *
 * M1 = c(t) × (R_market_fixture − B_value)
 *
 * Where:
 *   R_market_fixture = Elo-implied strength from next-fixture prematch odds
 *   B_value          = team's permanent earned base (from settlement engine)
 *   c(t)             = confidence scalar ∈ [0, 1] = c_books × c_dispersion × c_recency × c_horizon
 *
 * Constraints:
 *   - No imports from pricing-engine.ts or oracle-v1-settlement.ts
 *   - No carry decay, no xG
 *   - If ORACLE_V1_OFFSEASON_ENABLED and no fixture: uses outright futures for M
 *   - If team is mid-match, skip entirely — no writes
 *   - published_index is always B_value + M1_value
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

interface TeamOracleState {
  team_id: string;
  b_value: number;
  m1_value: number;
  published_index: number;
  confidence_score: number | null;
  next_fixture_id: number | null;
  last_market_refresh_ts: string | null;
}

interface RefreshM1Result {
  updated: boolean;
  skipped_reason?: string;
  M1_value?: number;
  confidence?: number;
  published_index?: number;
  next_fixture_id?: number | null;
}

// ─── Constants ──────────────────────────────────────────────

/** Home advantage in Elo points — used to strip venue bias from odds-implied strength */
const HOME_ADVANTAGE_ELO = 65;

/** Maximum absolute M1 overlay in Elo points — prevents market layer from overwhelming B */
const MAX_M1_ABS = 120;

// ─── Main function ──────────────────────────────────────────

/**
 * Refresh the M1 (market overlay) layer for a single team.
 *
 * Writes M1_value, published_index, confidence_score, next_fixture_id,
 * and last_market_refresh_ts to team_oracle_state.
 * Never touches B_value or last_kr_fixture_id.
 *
 * @returns RefreshM1Result indicating what happened
 */
export async function refreshM1(team: string): Promise<RefreshM1Result> {
  const sb = getSupabase();

  // ── Step 1: Guard — no live match ────────────────────────
  const { data: liveMatches, error: liveErr } = await sb
    .from("matches")
    .select("fixture_id, status")
    .or(`home_team.eq.${team},away_team.eq.${team}`)
    .eq("status", "live");

  if (liveErr) {
    log.error(`M1 refresh: live match query failed for ${team}: ${liveErr.message}`);
    return { updated: false, skipped_reason: "live_query_error" };
  }

  if (liveMatches && liveMatches.length > 0) {
    log.debug(`M1 refresh skipped — match live for ${team}`);
    return { updated: false, skipped_reason: "match_live" };
  }

  // ── Step 2: Find next competitive fixture ────────────────
  const now = new Date().toISOString();

  const { data: nextFixtures, error: nextErr } = await sb
    .from("matches")
    .select("fixture_id, date, home_team, away_team, commence_time")
    .or(`home_team.eq.${team},away_team.eq.${team}`)
    .eq("status", "upcoming")
    .order("commence_time", { ascending: true })
    .limit(1);

  if (nextErr) {
    log.error(`M1 refresh: next fixture query failed for ${team}: ${nextErr.message}`);
    return { updated: false, skipped_reason: "next_fixture_query_error" };
  }

  // Load the team's current b_value (needed for all paths)
  const { data: teamState } = await sb
    .from("team_oracle_state")
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

        await writeM1State(sb, team, {
          m1_value: M,
          published_index,
          confidence_score: futures.confidence,
          next_fixture_id: null,
        });

        log.debug(
          `M1 refresh (offseason): ${team} — R_futures=${futures.R_futures.toFixed(1)} ` +
          `P_title=${futures.P_title.toFixed(4)} B=${B_value.toFixed(1)} ` +
          `M=${M.toFixed(2)} c=${futures.confidence.toFixed(3)} [${futures.bookmaker_count} books]`
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

    // Fallback: no fixtures AND no futures (or offseason disabled) → M = 0
    await writeM1State(sb, team, {
      m1_value: 0,
      published_index: B_value,
      confidence_score: 0,
      next_fixture_id: null,
    });

    log.debug(`M1 refresh: ${team} — no upcoming fixture, no futures, M1=0`);
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
  };

  const isHome = nextFixture.home_team === team;
  const opponent = isHome ? nextFixture.away_team : nextFixture.home_team;
  const kickoffTs = nextFixture.commence_time ?? `${nextFixture.date}T23:59:59Z`;

  // ── Step 3: Load prematch odds consensus ─────────────────
  const { data: oddsData, error: oddsErr } = await sb
    .from("odds_snapshots")
    .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
    .eq("fixture_id", nextFixture.fixture_id)
    .lt("snapshot_time", kickoffTs)
    .order("snapshot_time", { ascending: false });

  if (oddsErr) {
    log.error(`M1 refresh: odds query failed for fixture ${nextFixture.fixture_id}: ${oddsErr.message}`);
    return { updated: false, skipped_reason: "odds_query_error" };
  }

  let allSnapshots = (oddsData ?? []) as OddsSnapshotRow[];

  // ── Fallback: fixture ID mismatch between API-Football and Odds API ──
  // API-Football and The Odds API assign different fixture IDs for the same match
  // (especially non-EPL leagues). If no odds under the primary ID, search by team+date.
  if (allSnapshots.length === 0) {
    const matchDate = nextFixture.date; // YYYY-MM-DD
    const dayBefore = new Date(new Date(matchDate).getTime() - 86400000).toISOString().slice(0, 10);
    const dayAfter = new Date(new Date(matchDate).getTime() + 86400000).toISOString().slice(0, 10);

    const { data: altFixtures } = await sb
      .from("matches")
      .select("fixture_id")
      .eq("home_team", nextFixture.home_team)
      .eq("away_team", nextFixture.away_team)
      .gte("date", dayBefore)
      .lte("date", dayAfter)
      .neq("fixture_id", nextFixture.fixture_id);

    if (altFixtures && altFixtures.length > 0) {
      const altId = altFixtures[0].fixture_id as number;

      const { data: altOdds } = await sb
        .from("odds_snapshots")
        .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
        .eq("fixture_id", altId)
        .lt("snapshot_time", kickoffTs)
        .order("snapshot_time", { ascending: false });

      if (altOdds && altOdds.length > 0) {
        allSnapshots = altOdds as OddsSnapshotRow[];
        log.info(
          `M1 fixture fallback: ${team} — primary ${nextFixture.fixture_id} had 0 odds, ` +
          `using alt ${altId} (${allSnapshots.length} snapshots)`
        );
      }
    }
  }

  // Latest valid snapshot per bookmaker
  const latestByBook = new Map<string, OddsSnapshotRow>();
  for (const snap of allSnapshots) {
    if (latestByBook.has(snap.bookmaker)) continue; // already have a newer one
    if (snap.home_odds == null || snap.draw_odds == null || snap.away_odds == null) continue;
    if (snap.home_odds < 1.01 || snap.draw_odds < 1.01 || snap.away_odds < 1.01) continue;
    latestByBook.set(snap.bookmaker, snap);
  }

  // De-vig each bookmaker (power de-vig)
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

  // Insufficient books → c(t) = 0, M1 = 0
  if (bookmakerCount < 2) {
    await writeM1State(sb, team, {
      m1_value: 0,
      published_index: B_value,
      confidence_score: 0,
      next_fixture_id: nextFixture.fixture_id,
    });

    log.debug(`M1 refresh: ${team} — only ${bookmakerCount} bookmaker(s), M1=0`);
    return {
      updated: true,
      M1_value: 0,
      confidence: 0,
      published_index: B_value,
      next_fixture_id: nextFixture.fixture_id,
    };
  }

  // c_books: full confidence at 5+ books
  const c_books = Math.min(bookmakerCount / 5, 1);

  // c_dispersion: spread = max implied win prob - min implied win prob across bookmakers
  // Use the team's win prob (home or away depending on perspective)
  const teamWinProbs = bookmakerProbs.map(b => isHome ? b.homeProb : b.awayProb);
  const spread = Math.max(...teamWinProbs) - Math.min(...teamWinProbs);
  const c_dispersion = 1 - Math.min(spread / 0.08, 1);

  // c_recency: hours since latest snapshot
  const latestSnapshotTime = bookmakerProbs
    .map(b => new Date(b.snapshot_time).getTime())
    .reduce((a, b) => Math.max(a, b), 0);
  const hoursSinceLatest = (Date.now() - latestSnapshotTime) / (1000 * 3600);
  const c_recency = 1 - Math.min(hoursSinceLatest / 48, 1);

  const confidence = c_books * c_dispersion * c_recency;

  // ── Step 5: Compute R_market_fixture ─────────────────────
  // Median de-vigged probabilities across bookmakers (robust to outliers) + renormalize
  const rawHome = median(bookmakerProbs.map(b => b.homeProb));
  const rawDraw = median(bookmakerProbs.map(b => b.drawProb));
  const rawAway = median(bookmakerProbs.map(b => b.awayProb));
  const probTotal = rawHome + rawDraw + rawAway;
  const consensusHomeProb = rawHome / probTotal;
  const consensusDrawProb = rawDraw / probTotal;
  const consensusAwayProb = rawAway / probTotal;

  // Team's expected score from consensus
  const teamExpectedScore = isHome
    ? consensusHomeProb + 0.5 * consensusDrawProb
    : consensusAwayProb + 0.5 * consensusDrawProb;

  // Opponent's current b_value as their Elo proxy
  const { data: opponentState } = await sb
    .from("team_oracle_state")
    .select("b_value")
    .eq("team_id", opponent)
    .single();

  const opponentB = opponentState ? Number(opponentState.b_value) : 0;

  // Invert odds into team-level Elo-equivalent strength
  const R_market_fixture = oddsImpliedStrength(
    teamExpectedScore,
    opponentB,
    isHome,
    HOME_ADVANTAGE_ELO
  );

  // ── Step 6: Compute M1 ──────────────────────────────────
  const M1_raw = R_market_fixture - B_value;

  // Horizon decay: fixture further away = less confident
  const HORIZON_DAYS = 10;
  const kickoffMs = new Date(kickoffTs).getTime();
  let c_horizon = 1.0;

  if (isNaN(kickoffMs) || !nextFixture.commence_time) {
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
      `M1 CLAMPED: ${team} raw=${M1_unclamped.toFixed(2)} clamped=${M1.toFixed(2)} ` +
      `days_to_ko=${c_horizon < 1 ? ((1 - c_horizon) * HORIZON_DAYS).toFixed(1) : '0'}`
    );
  }

  // ── Step 7: Write outputs ────────────────────────────────
  await writeM1State(sb, team, {
    m1_value: M1,
    published_index,
    confidence_score: eff_conf,
    next_fixture_id: nextFixture.fixture_id,
  });

  // ── Step 8: Append price history ──────────────────────────
  {
    const { error: phErr } = await sb
      .from("oracle_price_history")
      .insert([{
        team,
        league: await getTeamLeague(sb, team),
        timestamp: new Date().toISOString(),
        b_value: Number(B_value.toFixed(4)),
        m1_value: Number(M1.toFixed(4)),
        published_index: Number(published_index.toFixed(4)),
        confidence_score: Number(eff_conf.toFixed(4)),
        source_fixture_id: nextFixture.fixture_id,
        publish_reason: "market_refresh",
      }]);

    if (phErr) {
      log.warn(`M1 price history insert failed for ${team}: ${phErr.message}`);
      // Non-fatal — M1 write already succeeded
    }
  }

  log.debug(
    `M1 refresh: ${team} — ` +
    `R_mkt=${R_market_fixture.toFixed(1)} B=${B_value.toFixed(1)} ` +
    `M1_raw=${M1_raw.toFixed(2)} c=${confidence.toFixed(3)} ` +
    `c_hor=${c_horizon.toFixed(3)} eff=${eff_conf.toFixed(3)} ` +
    `M1=${M1.toFixed(2)} idx=${published_index.toFixed(2)} ` +
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

/** Get the league for a team from the most recent match. Cached in-memory. */
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

// ─── State writer ───────────────────────────────────────────

/**
 * Write M1-owned fields to team_oracle_state.
 * Never touches B_value or last_kr_fixture_id.
 */
async function writeM1State(
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
    .from("team_oracle_state")
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
    // Row might not exist yet (team never settled) — try upsert
    if (error.code === "PGRST116" || error.message.includes("0 rows")) {
      const { error: upsertErr } = await sb
        .from("team_oracle_state")
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
        log.error(`M1 state upsert failed for ${team}: ${upsertErr.message}`);
      }
    } else {
      log.error(`M1 state update failed for ${team}: ${error.message}`);
    }
  }
}
