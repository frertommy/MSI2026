import { ODDS_API_KEY, LEAGUE_SPORT_KEYS, OUTRIGHT_SPORT_KEYS } from "../config.js";
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
 * Fetch odds for a single sport key with configurable markets.
 * Credit cost = number of comma-separated markets requested.
 */
async function fetchSportOdds(
  sportKey: string,
  markets = "h2h"
): Promise<FetchResult> {
  const url = `${BASE_URL}/${sportKey}/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=${markets}`;
  const creditCost = markets.split(",").length;

  const resp = await fetch(url);

  // Parse credit headers
  const remaining = resp.headers.get("x-requests-remaining");
  const used = resp.headers.get("x-requests-used");

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    log.error(`Odds API ${sportKey} HTTP ${resp.status}`, body.slice(0, 200));
    return {
      events: [],
      creditsUsed: creditCost,
      creditsRemaining: remaining ? parseInt(remaining, 10) : null,
    };
  }

  const events = (await resp.json()) as LiveOddsEvent[];

  log.debug(
    `Odds API ${sportKey} [${markets}]: ${events.length} events, remaining=${remaining}, used=${used}`
  );

  return {
    events,
    creditsUsed: creditCost,
    creditsRemaining: remaining ? parseInt(remaining, 10) : null,
  };
}

/**
 * Fetch live odds for all 5 leagues.
 * Markets are selected based on remaining credits:
 *   - creditsRemaining < 100 → h2h only (1 credit/league)
 *   - otherwise → h2h,totals,spreads (3 credits/league)
 * 1-second delay between calls to avoid rate limits.
 */
export async function fetchAllLeagueOdds(
  creditsRemaining: number | null = null
): Promise<{
  allEvents: { league: string; events: LiveOddsEvent[] }[];
  totalCreditsUsed: number;
  creditsRemaining: number | null;
  marketsUsed: string;
}> {
  // Choose markets based on credit budget
  const markets =
    creditsRemaining !== null && creditsRemaining < 100
      ? "h2h"
      : "h2h,totals,spreads";
  const creditCost = markets.split(",").length;

  log.info(`Odds poll: markets=${markets} (${creditCost} credits/league)`);

  const allEvents: { league: string; events: LiveOddsEvent[] }[] = [];
  let totalCreditsUsed = 0;
  let latestRemaining: number | null = null;

  const leagues = Object.entries(LEAGUE_SPORT_KEYS);

  for (let i = 0; i < leagues.length; i++) {
    const [league, sportKey] = leagues[i];

    try {
      const result = await fetchSportOdds(sportKey, markets);
      allEvents.push({ league, events: result.events });
      totalCreditsUsed += result.creditsUsed;
      if (result.creditsRemaining !== null) {
        latestRemaining = result.creditsRemaining;
      }
    } catch (err) {
      log.error(
        `Failed to fetch ${league} odds`,
        err instanceof Error ? err.message : err
      );
      allEvents.push({ league, events: [] });
      totalCreditsUsed += creditCost; // assume credit was used
    }

    // Rate limit: 1s between calls (except last)
    if (i < leagues.length - 1) {
      await sleep(1000);
    }
  }

  return {
    allEvents,
    totalCreditsUsed,
    creditsRemaining: latestRemaining,
    marketsUsed: markets,
  };
}

/**
 * Fetch outright (league winner) odds for a single sport key.
 * 1 credit per call.
 */
async function fetchOutrightOdds(sportKey: string): Promise<FetchResult> {
  const url = `${BASE_URL}/${sportKey}/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=outrights`;

  const resp = await fetch(url);
  const remaining = resp.headers.get("x-requests-remaining");
  const used = resp.headers.get("x-requests-used");

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    log.error(
      `Odds API outright ${sportKey} HTTP ${resp.status}`,
      body.slice(0, 200)
    );
    return {
      events: [],
      creditsUsed: 1,
      creditsRemaining: remaining ? parseInt(remaining, 10) : null,
    };
  }

  const events = (await resp.json()) as LiveOddsEvent[];

  log.debug(
    `Odds API outright ${sportKey}: ${events.length} events, remaining=${remaining}, used=${used}`
  );

  return {
    events,
    creditsUsed: 1,
    creditsRemaining: remaining ? parseInt(remaining, 10) : null,
  };
}

/**
 * Fetch outright odds for all 5 leagues.
 * 1-second delay between calls. 5 credits total.
 */
export async function fetchAllOutrights(): Promise<{
  allEvents: { league: string; events: LiveOddsEvent[] }[];
  totalCreditsUsed: number;
  creditsRemaining: number | null;
}> {
  const allEvents: { league: string; events: LiveOddsEvent[] }[] = [];
  let totalCreditsUsed = 0;
  let creditsRemaining: number | null = null;

  const leagues = Object.entries(OUTRIGHT_SPORT_KEYS);

  for (let i = 0; i < leagues.length; i++) {
    const [league, sportKey] = leagues[i];

    try {
      const result = await fetchOutrightOdds(sportKey);
      allEvents.push({ league, events: result.events });
      totalCreditsUsed += result.creditsUsed;
      if (result.creditsRemaining !== null) {
        creditsRemaining = result.creditsRemaining;
      }
    } catch (err) {
      log.error(
        `Failed to fetch ${league} outrights`,
        err instanceof Error ? err.message : err
      );
      allEvents.push({ league, events: [] });
      totalCreditsUsed += 1;
    }

    // Rate limit: 1s between calls (except last)
    if (i < leagues.length - 1) {
      await sleep(1000);
    }
  }

  return { allEvents, totalCreditsUsed, creditsRemaining };
}
