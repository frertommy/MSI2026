import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

async function main() {
  // Get all teams with B=1500 (bootstrap default)
  const { data: bootstrapTeams } = await sb
    .from("team_oracle_state")
    .select("team_id, b_value, m1_value, next_fixture_id")
    .gte("b_value", 1499.9)
    .lte("b_value", 1500.1)
    .order("team_id");

  console.log(`\nTeams with B=1500.0 (bootstrap default): ${bootstrapTeams?.length ?? 0}\n`);

  for (const team of bootstrapTeams ?? []) {
    const teamId = team.team_id as string;
    
    // Check settlement_log for this team
    const { count: settlements } = await sb
      .from("settlement_log")
      .select("*", { count: "exact", head: true })
      .eq("team_id", teamId);
    
    // Check if they have any upcoming matches
    const today = new Date().toISOString().slice(0, 10);
    const { count: upcoming } = await sb
      .from("matches")
      .select("*", { count: "exact", head: true })
      .or(`home_team.eq.${teamId},away_team.eq.${teamId}`)
      .eq("status", "upcoming")
      .gte("date", today);
    
    // Check if they have any finished matches at all
    const { count: finished } = await sb
      .from("matches")
      .select("*", { count: "exact", head: true })
      .or(`home_team.eq.${teamId},away_team.eq.${teamId}`)
      .eq("status", "finished");
    
    const status = settlements === 0 && upcoming === 0 ? "🔴 ORPHAN" :
                   settlements === 0 && (upcoming ?? 0) > 0 ? "🟡 NEW (no settlements yet)" :
                   settlements === 0 && (finished ?? 0) > 0 ? "🟠 UNSETTLED (has finished matches)" :
                   "✅ OK";
    
    console.log(`  ${teamId.padEnd(35)} settlements=${settlements ?? 0}, upcoming=${upcoming ?? 0}, finished=${finished ?? 0} ${status}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
