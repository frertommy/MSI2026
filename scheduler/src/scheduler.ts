import {
  PRIMARY_POLL_INTERVAL,
  CREDITS_FALLBACK_INTERVAL,
  CREDITS_DAILY_SOFT_LIMIT,
  OUTRIGHT_POLL_INTERVAL,
  DAILY_CREDIT_SAFETY,
  POLYMARKET_POLL_INTERVAL,
  ORACLE_V1_ENABLED,
} from "./config.js";
import { log } from "./logger.js";
import { updateHealth } from "./health.js";
import { getSupabase } from "./api/supabase-client.js";
import { pollOdds, pollOutrights } from "./services/odds-poller.js";
import {
  pollPolymarketMatches,
  pollPolymarketFutures,
  matchPolymarketToFixtures,
} from "./services/polymarket-poller.js";
import { refreshMatches } from "./services/match-tracker.js";
import { CreditTracker } from "./services/credit-tracker.js";
import { runOracleV1Cycle } from "./services/oracle-v1-cycle.js";
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

      // 2b. Outright / futures polling (every 6 hours — for M₂ layer)
      if (Date.now() - this.lastOutrightPoll >= OUTRIGHT_POLL_INTERVAL) {
        if (this.creditTracker.canPoll()) {
          try {
            await pollOutrights(this.lookup!, this.creditTracker);
            this.lastOutrightPoll = Date.now();
          } catch (err) {
            log.warn(
              "Outright poll failed",
              err instanceof Error ? err.message : err
            );
          }
        }
      }

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

      // 3. Refresh match scores (every 5th cycle ≈ 5 min at 1-min polling)
      if (this.cycleCount % 5 === 0) {
        await refreshMatches();
        // Rebuild lookup after new matches
        this.lookup = await buildTeamLookup();
      }

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

      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
      log.info(`═══ Cycle #${this.cycleCount} complete in ${elapsed}s ═══`);

      updateHealth({ status: "ok" });
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
      credits_used_today: this.cycleCount % 5 === 0 ? 5 : 0, // 5 leagues every 5th cycle
      daily_budget: 100,
      last_poll_at: this.cycleCount % 5 === 0 ? now : undefined,
      poll_interval_seconds: intervalSec * 5, // runs every 5th cycle
      next_poll_at: new Date(Date.now() + this.lastInterval * 5).toISOString(),
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
