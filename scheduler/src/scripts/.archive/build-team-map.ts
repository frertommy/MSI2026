/**
 * build-team-map.ts
 *
 * Fetches all team names from The Odds API (live endpoint) and from the
 * Supabase matches table (API-Football names), then auto-matches them
 * using exact match → normalized match → Levenshtein distance.
 *
 * Outputs: scheduler/src/data/team-aliases.json
 *   { "Odds API Name": "API-Football Name", ... }
 *
 * Usage: cd scheduler && npx tsx src/scripts/build-team-map.ts
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ODDS_API_KEY = process.env.ODDS_API_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";

if (!ODDS_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing ODDS_API_KEY, SUPABASE_URL, or SUPABASE_KEY in .env");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── League sport keys ───────────────────────────────────────
const SPORT_KEYS: Record<string, string> = {
  "Premier League": "soccer_epl",
  "La Liga": "soccer_spain_la_liga",
  Bundesliga: "soccer_germany_bundesliga",
  "Serie A": "soccer_italy_serie_a",
  "Ligue 1": "soccer_france_ligue_one",
};

// Reverse map: sport_key → league name
const SPORT_TO_LEAGUE: Record<string, string> = {};
for (const [league, sport] of Object.entries(SPORT_KEYS)) {
  SPORT_TO_LEAGUE[sport] = league;
}

// ─── Helpers ─────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Strip accents/diacritics from a string.
 */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Normalize a team name for matching:
 * lowercase, strip accents, remove common suffixes, collapse whitespace.
 */
