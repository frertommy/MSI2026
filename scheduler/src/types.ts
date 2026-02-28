// ─── Odds API response types ─────────────────────────────────
export interface OddsOutcome {
  name: string;
  price: number;
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
}

export interface OddsRow {
  fixture_id: number;
  bookmaker: string;
  home_odds: number | null;
  away_odds: number | null;
  draw_odds: number | null;
  days_before_kickoff: number;
}

export interface NormalizedOdds {
  fixture_id: number;
  homeProb: number;
  drawProb: number;
  awayProb: number;
}

export interface TeamPrice {
  team: string;
  league: string;
  date: string;
  model: string;
  implied_elo: number;
  dollar_price: number;
  confidence: number;
  matches_in_window: number;
  drift_elo: number;
}

export interface MatchProb {
  fixture_id: number;
  model: string;
  date: string;
  home_team: string;
  away_team: string;
  implied_home_win: number;
  implied_draw: number;
  implied_away_win: number;
  bookmaker_home_win: number;
  bookmaker_draw: number;
  bookmaker_away_win: number;
  edge_home: number;
  edge_draw: number;
  edge_away: number;
}

// ─── Drift snapshot type ─────────────────────────────────
export interface DriftSnapshot {
  fixture_id: number;
  bookmaker: string;
  home_odds: number;
  away_odds: number;
  draw_odds: number;
  snapshot_time: string;
}

// ─── Service result types ────────────────────────────────────
export interface PollResult {
  eventsFound: number;
  oddsRowsUpserted: number;
  creditsUsed: number;
  creditsRemaining: number | null;
  unmatchedEvents: string[];
}

export interface PricingResult {
  teamPriceRows: number;
  matchProbRows: number;
  topTeams: { team: string; elo: number; price: number }[];
}

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
