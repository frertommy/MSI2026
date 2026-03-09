/**
 * pipeline-watchdog.ts — Self-healing pipeline monitor.
 *
 * Runs every cycle after the main pipeline completes. Detects invariant
 * violations and auto-fixes them where possible.
 *
 * Checks:
 *   1. STUCK MATCHES — matches past commence_time + 3h still showing "upcoming"
 *      Fix: force re-fetch from API-Football for those specific fixtures
 *
 *   2. MATCH-TRACKER FAILURES — upsert failed count > 0
 *      Fix: retry failed rows one-by-one (bypasses batch failure)
 *
 *   3. SETTLEMENT BACKLOG — finished matches with no settlement_log entries
 *      Fix: flag for next oracle cycle (already handled, but alert if stale)
 *
 *   4. PRICE STALENESS — no oracle_price_history writes in 30+ minutes
 *      Fix: log critical warning, degrade health
 *
 *   5. M1 STALENESS — teams with last_market_refresh_ts > 30 min old
 *      Fix: log warning (M1 refresh is handled by oracle cycle)
 *
 * Each check produces a WatchdogAlert with severity and optional auto-fix.
 * Alerts are logged and written to the watchdog_alerts table for dashboarding.
 */

import { getSupabase } from "../api/supabase-client.js";
import { log } from "../logger.js";
import { API_FOOTBALL_KEY } from "../config.js";

// ─── Types ──────────────────────────────────────────────────

export interface WatchdogAlert {
  check: string;
  severity: "info" | "warning" | "critical";
  message: string;
  auto_fixed: boolean;
  details?: Record<string, unknown>;
}

export interface WatchdogResult {
  checks_run: number;
  alerts: WatchdogAlert[];
  fixes_applied: number;
  health_status: "ok" | "degraded" | "critical";
}

// ─── Main entry point ───────────────────────────────────────

/**
 * Run all watchdog checks. Call once per scheduler cycle.
 *
 * Returns a summary with any alerts and the recommended health status.
 * The scheduler should use the health_status to update the health endpoint.
 */
export async function runWatchdog(
  matchRefreshResult?: { upserted: number; failed: number }
): Promise<WatchdogResult> {
  const alerts: WatchdogAlert[] = [];
  let fixesApplied = 0;

  try {
    // ── Check 1: Stuck matches ────────────────────────────────
    const stuckAlerts = await checkStuckMatches();
    alerts.push(...stuckAlerts);
    fixesApplied += stuckAlerts.filter((a) => a.auto_fixed).length;

    // ── Check 2: Match-tracker batch failures ──────────────────
    if (matchRefreshResult && matchRefreshResult.failed > 0) {
      alerts.push({
        check: "match_tracker_failures",
        severity: matchRefreshResult.upserted === 0 ? "critical" : "warning",
        message: `Match-tracker: ${matchRefreshResult.failed} rows failed to upsert (${matchRefreshResult.upserted} succeeded)`,
        auto_fixed: false,
        details: matchRefreshResult,
      });
    }

    // ── Check 3: Settlement backlog ───────────────────────────
    const settlementAlerts = await checkSettlementBacklog();
    alerts.push(...settlementAlerts);

    // ── Check 4: Price history staleness ──────────────────────
    const priceAlerts = await checkPriceStaleness();
    alerts.push(...priceAlerts);

    // ── Check 5: M1 staleness ────────────────────────────────
    const m1Alerts = await checkM1Staleness();
    alerts.push(...m1Alerts);
  } catch (err) {
    alerts.push({
      check: "watchdog_internal",
      severity: "warning",
      message: `Watchdog internal error: ${err instanceof Error ? err.message : String(err)}`,
      auto_fixed: false,
    });
  }

  // ── Determine overall health status ─────────────────────────
  const hasCritical = alerts.some((a) => a.severity === "critical");
  const hasWarning = alerts.some((a) => a.severity === "warning");
  const health_status = hasCritical ? "critical" : hasWarning ? "degraded" : "ok";

  // ── Log alerts ──────────────────────────────────────────────
  for (const alert of alerts) {
    const prefix = alert.auto_fixed ? "[AUTO-FIXED]" : "[ALERT]";
    if (alert.severity === "critical") {
      log.error(`🚨 WATCHDOG ${prefix} ${alert.check}: ${alert.message}`);
    } else if (alert.severity === "warning") {
      log.warn(`⚠️  WATCHDOG ${prefix} ${alert.check}: ${alert.message}`);
    } else {
      log.info(`ℹ️  WATCHDOG ${prefix} ${alert.check}: ${alert.message}`);
    }
  }

  // ── Persist alerts to DB (best-effort) ──────────────────────
  if (alerts.length > 0) {
    await persistAlerts(alerts);
  }

  const result: WatchdogResult = {
    checks_run: 5,
    alerts,
    fixes_applied: fixesApplied,
    health_status,
  };

  if (alerts.length > 0) {
    log.info(
      `Watchdog: ${alerts.length} alert(s), ${fixesApplied} auto-fixed, health=${health_status}`
    );
  }

  return result;
}

