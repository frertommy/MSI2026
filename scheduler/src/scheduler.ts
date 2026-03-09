import {
  PRIMARY_POLL_INTERVAL,
  CREDITS_FALLBACK_INTERVAL,
  CREDITS_DAILY_SOFT_LIMIT,
  DAILY_CREDIT_SAFETY,
  POLYMARKET_POLL_INTERVAL,
  ORACLE_V1_ENABLED,
  ORACLE_V2_ENABLED,
} from "./config.js";
import { log } from "./logger.js";
import { updateHealth } from "./health.js";
import { getSupabase } from "./api/supabase-client.js";
import { pollOdds } from "./services/odds-poller.js";
import {
  pollPolymarketMatches,
  pollPolymarketFutures,
  matchPolymarketToFixtures,
} from "./services/polymarket-poller.js";
import { refreshMatches } from "./services/match-tracker.js";
import { CreditTracker } from "./services/credit-tracker.js";
import { runOracleV1Cycle } from "./services/oracle-v1-cycle.js";
import { runOracleV2Cycle } from "./services/oracle-v2-cycle.js";
import { runWatchdog } from "./services/pipeline-watchdog.js";
import { buildTeamLookup, type TeamLookup } from "./utils/team-names.js";
import type { PollResult } from "./types.js";

