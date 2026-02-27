import { ODDS_API_KEY, LEAGUE_SPORT_KEYS, CREDITS_PER_LEAGUE_CALL } from "../config.js";
import { log } from "../logger.js";
import type { LiveOddsEvent } from "../types.js";

const BASE_URL = "https://api.the-odds-api.com/v4/sports";

interface FetchResult {
  events: LiveOddsEvent[];
  creditsUsed: number;
  creditsRemaining: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch live h2h odds for a single sport key.
 * Returns events with bookmakers and credit info from response headers.
 */
async function fetchSportOdds(sportKey: string): Promise<FetchResult> {
  const url = `${BASE_URL}/${sportKey}/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h`;

  const resp = await fetch(url);

  // Parse credit headers
  const remaining = resp.headers.get("x-requests-remaining");
  const used = resp.headers.get("x-requests-used");

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    log.error(`Odds API ${sportKey} HTTP ${resp.status}`, body.slice(0, 200));
    return {
      events: [],
      creditsUsed: CREDITS_PER_LEAGUE_CALL,
      creditsRemaining: remaining ? parseInt(remaining, 10) : null,
    };
  }

  const events = (await resp.json()) as LiveOddsEvent[];

  log.debug(`Odds API ${sportKey}: ${events.length} events, remaining=${remaining}, used=${used}`);

  return {
    events,
    creditsUsed: CREDITS_PER_LEAGUE_CALL,
    creditsRemaining: remaining ? parseInt(remaining, 10) : null,
  };
}

/**
 * Fetch live odds for all 5 leagues.
 * 1-second delay between calls to avoid rate limits.
 */
export async function fetchAllLeagueOdds(): Promise<{
  allEvents: { league: string; events: LiveOddsEvent[] }[];
  totalCreditsUsed: number;
  creditsRemaining: number | null;
}> {
  const allEvents: { league: string; events: LiveOddsEvent[] }[] = [];
  let totalCreditsUsed = 0;
  let creditsRemaining: number | null = null;

  const leagues = Object.entries(LEAGUE_SPORT_KEYS);

  for (let i = 0; i < leagues.length; i++) {
    const [league, sportKey] = leagues[i];

    try {
      const result = await fetchSportOdds(sportKey);
      allEvents.push({ league, events: result.events });
      totalCreditsUsed += result.creditsUsed;
      if (result.creditsRemaining !== null) {
        creditsRemaining = result.creditsRemaining;
      }
    } catch (err) {
      log.error(`Failed to fetch ${league} odds`, err instanceof Error ? err.message : err);
      allEvents.push({ league, events: [] });
      totalCreditsUsed += CREDITS_PER_LEAGUE_CALL; // assume credit was used
    }

    // Rate limit: 1s between calls (except last)
    if (i < leagues.length - 1) {
      await sleep(1000);
    }
  }

  return { allEvents, totalCreditsUsed, creditsRemaining };
}
