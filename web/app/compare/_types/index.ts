export interface PriceRow {
  date: string;
  dollar_price: number;
  implied_elo: number;
  drift_elo: number | null;
  confidence: number;
  matches_in_window: number;
}

export interface MatchRow {
  fixture_id: number;
  date: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
}

export interface XgRow {
  fixture_id: number;
  home_team: string;
  away_team: string;
  home_xg: number;
  away_xg: number;
}

export interface ProbRow {
  fixture_id: number;
  date: string;
  home_team: string;
  away_team: string;
  implied_home_win: number;
  implied_draw: number;
  implied_away_win: number;
  bookmaker_home_win: number;
  bookmaker_draw: number;
  bookmaker_away_win: number;
}

export interface EnrichedMatch {
  fixture_id: number;
  date: string;
  opponent: string;
  isHome: boolean;
  score: string;
  status: string;
  homeGoals: number;
  awayGoals: number;
  result: 'W' | 'D' | 'L';
  teamXg: number | null;
  opponentXg: number | null;
  surprise: number | null;
  xgMult: number | null;
  priceImpact: number | null;
  postPrice: number | null;
}

export interface ChartDot {
  date: string;
  price: number;
  result: 'W' | 'D' | 'L';
  r: number;
  tooltip: string;
}

export interface HeaderStats {
  currentPrice: number;
  currentElo: number;
  seasonReturn: number | null;
  return7d: number | null;
  return30d: number | null;
  record: { w: number; d: number; l: number };
}

export interface TradingStats {
  annVol: number | null;
  currentStreak: string;
  maxWinStreak: number;
  maxLossStreak: number;
  meanReversion: number | null;
  oddsAccuracy: number | null;
  xgLuck: number | null;
  avgSurprise: number;
  upsetPct: number;
}

export interface HistogramBucket {
  bin: string;
  count: number;
  midpoint: number;
}

export const TIME_RANGES = [
  { label: '1W', days: 7 },
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: 'ALL', days: 9999 },
] as const;

export const RESULT_COLOR = { W: '#00e676', D: '#ffc107', L: '#ff1744' } as const;

export const LEAGUE_COLOR: Record<string, string> = {
  'Premier League': '#a855f7',
  'La Liga': '#fb923c',
  Bundesliga: '#f87171',
  'Serie A': '#60a5fa',
  'Ligue 1': '#22d3ee',
};

export const LEAGUE_SHORT: Record<string, string> = {
  'Premier League': 'EPL',
  'La Liga': 'ESP',
  Bundesliga: 'BUN',
  'Serie A': 'ITA',
  'Ligue 1': 'FRA',
};
