export interface TeamRow {
  rank: number;
  team: string;
  league: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  latestDate: string;
  dollarPrice: number | null;
  impliedElo: number | null;
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
