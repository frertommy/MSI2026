/**
 * name-mismatch-check.ts — Check for team name mismatches between
 * team_oracle_state and matches tables.
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

async function main() {
  const today = "2026-03-05";

  // Get all team_ids from team_oracle_state
  const { data: stateTeams } = await sb
    .from("team_oracle_state")
    .select("team_id, b_value, m1_value, next_fixture_id")
    .order("team_id");

  // Get all unique teams from upcoming matches
  const { data: homeTeams } = await sb
    .from("matches")
    .select("home_team")
    .eq("status", "upcoming")
    .gte("date", today);

  const { data: awayTeams } = await sb
    .from("matches")
    .select("away_team")
    .eq("status", "upcoming")
    .gte("date", today);

  const matchTeams = new Set<string>();
  for (const t of homeTeams ?? []) matchTeams.add(t.home_team);
  for (const t of awayTeams ?? []) matchTeams.add(t.away_team);

  const stateTeamIds = new Set((stateTeams ?? []).map((t: any) => t.team_id));

  // ─── Teams in upcoming matches but NOT in team_oracle_state ───
  console.log("\n=== Teams in upcoming matches but NOT in team_oracle_state ===\n");
  const missingFromState: string[] = [];
  for (const team of [...matchTeams].sort()) {
    if (!stateTeamIds.has(team)) {
      missingFromState.push(team);
      console.log("  " + team);
    }
  }
  console.log(`\nTotal: ${missingFromState.length}`);

  // ─── Teams in team_oracle_state with B=1500 (bootstrap default, never settled) ───
  console.log("\n=== Teams in state with B=1500.0 (bootstrap, never settled) ===\n");
  const bootstrapTeams = (stateTeams ?? []).filter((t: any) => Math.abs(Number(t.b_value) - 1500) < 0.1);
  for (const t of bootstrapTeams) {
    const hasFixture = t.next_fixture_id ? "has fixture" : "no fixture";
    console.log(`  ${(t.team_id as string).padEnd(35)} B=${Number(t.b_value).toFixed(1)}, M1=${Number(t.m1_value).toFixed(2)} (${hasFixture})`);
  }
  console.log(`\nTotal: ${bootstrapTeams.length}`);

  // ─── Cross-match: teams in matches but not state, vs teams in state with B=1500 ───
  console.log("\n=== Potential Name Mismatches ===\n");

  // For each missing team, find closest match in bootstrapTeams
  for (const missing of missingFromState) {
    const missingLower = missing.toLowerCase();

    // Check bootstrap teams for similarities
    for (const bt of bootstrapTeams) {
      const stateId = (bt.team_id as string);
      const stateLower = stateId.toLowerCase();

      // Basic similarity checks
      const match =
        // One contains the other's first word
        missingLower.split(" ")[0] === stateLower.split(" ")[0] ||
        // One is a substring of the other (at least 5 chars)
        (missingLower.length >= 5 && stateLower.includes(missingLower.slice(0, 5))) ||
        (stateLower.length >= 5 && missingLower.includes(stateLower.slice(0, 5)));

      if (match) {
        console.log(`  "${missing}" (matches) ↔ "${stateId}" (state, B=1500)`);
      }
    }
  }

  // Also check: teams in state with non-1500 B that DON'T have upcoming matches
  // (could be the "correct" version of a mismatched name)
  console.log("\n=== Active teams in state (B≠1500) without upcoming fixtures ===\n");
  const activeNoFixture = (stateTeams ?? []).filter(
    (t: any) => Math.abs(Number(t.b_value) - 1500) >= 0.1 && !t.next_fixture_id
  );
  for (const t of activeNoFixture) {
    // Check if this team has ANY upcoming match
    const { count } = await sb
      .from("matches")
      .select("*", { count: "exact", head: true })
      .or(`home_team.eq.${t.team_id},away_team.eq.${t.team_id}`)
      .eq("status", "upcoming")
      .gte("date", today);

    const inMatchTeams = matchTeams.has(t.team_id as string);
    console.log(`  ${(t.team_id as string).padEnd(35)} B=${Number(t.b_value).toFixed(1)}, upcoming=${count ?? 0}, inMatchSet=${inMatchTeams}`);
  }

  // ─── Specific check: look for Bundesliga umlaut issues ───
  console.log("\n=== Duplicate/Similar Bundesliga Names ===\n");
  const bundesTeams = (stateTeams ?? []).filter((t: any) => {
    const id = t.team_id as string;
    return id.includes("Bayern") || id.includes("Köln") || id.includes("Koln") ||
           id.includes("Gladbach") || id.includes("Mönchengladbach") || id.includes("Monchengladbach") ||
           id.includes("Nürnberg") || id.includes("Nurnberg") || id.includes("Düsseldorf") || id.includes("Dusseldorf") ||
           id.includes("München") || id.includes("Munich") || id.includes("Bochum");
  });
  for (const t of bundesTeams) {
    console.log(`  ${(t.team_id as string).padEnd(35)} B=${Number(t.b_value).toFixed(1)}, M1=${Number(t.m1_value).toFixed(2)}`);
  }

  // Check Serie A names
  console.log("\n=== Duplicate/Similar Serie A Names ===\n");
  const serieTeams = (stateTeams ?? []).filter((t: any) => {
    const id = t.team_id as string;
    return id.includes("Inter") || id.includes("Milan") || id.includes("Napoli");
  });
  for (const t of serieTeams) {
    console.log(`  ${(t.team_id as string).padEnd(35)} B=${Number(t.b_value).toFixed(1)}, M1=${Number(t.m1_value).toFixed(2)}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
