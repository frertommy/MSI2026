export interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
}

export interface OddsConsensus {
  fixture_id: number;
  homeProb: number;
  drawProb: number;
  awayProb: number;
}

export interface PriceHistoryRow {
  team: string;
  league: string;
  date: string;
  dollar_price: number;
  implied_elo: number;
}

export interface V2Point {
  date: string;
  elo: number;
  price: number;
}

export interface XgRow {
  fixture_id: number | null;
  date: string;
  home_team: string;
  away_team: string;
  home_xg: number;
  away_xg: number;
  home_goals: number;
  away_goals: number;
}

export interface ChartPoint {
  date: string;
  current?: number;
  v2?: number;
}

export interface StartingElo {
  team: string;
  league: string;
  startingElo: number;
}

export const LEAGUE_SHORT: Record<string, string> = {
  'Premier League': 'EPL',
  'La Liga': 'ESP',
  Bundesliga: 'BUN',
  'Serie A': 'ITA',
  'Ligue 1': 'FRA',
};

export const LEAGUE_COLOR: Record<string, string> = {
  'Premier League': '#a855f7',
  'La Liga': '#fb923c',
  Bundesliga: '#f87171',
  'Serie A': '#60a5fa',
  'Ligue 1': '#22d3ee',
};
