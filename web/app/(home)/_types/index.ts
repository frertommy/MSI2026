export interface CreditRow {
  provider: string;
  credits_remaining: number | null;
  credits_used_today: number;
  daily_budget: number;
  last_poll_at: string | null;
  poll_interval_seconds: number | null;
  next_poll_at: string | null;
}
