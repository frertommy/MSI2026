export interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
}

export interface TeamPriceRow {
  team: string;
  league: string;
  date: string;
  dollar_price: number;
  implied_elo: number;
}

export interface OddsRow {
  fixture_id: number;
  home_odds: number | null;
  away_odds: number | null;
  draw_odds: number | null;
}

export interface UpcomingMatch {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  home_elo: number;
  away_elo: number;
  home_price: number;
  away_price: number;
  league_mean_elo: number;
  bookmaker_home_prob: number | null;
  bookmaker_draw_prob: number | null;
  bookmaker_away_prob: number | null;
}

export interface OutcomeImpact {
  label: string;
  delta: number;
  pctDelta: number;
}

export interface MatchImpacts {
  win: OutcomeImpact;
  draw: OutcomeImpact;
  loss: OutcomeImpact;
}

export interface MatchProbs {
  home: number;
  draw: number;
  away: number;
  source: 'odds' | 'elo';
}

export interface EnrichedMatch extends UpcomingMatch {
  homeImpacts: MatchImpacts;
  awayImpacts: MatchImpacts;
  probs: MatchProbs;
}
