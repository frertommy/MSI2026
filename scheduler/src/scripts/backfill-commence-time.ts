/**
 * backfill-commence-time.ts
 *
 * Backfills the `commence_time` column for matches that have it as NULL.
 *
 * Problem: 1,198 finished matches have commence_time = NULL. This causes
 * freezeKR() to fall back to `${date}T23:59:59Z`, which can include
 * post-kickoff odds snapshots (e.g., a 15:00 KO with a 17:55 snapshot).
 *
 * Solution: Fetch fixtures from API-Football for all seasons and set
 * commence_time = fixture.date (the full ISO timestamp with exact kickoff).
 *
 * API calls: 5 leagues × 3 seasons = 15 calls total (well within 100/day limit)
 *
 * Usage:
 *   cd scheduler
 *   npx tsx src/scripts/backfill-commence-time.ts
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";

if (!API_FOOTBALL_KEY) throw new Error("API_FOOTBALL_KEY not set");
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("SUPABASE_URL / SUPABASE_KEY not set");

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Configuration ──────────────────────────────────────────

const LEAGUES: Record<string, number> = {
  "Premier League": 39,
  "La Liga": 140,
  Bundesliga: 78,
  "Serie A": 135,
  "Ligue 1": 61,
};

// API-Football seasons: 2023 = 2023-24, 2024 = 2024-25, 2025 = 2025-26
const SEASONS = [2023, 2024, 2025];

// ─── Types ──────────────────────────────────────────────────

interface ApiFixture {
  fixture: {
    id: number;
    date: string;   // Full ISO 8601, e.g. "2025-08-15T19:00:00+00:00"
    status: { short: string };
  };
  league: { name: string; season: number };
  teams: { home: { name: string }; away: { name: string } };
}

// ─── Helpers ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

async function fetchFixtures(leagueId: number, season: number): Promise<ApiFixture[]> {
  const url = `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=${season}`;

  const resp = await fetch(url, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY },
  });

  if (!resp.ok) {
    console.error(`  [${ts()}] HTTP ${resp.status} for league=${leagueId} season=${season}`);
    return [];
  }

  const remaining = resp.headers.get("x-ratelimit-requests-remaining");
  if (remaining) {
    console.log(`  [${ts()}] API credits remaining today: ${remaining}`);
  }

  const json = await resp.json();
  return (json as { response: ApiFixture[] }).response ?? [];
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log("\n" + "═".repeat(65));
  console.log("  BACKFILL commence_time FOR NULL MATCHES");
  console.log("  " + new Date().toISOString());
  console.log("═".repeat(65));

  // Step 1: Find all matches with NULL commence_time
  console.log("\n  Step 1: Querying matches with NULL commence_time...");

  const nullMatches: { fixture_id: number; date: string; home_team: string; away_team: string }[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("fixture_id, date, home_team, away_team")
      .is("commence_time", null)
      .range(from, from + pageSize - 1);

    if (error) {
      console.error(`  ERROR: ${error.message}`);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    nullMatches.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  console.log(`  Found ${nullMatches.length} matches with NULL commence_time`);

  if (nullMatches.length === 0) {
    console.log("\n  ✅ All matches already have commence_time. Nothing to do.\n");
    return;
  }

  // Build lookup: fixture_id → match
  const nullFixtureIds = new Set(nullMatches.map(m => m.fixture_id));

  // Step 2: Fetch fixtures from API-Football for all seasons
  console.log("\n  Step 2: Fetching fixtures from API-Football...\n");

  const fixtureMap = new Map<number, string>(); // fixture_id → commence_time
  let apiCalls = 0;

  for (const season of SEASONS) {
    const seasonLabel = `${season}-${(season + 1).toString().slice(2)}`;

    for (const [leagueName, leagueId] of Object.entries(LEAGUES)) {
      console.log(`  [${ts()}] Fetching ${leagueName} ${seasonLabel}...`);
      const fixtures = await fetchFixtures(leagueId, season);
      apiCalls++;

      let matched = 0;
      for (const f of fixtures) {
        if (nullFixtureIds.has(f.fixture.id)) {
          fixtureMap.set(f.fixture.id, f.fixture.date);
          matched++;
        }
      }

      console.log(`  [${ts()}]   ${fixtures.length} fixtures fetched, ${matched} matched to NULL commence_time`);

      // Rate limit: 7s between calls (safe for 10 req/min)
      await sleep(7000);
    }
  }

  console.log(`\n  API calls made: ${apiCalls}`);
  console.log(`  Fixtures matched: ${fixtureMap.size} of ${nullMatches.length}`);

  const unmatched = nullMatches.filter(m => !fixtureMap.has(m.fixture_id));
  if (unmatched.length > 0) {
    console.log(`  Unmatched (not in API-Football): ${unmatched.length}`);
    console.log(`  Sample unmatched:`);
    for (const m of unmatched.slice(0, 10)) {
      console.log(`    fid=${m.fixture_id} ${m.home_team} vs ${m.away_team} date=${m.date}`);
    }
  }

  // Step 3: Update commence_time in Supabase
  if (fixtureMap.size === 0) {
    console.log("\n  No fixtures to update.");
    return;
  }

  console.log(`\n  Step 3: Updating ${fixtureMap.size} matches in Supabase...`);

  const updateEntries = [...fixtureMap.entries()];

  let updated = 0;
  let failed = 0;

  // Update one-by-one (safe — no risk of overwriting other columns)
  // Supabase .update() only touches the columns you specify
  for (const [fixture_id, commence_time] of updateEntries) {
    const { error } = await sb
      .from("matches")
      .update({ commence_time })
      .eq("fixture_id", fixture_id);

    if (error) {
      console.error(`  Update failed for fixture ${fixture_id}: ${error.message}`);
      failed++;
    } else {
      updated++;
    }

    // Progress every 200
    if ((updated + failed) % 200 === 0) {
      console.log(`  ... ${updated + failed}/${updateEntries.length} processed`);
    }
  }

  console.log(`  Updated: ${updated}`);
  console.log(`  Failed:  ${failed}`);

  // Step 4: Verify
  console.log("\n  Step 4: Verification...");

  const { count: remainingNull } = await sb
    .from("matches")
    .select("*", { count: "exact", head: true })
    .is("commence_time", null);

  const { count: totalMatches } = await sb
    .from("matches")
    .select("*", { count: "exact", head: true });

  console.log(`  Total matches:         ${totalMatches}`);
  console.log(`  Still NULL:            ${remainingNull}`);
  console.log(`  Coverage:              ${(((totalMatches ?? 0) - (remainingNull ?? 0)) / (totalMatches ?? 1) * 100).toFixed(1)}%`);

  if ((remainingNull ?? 0) === 0) {
    console.log("\n  ✅ All matches now have commence_time!\n");
  } else {
    console.log(`\n  ⚠️  ${remainingNull} matches still have NULL commence_time (may be from unmapped fixtures)\n`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
