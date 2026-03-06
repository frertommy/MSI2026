/**
 * credit-check.ts
 * Quick diagnostic: check The Odds API credit usage and Supabase api_credits table.
 *
 * Usage:  npx tsx src/scripts/credit-check.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const ODDS_API_KEY = process.env.ODDS_API_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_KEY!;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── 1. Live credit check via The Odds API ──────────────────────────────
async function checkOddsApi() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  THE ODDS API — LIVE CREDIT CHECK");
  console.log("═══════════════════════════════════════════════════════\n");

  const res = await fetch(
    `https://api.the-odds-api.com/v4/sports?apiKey=${ODDS_API_KEY}`,
    { method: "HEAD" }
  );

  const used = res.headers.get("x-requests-used");
  const remaining = res.headers.get("x-requests-remaining");
  const last = res.headers.get("x-requests-last");

  console.log(`  Requests used (lifetime):  ${used}`);
  console.log(`  Requests remaining:        ${remaining}`);
  console.log(`  Last request cost:         ${last}`);

  const totalQuota = Number(used) + Number(remaining);
  const usedPct = ((Number(used) / totalQuota) * 100).toFixed(2);

  console.log(`  Total quota:               ${totalQuota.toLocaleString()}`);
  console.log(`  Usage:                     ${usedPct}%`);

  // Determine plan based on quota
  console.log("\n  --- Plan Detection ---");
  if (totalQuota >= 5_000_000) {
    console.log(`  Plan: Mega (5,000,000 credits/month)`);
  } else if (totalQuota >= 1_000_000) {
    console.log(`  Plan: Ultra (1,000,000 credits/month)`);
  } else if (totalQuota >= 500_000) {
    console.log(`  Plan: Premium (500,000 credits/month)`);
  } else if (totalQuota >= 100_000) {
    console.log(`  Plan: Standard (100,000 credits/month)`);
  } else if (totalQuota >= 10_000) {
    console.log(`  Plan: Starter (10,000 credits/month)`);
  } else {
    console.log(`  Plan: Free (500 credits/month)`);
  }

  // Show all response headers for completeness
  console.log("\n  --- All Response Headers ---");
  res.headers.forEach((v, k) => {
    if (k.startsWith("x-")) console.log(`  ${k}: ${v}`);
  });
  console.log();
}

// ── 2. Supabase api_credits table ──────────────────────────────────────
async function checkSupabaseCredits() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  SUPABASE — api_credits TABLE (current state)");
  console.log("═══════════════════════════════════════════════════════\n");

  const { data, error } = await sb
    .from("api_credits")
    .select("*")
    .order("last_poll_at", { ascending: false });

  if (error) {
    if (error.code === "PGRST205" || error.message.includes("does not exist")) {
      console.log("  [!] api_credits table does not exist yet.\n");
    } else {
      console.log(`  [!] Error querying api_credits: ${error.message}\n`);
    }
    return;
  }

  if (!data || data.length === 0) {
    console.log("  [!] No rows in api_credits table.\n");
    return;
  }

  for (const row of data) {
    console.log(`  Provider:            ${row.provider}`);
    console.log(`  Credits remaining:   ${row.credits_remaining ?? "N/A"}`);
    console.log(`  Credits used today:  ${row.credits_used_today ?? "N/A"}`);
    console.log(`  Daily budget:        ${row.daily_budget ?? "N/A"}`);
    console.log(`  Last poll at:        ${row.last_poll_at ?? "N/A"}`);
    console.log(`  Poll interval (s):   ${row.poll_interval_seconds ?? "N/A"}`);
    console.log(`  Next poll at:        ${row.next_poll_at ?? "N/A"}`);
    console.log("  ---");
  }
  console.log();
}

// ── 3. Historical daily usage (from scheduler_log or api_credits_history) ──
async function checkDailyUsage() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  DAILY CREDIT USAGE — PAST 30 DAYS");
  console.log("═══════════════════════════════════════════════════════\n");

  // Try api_credits_history first (if it exists)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: histData, error: histErr } = await sb
    .from("api_credits_history")
    .select("*")
    .gte("created_at", thirtyDaysAgo)
    .order("created_at", { ascending: false })
    .limit(100);

  if (!histErr && histData && histData.length > 0) {
    console.log("  Source: api_credits_history table\n");
    // Group by date
    const byDate = new Map<string, { used: number; remaining: number; count: number }>();
    for (const row of histData) {
      const date = (row.created_at || row.date || "").slice(0, 10);
      const existing = byDate.get(date) || { used: 0, remaining: 0, count: 0 };
      existing.used = Math.max(existing.used, row.credits_used_today || 0);
      existing.remaining = row.credits_remaining || existing.remaining;
      existing.count++;
      byDate.set(date, existing);
    }

    console.log("  Date         | Used Today | Remaining  | Samples");
    console.log("  -------------|------------|------------|--------");
    for (const [date, info] of [...byDate.entries()].sort()) {
      console.log(
        `  ${date}  | ${String(info.used).padStart(10)} | ${String(info.remaining).padStart(10)} | ${info.count}`
      );
    }
    console.log();
    return;
  }

  // Fallback: try scheduler_log table
  const { data: logData, error: logErr } = await sb
    .from("scheduler_log")
    .select("*")
    .gte("created_at", thirtyDaysAgo)
    .order("created_at", { ascending: false })
    .limit(100);

  if (!logErr && logData && logData.length > 0) {
    console.log("  Source: scheduler_log table\n");
    for (const row of logData.slice(0, 20)) {
      console.log(`  ${row.created_at?.slice(0, 19)} | ${JSON.stringify(row).slice(0, 80)}`);
    }
    console.log();
    return;
  }

  // If neither table exists, give a usage estimate from the live API
  console.log("  [!] No historical tables found (api_credits_history, scheduler_log).");
  console.log("      The api_credits table only stores current state, not history.\n");
  console.log("  Rough estimate from live API headers:");
  console.log("  - Total used this billing period: see 'x-requests-used' above");
  console.log("  - The Odds API resets credits monthly on your billing date.\n");
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n");
  await checkOddsApi();
  await checkSupabaseCredits();
  await checkDailyUsage();

  // Summary
  console.log("═══════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════════\n");
  console.log("  To check your exact plan and billing date, visit:");
  console.log("  https://the-odds-api.com/account/\n");
}

main().catch(console.error).finally(() => process.exit(0));
