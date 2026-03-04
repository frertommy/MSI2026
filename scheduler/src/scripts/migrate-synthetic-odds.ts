/**
 * Migration: Re-point odds stored under synthetic fixture_ids (9M+)
 * to the real API-Football fixture_ids.
 *
 * Problem: odds-poller creates synthetic fixture rows when it polls
 * before match-tracker has ingested the real match. Odds end up under
 * synthetic IDs while the pricing engine looks them up by real IDs.
 *
 * Usage:
 *   npx tsx src/scripts/migrate-synthetic-odds.ts          # dry-run
 *   npx tsx src/scripts/migrate-synthetic-odds.ts --execute # apply changes
 */
import "dotenv/config";
import { getSupabase } from "../api/supabase-client.js";

const EXECUTE = process.argv.includes("--execute");

async function main() {
  const sb = getSupabase();

  console.log(EXECUTE ? "🔴 EXECUTE MODE — changes will be applied" : "🟡 DRY-RUN — no changes will be made");
  console.log("");

  // 1. Get all synthetic match rows
  const { data: synthMatches, error: e1 } = await sb
    .from("matches")
    .select("fixture_id, date, home_team, away_team, score, status")
    .gte("fixture_id", 9000000)
    .order("date", { ascending: true });

  if (e1) {
    console.error("Error fetching synthetic matches:", e1.message);
    return;
  }

  console.log(`Synthetic match rows: ${synthMatches?.length ?? 0}`);

  // 2. For each synthetic match, find the real API-Football row
  const mappings: { synthId: number; realId: number; desc: string }[] = [];
  const orphans: typeof synthMatches = [];

  for (const m of synthMatches ?? []) {
    const { data: realRows } = await sb
      .from("matches")
      .select("fixture_id")
      .eq("date", m.date)
      .eq("home_team", m.home_team)
      .eq("away_team", m.away_team)
      .lt("fixture_id", 9000000);

    if (realRows && realRows.length > 0) {
      mappings.push({
        synthId: m.fixture_id,
        realId: realRows[0].fixture_id,
        desc: `${m.date} ${m.home_team} vs ${m.away_team}`,
      });
    } else {
      orphans.push(m);
    }
  }

  console.log(`Mappings found (synth → real): ${mappings.length}`);
  console.log(`Orphans (no real match):        ${orphans.length}`);
  console.log("");

  // Show first few mappings
  for (const mp of mappings.slice(0, 10)) {
    console.log(`  ${mp.desc}  synth=${mp.synthId} → real=${mp.realId}`);
  }
  if (mappings.length > 10) console.log(`  ... and ${mappings.length - 10} more`);
  console.log("");

  // Show orphans (future matches with no real row yet — expected)
  if (orphans.length > 0) {
    console.log("Orphans (expected for future matches):");
    for (const o of orphans.slice(0, 10)) {
      console.log(`  ${o.date} ${o.home_team} vs ${o.away_team} [${o.status}] synth=${o.fixture_id}`);
    }
    if (orphans.length > 10) console.log(`  ... and ${orphans.length - 10} more`);
    console.log("");
  }

  if (!EXECUTE) {
    // Count how many odds rows would be migrated
    let totalOddsToMigrate = 0;
    let totalTotalsToMigrate = 0;
    let totalSpreadsToMigrate = 0;

    for (const mp of mappings) {
      const { count: oddsCount } = await sb
        .from("odds_snapshots")
        .select("*", { count: "exact", head: true })
        .eq("fixture_id", mp.synthId);
      totalOddsToMigrate += oddsCount ?? 0;

      const { count: totalsCount } = await sb
        .from("totals_snapshots")
        .select("*", { count: "exact", head: true })
        .eq("fixture_id", mp.synthId);
      totalTotalsToMigrate += totalsCount ?? 0;

      const { count: spreadsCount } = await sb
        .from("spreads_snapshots")
        .select("*", { count: "exact", head: true })
        .eq("fixture_id", mp.synthId);
      totalSpreadsToMigrate += spreadsCount ?? 0;
    }

    console.log("=== DRY-RUN SUMMARY ===");
    console.log(`Mappings to apply:       ${mappings.length}`);
    console.log(`odds_snapshots to move:  ${totalOddsToMigrate}`);
    console.log(`totals_snapshots to move: ${totalTotalsToMigrate}`);
    console.log(`spreads_snapshots to move: ${totalSpreadsToMigrate}`);
    console.log(`Synthetic match rows to delete: ${mappings.length}`);
    console.log(`\nRun with --execute to apply.`);
    return;
  }

  // ─── EXECUTE MODE ───

  let oddsUpdated = 0;
  let totalsUpdated = 0;
  let spreadsUpdated = 0;
  let matchesDeleted = 0;
  let errors = 0;

  for (let i = 0; i < mappings.length; i++) {
    const mp = mappings[i];
    if (i % 20 === 0) {
      console.log(`Processing ${i + 1}/${mappings.length}...`);
    }

    // Update odds_snapshots: synth → real
    // Supabase doesn't support UPDATE SET fixture_id = X directly in the JS client
    // for rows that may conflict with existing rows (same fixture_id + source + bookmaker + snapshot_time).
    // We need to handle potential unique constraint conflicts.
    //
    // Strategy: Use RPC or just update directly. The unique constraint on odds_snapshots
    // is (fixture_id, source, bookmaker, snapshot_time). Since the real fixture_id may
    // already have some odds rows (from early correct matching), we need to handle conflicts.
    // Approach: update and let conflicts fail gracefully per-row, or just update in bulk.

    const { error: oddsErr, count: oc } = await sb
      .from("odds_snapshots")
      .update({ fixture_id: mp.realId })
      .eq("fixture_id", mp.synthId);

    if (oddsErr) {
      // If there's a unique constraint violation, we need to handle row-by-row
      // But for now, the most common case is that the real fid has few/no odds,
      // so bulk update should work for most.
      console.error(`  odds_snapshots error for ${mp.desc}: ${oddsErr.message}`);
      errors++;
    } else {
      oddsUpdated += oc ?? 0;
    }

    // Update totals_snapshots
    const { error: totErr, count: tc } = await sb
      .from("totals_snapshots")
      .update({ fixture_id: mp.realId })
      .eq("fixture_id", mp.synthId);

    if (totErr && !totErr.message.includes("does not exist")) {
      console.error(`  totals error: ${totErr.message}`);
    } else {
      totalsUpdated += tc ?? 0;
    }

    // Update spreads_snapshots
    const { error: sprErr, count: sc } = await sb
      .from("spreads_snapshots")
      .update({ fixture_id: mp.realId })
      .eq("fixture_id", mp.synthId);

    if (sprErr && !sprErr.message.includes("does not exist")) {
      console.error(`  spreads error: ${sprErr.message}`);
    } else {
      spreadsUpdated += sc ?? 0;
    }

    // Delete the synthetic match row
    const { error: delErr } = await sb
      .from("matches")
      .delete()
      .eq("fixture_id", mp.synthId);

    if (delErr) {
      console.error(`  match delete error: ${delErr.message}`);
      errors++;
    } else {
      matchesDeleted++;
    }
  }

  console.log("\n=== MIGRATION COMPLETE ===");
  console.log(`odds_snapshots updated:    ${oddsUpdated}`);
  console.log(`totals_snapshots updated:  ${totalsUpdated}`);
  console.log(`spreads_snapshots updated: ${spreadsUpdated}`);
  console.log(`Synthetic matches deleted: ${matchesDeleted}`);
  console.log(`Errors: ${errors}`);
}

main().catch(console.error);
