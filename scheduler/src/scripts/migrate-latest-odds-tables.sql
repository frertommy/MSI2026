-- ================================================================
-- Migration: latest_odds + latest_preko_odds serving tables
-- Run this in the Supabase SQL Editor.
-- ================================================================

-- 1. latest_odds — globally latest snapshot per (fixture, bookmaker)
-- Used by: oracle-v1-live.ts, web pages
CREATE TABLE IF NOT EXISTS latest_odds (
  fixture_id    integer      NOT NULL,
  bookmaker     text         NOT NULL,
  home_odds     numeric,
  draw_odds     numeric,
  away_odds     numeric,
  snapshot_time timestamptz  NOT NULL,
  source        text         NOT NULL DEFAULT 'the-odds-api-live',
  PRIMARY KEY (fixture_id, bookmaker)
);

-- 2. latest_preko_odds — latest PRE-KICKOFF snapshot per (fixture, bookmaker)
-- Used by: oracle-v1-market.ts (refreshM1), oracle-v1-settlement.ts (freezeKR primary)
-- Write rule: only upserted when snapshot_time < kickoff_time
CREATE TABLE IF NOT EXISTS latest_preko_odds (
  fixture_id    integer      NOT NULL,
  bookmaker     text         NOT NULL,
  home_odds     numeric,
  draw_odds     numeric,
  away_odds     numeric,
  snapshot_time timestamptz  NOT NULL,
  source        text         NOT NULL DEFAULT 'the-odds-api-live',
  PRIMARY KEY (fixture_id, bookmaker)
);

-- 3. Archive index — makes freezeKR fallback + any archive queries fast
-- DISTINCT ON (bookmaker) ... ORDER BY bookmaker, snapshot_time DESC
-- scans this index instead of seq-scanning 2.5M+ rows
CREATE INDEX IF NOT EXISTS idx_odds_snapshots_fixture_book_time
ON odds_snapshots (fixture_id, bookmaker, snapshot_time DESC);

-- 4. Optional: simple index for fixture-only lookups on serving tables
CREATE INDEX IF NOT EXISTS idx_latest_odds_fixture
ON latest_odds (fixture_id);

CREATE INDEX IF NOT EXISTS idx_latest_preko_odds_fixture
ON latest_preko_odds (fixture_id);

-- 5. Backfill latest_odds from current archive
-- This populates the serving tables from existing data so consumers
-- work immediately after migration (no need to wait for the next poll cycle).
INSERT INTO latest_odds (fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time, source)
SELECT DISTINCT ON (fixture_id, bookmaker)
  fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time,
  COALESCE(source, 'the-odds-api-live')
FROM odds_snapshots
ORDER BY fixture_id, bookmaker, snapshot_time DESC
ON CONFLICT (fixture_id, bookmaker) DO NOTHING;

-- 6. Backfill latest_preko_odds from current archive
-- Only rows where snapshot_time < the match's commence_time (or date+23:59:59)
INSERT INTO latest_preko_odds (fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time, source)
SELECT DISTINCT ON (os.fixture_id, os.bookmaker)
  os.fixture_id, os.bookmaker, os.home_odds, os.draw_odds, os.away_odds, os.snapshot_time,
  COALESCE(os.source, 'the-odds-api-live')
FROM odds_snapshots os
JOIN matches m ON m.fixture_id = os.fixture_id
WHERE os.snapshot_time < COALESCE(m.commence_time, (m.date || 'T23:59:59Z')::timestamptz)
ORDER BY os.fixture_id, os.bookmaker, os.snapshot_time DESC
ON CONFLICT (fixture_id, bookmaker) DO NOTHING;

-- Done. Enable RLS policies if needed (match your odds_snapshots policies).
