import { CREDITS_DAILY_SOFT_LIMIT } from "../config.js";
import { log } from "../logger.js";
import type { CreditStatus } from "../types.js";

export class CreditTracker {
  private usedToday = 0;
  private lastRemaining: number | null = null;
  private resetDate: string; // YYYY-MM-DD in UTC

  constructor() {
    this.resetDate = this.todayUTC();
  }

  private todayUTC(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private checkReset(): void {
    const today = this.todayUTC();
    if (today !== this.resetDate) {
      log.info(`Credit tracker reset for new day (${this.resetDate} → ${today}), was ${this.usedToday} credits`);
      this.usedToday = 0;
      this.resetDate = today;
    }
  }

  /** Record credits used after an API call. */
  recordUsage(creditsUsed: number, creditsRemaining: number | null): void {
    this.checkReset();
    this.usedToday += creditsUsed;
    if (creditsRemaining !== null) {
      this.lastRemaining = creditsRemaining;
    }
  }

  /** Can we afford another poll cycle? (5 credits for 5 leagues) */
  canPoll(): boolean {
    this.checkReset();
    // Check our soft daily limit
    if (this.usedToday + 5 > CREDITS_DAILY_SOFT_LIMIT) {
      log.warn(`Daily credit soft limit reached: ${this.usedToday}/${CREDITS_DAILY_SOFT_LIMIT}`);
      return false;
    }
    // Check Odds API reported remaining
    if (this.lastRemaining !== null && this.lastRemaining < 10) {
      log.warn(`Odds API credits critically low: ${this.lastRemaining} remaining`);
      return false;
    }
    return true;
  }

  getStatus(): CreditStatus {
    this.checkReset();
    // Next reset is midnight UTC of the next day
    const tomorrow = new Date(this.resetDate + "T00:00:00Z");
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    return {
      usedToday: this.usedToday,
      remaining: this.lastRemaining,
      canPoll: this.canPoll(),
      resetAt: tomorrow.toISOString(),
    };
  }

  logStatus(): void {
    const s = this.getStatus();
    log.info(
      `Credits: ${s.usedToday} used today / ${CREDITS_DAILY_SOFT_LIMIT} limit` +
        (s.remaining !== null ? `, API reports ${s.remaining} remaining` : "")
    );
  }
}