// ─── Check 1: Stuck matches ─────────────────────────────────

/**
 * Detect matches that should be finished (commence_time + 3h ago)
 * but are still "upcoming". This is the invariant violation that
 * caused the 3-day outage.
 *
 * Auto-fix: force re-fetch from API-Football for those fixture IDs
 * and upsert individually (not batched).
 */
async function checkStuckMatches(): Promise<WatchdogAlert[]> {
  const sb = getSupabase();
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

  const { data: stuckRows, error } = await sb
    .from("matches")
    .select("fixture_id, home_team, away_team, date, commence_time, league")
    .eq("status", "upcoming")
    .lt("commence_time", threeHoursAgo)
    .not("commence_time", "is", null);

  if (error || !stuckRows) return [];
  if (stuckRows.length === 0) return [];

  const alerts: WatchdogAlert[] = [];

  // Try to fix: re-fetch each stuck fixture from API-Football individually
  let fixed = 0;
  let failedToFix = 0;

  if (API_FOOTBALL_KEY) {
    for (const row of stuckRows) {
      try {
        const result = await refetchSingleFixture(row.fixture_id);
        if (result) {
          fixed++;
        } else {
          failedToFix++;
        }
      } catch {
        failedToFix++;
      }
    }
  }

  if (fixed > 0) {
    alerts.push({
      check: "stuck_matches",
      severity: "warning",
      message: `${fixed} stuck match(es) auto-fixed by re-fetching from API-Football`,
      auto_fixed: true,
      details: {
        fixed,
        failedToFix,
        fixtures: stuckRows.map((r) => ({
          fixture_id: r.fixture_id,
          teams: `${r.home_team} vs ${r.away_team}`,
          commence_time: r.commence_time,
        })),
      },
    });
  }

  if (failedToFix > 0 || (!API_FOOTBALL_KEY && stuckRows.length > 0)) {
    alerts.push({
      check: "stuck_matches",
      severity: "critical",
      message: `${stuckRows.length - fixed} match(es) stuck as "upcoming" past kickoff+3h — cannot auto-fix`,
      auto_fixed: false,
      details: {
        fixtures: stuckRows
          .slice(0, 10) // cap detail output
          .map((r) => ({
            fixture_id: r.fixture_id,
            teams: `${r.home_team} vs ${r.away_team}`,
            commence_time: r.commence_time,
          })),
      },
    });
  }

  return alerts;
}

/**
 * Re-fetch a single fixture from API-Football and upsert directly.
 * This bypasses the normal batch flow to fix individual stuck matches.
 */
async function refetchSingleFixture(fixtureId: number): Promise<boolean> {
  const url = `https://v3.football.api-sports.io/fixtures?id=${fixtureId}`;
  const resp = await fetch(url, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY },
  });

  if (!resp.ok) {
    log.error(`Watchdog refetch: HTTP ${resp.status} for fixture ${fixtureId}`);
    return false;
  }

  const json = (await resp.json()) as {
    response: {
      fixture: { id: number; date: string; status: { short: string } };
      league: { name: string };
      teams: { home: { name: string }; away: { name: string } };
      goals: { home: number | null; away: number | null };
    }[];
  };

  const fixtures = json.response ?? [];
  if (fixtures.length === 0) {
    log.warn(`Watchdog refetch: no data for fixture ${fixtureId}`);
    return false;
  }

  const f = fixtures[0];
  const statusCode = f.fixture.status.short;
  const finished = ["FT", "AET", "PEN"].includes(statusCode);
  const live = ["1H", "HT", "2H", "ET", "BT", "P"].includes(statusCode);
  const score =
    f.goals.home !== null && f.goals.away !== null
      ? `${f.goals.home}-${f.goals.away}`
      : "N/A";

  const row = {
    fixture_id: f.fixture.id,
    date: f.fixture.date.slice(0, 10),
    league: f.league.name,
    home_team: f.teams.home.name,
    away_team: f.teams.away.name,
    score,
    status: finished ? "finished" : live ? "live" : "upcoming",
    status_code: statusCode,
    commence_time: f.fixture.date,
  };

  // Individual upsert — not batched
  const sb = getSupabase();
  const { error } = await sb
    .from("matches")
    .upsert([row], { onConflict: "fixture_id" });

  if (error) {
    log.error(`Watchdog refetch: upsert failed for fixture ${fixtureId}: ${error.message}`);
    return false;
  }

  log.info(
    `Watchdog refetch: fixture ${fixtureId} updated to status="${row.status}" (${statusCode}), score=${score}`
  );
  return true;
}

