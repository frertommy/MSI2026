-- Oracle v1.4 Phase 4: Mark-price feedback term (F)

-- team_oracle_state: add F value column
ALTER TABLE team_oracle_state
  ADD COLUMN IF NOT EXISTS f_value NUMERIC(10,4) NOT NULL DEFAULT 0;

-- oracle_price_history: add F value column
ALTER TABLE oracle_price_history
  ADD COLUMN IF NOT EXISTS f_value NUMERIC(10,4) NOT NULL DEFAULT 0;

COMMENT ON COLUMN team_oracle_state.f_value IS 'Mark-price feedback: F(t) = w × (MarkTWAP − NaiveIndex). Capped at ±20 Elo.';
COMMENT ON COLUMN oracle_price_history.f_value IS 'Mark-price feedback value at time of this price history entry.';
