/**
 * perp-spec-audit-2.ts — Supplementary queries for the perp spec audit.
 *   cd scheduler && npx tsx src/scripts/perp-spec-audit-2.ts
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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function main() {
  // 1. B_value distribution from team_oracle_state
  const { data: states } = await sb.from("team_oracle_state").select("team_id, b_value, m1_value, published_index, confidence_score");
  const bValues = (states ?? []).map((s: any) => Number(s.b_value)).filter((b: number) => b !== 0).sort((a: number, b: number) => a - b);
  console.log("=== Current B_value distribution (non-zero) ===");
  console.log("Count:", bValues.length);
  if (bValues.length > 0) {
    console.log("Min:", bValues[0].toFixed(1));
    console.log("P10:", percentile(bValues, 10).toFixed(1));
    console.log("P25:", percentile(bValues, 25).toFixed(1));
    console.log("Median:", percentile(bValues, 50).toFixed(1));
    console.log("P75:", percentile(bValues, 75).toFixed(1));
    console.log("P90:", percentile(bValues, 90).toFixed(1));
    console.log("Max:", bValues[bValues.length - 1].toFixed(1));
  }

  // 2. Published index distribution
  const pubIdx = (states ?? []).map((s: any) => Number(s.published_index)).sort((a: number, b: number) => a - b);
  console.log("\n=== Current published_index distribution ===");
  console.log("Count:", pubIdx.length);
  if (pubIdx.length > 0) {
    console.log("Min:", pubIdx[0].toFixed(1));
    console.log("P25:", percentile(pubIdx, 25).toFixed(1));
    console.log("Median:", percentile(pubIdx, 50).toFixed(1));
    console.log("P75:", percentile(pubIdx, 75).toFixed(1));
    console.log("Max:", pubIdx[pubIdx.length - 1].toFixed(1));
  }

  // 3. Timeline of market_refresh entries
  const { data: mkt } = await sb.from("oracle_price_history")
    .select("timestamp, publish_reason")
    .eq("publish_reason", "market_refresh")
    .order("timestamp", { ascending: true })
    .limit(5);

  const { data: mktLast } = await sb.from("oracle_price_history")
    .select("timestamp, publish_reason")
    .eq("publish_reason", "market_refresh")
    .order("timestamp", { ascending: false })
    .limit(5);

  console.log("\n=== Market refresh timeline ===");
  console.log("First 5 market_refresh entries:");
  (mkt ?? []).forEach((r: any) => console.log("  ", r.timestamp));
  console.log("Last 5 market_refresh entries:");
  (mktLast ?? []).forEach((r: any) => console.log("  ", r.timestamp));

  // 4. Settlement timeline
  const { data: settFirst } = await sb.from("settlement_log")
    .select("settled_at")
    .order("settled_at", { ascending: true })
    .limit(3);

  const { data: settLast } = await sb.from("settlement_log")
    .select("settled_at")
    .order("settled_at", { ascending: false })
    .limit(3);

  console.log("\n=== Settlement timeline ===");
  console.log("First settlements:");
  (settFirst ?? []).forEach((r: any) => console.log("  ", r.settled_at));
  console.log("Last settlements:");
  (settLast ?? []).forEach((r: any) => console.log("  ", r.settled_at));

  // 5. How many distinct days have market_refresh?
  const { data: allMkt } = await sb.from("oracle_price_history")
    .select("timestamp")
    .eq("publish_reason", "market_refresh")
    .order("timestamp", { ascending: true });

  const mktDays = new Set((allMkt ?? []).map((r: any) => r.timestamp.slice(0, 10)));
  console.log("\n=== Market refresh days ===");
  console.log("Distinct days with market_refresh:", mktDays.size);
  for (const d of [...mktDays].sort()) console.log("  ", d);

  // 6. B_before distribution from settlement_log
  const allBBefore: number[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data } = await sb.from("settlement_log")
      .select("b_before")
      .range(from, from + pageSize - 1);
    if (!data || data.length === 0) break;
    for (const r of data) allBBefore.push(Number(r.b_before));
    if (data.length < pageSize) break;
    from += pageSize;
  }

  const nonZeroBBefore = allBBefore.filter(b => b !== 0).sort((a, b) => a - b);
  const zeroBBefore = allBBefore.filter(b => b === 0).length;
  console.log("\n=== Settlement B_before distribution ===");
  console.log("Total:", allBBefore.length);
  console.log("Zero (first settlement for team):", zeroBBefore);
  console.log("Non-zero:", nonZeroBBefore.length);
  if (nonZeroBBefore.length > 0) {
    console.log("Min:", nonZeroBBefore[0].toFixed(1));
    console.log("P10:", percentile(nonZeroBBefore, 10).toFixed(1));
    console.log("Median:", percentile(nonZeroBBefore, 50).toFixed(1));
    console.log("P90:", percentile(nonZeroBBefore, 90).toFixed(1));
    console.log("Max:", nonZeroBBefore[nonZeroBBefore.length - 1].toFixed(1));
  }

  // 7. Check how many teams have non-zero confidence_score currently
  const confScores = (states ?? []).map((s: any) => Number(s.confidence_score ?? 0));
  const nonZeroConf = confScores.filter((c: number) => c > 0).sort((a: number, b: number) => a - b);
  console.log("\n=== Current confidence_score distribution ===");
  console.log("Total teams:", confScores.length);
  console.log("confidence=0:", confScores.filter((c: number) => c === 0).length);
  console.log("confidence>0:", nonZeroConf.length);
  if (nonZeroConf.length > 0) {
    console.log("Min:", nonZeroConf[0].toFixed(4));
    console.log("Median:", percentile(nonZeroConf, 50).toFixed(4));
    console.log("Max:", nonZeroConf[nonZeroConf.length - 1].toFixed(4));
  }

  // 8. Verify: how big is a typical index move as a % of the index?
  // Use median b_value vs median delta_b
  if (nonZeroBBefore.length > 0) {
    const medB = percentile(nonZeroBBefore, 50);
    // Typical delta_b from the main audit was ~10
    console.log("\n=== Move magnitude context ===");
    console.log("Median B_before (non-zero):", medB.toFixed(1));
    console.log("Median |delta_b| from audit: ~9.92");
    console.log("As % of B:", ((9.92 / medB) * 100).toFixed(2) + "%");
    console.log("As % of index at 1500 baseline:", ((9.92 / 1500) * 100).toFixed(2) + "%");
  }

  // 9. Top 10 teams by B_value (strongest)
  const sortedTeams = (states ?? [])
    .map((s: any) => ({ team: s.team_id, b: Number(s.b_value), m1: Number(s.m1_value), idx: Number(s.published_index) }))
    .sort((a: any, b: any) => b.b - a.b);
  console.log("\n=== Top 10 teams by B_value ===");
  for (const t of sortedTeams.slice(0, 10)) {
    console.log(`  ${t.team.padEnd(25)} B=${t.b.toFixed(1).padStart(7)}  M1=${t.m1.toFixed(1).padStart(7)}  idx=${t.idx.toFixed(1).padStart(7)}`);
  }

  // Bottom 10
  console.log("\n=== Bottom 10 teams by B_value ===");
  for (const t of sortedTeams.slice(-10)) {
    console.log(`  ${t.team.padEnd(25)} B=${t.b.toFixed(1).padStart(7)}  M1=${t.m1.toFixed(1).padStart(7)}  idx=${t.idx.toFixed(1).padStart(7)}`);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
