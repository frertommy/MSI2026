-- Run this in the Supabase Dashboard SQL Editor:
-- Dashboard → SQL Editor → New Query → Paste → Run

CREATE TABLE IF NOT EXISTS api_credits (
  id serial PRIMARY KEY,
  provider text NOT NULL UNIQUE,
  credits_remaining integer,
  credits_used_today integer NOT NULL DEFAULT 0,
  daily_budget integer NOT NULL DEFAULT 450,
  last_poll_at timestamptz,
  poll_interval_seconds integer,
  next_poll_at timestamptz
);

-- Seed initial rows
INSERT INTO api_credits (provider, daily_budget)
VALUES ('odds_api', 450), ('api_football', 100)
ON CONFLICT (provider) DO NOTHING;

-- Enable RLS but allow anon read access (for frontend dashboard)
ALTER TABLE api_credits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read" ON api_credits
  FOR SELECT USING (true);

CREATE POLICY "Allow service write" ON api_credits
  FOR ALL USING (true) WITH CHECK (true);
