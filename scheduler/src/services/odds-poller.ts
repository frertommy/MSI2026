import { fetchAllLeagueOdds } from "../api/odds-client.js";
import { upsertBatched, getSupabase } from "../api/supabase-client.js";
import {
  matchEventToFixture,
  resolveOddsApiName,
  type TeamLookup,
} from "../utils/team-names.js";
import { LEAGUE_SPORT_KEYS } from "../config.js";
import { log } from "../logger.js";
import type { PollResult, LiveOddsEvent } from "../types.js";
import { CreditTracker } from "./credit-tracker.js";

// Reverse map: sport_key → league name
const SPORT_TO_LEAGUE: Record<string, string> = {};
for (const [league, sport] of Object.entries(LEAGUE_SPORT_KEYS)) {
  SPORT_TO_LEAGUE[sport] = league;
}

/**
 * Generate a synthetic fixture_id from the Odds API event id.
 * We hash the string id into a numeric range that won't collide with API-Football ids.
 * API-Football ids are in the ~1M range; we use 9_000_000+ for synthetic ones.
 */
function syntheticFixtureId(oddsApiEventId: string): number {
  let hash = 0;
  for (let i = 0; i < oddsApiEventId.length; i++) {
    hash = (hash * 31 + oddsApiEventId.charCodeAt(i)) | 0;
  }
  return 9_000_000 + Math.abs(hash % 1_000_000);
}

/**
 * Create a new match row for an Odds API event that has no existing fixture.
 * Returns the generated fixture_id, or null on failure.
 */
async function createFixtureFromEvent(
  event: LiveOddsEvent,
  lookup: TeamLookup
): Promise<number | null> {
  const resolvedHome = resolveOddsApiName(event.home_team);
  const resolvedAway = resolveOddsApiName(event.away_team);
  const league = SPORT_TO_LEAGUE[event.sport_key] ?? event.sport_key;
  const date = event.commence_time.slice(0, 10);
  const fixtureId = syntheticFixtureId(event.id);

  const row = {
    fixture_id: fixtureId,
    date,
    league,
    home_team: resolvedHome,
    away_team: resolvedAway,
    score: "N/A",
    status: "upcoming",
  };

  const sb = getSupabase();
  const { error } = await sb
    .from("matches")
    .upsert([row], { onConflict: "fixture_id", ignoreDuplicates: true });

  if (error) {
    log.error(`Failed to create fixture for ${resolvedHome} vs ${resolvedAway}`, error.message);
    return null;
  }

  log.info(
    `Created fixture ${fixtureId}: ${resolvedHome} vs ${resolvedAway} (${league}, ${date})`
  );
  return fixtureId;
}

/**
 * Convert a single Odds API event into odds_snapshots rows.
 */
function eventToSnapshotRows(
  event: LiveOddsEvent,
  fixtureId: number
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();

  // Compute days_before_kickoff
  const kickoff = new Date(event.commence_time);
  const daysBefore = Math.max(
    0,
    Math.round((kickoff.getTime() - Date.now()) / 86400000)
  );

  for (const bk of event.bookmakers) {
    for (const market of bk.markets) {
      if (market.key !== "h2h") continue;

      const outcomes: Record<string, number> = {};
      for (const o of market.outcomes) {
        outcomes[o.name] = o.price;
      }

      rows.push({
        fixture_id: fixtureId,
        days_before_kickoff: daysBefore,
        snapshot_time: now,
        bookmaker: bk.key,
        home_odds: outcomes[event.home_team] ?? null,
        away_odds: outcomes[event.away_team] ?? null,
        draw_odds: outcomes["Draw"] ?? null,
        source: "the-odds-api-live",
      });
    }
  }

  return rows;
}

/**
 * Main poll function: fetch live odds from all leagues, match to fixtures, upsert.
 * For unmatched events: create new fixture rows, then store odds against them.
 */
export async function pollOdds(
  lookup: TeamLookup,
  creditTracker: CreditTracker
): Promise<PollResult> {
  log.info("Starting odds poll cycle...");

  const { allEvents, totalCreditsUsed, creditsRemaining } =
    await fetchAllLeagueOdds();

  // Record credits
  creditTracker.recordUsage(totalCreditsUsed, creditsRemaining);

  let eventsFound = 0;
  const unmatchedEvents: string[] = [];
  const allRows: Record<string, unknown>[] = [];
  let createdFixtures = 0;

  for (const { league, events } of allEvents) {
    log.info(`  ${league}: ${events.length} events`);
    eventsFound += events.length;

    for (const event of events) {
      let fixtureId = matchEventToFixture(event, lookup);

      if (fixtureId === null) {
        // Try creating a new fixture row
        fixtureId = await createFixtureFromEvent(event, lookup);
        if (fixtureId !== null) {
          createdFixtures++;
        } else {
          const resolvedHome = resolveOddsApiName(event.home_team);
          const resolvedAway = resolveOddsApiName(event.away_team);
          const desc = `${event.home_team}→${resolvedHome} vs ${event.away_team}→${resolvedAway} (${event.commence_time.slice(0, 10)})`;
          unmatchedEvents.push(desc);
          log.warn(`UNMATCHED: ${desc}`);
          continue;
        }
      }

      const rows = eventToSnapshotRows(event, fixtureId);
      allRows.push(...rows);
    }
  }

  // Upsert all odds rows
  let oddsRowsUpserted = 0;
  if (allRows.length > 0) {
    const { inserted, failed } = await upsertBatched(
      "odds_snapshots",
      allRows,
      "fixture_id,source,bookmaker,snapshot_time"
    );
    oddsRowsUpserted = inserted;
    if (failed > 0) {
      log.warn(`${failed} odds rows failed to upsert`);
    }
  }

  // Log summary
  if (createdFixtures > 0) {
    log.info(`Created ${createdFixtures} new fixture rows for unmatched events`);
  }
  if (unmatchedEvents.length > 0) {
    log.warn(
      `${unmatchedEvents.length} events still unmatched after fixture creation`,
      unmatchedEvents
    );
  }

  const result: PollResult = {
    eventsFound,
    oddsRowsUpserted,
    creditsUsed: totalCreditsUsed,
    creditsRemaining,
    unmatchedEvents,
  };

  log.info(
    `Poll complete: ${eventsFound} events, ${oddsRowsUpserted} rows upserted, ` +
      `${createdFixtures} new fixtures, ${totalCreditsUsed} credits used`
  );

  return result;
}
