-- Match xG data from Understat
CREATE TABLE IF NOT EXISTS match_xg (
  understat_id    TEXT        PRIMARY KEY,
  league          TEXT        NOT NULL,
  date            TEXT        NOT NULL,
  home_team       TEXT        NOT NULL,
  away_team       TEXT        NOT NULL,
  home_goals      INT         NOT NULL,
  away_goals      INT         NOT NULL,
  home_xg         REAL        NOT NULL,
  away_xg         REAL        NOT NULL,
  home_forecast_win REAL,
  away_forecast_win REAL,
  draw_forecast     REAL,
  fixture_id      BIGINT      REFERENCES matches(fixture_id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_match_xg_fixture_id ON match_xg (fixture_id);
CREATE INDEX IF NOT EXISTS idx_match_xg_date ON match_xg (date);
CREATE INDEX IF NOT EXISTS idx_match_xg_date_teams ON match_xg (date, home_team, away_team);
