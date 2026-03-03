import { API_FOOTBALL_KEY, LEAGUE_IDS } from "../config.js";
import { upsertBatched } from "../api/supabase-client.js";
import { log } from "../logger.js";

interface ApiFixture {
  fixture: { id: number; date: string; status: { short: string } };
  league: { name: string };
  teams: { home: { name: string }; away: { name: string } };
  goals: { home: number | null; away: number | null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch recent fixtures from API-Football for a single league.
 * Fetches last 3 days + next 3 days to catch recent results and upcoming matches.
 */
async function fetchLeagueFixtures(
  leagueId: number,
  fromDate: string,
  toDate: string
): Promise<ApiFixture[]> {
  const url = `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=2025&from=${fromDate}&to=${toDate}`;

  const resp = await fetch(url, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY },
  });

  if (!resp.ok) {
    log.error(`API-Football HTTP ${resp.status} for league ${leagueId}`);
    return [];
  }

  const json = await resp.json();
  return (json as { response: ApiFixture[] }).response ?? [];
}

/**
 * Refresh match scores from API-Football.
 * Fetches fixtures from the last 3 days to catch recently finished matches,
 * plus next 3 days for upcoming fixtures.
 */
export async function refreshMatches(): Promise<{
  upserted: number;
  failed: number;
}> {
  if (!API_FOOTBALL_KEY) {
    log.warn("API_FOOTBALL_KEY not set — skipping match refresh");
    return { upserted: 0, failed: 0 };
  }

  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 3);
  const to = new Date(now);
  to.setDate(to.getDate() + 3);

  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);

  log.info(`Refreshing matches (${fromStr} to ${toStr})...`);

  const allRows: Record<string, unknown>[] = [];
  const leagues = Object.entries(LEAGUE_IDS);

  for (let i = 0; i < leagues.length; i++) {
    const [leagueName, leagueId] = leagues[i];

    try {
      const fixtures = await fetchLeagueFixtures(leagueId, fromStr, toStr);
      log.info(`  ${leagueName}: ${fixtures.length} fixtures`);

      for (const f of fixtures) {
        const statusCode = f.fixture.status.short;
        const finished = ["FT", "AET", "PEN"].includes(statusCode);
        const live = ["1H", "HT", "2H", "ET", "BT", "P"].includes(statusCode);
        const score =
          f.goals.home !== null && f.goals.away !== null
            ? `${f.goals.home}-${f.goals.away}`
            : "N/A";

        allRows.push({
          fixture_id: f.fixture.id,
          date: f.fixture.date.slice(0, 10),
          league: f.league.name,
          home_team: f.teams.home.name,
          away_team: f.teams.away.name,
          score,
          status: finished ? "finished" : live ? "live" : "upcoming",
          status_code: statusCode,
        });
      }
    } catch (err) {
      log.error(`Failed to fetch ${leagueName}`, err instanceof Error ? err.message : err);
    }

    // Rate limit: 1s between calls
    if (i < leagues.length - 1) {
      await sleep(1000);
    }
  }

  if (allRows.length === 0) {
    log.info("No fixtures to upsert");
    return { upserted: 0, failed: 0 };
  }

  // Upsert — fixture_id is the primary key
  const { inserted, failed } = await upsertBatched(
    "matches",
    allRows,
    "fixture_id"
  );

  log.info(`Match refresh: ${inserted} upserted, ${failed} failed`);
  return { upserted: inserted, failed };
}
