import { log } from "../logger.js";
import { fetchAllRows } from "../api/supabase-client.js";
import type { MatchLookupEntry, LiveOddsEvent } from "../types.js";

/**
 * Normalize a team name for fuzzy matching:
 * - lowercase
 * - strip common suffixes (FC, CF, AFC, SC, etc.)
 * - collapse whitespace
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(fc|cf|afc|sc|ssc|ac|as|us|rc|rcd|ca|sv|vfb|tsg|1\.\s*fc|bsc)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TeamLookup {
  /** Map from normalized team name → set of matches (by fixture_id) */
  byName: Map<string, MatchLookupEntry[]>;
  /** All known team names (original form) */
  allTeams: Set<string>;
}

/**
 * Build a lookup of all matches from Supabase for team name resolution.
 * Called once at scheduler startup, refreshed periodically.
 */
export async function buildTeamLookup(): Promise<TeamLookup> {
  const matches = await fetchAllRows<Record<string, unknown>>(
    "matches",
    "fixture_id, date, league, home_team, away_team",
    undefined,
    { column: "date", ascending: false }
  );

  const byName = new Map<string, MatchLookupEntry[]>();
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

    // Index by both home and away normalized names
    for (const teamName of [entry.home_team, entry.away_team]) {
      const key = normalize(teamName);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key)!.push(entry);
    }
  }

  log.info(`Team lookup built: ${allTeams.size} teams, ${matches.length} matches`);

  return { byName, allTeams };
}

/**
 * Match a live Odds API event to a fixture_id in the matches table.
 *
 * Strategy:
 * 1. Normalize home_team and away_team from Odds API
 * 2. Find matches where both teams appear
 * 3. Filter by commence_time within 1 day of match date
 * 4. Return the best match, or null
 */
export function matchEventToFixture(
  event: LiveOddsEvent,
  lookup: TeamLookup
): number | null {
  const homeNorm = normalize(event.home_team);
  const awayNorm = normalize(event.away_team);

  const homeMatches = lookup.byName.get(homeNorm) ?? [];
  const awayMatches = lookup.byName.get(awayNorm) ?? [];

  if (homeMatches.length === 0 || awayMatches.length === 0) {
    return null;
  }

  // Find matches where this team is actually the home/away team
  const homeFixtures = new Set(
    homeMatches
      .filter((m) => normalize(m.home_team) === homeNorm)
      .map((m) => m.fixture_id)
  );

  // Find the intersection: fixture where home=home and away=away
  const eventDate = event.commence_time.slice(0, 10); // YYYY-MM-DD

  for (const am of awayMatches) {
    if (normalize(am.away_team) !== awayNorm) continue;
    if (!homeFixtures.has(am.fixture_id)) continue;

    // Check date proximity (within 1 day)
    const matchDate = am.date;
    const diff = Math.abs(
      new Date(eventDate).getTime() - new Date(matchDate).getTime()
    );
    if (diff <= 86400000) {
      // within 1 day
      return am.fixture_id;
    }
  }

  return null;
}

/**
 * Resolve a team name from Odds API format to matches-table format.
 * Returns the original name from the matches table, or null if unmatched.
 */
export function resolveTeamName(
  oddsApiName: string,
  lookup: TeamLookup
): string | null {
  const norm = normalize(oddsApiName);
  const entries = lookup.byName.get(norm);
  if (!entries || entries.length === 0) return null;

  // Return the first matching original name
  for (const e of entries) {
    if (normalize(e.home_team) === norm) return e.home_team;
    if (normalize(e.away_team) === norm) return e.away_team;
  }

  return null;
}
