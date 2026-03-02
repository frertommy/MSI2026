/**
 * Backfill Aug–Dec 2025 match results from API-Football → Supabase matches table.
 *
 * Usage:  npx tsx src/backfill-matches.ts
 * Delete this script after use.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";

if (!API_FOOTBALL_KEY) { console.error("Missing API_FOOTBALL_KEY"); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE_URL/KEY"); process.exit(1); }

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const LEAGUES: Record<string, number> = {
  "Premier League": 39,
  "La Liga": 140,
  Bundesliga: 78,
  "Serie A": 135,
  "Ligue 1": 61,
};

// Backfill window: season start through Dec 31 2025
const FROM_DATE = "2025-08-01";
const TO_DATE = "2025-12-31";

interface ApiFixture {
  fixture: { id: number; date: string; status: { short: string } };
  league: { name: string };
  teams: { home: { name: string }; away: { name: string } };
  goals: { home: number | null; away: number | null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchLeagueFixtures(leagueId: number): Promise<ApiFixture[]> {
  const url = `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=2025&from=${FROM_DATE}&to=${TO_DATE}`;
  const resp = await fetch(url, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY },
  });

  if (!resp.ok) {
    console.error(`  HTTP ${resp.status} for league ${leagueId}`);
    return [];
  }

  const json = (await resp.json()) as { response: ApiFixture[] };
  return json.response ?? [];
}

async function main() {
  console.log(`\nBackfilling matches: ${FROM_DATE} → ${TO_DATE}\n`);

  const allRows: Record<string, unknown>[] = [];
  const leagues = Object.entries(LEAGUES);

  for (let i = 0; i < leagues.length; i++) {
    const [name, id] = leagues[i];
    const fixtures = await fetchLeagueFixtures(id);
    console.log(`  ${name}: ${fixtures.length} fixtures`);

    for (const f of fixtures) {
      const finished = ["FT", "AET", "PEN"].includes(f.fixture.status.short);
      const score =
        f.goals.home !== null && f.goals.away !== null
          ? `${f.goals.home}-${f.goals.away}`
          : "N/A";

      allRows.push({
        fixture_id: f.fixture.id,
        date: f.fixture.date.slice(0, 10),
        league: f.league.name,
        home_team: f.teams.home.name,
        away_team: f.teams.away.name,
        score,
        status: finished ? "finished" : "upcoming",
      });
    }

    // Rate limit
    if (i < leagues.length - 1) await sleep(1500);
  }

  console.log(`\nTotal fixtures fetched: ${allRows.length}`);

  if (allRows.length === 0) {
    console.log("Nothing to insert.");
    return;
  }

  // Upsert in batches of 500
  let upserted = 0;
  let failed = 0;

  for (let i = 0; i < allRows.length; i += 500) {
    const batch = allRows.slice(i, i + 500);
    const { error } = await sb
      .from("matches")
      .upsert(batch, { onConflict: "fixture_id", ignoreDuplicates: false });

    if (error) {
      console.error(`  Batch ${i / 500 + 1} error: ${error.message}`);
      failed += batch.length;
    } else {
      upserted += batch.length;
      console.log(`  Upserted batch ${i / 500 + 1}: ${batch.length} rows`);
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Upserted: ${upserted}`);
  console.log(`Failed:   ${failed}`);

  // Quick verification
  const { count } = await sb
    .from("matches")
    .select("*", { count: "exact", head: true });
  console.log(`Total matches in DB: ${count}`);

  const { data: earliest } = await sb
    .from("matches")
    .select("date")
    .order("date", { ascending: true })
    .limit(1);
  console.log(`Earliest match: ${earliest?.[0]?.date}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
