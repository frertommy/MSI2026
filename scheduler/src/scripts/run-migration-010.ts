import "dotenv/config";
import { getSupabase } from "../core/supabase.js";
import { log } from "../core/logger.js";

const SQL_LIVE_SCORES = `
CREATE TABLE IF NOT EXISTS polymarket_live_scores (
  game_id    TEXT PRIMARY KEY,
  slug       TEXT,
  home_team  TEXT,
  away_team  TEXT,
  status     TEXT,
  score      TEXT,
  period     TEXT,
  elapsed    TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
`;

const SQL_CLOB_PRICES = `
CREATE TABLE IF NOT EXISTS polymarket_clob_prices (
  token_id    TEXT,
  event_slug  TEXT,
  outcome     TEXT,
  mid_price   NUMERIC,
  snapshot_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (token_id, snapshot_at)
);

CREATE INDEX IF NOT EXISTS polymarket_clob_prices_token_time
  ON polymarket_clob_prices (token_id, snapshot_at DESC);
`;

async function main() {
  const sb = getSupabase();

  log.info("Running migration 010 — polymarket live tables...");

  const { error: e1 } = await sb.rpc("exec_sql", { sql: SQL_LIVE_SCORES });
  if (e1) {
    log.warn("polymarket_live_scores: " + e1.message + " (may already exist)");
  } else {
    log.info("polymarket_live_scores OK");
  }

  const { error: e2 } = await sb.rpc("exec_sql", { sql: SQL_CLOB_PRICES });
  if (e2) {
    log.warn("polymarket_clob_prices: " + e2.message + " (may already exist)");
  } else {
    log.info("polymarket_clob_prices OK");
  }

  log.info("Migration 010 complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
