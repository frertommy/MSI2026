/**
 * reseed-v2.ts — Load optimal seeds into team_oracle_v2_state.
 *
 * Reads optimal_seeds.json (computed via gravity simulation),
 * upserts each team into team_oracle_v2_state with M1=0, L=0, F=0.
 *
 * Run this ONCE before enabling V2 in production:
 *   npx tsx src/services/reseed-v2.ts
 *
 * Safe to re-run — upserts on team_id conflict.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSupabase } from "../api/supabase-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Load optimal seeds
  const seedsPath = path.resolve(__dirname, "../../../simulations/offseason/seeds/optimal_seeds.json");
  if (!fs.existsSync(seedsPath)) {
    console.error(`Seeds file not found: ${seedsPath}`);
    process.exit(1);
  }

  const seeds: Record<string, number> = JSON.parse(fs.readFileSync(seedsPath, "utf-8"));
  const teamCount = Object.keys(seeds).length;
  console.log(`Loaded ${teamCount} team seeds from optimal_seeds.json`);

  const sb = getSupabase();
  const now = new Date().toISOString();

  // Determine season
  const d = new Date();
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const season = month >= 7 ? `${year}-${(year + 1).toString().slice(2)}` : `${year - 1}-${year.toString().slice(2)}`;

  // Build upsert rows
  const rows = Object.entries(seeds).map(([team, bValue]) => ({
    team_id: team,
    season,
    b_value: Number(bValue.toFixed(4)),
    m1_value: 0,
    l_value: 0,
    f_value: 0,
    m1_locked: null,
    published_index: Number(bValue.toFixed(4)),
    next_fixture_id: null,
    confidence_score: 0,
    last_kr_fixture_id: null,
    last_market_refresh_ts: null,
    updated_at: now,
  }));

  // Upsert in batches of 50
  const batchSize = 50;
  let upserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await sb
      .from("team_oracle_v2_state")
      .upsert(batch, { onConflict: "team_id" });

    if (error) {
      console.error(`Upsert batch ${i / batchSize + 1} failed: ${error.message}`);
    } else {
      upserted += batch.length;
    }
  }

  console.log(`Reseed complete: ${upserted}/${teamCount} teams upserted into team_oracle_v2_state`);

  // Also write bootstrap price history rows
  const phRows = rows.map(r => ({
    team: r.team_id,
    league: "Unknown", // will be enriched by first M1 refresh
    timestamp: now,
    b_value: r.b_value,
    m1_value: 0,
    published_index: r.b_value,
    confidence_score: 0,
    source_fixture_id: null,
    publish_reason: "bootstrap_v2",
  }));

  for (let i = 0; i < phRows.length; i += batchSize) {
    const batch = phRows.slice(i, i + batchSize);
    const { error } = await sb
      .from("oracle_price_history")
      .insert(batch);

    if (error) {
      console.warn(`Price history batch ${i / batchSize + 1} failed: ${error.message}`);
    }
  }

  console.log(`Bootstrap price history written for ${phRows.length} teams`);
}

main().catch(err => {
  console.error("Reseed failed:", err);
  process.exit(1);
});
