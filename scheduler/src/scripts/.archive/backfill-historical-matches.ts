/**
 * backfill-historical-matches.ts
 *
 * Fetches full match history for seasons 2023-24 and 2024-25
 * from API-Football and upserts into the `matches` table.
 *
 * API-Football season convention:
 *   - season=2023 → 2023-24 campaign (Aug 2023 – May/Jun 2024)
 *   - season=2024 → 2024-25 campaign (Aug 2024 – May/Jun 2025)
 *
 * Leagues: Premier League (39), La Liga (140), Bundesliga (78),
 *          Serie A (135), Ligue 1 (61)
 *
 * Rate limits (free plan): 100 req/day, 10 req/min
 * This script makes 10 requests total (5 leagues × 2 seasons) — well within limits.
 *
 * Usage:
 *   cd scheduler
 *   npx tsx src/scripts/backfill-historical-matches.ts
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// ─── Load .env from project root ────────────────────────────
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

// API-Football seasons: 2023 = 2023-24, 2024 = 2024-25
const SEASONS = [2023, 2024];

const BATCH_SIZE = 500;

// ─── Types ──────────────────────────────────────────────────
interface ApiFixture {
  fixture: {
    id: number;
    date: string;
    status: { short: string };
  };
  league: { name: string; season: number };
  teams: { home: { name: string }; away: { name: string } };
  goals: { home: number | null; away: number | null };
}

// ─── Helpers ────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ts(): string {
  return new Date().toISOString();
}

async function fetchFixtures(leagueId: number, season: number): Promise<ApiFixture[]> {
  const url = `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=${season}`;

  const resp = await fetch(url, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY },
  });

  if (!resp.ok) {
    console.error(`[${ts()}] HTTP ${resp.status} for league=${leagueId} season=${season}`);
    return [];
  }

  // Log remaining daily credits
  const remaining = resp.headers.get("x-ratelimit-requests-remaining");
  if (remaining) {
    console.log(`[${ts()}]   API credits remaining today: ${remaining}`);
  }

  const json = await resp.json();
  const fixtures = (json as { response: ApiFixture[] }).response ?? [];
  return fixtures;
}

function toMatchRow(f: ApiFixture) {
  const statusCode = f.fixture.status.short;
  const finished = ["FT", "AET", "PEN"].includes(statusCode);
  const live = ["1H", "HT", "2H", "ET", "BT", "P"].includes(statusCode);
  const score =
    f.goals.home !== null && f.goals.away !== null
      ? `${f.goals.home}-${f.goals.away}`
      : "N/A";

  return {
    fixture_id: f.fixture.id,
    date: f.fixture.date.slice(0, 10),
    league: f.league.name,
    home_team: f.teams.home.name,
    away_team: f.teams.away.name,
    score,
    status: finished ? "finished" : live ? "live" : "upcoming",
    status_code: statusCode,
    commence_time: f.fixture.date,
  };
}

async function upsertBatch(rows: Record<string, unknown>[]): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from("matches")
      .upsert(batch, { onConflict: "fixture_id", ignoreDuplicates: false });

    if (error) {
      console.error(`[${ts()}]   Batch ${Math.floor(i / BATCH_SIZE) + 1} error:`, error.message);
      fail += batch.length;
    } else {
      ok += batch.length;
    }
  }
  return { ok, fail };
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  HISTORICAL MATCH BACKFILL`);
  console.log(`  Seasons: ${SEASONS.map((s) => `${s}-${(s + 1).toString().slice(2)}`).join(", ")}`);
  console.log(`  Leagues: ${Object.keys(LEAGUES).join(", ")}`);
  console.log(`${"═".repeat(60)}\n`);

  let totalMatches = 0;
  let totalFinished = 0;
  let totalFailed = 0;

  const leagueEntries = Object.entries(LEAGUES);

  for (const season of SEASONS) {
    const seasonLabel = `${season}-${(season + 1).toString().slice(2)}`;
    console.log(`\n── Season ${seasonLabel} ──────────────────────────────`);

    for (let i = 0; i < leagueEntries.length; i++) {
      const [leagueName, leagueId] = leagueEntries[i];

      console.log(`[${ts()}] Fetching ${leagueName} (${seasonLabel})...`);
      const fixtures = await fetchFixtures(leagueId, season);

      const finished = fixtures.filter((f) =>
        ["FT", "AET", "PEN"].includes(f.fixture.status.short)
      );
      const postponed = fixtures.filter((f) =>
        ["PST", "CANC", "ABD", "AWD", "WO"].includes(f.fixture.status.short)
      );

      console.log(
        `[${ts()}]   ${leagueName}: ${fixtures.length} total, ` +
          `${finished.length} finished, ${postponed.length} postponed/cancelled`
      );

      if (fixtures.length > 0) {
        const rows = fixtures.map(toMatchRow);
        const { ok, fail } = await upsertBatch(rows);
        console.log(`[${ts()}]   Upserted: ${ok}, Failed: ${fail}`);
        totalMatches += ok;
        totalFinished += finished.length;
        totalFailed += fail;
      }

      // Rate limit: wait 7s between calls (safe for 10 req/min free plan)
      if (i < leagueEntries.length - 1 || season !== SEASONS[SEASONS.length - 1]) {
        console.log(`[${ts()}]   Waiting 7s for rate limit...`);
        await sleep(7000);
      }
    }
  }

  // ─── Summary ────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  BACKFILL COMPLETE`);
  console.log(`  Total matches upserted: ${totalMatches}`);
  console.log(`  Total finished matches: ${totalFinished}`);
  console.log(`  Total failed:           ${totalFailed}`);
  console.log(`${"═".repeat(60)}\n`);

  // ─── Verify: count matches per season per league ──────────
  console.log(`Verifying DB state...\n`);

  for (const season of SEASONS) {
    const seasonLabel = `${season}-${(season + 1).toString().slice(2)}`;
    const fromDate = `${season}-07-01`;
    const toDate = `${season + 1}-07-01`;

    const { data, error } = await sb
      .from("matches")
      .select("league, status", { count: "exact" })
      .gte("date", fromDate)
      .lt("date", toDate);

    if (error) {
      console.error(`Verification query error:`, error.message);
      continue;
    }

    // Group by league + status
    const grouped: Record<string, Record<string, number>> = {};
    for (const row of data ?? []) {
      const l = row.league as string;
      const s = row.status as string;
      if (!grouped[l]) grouped[l] = {};
      grouped[l][s] = (grouped[l][s] || 0) + 1;
    }

    console.log(`  Season ${seasonLabel}:`);
    for (const [league, statuses] of Object.entries(grouped).sort()) {
      const parts = Object.entries(statuses)
        .map(([s, n]) => `${n} ${s}`)
        .join(", ");
      console.log(`    ${league}: ${parts}`);
    }
    console.log();
  }

  // Also show current season (2025-26) for comparison
  const { data: current } = await sb
    .from("matches")
    .select("league, status")
    .gte("date", "2025-07-01")
    .lt("date", "2026-07-01");

  if (current && current.length > 0) {
    const grouped: Record<string, Record<string, number>> = {};
    for (const row of current) {
      const l = row.league as string;
      const s = row.status as string;
      if (!grouped[l]) grouped[l] = {};
      grouped[l][s] = (grouped[l][s] || 0) + 1;
    }
    console.log(`  Season 2025-26 (existing):`);
    for (const [league, statuses] of Object.entries(grouped).sort()) {
      const parts = Object.entries(statuses)
        .map(([s, n]) => `${n} ${s}`)
        .join(", ");
      console.log(`    ${league}: ${parts}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
