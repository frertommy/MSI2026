/**
 * cleanup-orphans.ts — Delete orphaned duplicate team entries from Supabase.
 *
 * These are bootstrap entries (B=1500) created from pre-alias team names
 * that never matched any actual match records for settlement.
 *
 * Usage:
 *   cd scheduler && npx tsx src/scripts/cleanup-orphans.ts
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

const ORPHANS = ["Bayern Munich", "Borussia Monchengladbach", "Vfl Bochum"];

async function main() {
  console.log("\n═══ Cleaning up orphaned duplicate team entries ═══\n");

  // Step 1: Verify they are indeed orphans (B=1500, no fixtures)
  for (const team of ORPHANS) {
    const { data } = await sb
      .from("team_oracle_state")
      .select("team_id, b_value, m1_value, next_fixture_id")
      .eq("team_id", team)
      .single();

    if (!data) {
      console.log(`  ⚠️  ${team}: not found in team_oracle_state (already deleted?)`);
      continue;
    }

    console.log(`  ${team}: B=${Number(data.b_value).toFixed(1)}, M1=${Number(data.m1_value).toFixed(2)}, fixture=${data.next_fixture_id}`);

    if (Math.abs(Number(data.b_value) - 1500) > 0.1) {
      console.log(`  ❌ ${team}: B≠1500, NOT deleting — may have real data!`);
      continue;
    }
  }

  // Step 2: Delete from team_oracle_state
  console.log("\n  Deleting from team_oracle_state...");
  const { error: stateErr, count: stateCount } = await sb
    .from("team_oracle_state")
    .delete({ count: "exact" })
    .in("team_id", ORPHANS);

  if (stateErr) {
    console.error(`  ❌ team_oracle_state delete failed: ${stateErr.message}`);
  } else {
    console.log(`  ✅ Deleted ${stateCount} rows from team_oracle_state`);
  }

  // Step 3: Delete from oracle_price_history
  console.log("  Deleting from oracle_price_history...");
  const { error: phErr, count: phCount } = await sb
    .from("oracle_price_history")
    .delete({ count: "exact" })
    .in("team", ORPHANS);

  if (phErr) {
    console.error(`  ❌ oracle_price_history delete failed: ${phErr.message}`);
  } else {
    console.log(`  ✅ Deleted ${phCount} rows from oracle_price_history`);
  }

  // Step 4: Delete from oracle_kr_snapshots
  console.log("  Deleting from oracle_kr_snapshots...");
  const { error: krErr, count: krCount } = await sb
    .from("oracle_kr_snapshots")
    .delete({ count: "exact" })
    .in("team", ORPHANS);

  if (krErr) {
    console.error(`  ❌ oracle_kr_snapshots delete failed: ${krErr.message}`);
  } else {
    console.log(`  ✅ Deleted ${krCount} rows from oracle_kr_snapshots`);
  }

  // Step 5: Verify the canonical versions still exist
  console.log("\n  Verifying canonical versions remain...");
  const canonicals = ["Bayern München", "Borussia Mönchengladbach", "VfL Bochum"];
  for (const team of canonicals) {
    const { data } = await sb
      .from("team_oracle_state")
      .select("team_id, b_value, m1_value")
      .eq("team_id", team)
      .single();

    if (data) {
      console.log(`  ✅ ${team}: B=${Number(data.b_value).toFixed(1)}, M1=${Number(data.m1_value).toFixed(2)}`);
    } else {
      console.log(`  ⚠️  ${team}: NOT found — may need re-bootstrap`);
    }
  }

  console.log("\n═══ Cleanup complete ═══\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
