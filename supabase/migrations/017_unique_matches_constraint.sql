-- Prevent duplicate fixture entries for the same match (same teams, same date).
-- The Mar 8 2026 batch ingested 15 duplicates from a secondary API source (9xxxxxxx fixture IDs)
-- which caused M1 to zero out silently for affected teams.

ALTER TABLE matches
  ADD CONSTRAINT uq_matches_teams_date UNIQUE (home_team, away_team, date);