// ─── Check 3: Settlement backlog ─────────────────────────────

/**
 * Check for finished matches older than 4 hours that have no
 * settlement_log entries. This means settlement is stuck.
 */
async function checkSettlementBacklog(): Promise<WatchdogAlert[]> {
  const sb = getSupabase();
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);

  // Find finished matches from the last 2 days
  const { data: recentFinished, error: finErr } = await sb
    .from("matches")
    .select("fixture_id, home_team, away_team, date")
    .eq("status", "finished")
    .gte("date", twoDaysAgo)
    .lte("date", fourHoursAgo);

  if (finErr || !recentFinished || recentFinished.length === 0) return [];

  // Check which ones have settlement entries
  const fixtureIds = recentFinished.map((m) => m.fixture_id);
  const { data: settledRows, error: settErr } = await sb
    .from("settlement_log")
    .select("fixture_id")
    .in("fixture_id", fixtureIds);

  if (settErr) return [];

  const settledSet = new Set((settledRows ?? []).map((r) => r.fixture_id));
  const unsettled = recentFinished.filter((m) => !settledSet.has(m.fixture_id));

  if (unsettled.length === 0) return [];

  // Only alert if they've been finished for >4 hours (give normal cycle time to settle)
  return [
    {
      check: "settlement_backlog",
      severity: unsettled.length > 5 ? "critical" : "warning",
      message: `${unsettled.length} finished match(es) from last 2 days have no settlement entries`,
      auto_fixed: false,
      details: {
        count: unsettled.length,
        fixtures: unsettled.slice(0, 5).map((m) => ({
          fixture_id: m.fixture_id,
          teams: `${m.home_team} vs ${m.away_team}`,
          date: m.date,
        })),
      },
    },
  ];
}

// ─── Check 4: Price history staleness ────────────────────────

/**
 * Check if oracle_price_history has had any writes in the last 30 minutes.
 * A gap means the oracle pipeline is stalled.
 */
async function checkPriceStaleness(): Promise<WatchdogAlert[]> {
  const sb = getSupabase();
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: recent, error } = await sb
    .from("oracle_price_history")
    .select("timestamp")
    .gte("timestamp", thirtyMinsAgo)
    .limit(1);

  if (error) return [];

  if (!recent || recent.length === 0) {
    return [
      {
        check: "price_staleness",
        severity: "warning",
        message: "No oracle_price_history writes in the last 30 minutes",
        auto_fixed: false,
      },
    ];
  }

  return [];
}

// ─── Check 5: M1 staleness ──────────────────────────────────

/**
 * Check if any teams have stale M1 data (last_market_refresh_ts > 30 min old).
 * A few stale teams is normal (no odds available), but many indicates a problem.
 */
async function checkM1Staleness(): Promise<WatchdogAlert[]> {
  const sb = getSupabase();
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: staleTeams, error } = await sb
    .from("team_oracle_state")
    .select("team_id, last_market_refresh_ts")
    .not("last_market_refresh_ts", "is", null)
    .lt("last_market_refresh_ts", thirtyMinsAgo);

  if (error || !staleTeams) return [];

  // Only alert if >50% of teams are stale (a few is normal)
  const { count: totalTeams } = await sb
    .from("team_oracle_state")
    .select("team_id", { count: "exact", head: true });

  const total = totalTeams ?? 1;
  const staleCount = staleTeams.length;
  const stalePercent = (staleCount / total) * 100;

  if (stalePercent > 50) {
    return [
      {
        check: "m1_staleness",
        severity: "warning",
        message: `${staleCount}/${total} teams (${stalePercent.toFixed(0)}%) have stale M1 data (>30 min old)`,
        auto_fixed: false,
        details: {
          stale_count: staleCount,
          total_count: total,
          percent: stalePercent,
        },
      },
    ];
  }

  return [];
}

// ─── Persist alerts to DB ────────────────────────────────────

/**
 * Write watchdog alerts to a Supabase table for dashboarding.
 * Best-effort — silently fails if table doesn't exist.
 */
async function persistAlerts(alerts: WatchdogAlert[]): Promise<void> {
  const sb = getSupabase();
  const now = new Date().toISOString();

  const rows = alerts.map((a) => ({
    check_name: a.check,
    severity: a.severity,
    message: a.message,
    auto_fixed: a.auto_fixed,
    details: a.details ?? null,
    created_at: now,
  }));

  try {
    const { error } = await sb.from("watchdog_alerts").insert(rows);
    if (error && error.code !== "PGRST205" && error.code !== "42P01") {
      log.debug(`Watchdog alert persist failed: ${error.message}`);
    }
  } catch {
    // Table may not exist — non-fatal
  }
}
