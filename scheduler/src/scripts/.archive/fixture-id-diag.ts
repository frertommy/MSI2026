/**
 * fixture-id-diag.ts — Quick fixture_id mismatch diagnostic
 *
 * Hypothesis: matches.fixture_id uses API-Football IDs (~1M range)
 *             odds_snapshots.fixture_id uses The Odds API IDs or synthetic hashes (~9M range)
 *
 * 5 checks:
 *   1. Sample 10 fixture_ids from matches (finished, with scores)
 *   2. Sample 10 fixture_ids from odds_snapshots
 *   3. Overlap between the two sample sets
 *   4. Distinct counts & intersection (efficient: probe from matches side)
 *   5. Specific EPL match from Dec 2025 — cross-table lookup
 *
 * Usage:  cd scheduler && npx tsx src/scripts/fixture-id-diag.ts
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
  console.log(`\n${"=".repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(72)}`);
}

/** Paginated fetch — returns all rows matching a query. */
async function fetchAll<T = any>(
  table: string,
  columns: string,
  filters?: { column: string; op: string; value: unknown }[],
  orderBy?: { column: string; ascending: boolean },
  limit?: number,
  pageSize = 1000
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  while (true) {
    let query = sb.from(table).select(columns).range(from, from + pageSize - 1);
    if (filters) {
      for (const f of filters) {
        if (f.op === "eq") query = query.eq(f.column, f.value);
        else if (f.op === "gte") query = query.gte(f.column, f.value);
        else if (f.op === "lte") query = query.lte(f.column, f.value);
        else if (f.op === "neq") query = query.neq(f.column, f.value);
        else if (f.op === "in") query = query.in(f.column, f.value as any[]);
      }
    }
    if (orderBy) query = query.order(orderBy.column, { ascending: orderBy.ascending });
    const { data, error } = await query;
    if (error) { console.error(`  fetchAll(${table}) error:`, error.message); break; }
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (limit && rows.length >= limit) return rows.slice(0, limit);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function main() {
  console.log("Fixture ID Mismatch Diagnostic");
  console.log(`Time: ${new Date().toISOString()}\n`);

  // ─── CHECK 1: Sample 10 fixture_ids from matches (finished, with scores) ───
  hr("CHECK 1: 10 SAMPLE fixture_ids FROM matches (finished, with scores)");

  const matchSamples = await fetchAll<{
    fixture_id: number; date: string; league: string;
    home_team: string; away_team: string; score: string;
  }>(
    "matches",
    "fixture_id, date, league, home_team, away_team, score",
    [
      { column: "status", op: "eq", value: "finished" },
      { column: "score", op: "neq", value: "N/A" },
      { column: "date", op: "gte", value: "2025-08-01" },
    ],
    { column: "date", ascending: false },
    10
  );

  const matchSampleIds = new Set<number>();
  for (const m of matchSamples) {
    matchSampleIds.add(m.fixture_id);
    const synLabel = m.fixture_id >= 9_000_000 ? " [SYNTHETIC]" : " [API-Football]";
    console.log(
      `  fid=${String(m.fixture_id).padEnd(12)} ${m.date}  ${m.home_team.padEnd(22)} ${m.score.padEnd(6)} ${m.away_team.padEnd(22)} ${m.league}${synLabel}`
    );
  }

  const apiFootball = matchSamples.filter(m => m.fixture_id < 9_000_000).length;
  const synthetic = matchSamples.filter(m => m.fixture_id >= 9_000_000).length;
  console.log(`\n  API-Football range (<9M): ${apiFootball}  |  Synthetic range (>=9M): ${synthetic}`);

  // ─── CHECK 2: Sample 10 fixture_ids from odds_snapshots ────────────────
  hr("CHECK 2: 10 SAMPLE fixture_ids FROM odds_snapshots");

  const oddsSamples = await fetchAll<{
    fixture_id: number; bookmaker: string; home_odds: number;
    draw_odds: number; away_odds: number; snapshot_time: string; source: string;
  }>(
    "odds_snapshots",
    "fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time, source",
    undefined,
    { column: "snapshot_time", ascending: false },
    10
  );

  const oddsSampleIds = new Set<number>();
  for (const o of oddsSamples) {
    oddsSampleIds.add(o.fixture_id);
    const synLabel = o.fixture_id >= 9_000_000 ? " [SYNTHETIC]" : " [API-Football]";
    console.log(
      `  fid=${String(o.fixture_id).padEnd(12)} ${o.snapshot_time?.slice(0, 16)}  H=${o.home_odds} D=${o.draw_odds} A=${o.away_odds}  bk=${o.bookmaker}  src=${o.source}${synLabel}`
    );
  }

  const oddsApiFootball = oddsSamples.filter(o => o.fixture_id < 9_000_000).length;
  const oddsSynthetic = oddsSamples.filter(o => o.fixture_id >= 9_000_000).length;
  console.log(`\n  API-Football range (<9M): ${oddsApiFootball}  |  Synthetic range (>=9M): ${oddsSynthetic}`);

  // ─── CHECK 3: Overlap between the two sample sets ──────────────────────
  hr("CHECK 3: OVERLAP BETWEEN THE TWO 10-SAMPLE SETS");

  const overlap = [...matchSampleIds].filter(id => oddsSampleIds.has(id));
  console.log(`  Match sample IDs:  ${[...matchSampleIds].sort((a,b) => a-b).join(", ")}`);
  console.log(`  Odds sample IDs:   ${[...oddsSampleIds].sort((a,b) => a-b).join(", ")}`);
  console.log(`  Overlap:           ${overlap.length > 0 ? overlap.join(", ") : "NONE"}`);

  if (overlap.length === 0) {
    console.log("\n  ** ZERO overlap — confirms the ID systems are different! **");
  }

  // ─── CHECK 4: Distinct counts & intersection (efficient approach) ──────
  hr("CHECK 4: DISTINCT fixture_id COUNTS (full tables)");

  // Get all match fixture_ids (matches table is small, ~5K rows)
  console.log("  Loading all match fixture_ids...");
  const allMatchFids = await fetchAll<{ fixture_id: number }>(
    "matches", "fixture_id"
  );
  const matchFidSet = new Set<number>(allMatchFids.map(r => r.fixture_id));
  const matchFids = [...matchFidSet];
  console.log(`  Distinct fixture_ids in matches:        ${matchFidSet.size}`);

  const matchesUnder9M = matchFids.filter(id => id < 9_000_000).length;
  const matchesOver9M = matchFids.filter(id => id >= 9_000_000).length;
  console.log(`    - API-Football range (<9M):            ${matchesUnder9M}`);
  console.log(`    - Synthetic range (>=9M):              ${matchesOver9M}`);

  // Instead of scanning odds_snapshots for ALL fixture_ids (millions of rows),
  // probe in batches: check which match fixture_ids exist in odds_snapshots
  console.log("\n  Probing odds_snapshots for each match fixture_id (batched)...");
  const matchFidsWithOdds = new Set<number>();
  const batchSize = 50;

  for (let i = 0; i < matchFids.length; i += batchSize) {
    const batch = matchFids.slice(i, i + batchSize);
    const { data, error } = await sb
      .from("odds_snapshots")
      .select("fixture_id")
      .in("fixture_id", batch)
      .limit(1000);

    if (error) {
      console.error(`  Batch probe error:`, error.message);
      continue;
    }
    if (data) {
      for (const r of data) {
        matchFidsWithOdds.add(r.fixture_id);
      }
    }

    if ((i / batchSize) % 20 === 0) {
      process.stdout.write(`    Probed ${Math.min(i + batchSize, matchFids.length)}/${matchFids.length} match fixture_ids...\r`);
    }
  }
  console.log(`\n  Match fixture_ids WITH odds_snapshots:  ${matchFidsWithOdds.size}`);
  console.log(`  Match fixture_ids with NO odds:         ${matchFidSet.size - matchFidsWithOdds.size}`);

  // Breakdown of intersection by range
  const intWithOdds = [...matchFidsWithOdds];
  const intUnder9M = intWithOdds.filter(id => id < 9_000_000).length;
  const intOver9M = intWithOdds.filter(id => id >= 9_000_000).length;
  console.log(`    - Intersection API-Football (<9M):     ${intUnder9M}`);
  console.log(`    - Intersection Synthetic (>=9M):       ${intOver9M}`);

  // Get total row count and a sample of distinct fixture_ids from odds_snapshots
  // (use head count for total rows)
  const { count: totalOddsRows } = await sb
    .from("odds_snapshots")
    .select("*", { count: "exact", head: true });

  console.log(`\n  Total odds_snapshots rows:              ${totalOddsRows ?? "unknown"}`);

  // Get a few distinct fixture_ids from odds to see the range
  const oldOddsSample = await fetchAll<{ fixture_id: number }>(
    "odds_snapshots", "fixture_id",
    undefined,
    { column: "snapshot_time", ascending: true },
    100
  );
  const oldOddsFidSample = new Set<number>(oldOddsSample.map(r => r.fixture_id));
  const sampleOddsUnder9M = [...oldOddsFidSample].filter(id => id < 9_000_000).length;
  const sampleOddsOver9M = [...oldOddsFidSample].filter(id => id >= 9_000_000).length;
  console.log(`  Sample 100 oldest odds rows — distinct fids: ${oldOddsFidSample.size}`);
  console.log(`    - API-Football range (<9M):            ${sampleOddsUnder9M}`);
  console.log(`    - Synthetic range (>=9M):              ${sampleOddsOver9M}`);

  const joinRate = matchFidSet.size > 0
    ? ((matchFidsWithOdds.size / matchFidSet.size) * 100).toFixed(1)
    : "N/A";

  // ─── CHECK 5: Specific EPL match from Dec 2025 ────────────────────────
  hr("CHECK 5: SPECIFIC EPL MATCH LOOKUP (Dec 2025)");

  const eplDec = await fetchAll<{
    fixture_id: number; date: string; home_team: string;
    away_team: string; score: string; status: string;
  }>(
    "matches",
    "fixture_id, date, home_team, away_team, score, status",
    [
      { column: "league", op: "eq", value: "Premier League" },
      { column: "date", op: "gte", value: "2025-12-01" },
      { column: "date", op: "lte", value: "2025-12-31" },
      { column: "status", op: "eq", value: "finished" },
    ],
    { column: "date", ascending: true },
    5
  );

  if (eplDec.length === 0) {
    console.log("  No finished EPL matches found in December 2025.");
  } else {
    for (const m of eplDec) {
      console.log(`\n  MATCH: ${m.home_team} vs ${m.away_team} (${m.date}, ${m.score})`);
      console.log(`    fixture_id in matches table: ${m.fixture_id}`);

      // Check if this exact fixture_id has odds
      const { count: oddsCount } = await sb
        .from("odds_snapshots")
        .select("*", { count: "exact", head: true })
        .eq("fixture_id", m.fixture_id);

      console.log(`    odds_snapshots rows for this fixture_id: ${oddsCount ?? 0}`);

      if ((oddsCount ?? 0) === 0) {
        console.log(`    ** NO ODDS for this match's fixture_id! **`);

        // Look for a synthetic match with the same teams
        const { data: synMatches } = await sb
          .from("matches")
          .select("fixture_id, date, home_team, away_team, status")
          .gte("fixture_id", 9_000_000)
          .eq("home_team", m.home_team)
          .eq("away_team", m.away_team)
          .gte("date", "2025-11-25")
          .lte("date", "2026-01-05")
          .limit(5);

        if (synMatches && synMatches.length > 0) {
          for (const syn of synMatches) {
            const { count: synOddsCount } = await sb
              .from("odds_snapshots")
              .select("*", { count: "exact", head: true })
              .eq("fixture_id", syn.fixture_id);

            console.log(
              `    SYNTHETIC DUPLICATE: fid=${syn.fixture_id} date=${syn.date} status=${syn.status} odds_rows=${synOddsCount ?? 0}`
            );
          }
        } else {
          console.log(`    No synthetic duplicate found in matches table.`);
        }
      }
    }
  }

  // ─── VERDICT ───────────────────────────────────────────────────────────
  hr("VERDICT");

  console.log(`  Join rate (matches with odds):      ${joinRate}%`);
  console.log(`  Matches total (distinct fids):      ${matchFidSet.size}`);
  console.log(`    - API-Football IDs (<9M):         ${matchesUnder9M}`);
  console.log(`    - Synthetic IDs (>=9M):            ${matchesOver9M}`);
  console.log(`  Matches with odds:                  ${matchFidsWithOdds.size}`);
  console.log(`    - API-Football with odds:          ${intUnder9M}`);
  console.log(`    - Synthetic with odds:             ${intOver9M}`);
  console.log(`  Matches WITHOUT odds:               ${matchFidSet.size - matchFidsWithOdds.size}`);

  if (intUnder9M === 0 && matchesUnder9M > 0) {
    console.log(`\n  DIAGNOSIS: CONFIRMED FIXTURE_ID MISMATCH`);
    console.log(`  - ${matchesUnder9M} API-Football matches have ZERO odds in odds_snapshots`);
    console.log(`  - Only ${intOver9M} synthetic IDs (>=9M) link matches to odds`);
    console.log(`  - The odds poller stores odds under synthetic fixture_ids`);
    console.log(`  - API-Football match fixture_ids are in a completely different range`);
    console.log(`  - JOIN matches.fixture_id = odds_snapshots.fixture_id misses ~97% of matches`);
    console.log(`\n  ROOT CAUSE (from odds-poller.ts):`);
    console.log(`    syntheticFixtureId() hashes The Odds API event.id into 9M+ range`);
    console.log(`    When matchEventToFixture() fails to match, a NEW match row is created`);
    console.log(`    with the synthetic ID. Odds are stored against that synthetic row.`);
    console.log(`    Meanwhile, match-tracker.ts creates the "real" row from API-Football`);
    console.log(`    with a different fixture_id in the ~1M range.`);
    console.log(`    Result: duplicate match rows, odds only on the synthetic one.`);
  } else {
    console.log(`\n  DIAGNOSIS: ${joinRate}% join rate — ${intUnder9M > 0 ? "some" : "no"} API-Football IDs have odds`);
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
