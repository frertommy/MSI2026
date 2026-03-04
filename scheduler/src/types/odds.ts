export interface OddsOutcome {
  name: string;
  price: number;
  point?: number;
}

export interface BookmakerMarket {
  key: string;
  last_update: string;
  outcomes: OddsOutcome[];
}

export interface OddsBookmaker {
  key: string;
  title: string;
  markets: BookmakerMarket[];
}

export interface LiveOddsEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
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

export interface PollResult {
  eventsFound: number;
  oddsRowsUpserted: number;
  creditsUsed: number;
  creditsRemaining: number | null;
  unmatchedEvents: string[];
}
