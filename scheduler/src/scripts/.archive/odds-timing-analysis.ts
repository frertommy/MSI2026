/**
 * odds-timing-analysis.ts — Analyze how far before kickoff odds data arrives.
 *
 * Strategy: instead of scanning all 3M+ odds rows, iterate over the ~4800
 * matches with commence_time and for each one query the earliest/latest
 * snapshot_time from odds_snapshots (leveraging the idx on fixture_id, snapshot_time).
 * Then compute timing distributions from those aggregates.
 *
 * Usage:
 *   cd scheduler
 *   npx tsx src/scripts/odds-timing-analysis.ts
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";
if (!SUPABASE_URL || !SUPABASE_KEY)
  throw new Error("SUPABASE_URL / SUPABASE_KEY not set");

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

function hr(title: string) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(70)}`);
}

function sub(title: string) {
  console.log(`\n  --- ${title} ---`);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log("MSI2026 — Odds Timing Analysis (v2 — per-fixture queries)");
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Time:     ${new Date().toISOString()}`);

  // ── Step 1: Load all matches with commence_time ───────────
  hr("1. LOADING MATCHES WITH COMMENCE_TIME");

  const allMatches: {
    fixture_id: number;
    date: string;
    commence_time: string | null;
    home_team: string;
    away_team: string;
    league: string;
    status: string;
  }[] = [];

  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("fixture_id, date, commence_time, home_team, away_team, league, status")
      .range(from, from + pageSize - 1);
    if (error) { console.error("  matches fetch error:", error.message); break; }
    if (!data || data.length === 0) break;
    allMatches.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  const matchesWithCT = allMatches.filter((m) => m.commence_time != null);
  console.log(`  Total matches:              ${allMatches.length.toLocaleString()}`);
  console.log(`  Matches with commence_time: ${matchesWithCT.length.toLocaleString()}`);
  console.log(`  Matches without:            ${(allMatches.length - matchesWithCT.length).toLocaleString()}`);

  // ── Step 2: For each match, query earliest + latest + count of odds ─
  hr("2. QUERYING PER-FIXTURE ODDS TIMING");
  console.log(`  Processing ${matchesWithCT.length} fixtures...`);

  interface FixtureTiming {
    fixture_id: number;
    home_team: string;
    away_team: string;
    league: string;
    date: string;
    status: string;
    commence_time: string;
    earliestSnap: string | null;
    latestSnap: string | null;
    snapCount: number;
    earliestHoursBefore: number;
    latestHoursBefore: number;
  }

  const results: FixtureTiming[] = [];
  let processed = 0;
  let noOdds = 0;
  const startTime = Date.now();

  // Process in batches of 20 concurrent requests
  const CONCURRENCY = 20;
  for (let i = 0; i < matchesWithCT.length; i += CONCURRENCY) {
    const batch = matchesWithCT.slice(i, i + CONCURRENCY);

    const promises = batch.map(async (match) => {
      const kickoffMs = new Date(match.commence_time!).getTime();

      // Get earliest snapshot (ascending order, limit 1)
      const [earliestRes, latestRes, countRes] = await Promise.all([
        sb
          .from("odds_snapshots")
          .select("snapshot_time")
          .eq("fixture_id", match.fixture_id)
          .order("snapshot_time", { ascending: true })
          .limit(1),
        sb
          .from("odds_snapshots")
          .select("snapshot_time")
          .eq("fixture_id", match.fixture_id)
          .order("snapshot_time", { ascending: false })
          .limit(1),
        sb
          .from("odds_snapshots")
          .select("*", { count: "exact", head: true })
          .eq("fixture_id", match.fixture_id),
      ]);

      const earliest = earliestRes.data?.[0]?.snapshot_time ?? null;
      const latest = latestRes.data?.[0]?.snapshot_time ?? null;
      const count = countRes.count ?? 0;

      if (!earliest || !latest || count === 0) {
        noOdds++;
        return null;
      }

      const earliestMs = new Date(earliest).getTime();
      const latestMs = new Date(latest).getTime();

      return {
        fixture_id: match.fixture_id,
        home_team: match.home_team,
        away_team: match.away_team,
        league: match.league,
        date: match.date,
        status: match.status,
        commence_time: match.commence_time!,
        earliestSnap: earliest,
        latestSnap: latest,
        snapCount: count,
        earliestHoursBefore: (kickoffMs - earliestMs) / (1000 * 3600),
        latestHoursBefore: (kickoffMs - latestMs) / (1000 * 3600),
      } as FixtureTiming;
    });

    const batchResults = await Promise.all(promises);
    for (const r of batchResults) {
      if (r) results.push(r);
    }

    processed += batch.length;
    if (processed % 200 === 0 || processed === matchesWithCT.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(
        `    ${processed} / ${matchesWithCT.length} fixtures processed (${elapsed}s)`
      );
    }
  }

  console.log(`\n  Fixtures with odds data:    ${results.length.toLocaleString()}`);
  console.log(`  Fixtures without any odds:  ${noOdds.toLocaleString()}`);

  // ── Step 3: Distribution of EARLIEST snapshot timing ──────
  hr("3. EARLIEST ODDS ARRIVAL DISTRIBUTION");
  sub("How far before kickoff does the FIRST odds snapshot arrive?");

  const earliestBuckets = {
    "48h+ (2+ days)": 0,
    "24-48h (1-2 days)": 0,
    "12-24h": 0,
    "6-12h": 0,
    "3-6h": 0,
    "1-3h": 0,
    "<1h": 0,
    "post-kickoff (negative)": 0,
  };

  const earliestHours = results.map((r) => r.earliestHoursBefore).sort((a, b) => a - b);

  for (const h of earliestHours) {
    if (h < 0) earliestBuckets["post-kickoff (negative)"]++;
    else if (h < 1) earliestBuckets["<1h"]++;
    else if (h < 3) earliestBuckets["1-3h"]++;
    else if (h < 6) earliestBuckets["3-6h"]++;
    else if (h < 12) earliestBuckets["6-12h"]++;
    else if (h < 24) earliestBuckets["12-24h"]++;
    else if (h < 48) earliestBuckets["24-48h (1-2 days)"]++;
    else earliestBuckets["48h+ (2+ days)"]++;
  }

  const total = results.length;
  console.log(
    `\n  ${"Bucket".padEnd(30)} ${"Count".padStart(8)} ${"Pct".padStart(8)}`
  );
  console.log(`  ${"-".repeat(50)}`);
  for (const [bucket, count] of Object.entries(earliestBuckets)) {
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
    console.log(
      `  ${bucket.padEnd(30)} ${count.toLocaleString().padStart(8)} ${(pct + "%").padStart(8)}`
    );
  }

  // ── Step 4: Distribution of LATEST (closest to kickoff) ───
  hr("4. LATEST PRE-KICKOFF ODDS DISTRIBUTION");
  sub("How close to kickoff is the LAST odds snapshot?");

  const latestBuckets = {
    "48h+ (2+ days)": 0,
    "24-48h (1-2 days)": 0,
    "12-24h": 0,
    "6-12h": 0,
    "3-6h": 0,
    "1-3h": 0,
    "<1h": 0,
    "post-kickoff (negative)": 0,
  };

  const latestHours = results.map((r) => r.latestHoursBefore).sort((a, b) => a - b);

  for (const h of latestHours) {
    if (h < 0) latestBuckets["post-kickoff (negative)"]++;
    else if (h < 1) latestBuckets["<1h"]++;
    else if (h < 3) latestBuckets["1-3h"]++;
    else if (h < 6) latestBuckets["3-6h"]++;
    else if (h < 12) latestBuckets["6-12h"]++;
    else if (h < 24) latestBuckets["12-24h"]++;
    else if (h < 48) latestBuckets["24-48h (1-2 days)"]++;
    else latestBuckets["48h+ (2+ days)"]++;
  }

  console.log(
    `\n  ${"Bucket".padEnd(30)} ${"Count".padStart(8)} ${"Pct".padStart(8)}`
  );
  console.log(`  ${"-".repeat(50)}`);
  for (const [bucket, count] of Object.entries(latestBuckets)) {
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
    console.log(
      `  ${bucket.padEnd(30)} ${count.toLocaleString().padStart(8)} ${(pct + "%").padStart(8)}`
    );
  }

  // ── Step 5: Overall statistics ────────────────────────────
  hr("5. OVERALL TIMING STATISTICS");

  const preKickoffEarliest = earliestHours.filter((h) => h >= 0);
  const preKickoffLatest = latestHours.filter((h) => h >= 0);

  if (preKickoffEarliest.length > 0) {
    sub("Earliest odds per fixture (first snapshot arrival)");
    const maxH = preKickoffEarliest[preKickoffEarliest.length - 1];
    const minH = preKickoffEarliest[0];
    const mean = preKickoffEarliest.reduce((s, v) => s + v, 0) / preKickoffEarliest.length;

    console.log(`    Count:   ${preKickoffEarliest.length.toLocaleString()} fixtures`);
    console.log(`    Max:     ${maxH.toFixed(1)}h (${(maxH / 24).toFixed(1)} days) — earliest we ever get odds`);
    console.log(`    P95:     ${percentile(preKickoffEarliest, 95).toFixed(1)}h (${(percentile(preKickoffEarliest, 95) / 24).toFixed(1)} days)`);
    console.log(`    P90:     ${percentile(preKickoffEarliest, 90).toFixed(1)}h`);
    console.log(`    P75:     ${percentile(preKickoffEarliest, 75).toFixed(1)}h`);
    console.log(`    Median:  ${percentile(preKickoffEarliest, 50).toFixed(1)}h (${(percentile(preKickoffEarliest, 50) / 24).toFixed(1)} days)`);
    console.log(`    P25:     ${percentile(preKickoffEarliest, 25).toFixed(1)}h`);
    console.log(`    P10:     ${percentile(preKickoffEarliest, 10).toFixed(1)}h`);
    console.log(`    Min:     ${minH.toFixed(1)}h`);
    console.log(`    Mean:    ${mean.toFixed(1)}h (${(mean / 24).toFixed(1)} days)`);
  }

  if (preKickoffLatest.length > 0) {
    sub("Latest pre-kickoff odds per fixture (closest snapshot to kickoff)");
    const maxH = preKickoffLatest[preKickoffLatest.length - 1];
    const minH = preKickoffLatest[0];
    const mean = preKickoffLatest.reduce((s, v) => s + v, 0) / preKickoffLatest.length;

    console.log(`    Count:   ${preKickoffLatest.length.toLocaleString()} fixtures`);
    console.log(`    Min (closest to kickoff): ${minH.toFixed(2)}h (${(minH * 60).toFixed(0)} min)`);
    console.log(`    P10:     ${percentile(preKickoffLatest, 10).toFixed(2)}h`);
    console.log(`    P25:     ${percentile(preKickoffLatest, 25).toFixed(2)}h`);
    console.log(`    Median:  ${percentile(preKickoffLatest, 50).toFixed(2)}h`);
    console.log(`    P75:     ${percentile(preKickoffLatest, 75).toFixed(2)}h`);
    console.log(`    P90:     ${percentile(preKickoffLatest, 90).toFixed(2)}h`);
    console.log(`    Max (furthest from kickoff): ${maxH.toFixed(1)}h`);
    console.log(`    Mean:    ${mean.toFixed(2)}h`);
  }

  // ── Step 6: Snapshot count stats ──────────────────────────
  hr("6. SNAPSHOT COUNT PER FIXTURE");

  const snapCounts = results.map((r) => r.snapCount).sort((a, b) => a - b);
  if (snapCounts.length > 0) {
    const totalSnaps = snapCounts.reduce((s, v) => s + v, 0);
    console.log(`  Total snapshots across all matched fixtures: ${totalSnaps.toLocaleString()}`);
    console.log(`  Fixtures:  ${snapCounts.length.toLocaleString()}`);
    console.log(`  Min snaps: ${snapCounts[0]}`);
    console.log(`  P25:       ${percentile(snapCounts, 25)}`);
    console.log(`  Median:    ${percentile(snapCounts, 50)}`);
    console.log(`  P75:       ${percentile(snapCounts, 75)}`);
    console.log(`  P90:       ${percentile(snapCounts, 90)}`);
    console.log(`  Max snaps: ${snapCounts[snapCounts.length - 1]}`);
    console.log(`  Mean:      ${(totalSnaps / snapCounts.length).toFixed(1)}`);
  }

  // ── Step 7: Sample of 10 matches ──────────────────────────
  hr("7. SAMPLE: 10 MATCHES WITH MOST ODDS SNAPSHOTS");

  const topBySnaps = [...results]
    .sort((a, b) => b.snapCount - a.snapCount)
    .slice(0, 10);

  console.log(
    `\n  ${"Match".padEnd(40)} ${"League".padEnd(18)} ${"Kickoff".padEnd(20)} ${"1st odds".padStart(10)} ${"Last odds".padStart(10)} ${"Snaps".padStart(6)}`
  );
  console.log(`  ${"-".repeat(108)}`);

  for (const r of topBySnaps) {
    const label = `${r.home_team} vs ${r.away_team}`;
    const kickoff = r.commence_time.replace("T", " ").substring(0, 16);
    const e = r.earliestHoursBefore >= 0 ? `${r.earliestHoursBefore.toFixed(1)}h` : "post-KO";
    const l = r.latestHoursBefore >= 0 ? `${r.latestHoursBefore.toFixed(1)}h` : "post-KO";

    console.log(
      `  ${label.substring(0, 39).padEnd(40)} ${r.league.substring(0, 17).padEnd(18)} ${kickoff.padEnd(20)} ${e.padStart(10)} ${l.padStart(10)} ${String(r.snapCount).padStart(6)}`
    );
  }

  // ── Step 8: Sample of 10 recent finished matches ──────────
  hr("8. SAMPLE: 10 RECENT FINISHED MATCHES");

  const recentFinished = [...results]
    .filter((r) => r.status === "finished")
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10);

  console.log(
    `\n  ${"Match".padEnd(40)} ${"League".padEnd(18)} ${"Kickoff".padEnd(20)} ${"1st odds".padStart(10)} ${"Last odds".padStart(10)} ${"Snaps".padStart(6)}`
  );
  console.log(`  ${"-".repeat(108)}`);

  for (const r of recentFinished) {
    const label = `${r.home_team} vs ${r.away_team}`;
    const kickoff = r.commence_time.replace("T", " ").substring(0, 16);
    const e = r.earliestHoursBefore >= 0 ? `${r.earliestHoursBefore.toFixed(1)}h` : "post-KO";
    const l = r.latestHoursBefore >= 0 ? `${r.latestHoursBefore.toFixed(1)}h` : "post-KO";

    console.log(
      `  ${label.substring(0, 39).padEnd(40)} ${r.league.substring(0, 17).padEnd(18)} ${kickoff.padEnd(20)} ${e.padStart(10)} ${l.padStart(10)} ${String(r.snapCount).padStart(6)}`
    );
  }

  // ── Step 9: By league breakdown ───────────────────────────
  hr("9. TIMING BY LEAGUE");

  const leagueStats = new Map<
    string,
    { earliestHours: number[]; latestHours: number[]; snapCounts: number[] }
  >();

  for (const r of results) {
    if (!leagueStats.has(r.league))
      leagueStats.set(r.league, { earliestHours: [], latestHours: [], snapCounts: [] });
    const ls = leagueStats.get(r.league)!;
    if (r.earliestHoursBefore >= 0) ls.earliestHours.push(r.earliestHoursBefore);
    if (r.latestHoursBefore >= 0) ls.latestHours.push(r.latestHoursBefore);
    ls.snapCounts.push(r.snapCount);
  }

  console.log(
    `\n  ${"League".padEnd(22)} ${"Fix".padStart(5)} ${"Med 1st".padStart(10)} ${"Max 1st".padStart(10)} ${"Med last".padStart(10)} ${"Med snaps".padStart(10)}`
  );
  console.log(`  ${"-".repeat(70)}`);

  for (const [league, stats] of [...leagueStats.entries()].sort()) {
    stats.earliestHours.sort((a, b) => a - b);
    stats.latestHours.sort((a, b) => a - b);
    stats.snapCounts.sort((a, b) => a - b);

    const medEarliest = percentile(stats.earliestHours, 50);
    const maxEarliest =
      stats.earliestHours.length > 0
        ? stats.earliestHours[stats.earliestHours.length - 1]
        : 0;
    const medLatest = percentile(stats.latestHours, 50);
    const medSnaps = percentile(stats.snapCounts, 50);

    console.log(
      `  ${league.substring(0, 21).padEnd(22)} ${String(stats.earliestHours.length).padStart(5)} ${(medEarliest.toFixed(1) + "h").padStart(10)} ${(maxEarliest.toFixed(1) + "h").padStart(10)} ${(medLatest.toFixed(1) + "h").padStart(10)} ${String(medSnaps).padStart(10)}`
    );
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
