-- 009: Add odds_snapshots index + commence_time to matches
-- Critical for Phase 2 odds blend — without this index,
-- looking up latest odds per fixture scans the entire 2M+ row table.

CREATE INDEX IF NOT EXISTS idx_odds_fixture_time
ON odds_snapshots(fixture_id, snapshot_time DESC);

-- Add commence_time column to matches table.
-- The odds poller already has commence_time from the API.
-- Enables sub-day weight resolution in future live mode.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS commence_time timestamptz;
