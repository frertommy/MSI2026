import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string
);

async function main() {
  // Get ALL Arsenal matches (both API-Football and synthetic IDs)
  const { data: homeM } = await sb.from("matches")
    .select("fixture_id, date, home_team, away_team, score, status")
    .eq("home_team", "Arsenal").gte("date", "2025-12-01").order("date");
  const { data: awayM } = await sb.from("matches")
    .select("fixture_id, date, home_team, away_team, score, status")
    .eq("away_team", "Arsenal").gte("date", "2025-12-01").order("date");

  const all = [...(homeM ?? []), ...(awayM ?? [])].sort((a, b) => a.date.localeCompare(b.date));

  console.log("=== ALL Arsenal fixture_ids (Dec 2025+) ===");
  const allFids: number[] = [];
  for (const m of all) {
    const synthetic = m.fixture_id >= 9000000 ? "SYNTH" : "APIFB";
    console.log(`  ${m.date} ${m.home_team} vs ${m.away_team} fid=${m.fixture_id} (${synthetic}) ${m.status} ${m.score}`);
    allFids.push(m.fixture_id);
  }

  // Check EACH fixture_id individually against odds_snapshots
  console.log("\n=== Checking odds_snapshots for EACH fixture_id ===");
  for (const fid of allFids) {
    const { count } = await sb.from("odds_snapshots")
      .select("*", { count: "exact", head: true })
      .eq("fixture_id", fid);
    const match = all.find(m => m.fixture_id === fid);
    const label = `${match?.date} ${match?.home_team} vs ${match?.away_team}`;
    const synthetic = fid >= 9000000 ? "SYNTH" : "APIFB";
    console.log(`  fid=${fid} (${synthetic}) → ${count ?? 0} odds snapshots  [${label}]`);
  }

  // Also check: total rows in odds_snapshots
  const { count: totalOdds } = await sb.from("odds_snapshots")
    .select("*", { count: "exact", head: true });
  console.log(`\nTotal rows in odds_snapshots: ${totalOdds}`);

  // Check distinct fixture_ids in odds_snapshots
  const { data: distinctFids } = await sb.from("odds_snapshots")
    .select("fixture_id")
    .limit(1000);
  const uniqueSet = new Set((distinctFids ?? []).map(r => r.fixture_id));
  console.log(`Distinct fixture_ids in odds_snapshots (up to 1000 rows sampled): ${uniqueSet.size}`);
  console.log(`Sample fixture_ids: ${[...uniqueSet].slice(0, 20).join(", ")}`);

  // Check if there's a different table name for historical odds
  const tables = ["odds", "odds_history", "bookmaker_odds", "odds_data", "fixture_odds", "pre_match_odds"];
  for (const t of tables) {
    const { data, error } = await sb.from(t).select("*").limit(1);
    if (error) {
      console.log(`Table "${t}": does not exist`);
    } else {
      console.log(`Table "${t}": EXISTS, sample=${JSON.stringify(data)}`);
    }
  }
}

main().catch(console.error);
