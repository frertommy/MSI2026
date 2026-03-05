-- Oracle v1.5: Live Layer support
-- Adds l_value (live layer) and m1_locked (M1 frozen at kickoff) to team_oracle_state
-- Adds l_value to oracle_price_history for live update tracking

-- team_oracle_state: live layer columns
ALTER TABLE team_oracle_state
  ADD COLUMN IF NOT EXISTS l_value NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS m1_locked NUMERIC DEFAULT NULL;

-- oracle_price_history: live layer value
ALTER TABLE oracle_price_history
  ADD COLUMN IF NOT EXISTS l_value NUMERIC DEFAULT 0;

-- Add comment for clarity
COMMENT ON COLUMN team_oracle_state.l_value IS 'Live layer: L(t) = K × (E_live − E_KR). Resets to 0 at full time.';
COMMENT ON COLUMN team_oracle_state.m1_locked IS 'M1 value frozen at kickoff. NULL when team is not in a live match.';
COMMENT ON COLUMN oracle_price_history.l_value IS 'Live layer value at time of this price history entry.';
