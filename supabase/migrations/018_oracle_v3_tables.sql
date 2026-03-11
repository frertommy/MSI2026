-- Oracle V3: team state table + BT snapshots + settlement_log fix
-- Must run before backfill.

-- ─── team_oracle_v3_state ───────────────────────────────────
CREATE TABLE IF NOT EXISTS team_oracle_v3_state (
  team_id              TEXT           PRIMARY KEY,
  league               TEXT,
  season               TEXT,
  b_value              NUMERIC(10,4)  NOT NULL DEFAULT 0,
  m1_value             NUMERIC(10,4)  NOT NULL DEFAULT 0,
  l_value              NUMERIC(10,4)  NOT NULL DEFAULT 0,
  r_network            NUMERIC(10,4),
  r_next               NUMERIC(10,4),
  r_market             NUMERIC(10,4),
  published_index      NUMERIC(10,4)  NOT NULL DEFAULT 0,
  next_fixture_id      BIGINT,
  m1_locked            NUMERIC(10,4),
  r_market_frozen      NUMERIC(10,4),
  confidence_score     NUMERIC(6,4),
  bt_std_error         NUMERIC(10,4),
  last_bt_solve_ts     TIMESTAMPTZ,
  last_settlement_ts   TIMESTAMPTZ,
  last_kr_fixture_id   BIGINT,
  last_market_refresh_ts TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ    NOT NULL DEFAULT now()
);

ALTER TABLE team_oracle_v3_state ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='team_oracle_v3_state' AND policyname='Allow anon read') THEN
    CREATE POLICY "Allow anon read" ON team_oracle_v3_state FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='team_oracle_v3_state' AND policyname='Allow service write') THEN
    CREATE POLICY "Allow service write" ON team_oracle_v3_state FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─── oracle_bt_snapshots ────────────────────────────────────
CREATE TABLE IF NOT EXISTS oracle_bt_snapshots (
  id                   BIGSERIAL       PRIMARY KEY,
  league               TEXT            NOT NULL,
  solve_timestamp      TIMESTAMPTZ     NOT NULL DEFAULT now(),
  trigger_type         TEXT            NOT NULL DEFAULT 'settlement',
  trigger_fixture_id   BIGINT,
  fixtures_used        INTEGER         NOT NULL,
  teams_count          INTEGER         NOT NULL,
  iterations           INTEGER         NOT NULL,
  max_step             NUMERIC(10,6),
  converged            BOOLEAN         DEFAULT true,
  sigma_prior          NUMERIC(10,2)   NOT NULL,
  home_adv             NUMERIC(10,2)   NOT NULL,
  window_days          INTEGER,
  ratings              JSONB           NOT NULL,
  std_errors           JSONB           NOT NULL,
  prior_means          JSONB,
  fixtures_detail      JSONB
);

CREATE INDEX IF NOT EXISTS idx_bt_snapshots_league_ts
  ON oracle_bt_snapshots (league, solve_timestamp DESC);

ALTER TABLE oracle_bt_snapshots ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='oracle_bt_snapshots' AND policyname='Allow anon read') THEN
    CREATE POLICY "Allow anon read" ON oracle_bt_snapshots FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='oracle_bt_snapshots' AND policyname='Allow service write') THEN
    CREATE POLICY "Allow service write" ON oracle_bt_snapshots FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─── settlement_log: add oracle_version + gravity columns ───
ALTER TABLE settlement_log
  ADD COLUMN IF NOT EXISTS oracle_version TEXT DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS gravity_component NUMERIC(10,6);

-- Fix unique constraint: UNIQUE(fixture_id, team_id, oracle_version)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_settlement_log_fixture_team') THEN
    ALTER TABLE settlement_log DROP CONSTRAINT uq_settlement_log_fixture_team;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_settlement_log_fixture_team_version') THEN
    ALTER TABLE settlement_log
      ADD CONSTRAINT uq_settlement_log_fixture_team_version UNIQUE (fixture_id, team_id, oracle_version);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_settlement_log_version
  ON settlement_log (oracle_version, fixture_id);
