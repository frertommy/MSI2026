import "dotenv/config";
import { getSupabase } from "../api/supabase-client.js";
import { log } from "../logger.js";

async function main() {
  const sb = getSupabase();

  // 1. Create index on odds_snapshots
  log.info("Creating index idx_odds_fixture_time on odds_snapshots...");
  const { error: idxErr } = await sb.rpc("exec_sql", {
    sql: "CREATE INDEX IF NOT EXISTS idx_odds_fixture_time ON odds_snapshots(fixture_id, snapshot_time DESC)",
  });
  if (idxErr) {
    // RPC may not exist — try via raw query workaround
    log.warn("RPC exec_sql not available:", idxErr.message);
    log.info("Index must be created manually in Supabase SQL editor:");
    log.info("  CREATE INDEX IF NOT EXISTS idx_odds_fixture_time ON odds_snapshots(fixture_id, snapshot_time DESC);");
  } else {
    log.info("  Index created successfully");
  }

  // 2. Add commence_time column to matches
  log.info("Adding commence_time column to matches...");
  const { error: colErr } = await sb.rpc("exec_sql", {
    sql: "ALTER TABLE matches ADD COLUMN IF NOT EXISTS commence_time timestamptz",
  });
  if (colErr) {
    log.warn("RPC exec_sql not available:", colErr.message);
    log.info("Column must be added manually in Supabase SQL editor:");
    log.info("  ALTER TABLE matches ADD COLUMN IF NOT EXISTS commence_time timestamptz;");
  } else {
    log.info("  Column added successfully");
  }

  // 3. Verify by checking if we can query the column
  const { data, error } = await sb
    .from("matches")
    .select("fixture_id, commence_time")
    .limit(1);
  if (error) {
    log.warn("commence_time column may not exist yet:", error.message);
  } else {
    log.info("  Verified: commence_time column accessible");
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
