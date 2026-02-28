-- Outright futures (league winner odds)
CREATE TABLE IF NOT EXISTS outright_odds (
  id serial PRIMARY KEY,
  league text NOT NULL,
  team text NOT NULL,
  bookmaker text NOT NULL,
  outright_odds float NOT NULL,
  implied_prob float NOT NULL,
  snapshot_time timestamptz NOT NULL DEFAULT now(),
  UNIQUE(league, team, bookmaker, snapshot_time)
);
ALTER TABLE outright_odds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon read" ON outright_odds FOR SELECT USING (true);
CREATE POLICY "Allow service write" ON outright_odds FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX idx_outright_odds_team ON outright_odds(team);
CREATE INDEX idx_outright_odds_snapshot ON outright_odds(snapshot_time);

-- Totals (over/under goals)
CREATE TABLE IF NOT EXISTS totals_snapshots (
  id serial PRIMARY KEY,
  fixture_id integer NOT NULL,
  bookmaker text NOT NULL,
  point float NOT NULL,
  over_odds float NOT NULL,
  under_odds float NOT NULL,
  snapshot_time timestamptz NOT NULL DEFAULT now(),
  source text DEFAULT 'the-odds-api-live',
  UNIQUE(fixture_id, bookmaker, snapshot_time)
);
ALTER TABLE totals_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon read" ON totals_snapshots FOR SELECT USING (true);
CREATE POLICY "Allow service write" ON totals_snapshots FOR ALL USING (true) WITH CHECK (true);

-- Spreads (Asian handicap)
CREATE TABLE IF NOT EXISTS spreads_snapshots (
  id serial PRIMARY KEY,
  fixture_id integer NOT NULL,
  bookmaker text NOT NULL,
  home_point float NOT NULL,
  home_odds float NOT NULL,
  away_point float NOT NULL,
  away_odds float NOT NULL,
  snapshot_time timestamptz NOT NULL DEFAULT now(),
  source text DEFAULT 'the-odds-api-live',
  UNIQUE(fixture_id, bookmaker, snapshot_time)
);
ALTER TABLE spreads_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon read" ON spreads_snapshots FOR SELECT USING (true);
CREATE POLICY "Allow service write" ON spreads_snapshots FOR ALL USING (true) WITH CHECK (true);
