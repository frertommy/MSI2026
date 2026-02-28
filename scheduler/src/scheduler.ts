import {
  POLL_INTERVALS,
  CREDITS_FALLBACK_INTERVAL,
  CREDITS_DAILY_SOFT_LIMIT,
  OUTRIGHT_POLL_INTERVAL,
} from "./config.js";
import { log } from "./logger.js";
import { updateHealth } from "./health.js";
import { getSupabase } from "./api/supabase-client.js";
import { pollOdds, pollOutrights } from "./services/odds-poller.js";
import { refreshMatches } from "./services/match-tracker.js";
import { runPricingEngine } from "./services/pricing-engine.js";
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
    log.info(`═══ Cycle #${this.cycleCount} starting ═══`);

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
      }

      // 2b. Poll outrights (every 6 hours)
      if (Date.now() - this.lastOutrightPoll >= OUTRIGHT_POLL_INTERVAL) {
        if (this.creditTracker.canPoll()) {
          await pollOutrights(this.lookup!, this.creditTracker);
          this.lastOutrightPoll = Date.now();
        } else {
          log.warn("Skipping outright poll — credit limit reached");
        }
      }

      // 3. Refresh match scores (every other cycle to save API calls)
      if (this.cycleCount % 2 === 0) {
        await refreshMatches();
        // Rebuild lookup after new matches
        this.lookup = await buildTeamLookup();
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
   * Compute the next polling interval based on proximity to kickoff times.
   * Uses commence_times from the latest poll results + Supabase matches.
   */
  private computeNextInterval(): number {
    // If credits are low, fall back to hourly
    if (!this.creditTracker.canPoll()) {
      return CREDITS_FALLBACK_INTERVAL;
    }

    const now = Date.now();

    // Gather commence times from last poll
    // (We don't store them directly, but we can check the next match date from lookup)
    if (this.lookup) {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000)
        .toISOString()
        .slice(0, 10);

      // Check if there are matches today or tomorrow
      let hasMatchesToday = false;
      let hasMatchesTomorrow = false;

      for (const entries of this.lookup.byName.values()) {
        for (const entry of entries) {
          if (entry.date === today) hasMatchesToday = true;
          if (entry.date === tomorrow) hasMatchesTomorrow = true;
        }
      }

      if (!hasMatchesToday && !hasMatchesTomorrow) {
        return POLL_INTERVALS.NO_MATCHES_TODAY;
      }

      if (hasMatchesToday) {
        // Approximate: most matches kick off between 12:00 and 21:00 UTC
        // Without exact commence times, use a reasonable default
        const hour = new Date().getUTCHours();

        if (hour >= 10 && hour <= 22) {
          // Peak match hours — poll frequently
          return POLL_INTERVALS.APPROACHING; // 5 min
        }

        return POLL_INTERVALS.FAR_FROM_KICKOFF; // 60 min
      }
    }

    // Default: far from kickoff
    return POLL_INTERVALS.FAR_FROM_KICKOFF;
  }
}
