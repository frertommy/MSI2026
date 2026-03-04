export interface TeamPrice {
  team: string;
  league: string;
  date: string;
  model: string;
  implied_elo: number;
  dollar_price: number;
  ema_dollar_price: number | null;
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

export interface DriftSnapshot {
  fixture_id: number;
  bookmaker: string;
  home_odds: number;
  away_odds: number;
  draw_odds: number;
  snapshot_time: string;
}

export interface PricingResult {
  teamPriceRows: number;
  matchProbRows: number;
  topTeams: { team: string; elo: number; price: number }[];
}
