import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

function fuzzyNorm(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(fc|cf|afc|sc|ssc|ac|as|us|rc|rcd|ca|sv|vfb|tsg|bsc|ud|cd)\b/g, "")
    .replace(/[''`.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  // The primary fixture
  const primaryId = 1378143;
  const { data: primary } = await sb
    .from("matches")
    .select("fixture_id, league, home_team, away_team, date, status")
    .eq("fixture_id", primaryId)
    .single();

  console.log("Primary fixture:", primary);
  console.log(`  homeNorm: "${fuzzyNorm(primary!.home_team)}"`);
  console.log(`  awayNorm: "${fuzzyNorm(primary!.away_team)}"`);

  // Search all fixtures in same league + date range
  const matchDate = primary!.date;
  const dayBefore = new Date(new Date(matchDate).getTime() - 86400000).toISOString().slice(0, 10);
  const dayAfter = new Date(new Date(matchDate).getTime() + 86400000).toISOString().slice(0, 10);

  console.log(`\nSearching league=${primary!.league}, date ${dayBefore} to ${dayAfter}:`);

  const { data: leagueFixtures } = await sb
    .from("matches")
    .select("fixture_id, home_team, away_team, date, status")
    .eq("league", primary!.league)
    .gte("date", dayBefore)
    .lte("date", dayAfter)
    .neq("fixture_id", primaryId);

  if (!leagueFixtures || leagueFixtures.length === 0) {
    console.log("  NO other fixtures found in this league+date range!");
  } else {
    console.log(`  Found ${leagueFixtures.length} other fixtures:`);
    for (const lf of leagueFixtures) {
      const lfHomeNorm = fuzzyNorm(lf.home_team);
      const lfAwayNorm = fuzzyNorm(lf.away_team);
      const homeMatch = lfHomeNorm.includes(fuzzyNorm(primary!.home_team)) || fuzzyNorm(primary!.home_team).includes(lfHomeNorm);
      const awayMatch = lfAwayNorm.includes(fuzzyNorm(primary!.away_team)) || fuzzyNorm(primary!.away_team).includes(lfAwayNorm);

      // Check odds
      const { count } = await sb
        .from("odds_snapshots")
        .select("*", { count: "exact", head: true })
        .eq("fixture_id", lf.fixture_id);

      console.log(`    ${lf.fixture_id} ${lf.date} ${lf.home_team} vs ${lf.away_team} (${lf.status}) odds=${count ?? 0} homeMatch=${homeMatch} awayMatch=${awayMatch}`);
      console.log(`      homeNorm="${lfHomeNorm}" awayNorm="${lfAwayNorm}"`);
    }
  }

  // Also check: is there a Napoli vs Torino in odds_snapshots via any fixture?
  console.log("\n\nSearching odds_snapshots for any fixture involving these teams...");
  // Get all Napoli upcoming fixtures
  const { data: napoliFixtures } = await sb
    .from("matches")
    .select("fixture_id, home_team, away_team, date, status")
    .or("home_team.ilike.%Napoli%,away_team.ilike.%Napoli%")
    .gte("date", dayBefore)
    .lte("date", dayAfter);

  console.log("\nAll Napoli fixtures in date range:");
  for (const f of napoliFixtures ?? []) {
    const { count } = await sb
      .from("odds_snapshots")
      .select("*", { count: "exact", head: true })
      .eq("fixture_id", f.fixture_id);
    console.log(`  ${f.fixture_id} ${f.date} ${f.home_team} vs ${f.away_team} (${f.status}) odds=${count ?? 0}`);
  }

  // And Torino
  const { data: torinoFixtures } = await sb
    .from("matches")
    .select("fixture_id, home_team, away_team, date, status")
    .or("home_team.ilike.%Torino%,away_team.ilike.%Torino%")
    .gte("date", dayBefore)
    .lte("date", dayAfter);

  console.log("\nAll Torino fixtures in date range:");
  for (const f of torinoFixtures ?? []) {
    const { count } = await sb
      .from("odds_snapshots")
      .select("*", { count: "exact", head: true })
      .eq("fixture_id", f.fixture_id);
    console.log(`  ${f.fixture_id} ${f.date} ${f.home_team} vs ${f.away_team} (${f.status}) odds=${count ?? 0}`);
  }
}
main().catch(console.error);
