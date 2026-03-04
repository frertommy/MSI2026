export interface Match {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
  status_code?: string;
}

export interface MatchLookupEntry {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
}

export interface CreditStatus {
  usedToday: number;
  remaining: number | null;
  canPoll: boolean;
  resetAt: string;
}

export interface HealthStatus {
  status: "ok" | "degraded" | "error";
  uptime: number;
  lastPoll: string | null;
  lastPollResult: import("./odds.js").PollResult | null;
  credits: CreditStatus | null;
  nextPollIn: number | null;
}
