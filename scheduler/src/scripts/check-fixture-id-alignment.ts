/**
 * check-fixture-id-alignment.ts — Diagnose fixture_id alignment between
 * matches and odds_snapshots for V1 Oracle settlement.
 *
 * The concern: freezeKR queries odds_snapshots by matches.fixture_id, but if
 * the odds poller wrote odds under a different fixture_id (e.g., a synthetic
 * one from The Odds API), the join silently fails and settlement says
 * "insufficient KR snapshots."
 *
 * Checks:
 *   1. How many FINISHED matches from 2025-26 have matching odds_snapshots rows?
 *   2. How many FINISHED matches from 2025-26 have ZERO odds_snapshots rows?
 *   3. For matches with zero odds — do odds exist under a different fixture_id?
 *      (Name-based cross-reference)
 *   4. Top 20 orphaned odds fixture_ids (in odds_snapshots but NOT in matches)
 *   5. Top 20 finished matches from this season with NO odds_snapshots
 *
 * Usage:
 *   cd scheduler
 *   npx tsx src/scripts/check-fixture-id-alignment.ts
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

// ─── Helpers ──────────────────────────────────────────────────

function hr(title: string) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(72)}`);
}

function sub(title: string) {
  console.log(`\n  --- ${title} ---`);
}

/** Derive season string from a date — e.g. 2025-08-20 → "2025-26" */
function deriveSeason(dateStr: string): string {
  const d = new Date(dateStr);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  if (month >= 7) return `${year}-${(year + 1).toString().slice(2)}`;
  return `${year - 1}-${year.toString().slice(2)}`;
}

