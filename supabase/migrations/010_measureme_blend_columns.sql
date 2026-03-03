-- MeasureMe v3: Add blend grid columns
ALTER TABLE measureme_results ADD COLUMN IF NOT EXISTS prematch_weight NUMERIC DEFAULT 0;
ALTER TABLE measureme_results ADD COLUMN IF NOT EXISTS zero_point NUMERIC;
ALTER TABLE measureme_results ADD COLUMN IF NOT EXISTS odds_responsiveness NUMERIC;
ALTER TABLE measureme_results ADD COLUMN IF NOT EXISTS odds_responsiveness_score NUMERIC;
ALTER TABLE measureme_results ADD COLUMN IF NOT EXISTS venue_stability NUMERIC;
ALTER TABLE measureme_results ADD COLUMN IF NOT EXISTS venue_stability_score NUMERIC;
ALTER TABLE measureme_results ADD COLUMN IF NOT EXISTS between_match_vol NUMERIC;
ALTER TABLE measureme_results ADD COLUMN IF NOT EXISTS between_match_vol_score NUMERIC;
