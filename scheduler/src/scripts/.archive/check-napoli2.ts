import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

async function main() {
  const { data: f1 } = await sb.from("matches")
    .select("fixture_id, home_team, away_team, date, status, commence_time")
    .eq("fixture_id", 9633790).single();
  console.log("Fixture 9633790:", f1);

  const { data: f2 } = await sb.from("matches")
    .select("fixture_id, home_team, away_team, date, status, commence_time")
    .eq("fixture_id", 1378143).single();
  console.log("Fixture 1378143:", f2);

  // Check all Napoli vs Torino matches
  const { data: all } = await sb.from("matches")
    .select("fixture_id, home_team, away_team, date, status, commence_time")
    .eq("home_team", "Napoli")
    .eq("away_team", "Torino")
    .order("date");
  console.log("\nAll Napoli vs Torino:");
  for (const m of all ?? []) console.log(m);
}
main().catch(console.error);