/** Paginated fetch — returns all rows for a table/select. */
async function fetchAll<T = any>(
  table: string,
  columns: string,
  filters?: { column: string; op: string; value: unknown }[],
  orderBy?: { column: string; ascending: boolean },
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
        else if (f.op === "in") query = query.in(f.column, f.value as any[]);
      }
    }
    if (orderBy) {
      query = query.order(orderBy.column, { ascending: orderBy.ascending });
    }
    const { data, error } = await query;
    if (error) {
      console.error(`  [fetchAll ${table}] error:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

/** Count rows matching fixture_id in odds_snapshots. Supabase exact count. */
async function countOddsForFixture(fixtureId: number): Promise<number> {
  const { count, error } = await sb
    .from("odds_snapshots")
    .select("*", { count: "exact", head: true })
    .eq("fixture_id", fixtureId);
  if (error) return -1;
  return count ?? 0;
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  console.log("Fixture ID Alignment Diagnostic");
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Time:     ${new Date().toISOString()}`);

  // ────────────────────────────────────────────────────────────
  // Step 1: Load all FINISHED matches from the 2025-26 season
  // ────────────────────────────────────────────────────────────
  hr("1. LOAD FINISHED MATCHES (2025-26 SEASON)");

  // 2025-26 season: dates from ~2025-07-01 to ~2026-06-30
  const allMatches = await fetchAll<{
    fixture_id: number;
    date: string;
    league: string;
    home_team: string;
    away_team: string;
    score: string;
    status: string;
  }>(
    "matches",
    "fixture_id, date, league, home_team, away_team, score, status",
    [
      { column: "status", op: "eq", value: "finished" },
      { column: "date", op: "gte", value: "2025-07-01" },
      { column: "date", op: "lte", value: "2026-06-30" },
    ],
    { column: "date", ascending: false }
  );

  console.log(`  Finished matches in 2025-26 season window: ${allMatches.length}`);

  if (allMatches.length === 0) {
    console.log("  No finished matches found — nothing to check.");
    return;
  }

  // Show date range
  const dates = allMatches.map((m) => m.date).sort();
  console.log(`  Date range: ${dates[0]} to ${dates[dates.length - 1]}`);

  // Show league breakdown
  const leagueCounts: Record<string, number> = {};
  for (const m of allMatches) {
    leagueCounts[m.league] = (leagueCounts[m.league] || 0) + 1;
  }
  sub("By league");
  for (const [l, c] of Object.entries(leagueCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${l.padEnd(30)} ${c}`);
  }

  // ────────────────────────────────────────────────────────────
  // Step 2: Get distinct fixture_ids in odds_snapshots
  // ────────────────────────────────────────────────────────────
  hr("2. ODDS_SNAPSHOTS FIXTURE IDs");

  console.log("  Scanning odds_snapshots for distinct fixture_ids (paginated)...");
  const oddsFixtureRows = await fetchAll<{ fixture_id: number }>(
    "odds_snapshots",
    "fixture_id",
    undefined,
    undefined,
    1000
  );

  const oddsFixtureIdSet = new Set<number>();
  const oddsFixtureIdCounts = new Map<number, number>();
  for (const r of oddsFixtureRows) {
    oddsFixtureIdSet.add(r.fixture_id);
    oddsFixtureIdCounts.set(
      r.fixture_id,
      (oddsFixtureIdCounts.get(r.fixture_id) || 0) + 1
    );
  }
  console.log(`  Distinct fixture_ids in odds_snapshots: ${oddsFixtureIdSet.size}`);
  console.log(`  Total odds_snapshots rows scanned: ${oddsFixtureRows.length}`);

  // ────────────────────────────────────────────────────────────
  // Step 3: Cross-reference — which finished matches have odds?
  // ────────────────────────────────────────────────────────────
  hr("3. CROSS-REFERENCE: FINISHED MATCHES vs ODDS_SNAPSHOTS");

  const matchesWithOdds: typeof allMatches = [];
  const matchesWithoutOdds: typeof allMatches = [];
  const matchFixtureIdSet = new Set<number>();

  for (const m of allMatches) {
    matchFixtureIdSet.add(m.fixture_id);
    if (oddsFixtureIdSet.has(m.fixture_id)) {
      matchesWithOdds.push(m);
    } else {
      matchesWithoutOdds.push(m);
    }
  }

  console.log(`  Finished matches WITH odds_snapshots rows:    ${matchesWithOdds.length}`);
  console.log(`  Finished matches with ZERO odds_snapshots:    ${matchesWithoutOdds.length}`);
  const pctWithOdds =
    allMatches.length > 0
      ? ((matchesWithOdds.length / allMatches.length) * 100).toFixed(1)
      : "0";
  console.log(`  Coverage:                                     ${pctWithOdds}%`);

  // ────────────────────────────────────────────────────────────
  // Step 4: Orphaned odds — fixture_ids in odds_snapshots NOT in matches
  // ────────────────────────────────────────────────────────────
  hr("4. ORPHANED ODDS (fixture_ids in odds_snapshots NOT in matches table)");

  // Get ALL match fixture_ids (not just 2025-26 finished)
  const allMatchRows = await fetchAll<{ fixture_id: number }>(
    "matches",
    "fixture_id"
  );
  const allMatchFixtureIdSet = new Set<number>(allMatchRows.map((r) => r.fixture_id));

  const orphanedOddsFixtureIds: { fixture_id: number; count: number }[] = [];
  for (const fid of oddsFixtureIdSet) {
    if (!allMatchFixtureIdSet.has(fid)) {
      orphanedOddsFixtureIds.push({
        fixture_id: fid,
        count: oddsFixtureIdCounts.get(fid) || 0,
      });
    }
  }

  orphanedOddsFixtureIds.sort((a, b) => b.count - a.count);

  console.log(
    `  Total orphaned fixture_ids (in odds but NOT in matches): ${orphanedOddsFixtureIds.length}`
  );

  sub("Top 20 orphaned fixture_ids by row count");
  const top20Orphans = orphanedOddsFixtureIds.slice(0, 20);
  if (top20Orphans.length === 0) {
    console.log("    (none — all odds fixture_ids exist in matches)");
  } else {
    // For each orphaned fixture_id, grab a sample odds row to see team names
    for (const o of top20Orphans) {
      const { data: sampleRows } = await sb
        .from("odds_snapshots")
        .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time, source")
        .eq("fixture_id", o.fixture_id)
        .limit(1);

      const sample = sampleRows?.[0];
      const sampleInfo = sample
        ? `snap_time=${sample.snapshot_time?.substring(0, 16)} src=${sample.source} bk=${sample.bookmaker}`
        : "(no sample)";

      console.log(
        `    fixture_id=${String(o.fixture_id).padEnd(12)} rows=${String(
          o.count
        ).padEnd(6)} ${sampleInfo}`
      );
    }

    // Check if orphans are synthetic IDs (9_000_000+)
    const syntheticCount = orphanedOddsFixtureIds.filter(
      (o) => o.fixture_id >= 9_000_000
    ).length;
    console.log(
      `\n  Orphans with synthetic IDs (>=9,000,000): ${syntheticCount} / ${orphanedOddsFixtureIds.length}`
    );
  }

  // ────────────────────────────────────────────────────────────
  // Step 5: Finished matches with NO odds — show top 20
  // ────────────────────────────────────────────────────────────
  hr("5. TOP 20 FINISHED MATCHES (2025-26) WITH NO ODDS_SNAPSHOTS");

  const top20NoOdds = matchesWithoutOdds.slice(0, 20);
  if (top20NoOdds.length === 0) {
    console.log("  (none — all finished matches have odds)");
  } else {
    console.log(
      `  Showing ${top20NoOdds.length} of ${matchesWithoutOdds.length} matches without odds:\n`
    );
    for (const m of top20NoOdds) {
      const isSynthetic = m.fixture_id >= 9_000_000 ? " [SYNTHETIC]" : "";
      console.log(
        `    fid=${String(m.fixture_id).padEnd(12)} ${m.date}  ${m.home_team.padEnd(25)} vs ${m.away_team.padEnd(25)} ${m.league}${isSynthetic}`
      );
    }
  }

  // ────────────────────────────────────────────────────────────
  // Step 6: Name-based cross-reference — do orphaned odds match
  //         any of the "no odds" matches by team names + date?
  // ────────────────────────────────────────────────────────────
  hr("6. NAME-BASED CROSS-REFERENCE: ORPHANED ODDS vs NO-ODDS MATCHES");

  if (matchesWithoutOdds.length === 0 || orphanedOddsFixtureIds.length === 0) {
    console.log(
      "  Skipped — either no orphaned odds or no matches without odds."
    );
  } else {
    // Build a lookup from (home_norm, away_norm, date) for no-odds matches
    function normalize(name: string): string {
      return name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(
          /\b(fc|cf|afc|sc|ssc|ac|as|us|rc|rcd|ca|sv|vfb|tsg|1\.\s*fc|bsc|ud|cd|fk|bv|if|sk|nk)\b/g,
          ""
        )
        .replace(/[''`.-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    // For the orphaned odds, we can't easily get team names from odds_snapshots
    // (it only has fixture_id, not team names). But if the orphaned fixture_ids
    // are actually in matches (just under a different status or not matched above),
    // we can look them up. Let's check the matches table for orphaned fixture_ids.

    // Actually, orphaned means NOT in matches table at all. So let's try a different
    // approach: check if the no-odds matches have odds under DIFFERENT fixture_ids
    // by looking for matches that were created by the odds poller (synthetic IDs).

    // Approach: For each no-odds match, see if there's a match with a synthetic
    // fixture_id that has the same teams + similar date AND has odds.
    const syntheticMatches = await fetchAll<{
      fixture_id: number;
      date: string;
      home_team: string;
      away_team: string;
      league: string;
    }>(
      "matches",
      "fixture_id, date, home_team, away_team, league",
      [
        { column: "date", op: "gte", value: "2025-07-01" },
        { column: "date", op: "lte", value: "2026-06-30" },
      ]
    );

    // Build index of synthetic matches that HAVE odds
    const syntheticWithOdds = syntheticMatches.filter(
      (m) => m.fixture_id >= 9_000_000 && oddsFixtureIdSet.has(m.fixture_id)
    );

    console.log(
      `  Synthetic matches (fid >= 9M) with odds in 2025-26: ${syntheticWithOdds.length}`
    );

    // Check for duplicates: same teams + similar date
    let duplicateCount = 0;
    const duplicates: {
      matchFid: number;
      syntheticFid: number;
      home: string;
      away: string;
      matchDate: string;
      synDate: string;
      oddsRows: number;
    }[] = [];

    for (const noOddsMatch of matchesWithoutOdds) {
      const normHome = normalize(noOddsMatch.home_team);
      const normAway = normalize(noOddsMatch.away_team);
      const matchDate = new Date(noOddsMatch.date).getTime();

      for (const syn of syntheticWithOdds) {
        const synNormHome = normalize(syn.home_team);
        const synNormAway = normalize(syn.away_team);

        // Check if team names match (in either direction)
        const teamsMatch =
          (synNormHome === normHome && synNormAway === normAway) ||
          (synNormHome === normAway && synNormAway === normHome);

        if (!teamsMatch) continue;

        // Check date within 2 days
        const synDate = new Date(syn.date).getTime();
        if (Math.abs(synDate - matchDate) > 2 * 86400000) continue;

        duplicateCount++;
        duplicates.push({
          matchFid: noOddsMatch.fixture_id,
          syntheticFid: syn.fixture_id,
          home: noOddsMatch.home_team,
          away: noOddsMatch.away_team,
          matchDate: noOddsMatch.date,
          synDate: syn.date,
          oddsRows: oddsFixtureIdCounts.get(syn.fixture_id) || 0,
        });
      }
    }

    sub("Duplicate fixtures (API-Football ID with no odds + synthetic ID WITH odds)");
    console.log(`  Found ${duplicateCount} potential duplicate pairs:\n`);

    if (duplicates.length === 0) {
      console.log("    (none found)");
    } else {
      for (const d of duplicates.slice(0, 30)) {
        console.log(
          `    MATCH fid=${String(d.matchFid).padEnd(10)} date=${d.matchDate}  ${d.home.padEnd(22)} vs ${d.away.padEnd(22)}`
        );
        console.log(
          `    SYNTH fid=${String(d.syntheticFid).padEnd(10)} date=${d.synDate}  odds_rows=${d.oddsRows}`
        );
        console.log("");
      }
    }

    // Also check: non-synthetic fixture_ids in odds that don't match
    // any match row but have similar teams
    sub("Reverse check: no-odds matches vs ALL orphaned odds fixture_ids");

    // For a sample of orphaned odds, pull their rows and check team names
    // (odds_snapshots doesn't have team names, but we CAN check if the
    // fixture_id has a corresponding match that was somehow missed)
    // Actually let's check if matches for no-odds fixtures exist with
    // slightly different fixture_ids (off by small amount)
    const sampleNoOdds = matchesWithoutOdds.slice(0, 10);
    console.log(
      `\n  Checking ${sampleNoOdds.length} no-odds matches for nearby fixture_ids in odds...`
    );
    for (const m of sampleNoOdds) {
      // Check fixture_ids within +/- 10 of this match's fixture_id
      const nearbyOdds: number[] = [];
      for (const fid of oddsFixtureIdSet) {
        if (Math.abs(fid - m.fixture_id) <= 10 && fid !== m.fixture_id) {
          nearbyOdds.push(fid);
        }
      }
      if (nearbyOdds.length > 0) {
        console.log(
          `    fid=${m.fixture_id} (${m.home_team} vs ${m.away_team}) — nearby odds fids: ${nearbyOdds.join(", ")}`
        );
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // Step 7: Settlement impact — how many have oracle_kr_snapshots?
  // ────────────────────────────────────────────────────────────
  hr("7. SETTLEMENT IMPACT");

  const krRows = await fetchAll<{ fixture_id: number }>(
    "oracle_kr_snapshots",
    "fixture_id"
  );
  const krFixtureIdSet = new Set<number>(krRows.map((r) => r.fixture_id));

  const finishedWithKR = allMatches.filter((m) =>
    krFixtureIdSet.has(m.fixture_id)
  ).length;
  const finishedWithoutKR = allMatches.length - finishedWithKR;

  console.log(
    `  Finished 2025-26 matches with frozen KR:    ${finishedWithKR}`
  );
  console.log(
    `  Finished 2025-26 matches without frozen KR:  ${finishedWithoutKR}`
  );

  // Check settlement_log
  const settlementRows = await fetchAll<{
    fixture_id: number;
    team_id: string;
    delta_b: number;
    trace_payload: any;
  }>(
    "settlement_log",
    "fixture_id, team_id, delta_b, trace_payload"
  );

  const settledFixtures = new Set<number>(
    settlementRows.map((r) => r.fixture_id)
  );
  const failedSettlements = settlementRows.filter(
    (r) =>
      r.trace_payload &&
      typeof r.trace_payload === "object" &&
      (r.trace_payload as any).error === "insufficient_kr_snapshots"
  );

  const uniqueFailedFixtures = new Set<number>(
    failedSettlements.map((r) => r.fixture_id)
  );

  console.log(
    `\n  Settlement log: ${settledFixtures.size} distinct fixtures settled`
  );
  console.log(
    `  Failed settlements (insufficient_kr_snapshots): ${uniqueFailedFixtures.size} fixtures`
  );

  if (uniqueFailedFixtures.size > 0) {
    sub("Sample failed settlements");
    const failedSample = [...uniqueFailedFixtures].slice(0, 10);
    for (const fid of failedSample) {
      const match = allMatches.find((m) => m.fixture_id === fid);
      const hasOdds = oddsFixtureIdSet.has(fid);
      const oddsCount = oddsFixtureIdCounts.get(fid) || 0;
      if (match) {
        console.log(
          `    fid=${String(fid).padEnd(12)} ${match.date}  ${match.home_team.padEnd(22)} vs ${match.away_team.padEnd(22)} odds_in_table=${hasOdds} (${oddsCount} rows)`
        );
      } else {
        console.log(
          `    fid=${String(fid).padEnd(12)} (not in 2025-26 finished) odds_in_table=${hasOdds} (${oddsCount} rows)`
        );
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────────────────
  hr("SUMMARY");
  console.log(`  2025-26 finished matches total:             ${allMatches.length}`);
  console.log(`  ... with odds_snapshots rows:               ${matchesWithOdds.length} (${pctWithOdds}%)`);
  console.log(`  ... with ZERO odds_snapshots rows:          ${matchesWithoutOdds.length}`);
  console.log(`  Orphaned odds fixture_ids (not in matches): ${orphanedOddsFixtureIds.length}`);
  console.log(`  Duplicate pairs (API-Football + synthetic): ${matchesWithoutOdds.length > 0 ? "see section 6" : "0"}`);
  console.log(`  Frozen KR snapshots:                        ${finishedWithKR}`);
  console.log(`  Failed settlements (insufficient KR):       ${uniqueFailedFixtures.size}`);
  console.log(
    `\n  VERDICT: ${
      matchesWithoutOdds.length === 0
        ? "ALL finished matches have odds — fixture_id alignment looks GOOD."
        : `${matchesWithoutOdds.length} finished matches are MISSING odds. Check for fixture_id misalignment.`
    }`
  );

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
