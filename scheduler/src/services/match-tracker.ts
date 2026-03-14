import { API_FOOTBALL_KEY, LEAGUE_IDS, DOMESTIC_LEAGUES } from "../config.js";
import { upsertBatched, getSupabase } from "../api/supabase-client.js";
import { resolveOddsApiName } from "../utils/team-names.js";
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

// CL rate limiting: track last CL refresh to avoid exceeding API-Football daily limits
// CL refreshes at 5-min cadence vs 30s for domestic leagues
let lastCLRefreshTs = 0;
const CL_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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
    const isDomestic = DOMESTIC_LEAGUES.has(leagueName);

    // CL rate limiting: skip if refreshed too recently (5-min cadence)
    if (!isDomestic) {
      const now = Date.now();
      if (now - lastCLRefreshTs < CL_REFRESH_INTERVAL_MS) {
        log.debug(`Skipping ${leagueName} refresh — last CL refresh ${((now - lastCLRefreshTs) / 1000).toFixed(0)}s ago`);
        continue;
      }
      lastCLRefreshTs = now;
    }

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

        // Resolve team names through alias map so API-Football and Odds API use the same canonical names.
        // This prevents duplicate fixtures and ensures freezeKR alt-fixture fallback works.
        const homeTeam = resolveOddsApiName(f.teams.home.name);
        const awayTeam = resolveOddsApiName(f.teams.away.name);

        allRows.push({
          fixture_id: f.fixture.id,
          date: f.fixture.date.slice(0, 10),
          league: leagueName, // Use our config key, not API-Football's f.league.name (e.g. "Champions League" not "UEFA Champions League")
          home_team: homeTeam,
          away_team: awayTeam,
          score,
          status: finished ? "finished" : live ? "live" : "upcoming",
          status_code: statusCode,
          commence_time: f.fixture.date, // Full ISO datetime for sub-day resolution
          competition: isDomestic ? "league" : "champions_league",
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

  // ── Self-healing: if batch failed, retry each failed row individually ──
  // This handles cases where one bad row (constraint violation, etc.)
  // would otherwise kill the entire batch and block ALL match updates.
  if (failed > 0) {
    log.warn(
      `Match refresh: batch had ${failed} failures — retrying individually...`
    );

    const sb = getSupabase();
    let retrySuccess = 0;
    let retryFail = 0;

    for (const row of allRows) {
      const { error } = await sb
        .from("matches")
        .upsert([row], { onConflict: "fixture_id" });

      if (error) {
        retryFail++;
        log.error(
          `Match retry failed: fixture ${row.fixture_id} — ${error.message}`
        );
      } else {
        retrySuccess++;
      }
    }

    log.info(
      `Match refresh (retry): ${retrySuccess} succeeded, ${retryFail} still failing`
    );

    // Return combined totals: original successes + retry successes
    // The "failed" count is only what's still failing after retry
    return {
      upserted: inserted + retrySuccess,
      failed: retryFail,
    };
  }

  log.info(`Match refresh: ${inserted} upserted, ${failed} failed`);
  return { upserted: inserted, failed };
}
