import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_KEY as string
);

async function main() {
  // Try to query the tables to see if they exist
  const { error: e1 } = await sb.from("team_prices").select("id").limit(1);
  console.log("team_prices:", e1 ? `NOT FOUND (${e1.message})` : "EXISTS");

  const { error: e2 } = await sb.from("match_probabilities").select("id").limit(1);
  console.log("match_probabilities:", e2 ? `NOT FOUND (${e2.message})` : "EXISTS");
}

main();
