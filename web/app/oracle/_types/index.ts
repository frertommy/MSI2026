export interface OraclePriceRow {
  team: string;
  league: string;
  date: string;
  dollar_price: number;
  ema_dollar_price: number | null;
  implied_elo: number;
}

export interface MatchInfo {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
}

export interface PmPrice {
  team: string;
  impliedPrice: number;
  impliedProb: number;
}

export interface ChartPoint {
  date: string;
  price: number | null;
}

export interface MatchPoint {
  date: string;
  price: number;
  result: 'W' | 'D' | 'L';
}

export interface TeamStats {
  team: string;
  league: string;
  currentPrice: number;
  currentElo: number;
  seasonDelta: number | null;
  annualizedVol: number | null;
  priceRange: [number, number] | null;
  pmImpliedPrice: number | null;
  divergence: number | null;
}

export type SortKey = keyof Pick<TeamStats, 'currentPrice' | 'currentElo' | 'seasonDelta' | 'annualizedVol' | 'pmImpliedPrice' | 'divergence'>;

export const RESULT_COLOR = { W: '#00e676', D: '#ffc107', L: '#ff1744' } as const;

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
