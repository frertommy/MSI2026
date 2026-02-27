-- Run this in the Supabase Dashboard SQL Editor:
-- Dashboard → SQL Editor → New Query → Paste → Run

CREATE TABLE IF NOT EXISTS analytics_exports (
  id serial PRIMARY KEY,
  exported_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL
);

-- Index for fast latest-export lookup
CREATE INDEX IF NOT EXISTS idx_analytics_exports_exported_at
  ON analytics_exports (exported_at DESC);

-- Enable RLS: anon can read, service can write
ALTER TABLE analytics_exports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read" ON analytics_exports
  FOR SELECT USING (true);

CREATE POLICY "Allow service write" ON analytics_exports
  FOR ALL USING (true) WITH CHECK (true);
