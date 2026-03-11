/**
 * reseed-v3.ts — Seed Oracle V3 state from V2 state.
 *
 * Copies team_oracle_v2_state → team_oracle_v3_state with M1=0 (fresh start).
 * Sets r_network = r_next = r_market = B (initial until first BT solve).
 * Writes bootstrap_v3 price history entries.
 *
 * Usage:
 *   cd scheduler && npx tsx src/scripts/reseed-v3.ts
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

async function main(): Promise<void> {
  console.log("Reseeding Oracle V3 from V2 state...\n");

  // Step 1: Read all V2 state
  const { data: v2Rows, error: v2Err } = await sb
    .from("team_oracle_v2_state")
    .select("team_id, season, b_value");

  if (v2Err) {
    console.error("Failed to read team_oracle_v2_state:", v2Err.message);
    process.exit(1);
  }

  if (!v2Rows || v2Rows.length === 0) {
    console.error("No rows in team_oracle_v2_state — nothing to seed from");
    process.exit(1);
  }

  console.log(`Found ${v2Rows.length} teams in V2 state\n`);

  // Step 2: Build team → league lookup
  const { data: leagueLookup } = await sb
    .from("matches")
    .select("home_team, league")
    .order("date", { ascending: false })
    .limit(500);

  const teamLeagueMap = new Map<string, string>();
  if (leagueLookup) {
    for (const m of leagueLookup) {
      if (!teamLeagueMap.has(m.home_team)) {
        teamLeagueMap.set(m.home_team, m.league);
      }
    }
  }

  // Step 3: Upsert into V3 state
  const now = new Date().toISOString();
  let upserted = 0;
  let errors = 0;

  for (const row of v2Rows) {
    const B = Number(Number(row.b_value).toFixed(4));
    const league = teamLeagueMap.get(row.team_id) ?? null;

    const v3Row = {
      team_id: row.team_id,
      league,
      season: row.season,
      b_value: B,
      m1_value: 0,
      l_value: 0,
      r_network: B,
      r_next: B,
      r_market: B,
      published_index: B,
      next_fixture_id: null,
      m1_locked: null,
      r_market_frozen: null,
      confidence_score: 0,
      bt_std_error: null,
      last_bt_solve_ts: null,
      last_settlement_ts: null,
      last_kr_fixture_id: null,
      last_market_refresh_ts: null,
      updated_at: now,
    };

    const { error: upsertErr } = await sb
      .from("team_oracle_v3_state")
      .upsert([v3Row], { onConflict: "team_id" });

    if (upsertErr) {
      console.error(`  ${row.team_id}: ${upsertErr.message}`);
      errors++;
    } else {
      upserted++;
    }
  }

  console.log(`\nUpserted ${upserted} teams into team_oracle_v3_state (${errors} errors)\n`);

  // Step 4: Write bootstrap price history entries
  const priceRows = v2Rows.map(row => ({
    team: row.team_id,
    league: teamLeagueMap.get(row.team_id) ?? "Unknown",
    timestamp: now,
    b_value: Number(Number(row.b_value).toFixed(4)),
    m1_value: 0,
    published_index: Number(Number(row.b_value).toFixed(4)),
    confidence_score: 0,
    source_fixture_id: null,
    publish_reason: "bootstrap_v3",
  }));

  let phInserted = 0;
  for (let i = 0; i < priceRows.length; i += 50) {
    const batch = priceRows.slice(i, i + 50);
    const { error: phErr } = await sb
      .from("oracle_price_history")
      .insert(batch);

    if (phErr) {
      console.error(`  Price history batch ${i}: ${phErr.message}`);
    } else {
      phInserted += batch.length;
    }
  }

  console.log(`Inserted ${phInserted} bootstrap_v3 price history entries\n`);

  console.log("═══════════════════════════════════════════════════");
  console.log(`  Teams seeded:       ${upserted}`);
  console.log(`  Price history:      ${phInserted}`);
  console.log(`  Errors:             ${errors}`);
  console.log("═══════════════════════════════════════════════════");
  console.log("\nNext: run seed-and-backfill-v3.ts to replay settlements.");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
