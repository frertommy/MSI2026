/**
 * perp-spec-audit-3.ts — M1 clamp analysis + settlement discontinuity check
 *   cd scheduler && npx tsx src/scripts/perp-spec-audit-3.ts
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

async function main() {
  // 1. M1 clamp analysis
  const { data: states } = await sb.from("team_oracle_state")
    .select("team_id, b_value, m1_value, published_index, confidence_score");

  const teams = (states ?? []).map((s: any) => ({
    team: s.team_id,
    b: Number(s.b_value),
    m1: Number(s.m1_value),
    idx: Number(s.published_index),
    conf: Number(s.confidence_score ?? 0),
  }));

  const nonZeroM1 = teams.filter(t => t.m1 !== 0);
  const clamped75 = teams.filter(t => Math.abs(t.m1) === 75);
  const clampedHigh = teams.filter(t => Math.abs(t.m1) >= 70);

  console.log("=== M1 Clamp Analysis ===");
  console.log(`Total teams: ${teams.length}`);
  console.log(`M1 = 0: ${teams.filter(t => t.m1 === 0).length}`);
  console.log(`M1 != 0: ${nonZeroM1.length}`);
  console.log(`|M1| = 75 (hard clamped): ${clamped75.length} (${((clamped75.length / nonZeroM1.length) * 100).toFixed(1)}% of non-zero)`);
  console.log(`|M1| >= 70 (near clamp): ${clampedHigh.length}`);

  // Show the clamped teams
  console.log("\nTeams at M1 = +75:");
  for (const t of teams.filter(t => t.m1 === 75).sort((a, b) => b.b - a.b)) {
    console.log(`  ${t.team.padEnd(25)} B=${t.b.toFixed(1).padStart(7)}  idx=${t.idx.toFixed(1).padStart(7)}  conf=${t.conf.toFixed(3)}`);
  }
  console.log("\nTeams at M1 = -75:");
  for (const t of teams.filter(t => t.m1 === -75).sort((a, b) => b.b - a.b)) {
    console.log(`  ${t.team.padEnd(25)} B=${t.b.toFixed(1).padStart(7)}  idx=${t.idx.toFixed(1).padStart(7)}  conf=${t.conf.toFixed(3)}`);
  }

  // 2. What does the spread of B values look like?
  // This tells us if B has diverged enough from the 1500 baseline
  const bRange = teams.map(t => t.b).sort((a, b) => a - b);
  console.log("\n=== B_value range ===");
  console.log(`Range: ${bRange[0].toFixed(1)} to ${bRange[bRange.length - 1].toFixed(1)}`);
  console.log(`Spread: ${(bRange[bRange.length - 1] - bRange[0]).toFixed(1)} Elo points`);
  console.log(`Index range: ${teams.map(t => t.idx).sort((a, b) => a - b)[0].toFixed(1)} to ${teams.map(t => t.idx).sort((a, b) => b - a)[0].toFixed(1)}`);

  // 3. How many matches has each team had settled?
  const { data: settCounts } = await sb.from("settlement_log")
    .select("team_id");

  const teamSettlements = new Map<string, number>();
  for (const s of (settCounts ?? [])) {
    const team = s.team_id as string;
    teamSettlements.set(team, (teamSettlements.get(team) ?? 0) + 1);
  }

  const settleCounts = [...teamSettlements.values()].sort((a, b) => a - b);
  console.log("\n=== Settlements per team ===");
  console.log(`Teams with settlements: ${teamSettlements.size}`);
  if (settleCounts.length > 0) {
    const p = (arr: number[], pct: number) => {
      const idx = (pct / 100) * (arr.length - 1);
      const lo = Math.floor(idx);
      return arr[lo] + (arr[Math.ceil(idx)] - arr[lo]) * (idx - lo);
    };
    console.log(`Min: ${settleCounts[0]}`);
    console.log(`Median: ${p(settleCounts, 50).toFixed(0)}`);
    console.log(`Max: ${settleCounts[settleCounts.length - 1]}`);
  }

  // 4. Estimate: how long has the system been running?
  // 1251 fixtures settled across ~125 teams, ~10 settlements per team
  // EPL has 38 matches/season x 20 teams = 760 team-settlements
  // 5 leagues x ~20 teams x ~10 matches = 1000+ matches
  console.log("\n=== System maturity ===");
  console.log(`Total KR snapshots (settled fixtures): 1251`);
  console.log(`Total settlement_log entries: ${(settCounts ?? []).length}`);
  console.log(`Teams tracked: ${teams.length}`);
  console.log(`Avg settlements per team: ${((settCounts ?? []).length / teamSettlements.size).toFixed(1)}`);
  console.log(`All settlements occurred on: 2026-03-04 (backfill)`);
  console.log(`Market refreshes started: 2026-03-04 ~19:57 UTC`);
  console.log(`System is VERY NEW (< 1 day of live M1 data)`);

  // 5. Check the discontinuity at settlement
  // Look for price history entries around a settlement to see the jump
  const { data: priceHist } = await sb.from("oracle_price_history")
    .select("team, timestamp, b_value, m1_value, published_index, publish_reason")
    .eq("team", "Arsenal")
    .order("timestamp", { ascending: true });

  console.log("\n=== Arsenal price history (sample) ===");
  let prevIdx: number | null = null;
  for (const ph of (priceHist ?? [])) {
    const idx = Number(ph.published_index);
    const jump = prevIdx !== null ? (idx - prevIdx).toFixed(1) : "-";
    console.log(
      `  ${ph.timestamp.slice(0, 19)} B=${Number(ph.b_value).toFixed(1).padStart(7)} M1=${Number(ph.m1_value).toFixed(1).padStart(7)} idx=${idx.toFixed(1).padStart(7)} [${ph.publish_reason}] jump=${jump}`
    );
    prevIdx = idx;
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