export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private cycleCount = 0;
  private lookup: TeamLookup | null = null;
  private creditTracker: CreditTracker;
  private lastPollResult: PollResult | null = null;
  private lastInterval: number = PRIMARY_POLL_INTERVAL;
  private lastOutrightPoll = 0;
  private lastHourlyPoll = 0;
  private lastPolymarketPoll = 0;

  /** Commence times from latest poll (ISO strings) for interval calculation */
  private commenceTimes: string[] = [];

  constructor() {
    this.creditTracker = new CreditTracker();
  }

  async start(): Promise<void> {
    this.running = true;
    log.info("Scheduler starting...");

    // Build team lookup on startup
    this.lookup = await buildTeamLookup();

    // Run first cycle immediately
    await this.runCycle();

    // Schedule next
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info(`Scheduler stopped after ${this.cycleCount} cycles`);
  }

  private scheduleNext(): void {
    if (!this.running) return;

    const interval = this.computeNextInterval();
    this.lastInterval = interval;
    const minutes = (interval / 60000).toFixed(1);
    log.info(`Next poll in ${minutes} min`);

    updateHealth({ nextPollIn: interval });

    this.timer = setTimeout(async () => {
      if (!this.running) return;
      await this.runCycle();
      this.scheduleNext();
    }, interval);
  }

  private async runCycle(): Promise<void> {
    this.cycleCount++;
    const cycleStart = Date.now();
    log.info(`═══ Cycle #${this.cycleCount} starting (1-min poll) ═══`);

    try {
      // 1. Check credits
      if (!this.creditTracker.canPoll()) {
        log.warn("Skipping odds poll — credit limit reached");
      } else {
        // 2. Poll odds (h2h + totals + spreads, all 5 leagues)
        this.lastPollResult = await pollOdds(this.lookup!, this.creditTracker);
        updateHealth({
          lastPoll: new Date().toISOString(),
          lastPollResult: this.lastPollResult,
          credits: this.creditTracker.getStatus(),
        });
      }

      // 2b. Outright / futures polling — DISABLED
      // outright_odds table dropped; API endpoints return 404.
      // Will be replaced by Polymarket futures integration.

      // 2c. Poll Polymarket (every 10 min — free, no credits, no auth)
      if (Date.now() - this.lastPolymarketPoll >= POLYMARKET_POLL_INTERVAL) {
        try {
          await pollPolymarketMatches();
          await pollPolymarketFutures();
          if (this.lookup) {
            await matchPolymarketToFixtures(this.lookup);
          }
          this.lastPolymarketPoll = Date.now();
        } catch (err) {
          log.warn(
            "Polymarket poll failed",
            err instanceof Error ? err.message : err
          );
        }
      }

      // 3. Refresh match scores (every cycle — 1 min)
      // Needed for timely status='finished' detection so settlement + L reset aren't delayed.
      // Pro plan: 7,500 calls/day, this uses ~7,200 (5 leagues × 1,440 cycles).
      const matchRefreshResult = await refreshMatches();
      // Rebuild lookup after new matches
      this.lookup = await buildTeamLookup();

      this.creditTracker.logStatus();

      // 4. Write credit stats to Supabase for frontend dashboard
      await this.writeCreditStats();

      // 5. Oracle V1 cycle — settle finished matches + refresh M1
      if (ORACLE_V1_ENABLED) {
        try {
          await runOracleV1Cycle();
        } catch (err) {
          log.warn(
            "Oracle V1 cycle failed",
            err instanceof Error ? err.message : err
          );
        }
      }

      // 5b. Oracle V2 cycle — settle with gravity + refresh M1 (parallel to V1)
      if (ORACLE_V2_ENABLED) {
        try {
          await runOracleV2Cycle();
        } catch (err) {
          log.warn(
            "Oracle V2 cycle failed",
            err instanceof Error ? err.message : err
          );
        }
      }

      // 6. Pipeline watchdog — detect invariant violations, auto-fix, degrade health
      try {
        const watchdogResult = await runWatchdog(matchRefreshResult);
        updateHealth({
          watchdog: {
            checks_run: watchdogResult.checks_run,
            alerts_count: watchdogResult.alerts.length,
            fixes_applied: watchdogResult.fixes_applied,
            health_status: watchdogResult.health_status,
            last_run: new Date().toISOString(),
          },
        });

        // Set health status based on watchdog assessment
        if (watchdogResult.health_status === "critical") {
          updateHealth({ status: "degraded" });
        } else {
          updateHealth({ status: "ok" });
        }
      } catch (err) {
        log.warn(
          "Watchdog failed",
          err instanceof Error ? err.message : err
        );
      }

      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
      log.info(`═══ Cycle #${this.cycleCount} complete in ${elapsed}s ═══`);

      // Final health status: keep "degraded" if watchdog flagged critical, otherwise "ok"
      // (the watchdog block above already set "degraded" if critical)
    } catch (err) {
      log.error(
        `Cycle #${this.cycleCount} failed`,
        err instanceof Error ? err.message : err
      );
      updateHealth({ status: "degraded" });
    }
  }

  /**
   * Upsert credit stats to api_credits table so the frontend can display them.
   * Gracefully degrades if the table doesn't exist yet.
   */
  private async writeCreditStats(): Promise<void> {
    const sb = getSupabase();
    const now = new Date().toISOString();
    const intervalSec = Math.round(this.lastInterval / 1000);
    const nextPollAt = new Date(Date.now() + this.lastInterval).toISOString();
    const status = this.creditTracker.getStatus();

    // Odds API row
    const oddsRow = {
      provider: "odds_api",
      credits_remaining: status.remaining,
      credits_used_today: status.usedToday,
      daily_budget: CREDITS_DAILY_SOFT_LIMIT,
      last_poll_at: now,
      poll_interval_seconds: intervalSec,
      next_poll_at: nextPollAt,
    };

    // API-Football row (basic — no granular credit tracking)
    const footballRow = {
      provider: "api_football",
      credits_remaining: null,
      credits_used_today: 5, // 5 leagues every cycle now
      daily_budget: 7500,
      last_poll_at: now,
      poll_interval_seconds: intervalSec,
      next_poll_at: new Date(Date.now() + this.lastInterval).toISOString(),
    };

    try {
      const { error: oddsErr } = await sb
        .from("api_credits")
        .upsert([oddsRow], { onConflict: "provider" });

      if (oddsErr) {
        if (oddsErr.code === "PGRST205") {
          log.debug("api_credits table not found — skipping credit stats write");
        } else {
          log.warn("Failed to write odds credit stats", oddsErr.message);
        }
        return;
      }

      const { error: fbErr } = await sb
        .from("api_credits")
        .upsert([footballRow], { onConflict: "provider" });

      if (fbErr && fbErr.code !== "PGRST205") {
        log.warn("Failed to write football credit stats", fbErr.message);
      }

      log.debug("Credit stats written to api_credits");
    } catch {
      log.debug("api_credits write failed — table may not exist");
    }
  }

  /**
   * Compute the next polling interval.
   * Default: 1 minute (PRIMARY_POLL_INTERVAL).
   * Falls back to 5 minutes if credit budget is exhausted.
   */
  private computeNextInterval(): number {
    // If credits are critically low, fall back to 5-min
    if (!this.creditTracker.canPoll()) {
      return CREDITS_FALLBACK_INTERVAL;
    }

    // Credit safety: above daily threshold → fall back to 5-min
    const status = this.creditTracker.getStatus();
    if (status.usedToday > DAILY_CREDIT_SAFETY) {
      log.warn(
        `Credit safety (${status.usedToday}/${DAILY_CREDIT_SAFETY}) — fallback mode`
      );
      return CREDITS_FALLBACK_INTERVAL;
    }

    // Default: 1-minute polling
    return PRIMARY_POLL_INTERVAL;
  }
}