function normalize(name: string): string {
  return stripAccents(name)
    .toLowerCase()
    .replace(
      /\b(fc|cf|afc|sc|ssc|ac|as|us|rc|rcd|ca|sv|vfb|tsg|1\.\s*fc|bsc|ud|cd|fk|bv|if|sk|nk)\b/g,
      ""
    )
    .replace(/[''`.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

// ─── Step 1: Fetch Odds API team names ───────────────────────
interface OddsEvent {
  id: string;
  sport_key: string;
  home_team: string;
  away_team: string;
}

async function fetchOddsApiTeams(): Promise<Map<string, Set<string>>> {
  const teamsByLeague = new Map<string, Set<string>>();

  for (const [league, sportKey] of Object.entries(SPORT_KEYS)) {
    console.log(`Fetching Odds API teams for ${league} (${sportKey})...`);
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h`;

    const resp = await fetch(url);
    const remaining = resp.headers.get("x-requests-remaining");
    console.log(`  Credits remaining: ${remaining}`);

    if (!resp.ok) {
      console.error(`  HTTP ${resp.status} for ${sportKey}`);
      teamsByLeague.set(league, new Set());
      await sleep(1000);
      continue;
    }

    const events = (await resp.json()) as OddsEvent[];
    const teams = new Set<string>();
    for (const e of events) {
      teams.add(e.home_team);
      teams.add(e.away_team);
    }
    teamsByLeague.set(league, teams);
    console.log(`  ${teams.size} unique teams from ${events.length} events`);

    await sleep(1000);
  }

  return teamsByLeague;
}

// ─── Step 2: Fetch Supabase team names ───────────────────────
async function fetchSupabaseTeams(): Promise<Map<string, Set<string>>> {
  const teamsByLeague = new Map<string, Set<string>>();

  // Paginated fetch
  let from = 0;
  const pageSize = 1000;
  const allRows: { home_team: string; away_team: string; league: string }[] =
    [];

  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("home_team, away_team, league")
      .range(from, from + pageSize - 1);

    if (error) {
      console.error(`Supabase error: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  for (const row of allRows) {
    if (!teamsByLeague.has(row.league))
      teamsByLeague.set(row.league, new Set());
    teamsByLeague.get(row.league)!.add(row.home_team);
    teamsByLeague.get(row.league)!.add(row.away_team);
  }

  for (const [league, teams] of teamsByLeague) {
    console.log(`  Supabase ${league}: ${teams.size} teams`);
  }

  return teamsByLeague;
}

// ─── Step 3: Match teams ─────────────────────────────────────
function matchTeams(
  oddsTeams: Map<string, Set<string>>,
  supabaseTeams: Map<string, Set<string>>
): {
  aliases: Record<string, string>;
  unmatchedOdds: string[];
  unmatchedSupabase: string[];
} {
  const aliases: Record<string, string> = {};
  const matchedOdds = new Set<string>();
  const matchedSupabase = new Set<string>();

  // Flatten all Supabase teams into a single list with league info
  const allSupaTeams: string[] = [];
  for (const teams of supabaseTeams.values()) {
    for (const t of teams) allSupaTeams.push(t);
  }
  const uniqueSupaTeams = [...new Set(allSupaTeams)];

  // Flatten all Odds API teams
  const allOddsTeams: string[] = [];
  for (const teams of oddsTeams.values()) {
    for (const t of teams) allOddsTeams.push(t);
  }
  const uniqueOddsTeams = [...new Set(allOddsTeams)];

  // Build normalized lookup for Supabase teams
  const supaByNorm = new Map<string, string[]>();
  for (const t of uniqueSupaTeams) {
    const n = normalize(t);
    if (!supaByNorm.has(n)) supaByNorm.set(n, []);
    supaByNorm.get(n)!.push(t);
  }

  console.log(
    `\nMatching ${uniqueOddsTeams.length} Odds API teams → ${uniqueSupaTeams.length} Supabase teams...\n`
  );

  // Pass 1: Exact match
  for (const oddsName of uniqueOddsTeams) {
    if (uniqueSupaTeams.includes(oddsName)) {
      aliases[oddsName] = oddsName;
      matchedOdds.add(oddsName);
      matchedSupabase.add(oddsName);
      console.log(`  EXACT: "${oddsName}" → "${oddsName}"`);
    }
  }

  // Pass 2: Normalized match
  for (const oddsName of uniqueOddsTeams) {
    if (matchedOdds.has(oddsName)) continue;

    const oddsNorm = normalize(oddsName);
    const candidates = supaByNorm.get(oddsNorm);
    if (candidates && candidates.length > 0) {
      // Pick first unmatched candidate
      const candidate =
        candidates.find((c) => !matchedSupabase.has(c)) ?? candidates[0];
      aliases[oddsName] = candidate;
      matchedOdds.add(oddsName);
      matchedSupabase.add(candidate);
      console.log(`  NORM:  "${oddsName}" → "${candidate}"`);
    }
  }

  // Pass 3: Levenshtein distance < 3 on normalized forms
  const unmatchedOddsNames = uniqueOddsTeams.filter(
    (t) => !matchedOdds.has(t)
  );
  const unmatchedSupaNames = uniqueSupaTeams.filter(
    (t) => !matchedSupabase.has(t)
  );

  for (const oddsName of unmatchedOddsNames) {
    const oddsNorm = normalize(oddsName);
    let bestMatch: string | null = null;
    let bestDist = Infinity;

    for (const supaName of unmatchedSupaNames) {
      if (matchedSupabase.has(supaName)) continue;
      const supaNorm = normalize(supaName);
      const dist = levenshtein(oddsNorm, supaNorm);
      if (dist < bestDist) {
        bestDist = dist;
        bestMatch = supaName;
      }
    }

    if (bestMatch !== null && bestDist <= 3) {
      aliases[oddsName] = bestMatch;
      matchedOdds.add(oddsName);
      matchedSupabase.add(bestMatch);
      console.log(
        `  LEVEN(${bestDist}): "${oddsName}" → "${bestMatch}"`
      );
    }
  }

  // Collect final unmatched
  const finalUnmatchedOdds = uniqueOddsTeams.filter(
    (t) => !matchedOdds.has(t)
  );
  const finalUnmatchedSupabase = uniqueSupaTeams.filter(
    (t) => !matchedSupabase.has(t)
  );

  return {
    aliases,
    unmatchedOdds: finalUnmatchedOdds,
    unmatchedSupabase: finalUnmatchedSupabase,
  };
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log("═══ Build Team Alias Map ═══\n");

  console.log("Step 1: Fetching Odds API teams...");
  const oddsTeams = await fetchOddsApiTeams();

  console.log("\nStep 2: Fetching Supabase teams...");
  const supabaseTeams = await fetchSupabaseTeams();

  console.log("\nStep 3: Matching teams...");
  const { aliases, unmatchedOdds, unmatchedSupabase } = matchTeams(
    oddsTeams,
    supabaseTeams
  );

  // Sort aliases by key
  const sortedAliases: Record<string, string> = {};
  for (const key of Object.keys(aliases).sort()) {
    sortedAliases[key] = aliases[key];
  }

  // Write output
  const outPath = path.resolve(__dirname, "../data/team-aliases.json");
  fs.writeFileSync(outPath, JSON.stringify(sortedAliases, null, 2) + "\n");
  console.log(`\nWrote ${Object.keys(sortedAliases).length} aliases → ${outPath}`);

  // Report unmatched
  console.log(`\n═══ UNMATCHED ODDS API TEAMS (${unmatchedOdds.length}) ═══`);
  for (const t of unmatchedOdds.sort()) {
    console.log(`  ❌ "${t}"`);
  }

  console.log(
    `\n═══ UNMATCHED SUPABASE TEAMS (${unmatchedSupabase.length}) ═══`
  );
  for (const t of unmatchedSupabase.sort()) {
    console.log(`  ❌ "${t}"`);
  }

  console.log(
    `\n═══ SUMMARY ═══`
  );
  console.log(`  Matched: ${Object.keys(sortedAliases).length}`);
  console.log(`  Unmatched Odds API: ${unmatchedOdds.length}`);
  console.log(`  Unmatched Supabase: ${unmatchedSupabase.length}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
