// ─── Odds API response types ─────────────────────────────────
export interface OddsOutcome {
  name: string;
  price: number;
  point?: number;  // for totals (2.5) and spreads (-1.5)
}

export interface BookmakerMarket {
  key: string; // "h2h"
  last_update: string;
  outcomes: OddsOutcome[];
}

export interface OddsBookmaker {
  key: string; // e.g. "pinnacle", "betfair"
  title: string;
  markets: BookmakerMarket[];
}

export interface LiveOddsEvent {
  id: string;
  sport_key: string;
  commence_time: string; // ISO 8601
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
}

// ─── Supabase row types ──────────────────────────────────────
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

export interface OddsRow {
  fixture_id: number;
  bookmaker: string;
  home_odds: number | null;
  away_odds: number | null;
  draw_odds: number | null;
  days_before_kickoff: number;
}

// ─── Legacy types (removed — pricing-engine retired) ─────
// NormalizedOdds, TeamPrice, MatchProb, DriftSnapshot, LivePrice
// See git history if needed.

// ─── Service result types ────────────────────────────────────
export interface PollResult {
  eventsFound: number;
  oddsRowsUpserted: number;
  creditsUsed: number;
  creditsRemaining: number | null;
  unmatchedEvents: string[];
}

// PricingResult removed — pricing-engine retired

export interface CreditStatus {
  usedToday: number;
  remaining: number | null;
  canPoll: boolean;
  resetAt: string; // ISO timestamp
}

export interface HealthStatus {
  status: "ok" | "degraded" | "error";
  uptime: number;
  lastPoll: string | null;
  lastPollResult: PollResult | null;
  credits: CreditStatus | null;
  nextPollIn: number | null;
}

// ─── Team lookup ─────────────────────────────────────────────
export interface MatchLookupEntry {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
}
