import {
  POLL_INTERVALS,
  CREDITS_FALLBACK_INTERVAL,
  CREDITS_DAILY_SOFT_LIMIT,
  OUTRIGHT_POLL_INTERVAL,
  HOURLY_POLL_INTERVAL,
  DAILY_CREDIT_SAFETY,
  POLYMARKET_POLL_INTERVAL,
  XG_ENABLED,
  XG_POLL_INTERVAL,
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
import { runPricingEngine } from "./services/pricing-engine.js";
import { pollUnderstatXg } from "./services/understat-poller.js";
import { CreditTracker } from "./services/credit-tracker.js";
import { buildTeamLookup, type TeamLookup } from "./utils/team-names.js";
import type { PollResult } from "./types.js";

export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private cycleCount = 0;
  private lookup: TeamLookup | null = null;
  private creditTracker: CreditTracker;
  private lastPollResult: PollResult | null = null;
  private lastInterval: number = POLL_INTERVALS.FAR_FROM_KICKOFF;
  private lastOutrightPoll = 0;
  private lastHourlyPoll = 0;
  private lastPolymarketPoll = 0;
  private lastUnderstatPoll = 0;

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
    const matchDayActive = this.isMatchDayActivePolling();
    const pollType = matchDayActive ? "match-day" : "hourly-baseline";
    log.info(`═══ Cycle #${this.cycleCount} starting (${pollType}) ═══`);

    try {
      // 1. Check credits
      if (!this.creditTracker.canPoll()) {
        log.warn("Skipping odds poll — credit limit reached");
        // Still run pricing on existing data
      } else {
        // 2. Poll odds
        this.lastPollResult = await pollOdds(this.lookup!, this.creditTracker);
        updateHealth({
          lastPoll: new Date().toISOString(),
          lastPollResult: this.lastPollResult,
          credits: this.creditTracker.getStatus(),
        });

        // Track hourly baseline polls
        if (!matchDayActive) {
          this.lastHourlyPoll = Date.now();
          log.info("Hourly baseline poll completed");
        }
      }

      // 2b. Outright polling disabled — not feeding into model
      // (OUTRIGHT_WEIGHT = 0; league winner prob creates season-end discontinuity)
      // if (Date.now() - this.lastOutrightPoll >= OUTRIGHT_POLL_INTERVAL) {
      //   if (this.creditTracker.canPoll()) {
      //     await pollOutrights(this.lookup!, this.creditTracker);
      //     this.lastOutrightPoll = Date.now();
      //   }
      // }

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

      // 3. Refresh match scores (every other cycle to save API calls)
      if (this.cycleCount % 2 === 0) {
        await refreshMatches();
        // Rebuild lookup after new matches
        this.lookup = await buildTeamLookup();
      }

      // 3b. Poll Understat xG (every 4 hours — free, no auth)
      if (
        XG_ENABLED &&
        Date.now() - this.lastUnderstatPoll >= XG_POLL_INTERVAL
      ) {
        try {
          await pollUnderstatXg();
          this.lastUnderstatPoll = Date.now();
        } catch (err) {
          log.warn(
            "Understat xG poll failed",
            err instanceof Error ? err.message : err
          );
        }
      }

      // 4. Run pricing engine
      const pricingResult = await runPricingEngine();
      log.info(
        `Pricing: ${pricingResult.teamPriceRows} team_prices, ${pricingResult.matchProbRows} match_probs`
      );

      this.creditTracker.logStatus();

      // 5. Write credit stats to Supabase for frontend dashboard
      await this.writeCreditStats();

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
      credits_used_today: this.cycleCount % 2 === 0 ? 5 : 0, // 5 leagues every other cycle
      daily_budget: 100,
      last_poll_at: this.cycleCount % 2 === 0 ? now : undefined,
      poll_interval_seconds: intervalSec * 2, // runs every other cycle
      next_poll_at: new Date(Date.now() + this.lastInterval * 2).toISOString(),
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
   * Determine if we're in match-day active polling mode (5-min cycle).
   * True when: matches today + peak hours (10-22 UTC) + credit safety not exceeded.
   */
  private isMatchDayActivePolling(): boolean {
    if (!this.lookup) return false;

    const today = new Date().toISOString().slice(0, 10);
    let hasMatchesToday = false;

    for (const entries of this.lookup.byName.values()) {
      for (const entry of entries) {
        if (entry.date === today) {
          hasMatchesToday = true;
          break;
        }
      }
      if (hasMatchesToday) break;
    }

    if (!hasMatchesToday) return false;

    const hour = new Date().getUTCHours();
    if (hour < 10 || hour > 22) return false;

    // Credit safety: above 400 credits used today → not active mode
    const status = this.creditTracker.getStatus();
    if (status.usedToday > DAILY_CREDIT_SAFETY) return false;

    return true;
  }

  /**
   * Compute the next polling interval based on proximity to kickoff times.
   * Hourly baseline (60 min) runs 24/7; 5-min match-day polling overlays it
   * during peak hours if credit budget allows.
   */
  private computeNextInterval(): number {
    // If credits are critically low, fall back to hourly
    if (!this.creditTracker.canPoll()) {
      return CREDITS_FALLBACK_INTERVAL;
    }

    // Credit safety: above 400 credits used today → hourly only, no 5-min
    const status = this.creditTracker.getStatus();
    if (status.usedToday > DAILY_CREDIT_SAFETY) {
      log.warn(
        `Credit safety (${status.usedToday}/${DAILY_CREDIT_SAFETY}) — hourly-only mode`
      );
      return HOURLY_POLL_INTERVAL;
    }

    if (this.lookup) {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000)
        .toISOString()
        .slice(0, 10);

      let hasMatchesToday = false;
      let hasMatchesTomorrow = false;

      for (const entries of this.lookup.byName.values()) {
        for (const entry of entries) {
          if (entry.date === today) hasMatchesToday = true;
          if (entry.date === tomorrow) hasMatchesTomorrow = true;
        }
      }

      if (hasMatchesToday) {
        const hour = new Date().getUTCHours();

        if (hour >= 10 && hour <= 22) {
          // Peak match hours — 5-min match-day polling
          return POLL_INTERVALS.APPROACHING;
        }

        // Off-peak match day → hourly baseline
        return HOURLY_POLL_INTERVAL;
      }

      // No matches today — hourly baseline (was 120 min, now 60 min)
      return HOURLY_POLL_INTERVAL;
    }

    // Default: hourly baseline
    return HOURLY_POLL_INTERVAL;
  }
}
