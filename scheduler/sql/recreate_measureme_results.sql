-- MeasureMe v2: Drop and recreate with new schema (adds zero_point, renames columns)
-- Run via psql before running the measureme script:
--   psql "postgresql://postgres.kbxwyeacmszphbwgdexj:VDliC7JX4kfesRI6@aws-1-eu-central-1.pooler.supabase.com:5432/postgres" -f scheduler/sql/recreate_measureme_results.sql

DROP TABLE IF EXISTS measureme_results;

CREATE TABLE measureme_results (
  id SERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  slope NUMERIC NOT NULL,
  k_factor NUMERIC NOT NULL,
  decay NUMERIC NOT NULL,
  zero_point NUMERIC NOT NULL,
  composite_score INTEGER NOT NULL,

  -- Raw index values
  surprise_r2 NUMERIC,
  drift_neutrality NUMERIC,
  floor_hit_pct NUMERIC,
  kurtosis NUMERIC,
  vol_uniformity_ratio NUMERIC,
  mean_rev_sharpe NUMERIC,
  info_ratio NUMERIC,

  -- Index scores (0-100)
  surprise_r2_score INTEGER,
  drift_score INTEGER,
  floor_hit_score INTEGER,
  kurtosis_score INTEGER,
  vol_uni_score INTEGER,
  mean_rev_score INTEGER,
  info_score INTEGER,

  -- Summary stats
  avg_match_move_pct NUMERIC,
  avg_annual_vol NUMERIC,
  total_matches_evaluated INTEGER,
  total_teams INTEGER,
  teams_at_floor INTEGER,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_measureme_run ON measureme_results(run_id);
CREATE INDEX idx_measureme_composite ON measureme_results(composite_score DESC);
