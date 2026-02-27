import { fetchAllLeagueOdds } from "../api/odds-client.js";
import { upsertBatched } from "../api/supabase-client.js";
import { matchEventToFixture, type TeamLookup } from "../utils/team-names.js";
import { log } from "../logger.js";
import type { PollResult, LiveOddsEvent } from "../types.js";
import { CreditTracker } from "./credit-tracker.js";

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

  for (const { league, events } of allEvents) {
    log.info(`  ${league}: ${events.length} events`);
    eventsFound += events.length;

    for (const event of events) {
      const fixtureId = matchEventToFixture(event, lookup);

      if (fixtureId === null) {
        const desc = `${event.home_team} vs ${event.away_team} (${event.commence_time.slice(0, 10)})`;
        unmatchedEvents.push(desc);
        continue;
      }

      const rows = eventToSnapshotRows(event, fixtureId);
      allRows.push(...rows);
    }
  }

  // Upsert all rows
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

  // Log unmatched
  if (unmatchedEvents.length > 0) {
    log.warn(`${unmatchedEvents.length} unmatched events`, unmatchedEvents.slice(0, 5));
  }

  const result: PollResult = {
    eventsFound,
    oddsRowsUpserted,
    creditsUsed: totalCreditsUsed,
    creditsRemaining,
    unmatchedEvents,
  };

  log.info(
    `Poll complete: ${eventsFound} events, ${oddsRowsUpserted} rows upserted, ${totalCreditsUsed} credits used`
  );

  return result;
}
