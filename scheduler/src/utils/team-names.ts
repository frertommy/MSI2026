import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";
import { fetchAllRows } from "../api/supabase-client.js";
import type { MatchLookupEntry, LiveOddsEvent } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Alias map: Odds API name → API-Football name ───────────
let aliasMap: Record<string, string> = {};

function loadAliasMap(): void {
  const aliasPath = path.resolve(__dirname, "../data/team-aliases.json");
  try {
    const raw = fs.readFileSync(aliasPath, "utf-8");
    aliasMap = JSON.parse(raw);
    log.info(`Loaded ${Object.keys(aliasMap).length} team aliases from team-aliases.json`);
  } catch {
    log.warn("Could not load team-aliases.json — falling back to fuzzy matching only");
    aliasMap = {};
  }
}

// Load on module init
loadAliasMap();

/**
 * Resolve an Odds API team name to the API-Football name used in the matches table.
 * Priority: alias map → normalized fuzzy match → null
 */
export function resolveOddsApiName(oddsApiName: string): string {
  // Check alias map first
  if (aliasMap[oddsApiName]) {
    return aliasMap[oddsApiName];
  }
  // No alias — return original (will be used in fuzzy lookup below)
  return oddsApiName;
}

// ─── Normalize for fuzzy fallback ────────────────────────────
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

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

// ─── Team Lookup ─────────────────────────────────────────────
export interface TeamLookup {
  /** Map from normalized team name → list of matches */
  byName: Map<string, MatchLookupEntry[]>;
  /** Map from original team name → list of matches (exact key) */
  byExactName: Map<string, MatchLookupEntry[]>;
  /** All known team names (API-Football form) */
  allTeams: Set<string>;
}

/**
 * Build a lookup of all matches from Supabase for team name resolution.
 * Called once at scheduler startup, refreshed periodically.
 */
export async function buildTeamLookup(): Promise<TeamLookup> {
  // Reload alias map in case it was updated
  loadAliasMap();

  const matches = await fetchAllRows<Record<string, unknown>>(
    "matches",
    "fixture_id, date, league, home_team, away_team",
    undefined,
    { column: "date", ascending: false }
  );

  const byName = new Map<string, MatchLookupEntry[]>();
  const byExactName = new Map<string, MatchLookupEntry[]>();
  const allTeams = new Set<string>();

  for (const m of matches) {
    const entry: MatchLookupEntry = {
      fixture_id: m.fixture_id as number,
      date: m.date as string,
      league: m.league as string,
      home_team: m.home_team as string,
      away_team: m.away_team as string,
    };

    allTeams.add(entry.home_team);
    allTeams.add(entry.away_team);

    // Index by both home and away names (normalized + exact)
    for (const teamName of [entry.home_team, entry.away_team]) {
      const normKey = normalize(teamName);
      if (!byName.has(normKey)) byName.set(normKey, []);
      byName.get(normKey)!.push(entry);

      if (!byExactName.has(teamName)) byExactName.set(teamName, []);
      byExactName.get(teamName)!.push(entry);
    }
  }

  log.info(`Team lookup built: ${allTeams.size} teams, ${matches.length} matches`);

  return { byName, byExactName, allTeams };
}

/**
 * Match a live Odds API event to a fixture_id in the matches table.
 *
 * Strategy:
 * 1. Resolve both team names through alias map
 * 2. Look up by exact API-Football name first (fast path)
 * 3. Fall back to normalized fuzzy matching
 * 4. Filter by commence_time within 2 days of match date
 * 5. Return fixture_id or null
 */
export function matchEventToFixture(
  event: LiveOddsEvent,
  lookup: TeamLookup
): number | null {
  // Resolve through alias map
  const resolvedHome = resolveOddsApiName(event.home_team);
  const resolvedAway = resolveOddsApiName(event.away_team);
  const eventDate = event.commence_time.slice(0, 10);

  // Fast path: exact name match
  const homeExact = lookup.byExactName.get(resolvedHome) ?? [];
  const awayExact = lookup.byExactName.get(resolvedAway) ?? [];

  if (homeExact.length > 0 && awayExact.length > 0) {
    const homeFixtures = new Set(
      homeExact.filter((m) => m.home_team === resolvedHome).map((m) => m.fixture_id)
    );

    for (const am of awayExact) {
      if (am.away_team !== resolvedAway) continue;
      if (!homeFixtures.has(am.fixture_id)) continue;

      const diff = Math.abs(
        new Date(eventDate).getTime() - new Date(am.date).getTime()
      );
      if (diff <= 2 * 86400000) {
        return am.fixture_id;
      }
    }
  }

  // Fallback: normalized matching
  const homeNorm = normalize(resolvedHome);
  const awayNorm = normalize(resolvedAway);

  const homeMatches = lookup.byName.get(homeNorm) ?? [];
  const awayMatches = lookup.byName.get(awayNorm) ?? [];

  if (homeMatches.length === 0 || awayMatches.length === 0) {
    return null;
  }

  const homeFixtures = new Set(
    homeMatches
      .filter((m) => normalize(m.home_team) === homeNorm)
      .map((m) => m.fixture_id)
  );

  for (const am of awayMatches) {
    if (normalize(am.away_team) !== awayNorm) continue;
    if (!homeFixtures.has(am.fixture_id)) continue;

    const diff = Math.abs(
      new Date(eventDate).getTime() - new Date(am.date).getTime()
    );
    if (diff <= 2 * 86400000) {
      return am.fixture_id;
    }
  }

  return null;
}

/**
 * Resolve a team name from Odds API format to matches-table format.
 * Uses alias map first, then fuzzy lookup.
 */
export function resolveTeamName(
  oddsApiName: string,
  lookup: TeamLookup
): string | null {
  // Alias map
  const resolved = resolveOddsApiName(oddsApiName);
  if (lookup.allTeams.has(resolved)) return resolved;

  // Fuzzy fallback
  const norm = normalize(resolved);
  const entries = lookup.byName.get(norm);
  if (!entries || entries.length === 0) return null;

  for (const e of entries) {
    if (normalize(e.home_team) === norm) return e.home_team;
    if (normalize(e.away_team) === norm) return e.away_team;
  }

  return null;
}
