export interface GammaMarket {
  id: string;
  question: string;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  volumeNum: number;
  groupItemTitle?: string;
  active: boolean;
  closed: boolean;
}

export interface GammaEvent {
  id: number;
  title: string;
  volume: number;
  markets: GammaMarket[];
}

export interface ClobMidpointsResponse {
  [tokenId: string]: string;
}

export interface LiveScoreEvent {
  gameId: number;
  slug: string;
  leagueAbbreviation: string;
  homeTeam: string;
  awayTeam: string;
  status: string;
  score: string;
  period: string;
  elapsed: string;
  live: boolean;
  ended: boolean;
}
