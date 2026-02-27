export interface TeamRow {
  rank: number;
  team: string;
  league: string;
  avgImpliedWinProb: number;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  latestDate: string;
  dollarPrice: number | null;
}

export interface Match {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
}

export interface OddsSnapshot {
  fixture_id: number;
  bookmaker: string;
  home_odds: number | null;
  away_odds: number | null;
  draw_odds: number | null;
  days_before_kickoff: number;
  snapshot_time: string;
  source: string;
}
