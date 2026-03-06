import "dotenv/config";
import { getSupabase } from "../api/supabase-client.js";

async function main() {
  const sb = getSupabase();

  // 1. Distribution
  const { count: totalOdds } = await sb
    .from("odds_snapshots")
    .select("*", { count: "exact", head: true });
  const { count: synthOdds } = await sb
    .from("odds_snapshots")
    .select("*", { count: "exact", head: true })
    .gte("fixture_id", 9000000);

  const realOdds = (totalOdds ?? 0) - (synthOdds ?? 0);
  console.log("=== ODDS DISTRIBUTION ===");
  console.log(`Total:     ${totalOdds}`);
  console.log(`Real (<9M): ${realOdds}  (${((realOdds / (totalOdds ?? 1)) * 100).toFixed(1)}%)`);
  console.log(`Synth (>=9M): ${synthOdds}  (${(((synthOdds ?? 0) / (totalOdds ?? 1)) * 100).toFixed(1)}%)`);

  // 2. How many DISTINCT real fixture_ids have odds?
  // Get all distinct fixture_ids from odds_snapshots that are real
  const { data: oddsFixtures } = await sb
    .from("odds_snapshots")
    .select("fixture_id")
    .lt("fixture_id", 9000000);

  const distinctOddsFids = new Set((oddsFixtures ?? []).map(r => r.fixture_id));
  console.log(`\nDistinct real fixture_ids with odds: ${distinctOddsFids.size}`);

  // 3. How many finished matches (real fids, this season) have odds?
  const { data: finishedMatches } = await sb
    .from("matches")
    .select("fixture_id, date, home_team, away_team")
    .eq("status", "finished")
    .lt("fixture_id", 9000000)
    .gte("date", "2025-08-01");

  let withOdds = 0;
  let withoutOdds = 0;
  const missingExamples: string[] = [];

  for (const m of finishedMatches ?? []) {
    if (distinctOddsFids.has(m.fixture_id)) {
      withOdds++;
    } else {
      withoutOdds++;
      if (missingExamples.length < 10) {
        missingExamples.push(`  ${m.date} ${m.home_team} vs ${m.away_team} (fid=${m.fixture_id})`);
      }
    }
  }

  console.log(`\n=== PRICING ENGINE PERSPECTIVE ===`);
  console.log(`Finished real matches (since Aug 2025): ${finishedMatches?.length}`);
  console.log(`With odds:    ${withOdds}  (${((withOdds / (finishedMatches?.length ?? 1)) * 100).toFixed(1)}%)`);
  console.log(`Without odds: ${withoutOdds}  (${((withoutOdds / (finishedMatches?.length ?? 1)) * 100).toFixed(1)}%)`);

  if (missingExamples.length > 0) {
    console.log(`\nSample matches without odds:`);
    for (const ex of missingExamples) console.log(ex);
  }

  // 4. Remaining synthetic matches
  const { data: remainingSynth } = await sb
    .from("matches")
    .select("fixture_id, date, home_team, away_team, status")
    .gte("fixture_id", 9000000)
    .order("date", { ascending: false })
    .limit(10);

  console.log(`\n=== REMAINING SYNTHETIC MATCH ROWS ===`);
  const { count: synthCount } = await sb
    .from("matches")
    .select("*", { count: "exact", head: true })
    .gte("fixture_id", 9000000);
  console.log(`Total: ${synthCount}`);
  for (const m of remainingSynth ?? []) {
    console.log(`  ${m.date} ${m.home_team} vs ${m.away_team} [${m.status}] fid=${m.fixture_id}`);
  }

  // 5. Spot check a recent match
  console.log(`\n=== SPOT CHECK ===`);
  const spotFid = 1379258; // Wolves vs Liverpool
  const { count: spotCount } = await sb
    .from("odds_snapshots")
    .select("*", { count: "exact", head: true })
    .eq("fixture_id", spotFid);
  console.log(`Wolves vs Liverpool (fid=${spotFid}): ${spotCount} odds rows`);
}

main().catch(console.error);
