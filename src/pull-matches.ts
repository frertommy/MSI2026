import "dotenv/config";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const API_KEY = process.env.API_FOOTBALL_KEY;
if (!API_KEY) {
  console.error("Missing API_FOOTBALL_KEY in .env");
  process.exit(1);
}

const BASE_URL = "https://v3.football.api-sports.io";

const LEAGUES: Record<string, number> = {
  "Premier League": 39,
  "La Liga": 140,
  "Bundesliga": 78,
  "Serie A": 135,
  "Ligue 1": 61,
};

interface ApiFixture {
  fixture: { id: number; date: string; status: { short: string } };
  league: { name: string };
  teams: { home: { name: string }; away: { name: string } };
  goals: { home: number | null; away: number | null };
}

interface CleanMatch {
  fixtureId: number;
  date: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  score: string;
  status: "finished" | "upcoming";
}

function fetchLeague(leagueName: string, leagueId: number, rawDir: string) {
  const url = `${BASE_URL}/fixtures?league=${leagueId}&season=2025&from=2026-01-01&to=2026-02-26`;
  const rawPath = path.join(rawDir, `${leagueId}.json`);
  console.log(`Fetching ${leagueName} (id=${leagueId})...`);

  // Try fetch first, fall back to curl for environments where DNS is restricted
  try {
    const output = execSync(
      `curl -s -H "x-apisports-key: ${API_KEY}" "${url}"`,
      { encoding: "utf-8", timeout: 30_000 },
    );
    fs.writeFileSync(rawPath, output);
    return JSON.parse(output);
  } catch {
    throw new Error(`Failed to fetch ${leagueName} (id=${leagueId})`);
  }
}

function processFixtures(fixtures: ApiFixture[]): CleanMatch[] {
  return fixtures.map((f) => {
    const finished = ["FT", "AET", "PEN"].includes(f.fixture.status.short);
    return {
      fixtureId: f.fixture.id,
      date: f.fixture.date.slice(0, 10),
      league: f.league.name,
      homeTeam: f.teams.home.name,
      awayTeam: f.teams.away.name,
      score:
        f.goals.home !== null && f.goals.away !== null
          ? `${f.goals.home}-${f.goals.away}`
          : "N/A",
      status: finished ? "finished" : "upcoming",
    };
  });
}

function main() {
  const rawDir = path.resolve("data/raw/fixtures");
  const processedDir = path.resolve("data/processed");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });

  const allMatches: CleanMatch[] = [];
  const counts: Record<string, number> = {};

  for (const [name, id] of Object.entries(LEAGUES)) {
    const json = fetchLeague(name, id, rawDir);
    console.log(`  Saved raw → data/raw/fixtures/${id}.json`);

    const fixtures: ApiFixture[] = json.response ?? [];
    const cleaned = processFixtures(fixtures);
    allMatches.push(...cleaned);
    counts[name] = fixtures.length;
  }

  // Save processed matches
  const outPath = path.join(processedDir, "matches.json");
  fs.writeFileSync(outPath, JSON.stringify(allMatches, null, 2));
  console.log(`\nSaved ${allMatches.length} matches → ${outPath}`);

  // Print summary
  console.log("\n=== Match count per league ===");
  for (const [league, count] of Object.entries(counts)) {
    console.log(`  ${league}: ${count}`);
  }
  console.log(`  TOTAL: ${allMatches.length}`);
}

main();
