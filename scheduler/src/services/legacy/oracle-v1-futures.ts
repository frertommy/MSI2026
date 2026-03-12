/**
 * oracle-v1-futures.ts — Futures-based market strength for offseason regime.
 *
 * When no competitive fixtures exist, derives team strength from
 * Polymarket league winner title probabilities.
 *
 * R_futures = league_mean_B + 400 * log10(P_title / P_baseline)
 *
 * Where:
 *   P_title   = team's implied title probability from Polymarket
 *   P_baseline = 1/N (equal share among N teams in league)
 *   league_mean_B = average B_value of all teams in that league
 *
 * Confidence = volume_factor * recency_factor
 *   volume_factor  = min(volume / 50000, 1.0)
 *   recency_factor = 1 - min(hours_since_snapshot / 24, 1)
 *
 * Constraints:
 *   - Feature-flagged: only called when ORACLE_V1_OFFSEASON_ENABLED=true
 *   - Returns null when no Polymarket data exists or data is stale (>24h)
 *   - Returns null when team not found in Polymarket futures
 *   - Uses Bradley-Terry conversion (log-odds) which naturally spreads
 *     title favorites (P>>baseline) into higher R and relegation candidates
 *     (P<<baseline) into lower R
 */

import { getSupabase } from "../api/supabase-client.js";
import { log } from "../logger.js";

// ─── In-memory caches (refreshed per cycle) ──────────────────

interface LeagueSnapshot {
  teams: {
    team: string;
    implied_prob: number;
    volume: number;
    snapshot_time: string;
  }[];
  league_mean_b: number;
  fetched_at: number;
}

const leagueSnapshotCache = new Map<string, LeagueSnapshot>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — within a single cycle, reuse cached data

// ─── Polymarket → Oracle team name resolution ────────────────

/**
 * Build a Polymarket team name → oracle team_id mapping using team-aliases.json.
 * The polymarket-poller already cleans names via resolvePolymarketName(),
 * so `polymarket_futures.team` is the cleaned/aliased version.
 * But we still need to map those to oracle team_ids since some mismatches
 * exist (e.g., "Man City" in Polymarket vs "Manchester City" in oracle).
 *
 * This function loads the alias map once and caches it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname_futures = path.dirname(fileURLToPath(import.meta.url));
let polyAliasMap: Record<string, string> | null = null;

function getAliasMap(): Record<string, string> {
  if (polyAliasMap) return polyAliasMap;
  try {
    const raw = fs.readFileSync(
      path.resolve(__dirname_futures, "../data/team-aliases.json"),
      "utf-8"
    );
    polyAliasMap = JSON.parse(raw);
    return polyAliasMap!;
  } catch {
    polyAliasMap = {};
    return polyAliasMap;
  }
}

function resolveToOracleId(polymarketTeam: string): string {
  const aliases = getAliasMap();
  return aliases[polymarketTeam] ?? polymarketTeam;
}

// ─── Main exported function ─────────────────────────────────

/**
 * Compute R_futures from Polymarket league winner odds for a team.
 *
 * Uses Bradley-Terry model:
 *   R_futures = league_mean_B + 400 * log10(P_title / P_baseline)
 *
 * This naturally maps title favorites to high R and long shots to low R,
 * with the spread calibrated relative to the league's average B.
 */
export async function computeRFutures(
  teamId: string,
  league: string
): Promise<{
  R_futures: number;
  P_title: number;
  bookmaker_count: number;
  confidence: number;
  stale: boolean;
} | null> {
  // ── Get or refresh league snapshot ──────────────────────────
  const snapshot = await getLeagueSnapshot(league);
  if (!snapshot || snapshot.teams.length === 0) {
    log.debug(
      `computeRFutures: no Polymarket data for league=${league}, team=${teamId}`
    );
    return null;
  }

  // ── Find this team in the snapshot ─────────────────────────
  // Match by oracle team_id: the snapshot teams are Polymarket names,
  // but we resolve them to oracle IDs for comparison
  const teamEntry = snapshot.teams.find((t) => {
    const resolved = resolveToOracleId(t.team);
    return resolved === teamId;
  });

  if (!teamEntry) {
    log.debug(
      `computeRFutures: team ${teamId} not found in Polymarket futures for ${league}`
    );
    return null;
  }

  // ── Staleness check ────────────────────────────────────────
  const snapshotAge = Date.now() - new Date(teamEntry.snapshot_time).getTime();
  const hoursSince = snapshotAge / (3600 * 1000);
  const stale = hoursSince > 24;

  if (stale) {
    log.debug(
      `computeRFutures: stale data for ${teamId} (${hoursSince.toFixed(1)}h old)`
    );
    return { R_futures: 0, P_title: teamEntry.implied_prob, bookmaker_count: 1, confidence: 0, stale: true };
  }

  // ── Bradley-Terry conversion (clamped) ─────────────────────
  // Raw Bradley-Terry: offset = 400 * log10(P_title / P_baseline)
  // Problem: for non-contenders (P=0.05%), this gives -900 offset.
  // Title probability ≠ team strength. Liverpool at 0.05% is still
  // a 1800-rated team — they just can't win the title from their position.
  //
  // Solution: clamp the offset to ±300 ELO from league mean.
  // This keeps the signal proportional while preventing absurd values.
  // Effective range: league_mean ± 300 → covers ~95% of actual B spread.
  //
  // For off-season use: clamping is even more important because
  // summer title probabilities reflect genuine uncertainty, not
  // mathematical elimination. A 2% title probability in June means
  // "unlikely but possible", not "this team is terrible".
  const MAX_FUTURES_OFFSET = 300;
  const MIN_FUTURES_OFFSET = -200;

  const N = snapshot.teams.length;
  const P_baseline = 1 / N;
  const P_title = Math.max(teamEntry.implied_prob, 0.0001); // floor to avoid log(0)

  const league_mean_B = snapshot.league_mean_b;
  const raw_offset = 400 * Math.log10(P_title / P_baseline);
  const clamped_offset = Math.max(MIN_FUTURES_OFFSET, Math.min(MAX_FUTURES_OFFSET, raw_offset));
  const R_futures = league_mean_B + clamped_offset;

  // ── Confidence calculation ─────────────────────────────────
  // Volume factor: full confidence at $50k+ volume
  const volume_factor = Math.min(teamEntry.volume / 50_000, 1.0);

  // Recency factor: linear decay over 24h
  const recency_factor = 1 - Math.min(hoursSince / 24, 1);

  const confidence = volume_factor * recency_factor;

  log.debug(
    `computeRFutures: ${teamId} — P_title=${P_title.toFixed(4)} ` +
    `P_base=${P_baseline.toFixed(4)} league_mean_B=${league_mean_B.toFixed(1)} ` +
    `raw_off=${raw_offset.toFixed(1)} clamped=${clamped_offset.toFixed(1)} ` +
    `R_futures=${R_futures.toFixed(1)} vol=$${teamEntry.volume.toFixed(0)} ` +
    `c_vol=${volume_factor.toFixed(3)} c_rec=${recency_factor.toFixed(3)} ` +
    `conf=${confidence.toFixed(3)}`
  );

  return {
    R_futures,
    P_title,
    bookmaker_count: 1, // Polymarket is a single market source
    confidence,
    stale: false,
  };
}

