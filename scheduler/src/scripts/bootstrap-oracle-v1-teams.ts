/**
 * bootstrap-oracle-v1-teams.ts
 *
 * One-time bootstrap script for the V1 Oracle.
 * Queries all distinct teams from the `matches` table and inserts missing
 * teams into `team_oracle_state` with B_value = ORACLE_V1_BASELINE_ELO (1500).
 *
 * Also writes an initial `oracle_price_history` row for each bootstrapped team
 * with publish_reason = 'bootstrap'.
 *
 * Safe to re-run — uses upsert with onConflict: "team_id" (no-op for existing).
 *
 * Usage:
 *   cd scheduler
 *   npx tsx src/scripts/bootstrap-oracle-v1-teams.ts
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("SUPABASE_URL / SUPABASE_KEY not set");
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const ORACLE_V1_BASELINE_ELO = 1500;

// ─── Helpers ─────────────────────────────────────────────────

function deriveSeason(date: string): string {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  if (month >= 7) return `${year}-${(year + 1).toString().slice(2)}`;
  return `${year - 1}-${year.toString().slice(2)}`;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  ORACLE V1 — TEAM BOOTSTRAP");
  console.log("  " + new Date().toISOString());
  console.log("══════════════════════════════════════════════════════════════\n");

  // Step 1: Load all distinct teams from matches
  const teamMap = new Map<string, string>(); // team → league
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("home_team, away_team, league")
      .range(from, from + pageSize - 1);

    if (error) {
      console.error(`  ERROR loading matches: ${error.message}`);
      process.exit(1);
    }
    if (!data || data.length === 0) break;

    for (const m of data) {
      if (!teamMap.has(m.home_team)) teamMap.set(m.home_team, m.league);
      if (!teamMap.has(m.away_team)) teamMap.set(m.away_team, m.league);
    }

    if (data.length < pageSize) break;
    from += pageSize;
  }

  console.log(`  Total distinct teams in matches: ${teamMap.size}`);

  // Step 2: Load existing teams from team_oracle_state
  const { data: existingRows, error: existErr } = await sb
    .from("team_oracle_state")
    .select("team_id");

  if (existErr) {
    console.error(`  ERROR loading team_oracle_state: ${existErr.message}`);
    process.exit(1);
  }

  const existingTeams = new Set((existingRows ?? []).map(r => r.team_id as string));
  console.log(`  Teams already in oracle_state:   ${existingTeams.size}`);

  // Step 3: Find missing teams
  const missingTeams: { team: string; league: string }[] = [];
  for (const [team, league] of teamMap) {
    if (!existingTeams.has(team)) {
      missingTeams.push({ team, league });
    }
  }

  console.log(`  Teams to bootstrap:              ${missingTeams.length}`);

  if (missingTeams.length === 0) {
    console.log("\n  ✅ All teams already exist in team_oracle_state. Nothing to do.\n");
    return;
  }

  // Step 4: Insert into team_oracle_state
  const now = new Date().toISOString();
  const season = deriveSeason(now.slice(0, 10));

  const stateRows = missingTeams.map(t => ({
    team_id: t.team,
    season,
    B_value: ORACLE_V1_BASELINE_ELO,
    M1_value: 0,
    published_index: ORACLE_V1_BASELINE_ELO,
    confidence_score: 0,
    next_fixture_id: null,
    last_kr_fixture_id: null,
    last_market_refresh_ts: null,
    updated_at: now,
  }));

  // Batch in chunks of 100
  const batchSize = 100;
  let inserted = 0;

  for (let i = 0; i < stateRows.length; i += batchSize) {
    const batch = stateRows.slice(i, i + batchSize);
    const { error } = await sb
      .from("team_oracle_state")
      .upsert(batch, { onConflict: "team_id" });

    if (error) {
      console.error(`  ERROR upserting team_oracle_state batch ${i}: ${error.message}`);
    } else {
      inserted += batch.length;
    }
  }

  console.log(`  Upserted ${inserted} teams into team_oracle_state`);

  // Step 5: Insert price history rows
  const phRows = missingTeams.map(t => ({
    team: t.team,
    league: t.league,
    timestamp: now,
    B_value: ORACLE_V1_BASELINE_ELO,
    M1_value: 0,
    published_index: ORACLE_V1_BASELINE_ELO,
    confidence_score: 0,
    source_fixture_id: null,
    publish_reason: "bootstrap",
  }));

  let phInserted = 0;

  for (let i = 0; i < phRows.length; i += batchSize) {
    const batch = phRows.slice(i, i + batchSize);
    const { error } = await sb
      .from("oracle_price_history")
      .insert(batch);

    if (error) {
      console.error(`  ERROR inserting price history batch ${i}: ${error.message}`);
    } else {
      phInserted += batch.length;
    }
  }

  console.log(`  Inserted ${phInserted} price history rows (publish_reason='bootstrap')`);

  // Step 6: Summary
  console.log("\n  Bootstrapped teams:");
  const sorted = missingTeams.sort((a, b) => a.league.localeCompare(b.league) || a.team.localeCompare(b.team));

  const byLeague = new Map<string, string[]>();
  for (const t of sorted) {
    if (!byLeague.has(t.league)) byLeague.set(t.league, []);
    byLeague.get(t.league)!.push(t.team);
  }

  for (const [league, teams] of byLeague) {
    console.log(`\n    ${league} (${teams.length}):`);
    for (const team of teams) {
      console.log(`      • ${team}  B=${ORACLE_V1_BASELINE_ELO}`);
    }
  }

  console.log(`\n  ✅ Bootstrap complete — ${inserted} teams at B=${ORACLE_V1_BASELINE_ELO}\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
