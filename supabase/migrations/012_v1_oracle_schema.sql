-- Stage 2: V1 Oracle — team state + settlement audit log
-- Two new tables. Touches nothing existing.

-- ─── team_oracle_state ───────────────────────────────────────
-- One row per team: holds B (permanent base), M1 (market overlay),
-- published index, and pointers for KR / next fixture.
CREATE TABLE IF NOT EXISTS team_oracle_state (
  team_id              TEXT           PRIMARY KEY,
  season               TEXT,
  B_value              NUMERIC(10,4)  NOT NULL DEFAULT 0,
  M1_value             NUMERIC(10,4)  NOT NULL DEFAULT 0,
  published_index      NUMERIC(10,4)  NOT NULL DEFAULT 0,
  next_fixture_id      BIGINT,
  confidence_score     NUMERIC(6,4),
  last_kr_fixture_id   BIGINT,
  last_market_refresh_ts TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- ─── settlement_log ─────────────────────────────────────────
-- Append-only audit trail: one row per team per settled match.
-- Captures E_KR, actual S, delta_B, before/after B, and a
-- JSONB trace blob for full reproducibility.
CREATE TABLE IF NOT EXISTS settlement_log (
  settlement_id  BIGSERIAL       PRIMARY KEY,
  fixture_id     BIGINT          NOT NULL,
  team_id        TEXT            NOT NULL,
  E_KR           NUMERIC(10,6)  NOT NULL,
  actual_score_S NUMERIC(4,2)   NOT NULL,
  delta_B        NUMERIC(10,6)  NOT NULL,
  B_before       NUMERIC(10,6)  NOT NULL,
  B_after        NUMERIC(10,6)  NOT NULL,
  settled_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
  trace_payload  JSONB
);

-- ─── Indexes ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_settlement_log_team_settled
  ON settlement_log (team_id, settled_at DESC);

CREATE INDEX IF NOT EXISTS idx_settlement_log_fixture
  ON settlement_log (fixture_id);

-- ─── RLS: anon read, service write ──────────────────────────
ALTER TABLE team_oracle_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon read" ON team_oracle_state FOR SELECT USING (true);
CREATE POLICY "Allow service write" ON team_oracle_state FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE settlement_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon read" ON settlement_log FOR SELECT USING (true);
CREATE POLICY "Allow service write" ON settlement_log FOR ALL USING (true) WITH CHECK (true);
