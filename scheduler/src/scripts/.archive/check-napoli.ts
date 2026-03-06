import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

async function main() {
  for (const team of ["Napoli", "Torino", "Brighton", "Sunderland"]) {
    const { data } = await sb
      .from("team_oracle_state")
      .select("team_id, b_value, m1_value, published_index, confidence_score, next_fixture_id")
      .eq("team_id", team)
      .single();

    if (!data) { console.log(`${team}: NOT FOUND`); continue; }
    console.log(`${team}: B=${Number(data.b_value).toFixed(1)}, M1=${Number(data.m1_value).toFixed(2)}, idx=${Number(data.published_index).toFixed(2)}, conf=${Number(data.confidence_score).toFixed(4)}, fixture=${data.next_fixture_id}`);
  }

  // Check stale
  const { data: stale } = await sb
    .from("matches")
    .select("fixture_id, date, status")
    .eq("status", "upcoming")
    .lt("date", "2026-03-03");
  console.log(`\nStale fixtures (date < 2026-03-03): ${stale?.length ?? 0}`);

  // Count M1=0 teams
  const { data: allTeams } = await sb
    .from("team_oracle_state")
    .select("team_id, m1_value");
  const zeroM1 = (allTeams ?? []).filter((t: any) => Math.abs(Number(t.m1_value)) < 0.01);
  console.log(`\nTeams with M1=0: ${zeroM1.length}/${allTeams?.length ?? 0}`);
  for (const t of zeroM1) {
    console.log(`  ${t.team_id}`);
  }
}
main().catch(console.error);
