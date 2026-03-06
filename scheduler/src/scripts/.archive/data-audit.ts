/**
 * data-audit.ts — Comprehensive Supabase data audit (v4 — fixed columns)
 *
 * For the large odds_snapshots table (2.5M+ rows), does a SINGLE paginated
 * scan reading only the columns needed, computing all aggregates in one pass.
 *
 * Usage:
 *   cd scheduler
 *   npx tsx src/scripts/data-audit.ts
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

function hr(title: string) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(70)}`);
}

function sub(title: string) {
  console.log(`\n  --- ${title} ---`);
}

async function countTable(table: string): Promise<number | null> {
  const { count, error } = await sb
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) return null;
  return count;
}

async function tableExists(table: string): Promise<boolean> {
  const { error } = await sb
    .from(table)
    .select("*", { count: "exact", head: true });
  return !error;
}

async function fetchAll<T = any>(
  table: string,
  columns: string,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from(table)
      .select(columns)
      .range(from, from + pageSize - 1);
    if (error) { console.error(`    [fetchAll ${table}] error:`, error.message); break; }
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log("MSI2026 Data Audit");
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Time:     ${new Date().toISOString()}`);

  // ══════════════════════════════════════════════════════════
  // 1. DISCOVER TABLES
  // ══════════════════════════════════════════════════════════
  hr("1. TABLE DISCOVERY");

  const knownTables = [
    "matches", "odds_snapshots", "futures_odds", "outrights",
    "live_odds", "transfers", "team_mappings", "teams",
    "events", "standings", "elo_ratings", "predictions",
    "pricing", "pricing_snapshots", "measure_results", "measure_configs",
    "players", "injuries", "lineups", "xg", "expected_goals",
    "match_events", "bookmakers", "leagues", "seasons",
    "odds_history", "live_pricing", "live_snapshots", "match_stats", "team_stats",
  ];

  const existingTables: string[] = [];
  const missingTables: string[] = [];

  for (const t of knownTables) {
    const exists = await tableExists(t);
    if (exists) {
      const count = await countTable(t);
      existingTables.push(t);
      console.log(`  [EXISTS] ${t.padEnd(25)} -> ${count?.toLocaleString() ?? "?"} rows`);
    } else {
      missingTables.push(t);
    }
  }
  console.log(`\n  Tables NOT found: ${missingTables.join(", ")}`);

  // ══════════════════════════════════════════════════════════
  // 2. MATCHES TABLE (columns: fixture_id, date, league, home_team, away_team, score, status, status_code, commence_time)
  // ══════════════════════════════════════════════════════════
  hr("2. MATCHES TABLE");

  const matchCount = await countTable("matches");
  console.log(`  Total rows: ${matchCount?.toLocaleString()}`);

  // Sample row
  sub("Sample row (all columns)");
  const { data: sampleMatch } = await sb.from("matches").select("*").limit(1);
  if (sampleMatch?.[0]) {
    for (const [k, v] of Object.entries(sampleMatch[0])) {
      const val = typeof v === "object" ? JSON.stringify(v) : String(v);
      console.log(`    ${k.padEnd(25)} = ${val?.substring(0, 100)}`);
    }
  }

  // Fetch all matches (< 5k rows — fast)
  console.log("\n  Fetching all matches for analysis...");
  const allMatches = await fetchAll("matches", "fixture_id, date, status, league, commence_time");
  console.log(`  Fetched ${allMatches.length.toLocaleString()} matches`);

  // By status
  sub("Count by status");
  const statusCounts: Record<string, number> = {};
  for (const m of allMatches) {
    const s = m.status ?? "(null)";
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  for (const [s, c] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s.padEnd(20)} ${c.toLocaleString()}`);
  }

  // By league
  sub("Count by league");
  const leagueCounts: Record<string, number> = {};
  for (const m of allMatches) {
    const l = m.league ?? "(null)";
    leagueCounts[l] = (leagueCounts[l] || 0) + 1;
  }
  for (const [l, c] of Object.entries(leagueCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${l.padEnd(30)} ${c.toLocaleString()}`);
  }

  // By season
  sub("Count by season (derived from date)");
  const seasonCounts: Record<string, number> = {};
  for (const m of allMatches) {
    if (!m.date) { seasonCounts["(no date)"] = (seasonCounts["(no date)"] || 0) + 1; continue; }
    const d = new Date(m.date);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const seasonStart = month >= 8 ? year : year - 1;
    const season = `${seasonStart}/${(seasonStart + 1).toString().slice(-2)}`;
    seasonCounts[season] = (seasonCounts[season] || 0) + 1;
  }
  for (const [s, c] of Object.entries(seasonCounts).sort()) {
    console.log(`    ${s.padEnd(20)} ${c.toLocaleString()}`);
  }

  // commence_time
  sub("commence_time population");
  const withCT = allMatches.filter((m: any) => m.commence_time != null).length;
  console.log(`    With commence_time: ${withCT.toLocaleString()} / ${allMatches.length.toLocaleString()}`);
  const sampleWithCT = allMatches.filter((m: any) => m.commence_time != null).slice(0, 5);
  for (const r of sampleWithCT) {
    console.log(`      fid=${r.fixture_id}  date=${r.date}  commence_time=${r.commence_time}`);
  }
  const sampleWithoutCT = allMatches.filter((m: any) => m.commence_time == null).slice(0, 3);
  if (sampleWithoutCT.length > 0) {
    console.log(`    Without commence_time (sample):`);
    for (const r of sampleWithoutCT) {
      console.log(`      fid=${r.fixture_id}  date=${r.date}`);
    }
  }

  // Date range
  sub("Date range");
  const dates = allMatches.map((m: any) => m.date).filter(Boolean).sort();
  console.log(`    Earliest: ${dates[0]}`);
  console.log(`    Latest:   ${dates[dates.length - 1]}`);

  // Match fixture_id set
  const matchFixIdSet = new Set(allMatches.map((m: any) => m.fixture_id));

  // ══════════════════════════════════════════════════════════
  // 3. ODDS_SNAPSHOTS TABLE — SINGLE-PASS SCAN
  // ══════════════════════════════════════════════════════════
  hr("3. ODDS_SNAPSHOTS TABLE");

  const oddsCount = await countTable("odds_snapshots");
  console.log(`  Total rows: ${oddsCount?.toLocaleString()}`);

  // Sample row
  sub("Sample row (all columns)");
  const { data: sampleOdds } = await sb.from("odds_snapshots").select("*").limit(1);
  if (sampleOdds?.[0]) {
    for (const [k, v] of Object.entries(sampleOdds[0])) {
      const val = typeof v === "object" ? JSON.stringify(v) : String(v);
      console.log(`    ${k.padEnd(30)} = ${val?.substring(0, 120)}`);
    }
  }

  // Snapshot date range (uses index — fast)
  sub("Snapshot date range");
  const { data: earliestOdds } = await sb.from("odds_snapshots").select("snapshot_time").order("snapshot_time", { ascending: true }).limit(1);
  const { data: latestOdds } = await sb.from("odds_snapshots").select("snapshot_time").order("snapshot_time", { ascending: false }).limit(1);
  console.log(`    Earliest: ${earliestOdds?.[0]?.snapshot_time}`);
  console.log(`    Latest:   ${latestOdds?.[0]?.snapshot_time}`);

  // SINGLE-PASS SCAN
  sub("Single-pass scan (this takes a few minutes for 2.5M+ rows)");

  const distinctFixIds = new Set<number>();
  const bookmakerCounts = new Map<string, number>();
  const daysCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const fixtureBookmakers = new Map<number, Set<string>>();
  let rowsScanned = 0;
  let from = 0;
  const pageSize = 1000;
  const startTime = Date.now();

  while (true) {
    const { data, error } = await sb
      .from("odds_snapshots")
      .select("fixture_id, bookmaker, days_before_kickoff, source")
      .range(from, from + pageSize - 1);

    if (error) {
      console.error(`    Error at offset ${from}:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;

    for (const r of data) {
      distinctFixIds.add(r.fixture_id);

      const bk = r.bookmaker ?? "(null)";
      bookmakerCounts.set(bk, (bookmakerCounts.get(bk) || 0) + 1);

      const dbk = String(r.days_before_kickoff ?? "(null)");
      daysCounts.set(dbk, (daysCounts.get(dbk) || 0) + 1);

      const src = r.source ?? "(null)";
      sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1);

      if (!fixtureBookmakers.has(r.fixture_id)) {
        fixtureBookmakers.set(r.fixture_id, new Set());
      }
      fixtureBookmakers.get(r.fixture_id)!.add(bk);
    }

    rowsScanned += data.length;
    if (data.length < pageSize) break;
    from += pageSize;

    if (Math.floor(from / pageSize) % 500 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const pct = oddsCount ? ((rowsScanned / oddsCount) * 100).toFixed(1) : "?";
      console.log(`    ... ${rowsScanned.toLocaleString()} rows (${pct}%), ${elapsed}s elapsed, ${distinctFixIds.size} fixtures`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`    Scan complete: ${rowsScanned.toLocaleString()} rows in ${elapsed}s`);

  // --- Results ---
  sub("Distinct fixture_ids with odds");
  console.log(`    In odds_snapshots: ${distinctFixIds.size.toLocaleString()}`);
  console.log(`    In matches table:  ${matchFixIdSet.size.toLocaleString()}`);
  const matchesWithOdds = [...matchFixIdSet].filter((fid) => distinctFixIds.has(fid as number));
  console.log(`    Matches WITH odds: ${matchesWithOdds.length.toLocaleString()} / ${matchFixIdSet.size.toLocaleString()}`);
  const oddsWithoutMatch = [...distinctFixIds].filter((fid) => !matchFixIdSet.has(fid));
  console.log(`    Odds fixture_ids NOT in matches: ${oddsWithoutMatch.length.toLocaleString()}`);
  if (oddsWithoutMatch.length > 0 && oddsWithoutMatch.length <= 30) {
    console.log(`      IDs: ${oddsWithoutMatch.join(", ")}`);
  }

  sub("Bookmakers");
  console.log(`    Distinct bookmakers: ${bookmakerCounts.size}`);
  const sortedBk = [...bookmakerCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [b, c] of sortedBk) {
    console.log(`      ${b.padEnd(35)} ${c.toLocaleString()} rows`);
  }

  sub("days_before_kickoff distribution");
  const sortedDays = [...daysCounts.entries()].sort((a, b) => {
    const na = parseFloat(a[0]);
    const nb = parseFloat(b[0]);
    if (isNaN(na)) return 1;
    if (isNaN(nb)) return -1;
    return na - nb;
  });
  for (const [d, c] of sortedDays) {
    const marker = parseFloat(d) < 0 ? " ** LIVE/NEGATIVE **" : "";
    console.log(`    days_before=${d.padEnd(10)} ${c.toLocaleString()} rows${marker}`);
  }

  sub("Live odds check (days_before_kickoff < 0)");
  const negDays = sortedDays.filter(([d]) => parseFloat(d) < 0);
  if (negDays.length === 0) {
    console.log("    No negative days_before_kickoff found");
  } else {
    let totalNeg = 0;
    for (const [d, c] of negDays) {
      console.log(`    days_before=${d}: ${c.toLocaleString()} rows`);
      totalNeg += c;
    }
    console.log(`    Total live/negative rows: ${totalNeg.toLocaleString()}`);
  }

  sub("Source distribution");
  for (const [s, c] of [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s.padEnd(35)} ${c.toLocaleString()} rows`);
  }

  sub("Average bookmakers per fixture");
  const fixtureCount = fixtureBookmakers.size;
  let totalBk = 0;
  const bkCountDist = new Map<number, number>();
  for (const [, bks] of fixtureBookmakers) {
    totalBk += bks.size;
    bkCountDist.set(bks.size, (bkCountDist.get(bks.size) || 0) + 1);
  }
  const avgBk = fixtureCount > 0 ? totalBk / fixtureCount : 0;
  console.log(`    Fixtures with odds: ${fixtureCount.toLocaleString()}`);
  console.log(`    Average distinct bookmakers per fixture: ${avgBk.toFixed(2)}`);
  console.log(`    Distribution:`);
  for (const [n, c] of [...bkCountDist.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`      ${String(n).padEnd(3)} bookmakers: ${c} fixtures`);
  }

  // ══════════════════════════════════════════════════════════
  // 4. OTHER TABLES — DETAIL
  // ══════════════════════════════════════════════════════════
  hr("4. OTHER TABLES - DETAILS");

  for (const t of existingTables) {
    if (t === "matches" || t === "odds_snapshots") continue;

    sub(`Table: ${t}`);
    const count = await countTable(t);
    console.log(`    Rows: ${count?.toLocaleString()}`);

    const { data: sample } = await sb.from(t).select("*").limit(2);
    if (sample?.[0]) {
      console.log(`    Columns & sample values:`);
      for (const [k, v] of Object.entries(sample[0])) {
        const val = typeof v === "object" ? JSON.stringify(v) : String(v);
        console.log(`      ${k.padEnd(30)} = ${val?.substring(0, 100)}`);
      }
    } else {
      console.log(`    (empty or no access)`);
    }
  }

  // ══════════════════════════════════════════════════════════
  // 5. SUMMARY
  // ══════════════════════════════════════════════════════════
  hr("5. SUMMARY");
  console.log(`  Tables found: ${existingTables.length}`);
  for (const t of existingTables) {
    const c = await countTable(t);
    console.log(`    ${t.padEnd(25)} ${(c ?? 0).toLocaleString()} rows`);
  }
  console.log(`\n  Tables NOT found: ${missingTables.length}`);
  console.log(`    ${missingTables.join(", ")}`);

  console.log(`\n  Key metrics:`);
  console.log(`    Matches total:             ${matchFixIdSet.size.toLocaleString()}`);
  console.log(`    Odds snapshots total:      ${oddsCount?.toLocaleString()}`);
  console.log(`    Fixtures with odds:        ${distinctFixIds.size.toLocaleString()}`);
  console.log(`    Matches with odds:         ${matchesWithOdds.length.toLocaleString()}`);
  console.log(`    Distinct bookmakers:       ${bookmakerCounts.size}`);
  console.log(`    Avg bookmakers/fixture:    ${avgBk.toFixed(2)}`);
  console.log(`    Odds date range:           ${earliestOdds?.[0]?.snapshot_time?.substring(0, 10) ?? "?"} to ${latestOdds?.[0]?.snapshot_time?.substring(0, 10) ?? "?"}`);
  console.log(`    Match date range:          ${dates[0]} to ${dates[dates.length - 1]}`);

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
