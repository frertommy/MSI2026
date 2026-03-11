/**
 * seed-and-backfill-v3.ts — One-time backfill for Oracle V3.
 *
 * Part A: Seed team_oracle_v3_state from V2 (handled by reseed-v3.ts — run that first).
 * Part B: Warm-up replay (Nov 1 2025 → Feb 26 2026) — settle all finished matches chronologically.
 *         Each settlement triggers BT re-solve for the league, updating R_network/R_next/R_market.
 * Part C: High-frequency replay (Feb 27 → now) — simulate cycles with R_next + settlement.
 *         Produces price history entries at ~daily granularity for chart population.
 * Part D: Verify — sanity checks on row counts and prices.
 *
 * Usage:
 *   cd scheduler && npx tsx src/scripts/seed-and-backfill-v3.ts
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// Verify env is loaded
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_KEY must be set. Check .env file.");
  process.exit(1);
}

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

// ─── Constants ───────────────────────────────────────────────
const WARMUP_START = "2025-11-01";
const WARMUP_END = "2026-02-26";
const HIFI_START = "2026-02-27";

// ─── Dynamic imports (must happen after dotenv loads env vars) ─
// ESM hoists static imports before top-level code runs, so config.ts
// would read empty SUPABASE_URL. Dynamic import() runs at call time.
type SettleFn = typeof import("../services/oracle-v3-settlement.js")["settleFixtureV3"];
type SolveBTFn = typeof import("../services/oracle-v3-market.js")["solveBTForLeague"];
type RefreshFn = typeof import("../services/oracle-v3-market.js")["refreshRNextForLeague"];

let settleFixtureV3: SettleFn;
let solveBTForLeague: SolveBTFn;
let refreshRNextForLeague: RefreshFn;
let ALL_LEAGUES: string[];

async function loadModules(): Promise<void> {
  const settlement = await import("../services/oracle-v3-settlement.js");
  const market = await import("../services/oracle-v3-market.js");
  const config = await import("../config.js");

  settleFixtureV3 = settlement.settleFixtureV3;
  solveBTForLeague = market.solveBTForLeague;
  refreshRNextForLeague = market.refreshRNextForLeague;
  ALL_LEAGUES = Object.keys(config.LEAGUE_SPORT_KEYS);
}

// ─── Part B: Warm-up Replay ──────────────────────────────────

async function warmupReplay(): Promise<{ settled: number; errors: number; btSolves: number }> {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  Part B: Warm-up Replay (Nov 2025 → Feb 2026)   ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // Fetch all finished matches in the warmup window, chronologically
  const allMatches: { fixture_id: number; date: string; league: string; home_team: string; away_team: string; commence_time: string | null }[] = [];
  let from = 0;
  const pageSize = 500;

  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("fixture_id, date, league, home_team, away_team, commence_time")
      .eq("status", "finished")
      .gte("date", WARMUP_START)
      .lte("date", WARMUP_END)
      .order("date", { ascending: true })
      .order("commence_time", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      console.error("  Failed to fetch finished matches:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    allMatches.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  console.log(`  Found ${allMatches.length} finished matches in warmup window\n`);

  let settled = 0;
  let errors = 0;
  let btSolves = 0;
  const leaguesNeedBT = new Set<string>();

  for (let i = 0; i < allMatches.length; i++) {
    const match = allMatches[i];

    try {
      const result = await settleFixtureV3(match.fixture_id);

      if (result.settled) {
        settled++;
        if (result.league) leaguesNeedBT.add(result.league);
      }

      // Every 10 settlements or end of batch: run BT re-solve for affected leagues
      if ((settled > 0 && settled % 10 === 0) || i === allMatches.length - 1) {
        for (const league of leaguesNeedBT) {
          try {
            await solveBTForLeague(league, "backfill_warmup", match.fixture_id);
            btSolves++;
          } catch (btErr) {
            console.error(`  BT solve failed for ${league}: ${btErr instanceof Error ? btErr.message : btErr}`);
          }
        }
        leaguesNeedBT.clear();
      }
    } catch (err) {
      errors++;
      if (errors <= 5) {
        console.error(`  Settlement error for fixture ${match.fixture_id} (${match.home_team} vs ${match.away_team}): ${err instanceof Error ? err.message : err}`);
      }
    }

    // Progress logging
    if ((i + 1) % 50 === 0 || i === allMatches.length - 1) {
      console.log(`  Progress: ${i + 1}/${allMatches.length} processed, ${settled} settled, ${errors} errors, ${btSolves} BT solves`);
    }
  }

  console.log(`\n  Warmup complete: ${settled} settled, ${errors} errors, ${btSolves} BT solves\n`);
  return { settled, errors, btSolves };
}

// ─── Part C: High-frequency Replay ──────────────────────────

async function hifiReplay(): Promise<{ settled: number; refreshed: number; priceRows: number; errors: number }> {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  Part C: High-frequency Replay (Feb 27 → now)   ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const today = new Date().toISOString().slice(0, 10);

  // Fetch all finished matches in the hi-fi window
  const allMatches: { fixture_id: number; date: string; league: string; home_team: string; away_team: string; commence_time: string | null }[] = [];
  let from = 0;
  const pageSize = 500;

  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("fixture_id, date, league, home_team, away_team, commence_time")
      .eq("status", "finished")
      .gte("date", HIFI_START)
      .lte("date", today)
      .order("date", { ascending: true })
      .order("commence_time", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      console.error("  Failed to fetch hi-fi matches:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    allMatches.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  console.log(`  Found ${allMatches.length} finished matches in hi-fi window\n`);

  // Group matches by date for daily R_next refresh simulation
  const matchesByDate = new Map<string, typeof allMatches>();
  for (const m of allMatches) {
    const existing = matchesByDate.get(m.date) ?? [];
    existing.push(m);
    matchesByDate.set(m.date, existing);
  }

  const dates = [...matchesByDate.keys()].sort();
  let settled = 0;
  let refreshed = 0;
  let priceRows = 0;
  let errors = 0;

  for (const date of dates) {
    const dayMatches = matchesByDate.get(date)!;
    const leaguesSettled = new Set<string>();

    // 1. Settle all matches for this day
    for (const match of dayMatches) {
      try {
        const result = await settleFixtureV3(match.fixture_id);
        if (result.settled) {
          settled++;
          if (result.league) leaguesSettled.add(result.league);
        }
      } catch (err) {
        errors++;
        if (errors <= 5) {
          console.error(`  Settlement error for fixture ${match.fixture_id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // 2. BT re-solve for leagues with settlements
    for (const league of leaguesSettled) {
      try {
        await solveBTForLeague(league, "backfill_hifi");
      } catch (err) {
        console.error(`  BT solve failed for ${league} on ${date}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // 3. R_next-only refresh for all other leagues (simulates daily cycle)
    for (const league of ALL_LEAGUES) {
      if (leaguesSettled.has(league)) continue;
      try {
        const result = await refreshRNextForLeague(league);
        if (result.updated) refreshed += result.teams_refreshed;
      } catch {
        // Non-critical — skip silently
      }
    }

    priceRows += dayMatches.length * 2; // rough estimate: 2 teams per match

    console.log(
      `  ${date}: ${dayMatches.length} matches, ${leaguesSettled.size} leagues settled, ` +
      `${settled} total settled, ${errors} errors`
    );
  }

  console.log(`\n  Hi-fi complete: ${settled} settled, ${refreshed} R_next refreshed, ${errors} errors\n`);
  return { settled, refreshed, priceRows, errors };
}

// ─── Part D: Verification ────────────────────────────────────

async function verify(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  Part D: Verification                           ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // 1. Count rows in team_oracle_v3_state
  const { count: v3StateCount } = await sb
    .from("team_oracle_v3_state")
    .select("team_id", { count: "exact", head: true });
  console.log(`  team_oracle_v3_state rows: ${v3StateCount ?? "ERROR"}`);

  // 2. Count V3 settlements
  const { count: v3SettlementCount } = await sb
    .from("settlement_log")
    .select("id", { count: "exact", head: true })
    .eq("oracle_version", "v3");
  console.log(`  settlement_log (v3) rows: ${v3SettlementCount ?? "ERROR"}`);

  // 3. Count V3 price history entries
  const { count: phMarketCount } = await sb
    .from("oracle_price_history")
    .select("id", { count: "exact", head: true })
    .eq("publish_reason", "market_refresh_v3");
  console.log(`  oracle_price_history (market_refresh_v3): ${phMarketCount ?? "ERROR"}`);

  const { count: phSettlementCount } = await sb
    .from("oracle_price_history")
    .select("id", { count: "exact", head: true })
    .eq("publish_reason", "settlement_v3");
  console.log(`  oracle_price_history (settlement_v3): ${phSettlementCount ?? "ERROR"}`);

  // 4. Count BT snapshots
  const { count: btSnapCount } = await sb
    .from("oracle_bt_snapshots")
    .select("id", { count: "exact", head: true });
  console.log(`  oracle_bt_snapshots rows: ${btSnapCount ?? "ERROR"}`);

  // 5. Print top 5 and bottom 5 by published_index
  const { data: topTeams } = await sb
    .from("team_oracle_v3_state")
    .select("team_id, b_value, m1_value, r_network, r_market, published_index, league")
    .order("published_index", { ascending: false })
    .limit(5);

  const { data: bottomTeams } = await sb
    .from("team_oracle_v3_state")
    .select("team_id, b_value, m1_value, r_network, r_market, published_index, league")
    .order("published_index", { ascending: true })
    .limit(5);

  console.log("\n  Top 5 teams by published_index:");
  for (const t of (topTeams ?? [])) {
    const price = ((Number(t.published_index) - 800) / 5).toFixed(2);
    console.log(
      `    ${t.team_id.padEnd(25)} B=${Number(t.b_value).toFixed(1)} M1=${Number(t.m1_value).toFixed(1)} ` +
      `R_net=${t.r_network != null ? Number(t.r_network).toFixed(1) : "—"} ` +
      `R_mkt=${t.r_market != null ? Number(t.r_market).toFixed(1) : "—"} ` +
      `pub=${Number(t.published_index).toFixed(1)} → $${price}`
    );
  }

  console.log("\n  Bottom 5 teams by published_index:");
  for (const t of (bottomTeams ?? [])) {
    const price = ((Number(t.published_index) - 800) / 5).toFixed(2);
    console.log(
      `    ${t.team_id.padEnd(25)} B=${Number(t.b_value).toFixed(1)} M1=${Number(t.m1_value).toFixed(1)} ` +
      `R_net=${t.r_network != null ? Number(t.r_network).toFixed(1) : "—"} ` +
      `R_mkt=${t.r_market != null ? Number(t.r_market).toFixed(1) : "—"} ` +
      `pub=${Number(t.published_index).toFixed(1)} → $${price}`
    );
  }

  // 6. Spot check named teams
  const checkTeams = ["Arsenal", "Barcelona", "Bayern München", "Manchester City", "Paris Saint Germain"];
  console.log("\n  Spot-check named teams:");
  for (const name of checkTeams) {
    const { data } = await sb
      .from("team_oracle_v3_state")
      .select("team_id, b_value, m1_value, published_index, league")
      .eq("team_id", name)
      .maybeSingle();

    if (data) {
      const price = ((Number(data.published_index) - 800) / 5).toFixed(2);
      console.log(
        `    ${data.team_id.padEnd(25)} B=${Number(data.b_value).toFixed(1)} M1=${Number(data.m1_value).toFixed(1)} ` +
        `pub=${Number(data.published_index).toFixed(1)} → $${price} [${data.league}]`
      );
    } else {
      console.log(`    ${name.padEnd(25)} — NOT FOUND (check team name spelling)`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load service modules (dynamic import — after env is set)
  await loadModules();

  const totalStart = Date.now();

  console.log("═══════════════════════════════════════════════════");
  console.log("  Oracle V3 Seed & Backfill");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`  Warmup: ${WARMUP_START} → ${WARMUP_END}`);
  console.log(`  Hi-fi:  ${HIFI_START} → now`);
  console.log("═══════════════════════════════════════════════════");

  // Check V3 state exists
  const { count: existingCount } = await sb
    .from("team_oracle_v3_state")
    .select("team_id", { count: "exact", head: true });

  if (!existingCount || existingCount === 0) {
    console.error("\n  ERROR: team_oracle_v3_state is empty. Run reseed-v3.ts first!\n");
    process.exit(1);
  }

  console.log(`\n  V3 state has ${existingCount} teams — proceeding with backfill\n`);

  // Part B: Warm-up replay
  const warmup = await warmupReplay();

  // Part C: Hi-fi replay
  const hifi = await hifiReplay();

  // Part D: Verification
  await verify();

  const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  Backfill Summary");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Warmup settled:   ${warmup.settled} (${warmup.errors} errors, ${warmup.btSolves} BT solves)`);
  console.log(`  Hi-fi settled:    ${hifi.settled} (${hifi.errors} errors, ${hifi.refreshed} R_next refreshed)`);
  console.log(`  Total elapsed:    ${totalElapsed}s`);
  console.log("═══════════════════════════════════════════════════");
  console.log("\n  Next: set ORACLE_V3_ENABLED = true in config.ts, then push to main.\n");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
