-- Phase 4: Live In-Play Pricing — sub-daily price snapshots during live matches
CREATE TABLE IF NOT EXISTS live_prices (
  id BIGSERIAL PRIMARY KEY,
  team TEXT NOT NULL,
  league TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  model TEXT NOT NULL DEFAULT 'oracle',
  implied_elo NUMERIC NOT NULL,
  dollar_price NUMERIC NOT NULL,
  blend_mode TEXT NOT NULL DEFAULT 'live',
  fixture_id INTEGER,
  UNIQUE(team, timestamp, model)
);

CREATE INDEX IF NOT EXISTS idx_live_prices_team_ts
  ON live_prices (team, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_live_prices_fixture
  ON live_prices (fixture_id, timestamp DESC);