// ─── League snapshot loader ──────────────────────────────────

/**
 * Fetch the latest Polymarket futures snapshot for all teams in a league.
 * Caches for 5 minutes to avoid redundant DB queries within a single cycle.
 *
 * Also loads league_mean_B from team_oracle_state.
 */
async function getLeagueSnapshot(league: string): Promise<LeagueSnapshot | null> {
  // Check cache
  const cached = leagueSnapshotCache.get(league);
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
    return cached;
  }

  const sb = getSupabase();

  // ── Get latest Polymarket futures for this league ──────────
  // Strategy: get the max snapshot_time first, then pull all rows from that snapshot
  const { data: latestRow, error: latestErr } = await sb
    .from("polymarket_futures")
    .select("snapshot_time")
    .eq("league", league)
    .order("snapshot_time", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestErr || !latestRow) {
    log.debug(`getLeagueSnapshot: no data for ${league}: ${latestErr?.message ?? "empty"}`);
    return null;
  }

  const latestTime = latestRow.snapshot_time as string;

  // Pull all teams from the latest snapshot (± 2 min window to handle slight timing diffs)
  const latestTs = new Date(latestTime).getTime();
  const windowStart = new Date(latestTs - 2 * 60 * 1000).toISOString();

  const { data: futuresRows, error: futuresErr } = await sb
    .from("polymarket_futures")
    .select("team, implied_prob, volume, snapshot_time")
    .eq("league", league)
    .gte("snapshot_time", windowStart)
    .order("snapshot_time", { ascending: false });

  if (futuresErr || !futuresRows || futuresRows.length === 0) {
    log.debug(`getLeagueSnapshot: query failed for ${league}: ${futuresErr?.message ?? "empty"}`);
    return null;
  }

  // Deduplicate: keep first (most recent) row per team
  const teamMap = new Map<string, { team: string; implied_prob: number; volume: number; snapshot_time: string }>();
  for (const row of futuresRows) {
    const team = row.team as string;
    if (!teamMap.has(team)) {
      teamMap.set(team, {
        team,
        implied_prob: Number(row.implied_prob),
        volume: Number(row.volume),
        snapshot_time: row.snapshot_time as string,
      });
    }
  }

  const teams = [...teamMap.values()];

  // ── Get league mean B from team_oracle_state ───────────────
  // Resolve Polymarket team names to oracle IDs, then query B values
  const oracleTeamIds = teams.map((t) => resolveToOracleId(t.team));

  const { data: bRows, error: bErr } = await sb
    .from("team_oracle_state")
    .select("team_id, b_value")
    .in("team_id", oracleTeamIds);

  let league_mean_b = 1500; // fallback to baseline
  if (!bErr && bRows && bRows.length > 0) {
    const bValues = bRows.map((r) => Number(r.b_value));
    league_mean_b = bValues.reduce((a, b) => a + b, 0) / bValues.length;
  }

  const snapshot: LeagueSnapshot = {
    teams,
    league_mean_b,
    fetched_at: Date.now(),
  };

  leagueSnapshotCache.set(league, snapshot);

  log.debug(
    `getLeagueSnapshot: ${league} — ${teams.length} teams, ` +
    `league_mean_B=${league_mean_b.toFixed(1)}, latest=${latestTime}`
  );

  return snapshot;
}

/**
 * Clear the league snapshot cache. Call this at the start of each cycle
 * if you want fresh data, or let it expire naturally (5 min TTL).
 */
export function clearFuturesCache(): void {
  leagueSnapshotCache.clear();
}
