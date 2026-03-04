-- Stage 3: V1 Oracle — frozen KR snapshots, atomic settlement, price history
-- Three new tables + one constraint. Touches nothing existing.

-- ─── oracle_kr_snapshots ──────────────────────────────────────
-- One row per fixture: the frozen pre-kickoff odds consensus used for settlement.
-- Written once by freezeKR(), never updated. Settlement reads from here exclusively.
CREATE TABLE IF NOT EXISTS oracle_kr_snapshots (
  fixture_id           BIGINT          PRIMARY KEY,
  freeze_timestamp     TIMESTAMPTZ     NOT NULL DEFAULT now(),
  bookmaker_count      INT             NOT NULL,
  bookmakers_used      JSONB           NOT NULL,
  home_prob            NUMERIC(10,6)   NOT NULL,
  draw_prob            NUMERIC(10,6)   NOT NULL,
  away_prob            NUMERIC(10,6)   NOT NULL,
  home_expected_score  NUMERIC(10,6)   NOT NULL,
  away_expected_score  NUMERIC(10,6)   NOT NULL,
  raw_snapshots        JSONB           NOT NULL,
  method               TEXT            NOT NULL DEFAULT 'consensus_devigged_v1',
  created_at           TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- ─── settlement_log unique constraint ─────────────────────────
-- Prevents duplicate (fixture_id, team_id) entries — atomic settlement safety.
-- If the constraint already exists (e.g. from a re-run), skip gracefully.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_settlement_log_fixture_team'
  ) THEN
    ALTER TABLE settlement_log
      ADD CONSTRAINT uq_settlement_log_fixture_team UNIQUE (fixture_id, team_id);
  END IF;
END $$;

-- ─── oracle_price_history ─────────────────────────────────────
-- Append-only time series: every price publication (settlement, M1 refresh, bootstrap).
CREATE TABLE IF NOT EXISTS oracle_price_history (
  id                   BIGSERIAL       PRIMARY KEY,
  team                 TEXT            NOT NULL,
  league               TEXT            NOT NULL,
  timestamp            TIMESTAMPTZ     NOT NULL DEFAULT now(),
  B_value              NUMERIC(10,4)   NOT NULL,
  M1_value             NUMERIC(10,4)   NOT NULL,
  published_index      NUMERIC(10,4)   NOT NULL,
  confidence_score     NUMERIC(6,4),
  source_fixture_id    BIGINT,
  publish_reason       TEXT            NOT NULL,
  created_at           TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- ─── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_oracle_price_history_team_ts
  ON oracle_price_history (team, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_oracle_price_history_ts
  ON oracle_price_history (timestamp DESC);

-- ─── RLS ──────────────────────────────────────────────────────
ALTER TABLE oracle_kr_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon read" ON oracle_kr_snapshots FOR SELECT USING (true);
CREATE POLICY "Allow service write" ON oracle_kr_snapshots FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE oracle_price_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon read" ON oracle_price_history FOR SELECT USING (true);
CREATE POLICY "Allow service write" ON oracle_price_history FOR ALL USING (true) WITH CHECK (true);
