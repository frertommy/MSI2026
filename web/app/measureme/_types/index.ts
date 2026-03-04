export interface MeasureMeRow {
  id: number;
  run_id: string;
  slope: number;
  k_factor: number;
  decay: number;
  zero_point: number;
  composite_score: number;
  prematch_weight: number;
  surprise_r2: number;
  drift_neutrality: number;
  floor_hit_pct: number;
  kurtosis: number;
  vol_uniformity_ratio: number;
  mean_rev_sharpe: number;
  info_ratio: number;
  odds_responsiveness: number;
  venue_stability: number;
  between_match_vol: number;
  surprise_r2_score: number;
  drift_score: number;
  floor_hit_score: number;
  kurtosis_score: number;
  vol_uni_score: number;
  mean_rev_score: number;
  info_score: number;
  odds_responsiveness_score: number;
  venue_stability_score: number;
  between_match_vol_score: number;
  avg_match_move_pct: number;
  avg_annual_vol: number;
  total_matches_evaluated: number;
  total_teams: number;
  teams_at_floor: number;
}

export interface TeamEloRow {
  team: string;
  implied_elo: number;
}

export type NumericKey =
  | 'k_factor' | 'decay' | 'zero_point' | 'prematch_weight' | 'composite_score'
  | 'surprise_r2_score' | 'drift_score' | 'floor_hit_score' | 'kurtosis_score'
  | 'vol_uni_score' | 'mean_rev_score' | 'info_score' | 'odds_responsiveness_score'
  | 'venue_stability_score' | 'between_match_vol_score' | 'avg_match_move_pct' | 'avg_annual_vol';

export type SortCol = 'rank' | NumericKey;

export const INDEX_DEFS = [
  { key: 'surprise_r2_score' as const, rawKey: 'surprise_r2' as const, name: 'Surprise R²', weight: '20%', description: 'How well price moves correlate with match surprise magnitude', target: 'Higher is better (R² × 143, cap 100)', rawFmt: (v: number) => v.toFixed(4) },
  { key: 'drift_score' as const, rawKey: 'drift_neutrality' as const, name: 'Drift Neutrality', weight: '8%', description: 'Mean daily price return across all teams should be ~0%', target: 'Closer to 0 is better', rawFmt: (v: number) => (v * 100).toFixed(4) + '%' },
  { key: 'floor_hit_score' as const, rawKey: 'floor_hit_pct' as const, name: 'Floor Hit %', weight: '5%', description: '% of team-day prices at $10 floor — price discovery stops', target: '0% ideal (lower is better)', rawFmt: (v: number) => v.toFixed(2) + '%' },
  { key: 'kurtosis_score' as const, rawKey: 'kurtosis' as const, name: 'Return Kurtosis', weight: '5%', description: 'Tail thickness of return distribution (m4/m2²)', target: '4–10 ideal', rawFmt: (v: number) => v.toFixed(2) },
  { key: 'vol_uni_score' as const, rawKey: 'vol_uniformity_ratio' as const, name: 'Vol Uniformity', weight: '5%', description: 'Max/min annualized vol across Elo tiers (top/mid/bot 25%)', target: '< 1.5× ideal', rawFmt: (v: number) => v.toFixed(2) + '×' },
  { key: 'mean_rev_score' as const, rawKey: 'mean_rev_sharpe' as const, name: 'MR Sharpe', weight: '15%', description: 'Mean-reversion strategy Sharpe (long loss, short win, 3d)', target: '|SR| < 0.3 ideal (no free lunch)', rawFmt: (v: number) => v.toFixed(3) },
  { key: 'info_score' as const, rawKey: 'info_ratio' as const, name: 'Information Ratio', weight: '10%', description: 'Spearman: final price rank vs actual league points', target: 'Higher is better (×110, cap 100)', rawFmt: (v: number) => v.toFixed(3) },
  { key: 'odds_responsiveness_score' as const, rawKey: 'odds_responsiveness' as const, name: 'Odds Responsive', weight: '15%', description: 'Correlation between odds changes and price moves on non-match days', target: 'Higher is better (×125, cap 100)', rawFmt: (v: number) => v.toFixed(3) },
  { key: 'venue_stability_score' as const, rawKey: 'venue_stability' as const, name: 'Venue Stability', weight: '10%', description: 'Price move ratio on fixture-transition days vs normal non-match days', target: 'Ratio ≈ 1.0 ideal', rawFmt: (v: number) => v.toFixed(2) + '×' },
  { key: 'between_match_vol_score' as const, rawKey: 'between_match_vol' as const, name: 'Between-Match Vol', weight: '7%', description: 'Annualized vol of non-match-day price returns', target: '≥20% ideal (prices move between matches)', rawFmt: (v: number) => v.toFixed(1) + '%' },
] as const;

export const SLOPE_OPTIONS = [3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 8, 9, 10];
export const INITIAL_TABLE_ROWS = 50;
