-- MeasureMe parameter grid search results
CREATE TABLE IF NOT EXISTS measureme_results (
  id SERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  slope NUMERIC NOT NULL,
  k_factor NUMERIC NOT NULL,
  decay NUMERIC NOT NULL,
  composite_score INTEGER NOT NULL,

  -- Raw index values
  surprise_r2 NUMERIC,
  drift_neutrality NUMERIC,
  match_variance_share NUMERIC,
  kurtosis NUMERIC,
  vol_uniformity_ratio NUMERIC,
  mean_rev_sharpe NUMERIC,
  info_ratio NUMERIC,

  -- Index scores (0-100)
  surprise_r2_score INTEGER,
  drift_score INTEGER,
  match_share_score INTEGER,
  kurtosis_score INTEGER,
  vol_uni_score INTEGER,
  mean_rev_score INTEGER,
  info_score INTEGER,

  -- Summary stats
  avg_match_move_pct NUMERIC,
  avg_annual_vol NUMERIC,
  total_matches_evaluated INTEGER,
  total_teams INTEGER,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_measureme_run ON measureme_results(run_id);
CREATE INDEX idx_measureme_composite ON measureme_results(composite_score DESC);
