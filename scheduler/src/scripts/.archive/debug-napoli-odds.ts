import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

async function main() {
  // Search odds_snapshots for any fixture with recent snapshots that might be Napoli vs Torino
  // The odds_snapshots table has fixture_id but not team names — we need to check
  // what fixture_ids in the matches table DON'T exist but DO have odds

  // Get all fixture_ids from recent Serie A matches
  const { data: serieAMatches } = await sb
    .from("matches")
    .select("fixture_id, home_team, away_team, date, league")
    .eq("league", "Serie A")
    .gte("date", "2026-03-05")
    .lte("date", "2026-03-08")
    .order("date");

  console.log("Serie A fixtures Mar 5-8:");
  for (const m of serieAMatches ?? []) {
    const { count } = await sb
      .from("odds_snapshots")
      .select("*", { count: "exact", head: true })
      .eq("fixture_id", m.fixture_id);
    console.log(`  ${m.fixture_id} ${m.date} ${m.home_team} vs ${m.away_team} odds=${count ?? 0}`);
  }

  // Now let's check: what does the Odds API currently return for Serie A?
  // The odds-client fetches from soccer_italy_serie_a
  console.log("\n\nChecking Odds API directly for soccer_italy_serie_a...");
  const ODDS_API_KEY = process.env.ODDS_API_KEY!;
  const url = `https://api.the-odds-api.com/v4/sports/soccer_italy_serie_a/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h`;

  const resp = await fetch(url);
  if (!resp.ok) {
    console.log(`  HTTP ${resp.status}: ${await resp.text()}`);
    return;
  }

  const events = await resp.json();
  console.log(`  Found ${events.length} events\n`);

  for (const ev of events) {
    const homeTeam = ev.home_team;
    const awayTeam = ev.away_team;
    const commence = ev.commence_time;
    const id = ev.id;

    // Check if this event is Napoli-related
    if (homeTeam.includes("Napoli") || awayTeam.includes("Napoli") ||
        homeTeam.includes("Torino") || awayTeam.includes("Torino")) {
      console.log(`  *** ${id} ${commence} ${homeTeam} vs ${awayTeam}`);
      console.log(`      bookmakers: ${ev.bookmakers?.length ?? 0}`);
    }
  }

  // Show all events for completeness
  console.log("\nAll Serie A events from Odds API:");
  for (const ev of events) {
    console.log(`  ${ev.id} ${ev.commence_time} ${ev.home_team} vs ${ev.away_team} (${ev.bookmakers?.length ?? 0} books)`);
  }
}
main().catch(console.error);
