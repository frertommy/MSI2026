import { fetchAllLeagueOdds, fetchAllOutrights } from "../api/odds-client.js";
import { upsertBatched, getSupabase } from "../api/supabase-client.js";
import {
  matchEventToFixture,
  resolveOddsApiName,
  type TeamLookup,
} from "../utils/team-names.js";
import { LEAGUE_SPORT_KEYS, OUTRIGHT_SPORT_KEYS } from "../config.js";
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

  const row: Record<string, unknown> = {
    fixture_id: fixtureId,
    date,
    league,
    home_team: resolvedHome,
    away_team: resolvedAway,
    score: "N/A",
    status: "upcoming",
    commence_time: event.commence_time,
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
 * Convert a single Odds API event into rows for all market types.
 * Returns { h2hRows, totalsRows, spreadsRows }.
 */
function eventToSnapshotRows(
  event: LiveOddsEvent,
  fixtureId: number
): {
  h2hRows: Record<string, unknown>[];
  totalsRows: Record<string, unknown>[];
  spreadsRows: Record<string, unknown>[];
} {
  const h2hRows: Record<string, unknown>[] = [];
  const totalsRows: Record<string, unknown>[] = [];
  const spreadsRows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();

  // Compute days_before_kickoff
  const kickoff = new Date(event.commence_time);
  const daysBefore = Math.max(
    0,
    Math.round((kickoff.getTime() - Date.now()) / 86400000)
  );

  for (const bk of event.bookmakers) {
    for (const market of bk.markets) {
      if (market.key === "h2h") {
        const outcomes: Record<string, number> = {};
        for (const o of market.outcomes) {
          outcomes[o.name] = o.price;
        }

        h2hRows.push({
          fixture_id: fixtureId,
          days_before_kickoff: daysBefore,
          snapshot_time: now,
          bookmaker: bk.key,
          home_odds: outcomes[event.home_team] ?? null,
          away_odds: outcomes[event.away_team] ?? null,
          draw_odds: outcomes["Draw"] ?? null,
          source: "the-odds-api-live",
        });
      } else if (market.key === "totals") {
        // Find Over and Under outcomes
        const overOutcome = market.outcomes.find((o) => o.name === "Over");
        const underOutcome = market.outcomes.find((o) => o.name === "Under");
        if (overOutcome && underOutcome && overOutcome.point != null) {
          totalsRows.push({
            fixture_id: fixtureId,
            bookmaker: bk.key,
            point: overOutcome.point,
            over_odds: overOutcome.price,
            under_odds: underOutcome.price,
            snapshot_time: now,
            source: "the-odds-api-live",
          });
        }
      } else if (market.key === "spreads") {
        // Match outcome names to home/away teams
        const homeOutcome = market.outcomes.find(
          (o) => o.name === event.home_team
        );
        const awayOutcome = market.outcomes.find(
          (o) => o.name === event.away_team
        );
        if (
          homeOutcome &&
          awayOutcome &&
          homeOutcome.point != null &&
          awayOutcome.point != null
        ) {
          spreadsRows.push({
            fixture_id: fixtureId,
            bookmaker: bk.key,
            home_point: homeOutcome.point,
            home_odds: homeOutcome.price,
            away_point: awayOutcome.point,
            away_odds: awayOutcome.price,
            snapshot_time: now,
            source: "the-odds-api-live",
          });
        }
      }
    }
  }

  return { h2hRows, totalsRows, spreadsRows };
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

  // Pass remaining credits for market selection
  const remaining = creditTracker.getStatus().remaining;
  const { allEvents, totalCreditsUsed, creditsRemaining } =
    await fetchAllLeagueOdds(remaining);

  // Record credits
  creditTracker.recordUsage(totalCreditsUsed, creditsRemaining);

  let eventsFound = 0;
  const unmatchedEvents: string[] = [];
  const allH2hRows: Record<string, unknown>[] = [];
  const allTotalsRows: Record<string, unknown>[] = [];
  const allSpreadsRows: Record<string, unknown>[] = [];
  let createdFixtures = 0;

  for (const { league, events } of allEvents) {
    log.info(`  ${league}: ${events.length} events`);
    eventsFound += events.length;

    for (const event of events) {
      let fixtureId = matchEventToFixture(event, lookup);

      if (fixtureId === null) {
        // Fallback: direct DB lookup by resolved names + date before creating synthetic row.
        // This catches cases where match-tracker has already created the real row but
        // the in-memory lookup hasn't been refreshed yet (common for newly ingested matches).
        const resolvedH = resolveOddsApiName(event.home_team);
        const resolvedA = resolveOddsApiName(event.away_team);
        const eventDate = event.commence_time.slice(0, 10);

        const { data: dbMatch } = await getSupabase()
          .from("matches")
          .select("fixture_id")
          .eq("date", eventDate)
          .eq("home_team", resolvedH)
          .eq("away_team", resolvedA)
          .lt("fixture_id", 9000000)
          .limit(1)
          .maybeSingle();

        if (dbMatch) {
          fixtureId = dbMatch.fixture_id;
          log.debug(`DB fallback matched: ${resolvedH} vs ${resolvedA} → fid=${fixtureId}`);
        }
      }

      if (fixtureId === null) {
        // Last resort: create a synthetic fixture row
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

      const { h2hRows, totalsRows, spreadsRows } = eventToSnapshotRows(
        event,
        fixtureId
      );
      allH2hRows.push(...h2hRows);
      allTotalsRows.push(...totalsRows);
      allSpreadsRows.push(...spreadsRows);
    }
  }

  // Upsert h2h odds rows
  let oddsRowsUpserted = 0;
  if (allH2hRows.length > 0) {
    const { inserted, failed } = await upsertBatched(
      "odds_snapshots",
      allH2hRows,
      "fixture_id,source,bookmaker,snapshot_time"
    );
    oddsRowsUpserted = inserted;
    if (failed > 0) {
      log.warn(`${failed} h2h odds rows failed to upsert`);
    }
  }

  // Upsert totals rows (graceful — don't break if table missing)
  if (allTotalsRows.length > 0) {
    try {
      const { inserted, failed } = await upsertBatched(
        "totals_snapshots",
        allTotalsRows,
        "fixture_id,bookmaker,snapshot_time"
      );
      log.info(`  Totals: ${inserted} upserted, ${failed} failed`);
    } catch (err) {
      log.warn(
        "Totals upsert failed (table may not exist)",
        err instanceof Error ? err.message : err
      );
    }
  }

  // Upsert spreads rows (graceful — don't break if table missing)
  if (allSpreadsRows.length > 0) {
    try {
      const { inserted, failed } = await upsertBatched(
        "spreads_snapshots",
        allSpreadsRows,
        "fixture_id,bookmaker,snapshot_time"
      );
      log.info(`  Spreads: ${inserted} upserted, ${failed} failed`);
    } catch (err) {
      log.warn(
        "Spreads upsert failed (table may not exist)",
        err instanceof Error ? err.message : err
      );
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
    `Poll complete: ${eventsFound} events, ${oddsRowsUpserted} h2h rows, ` +
      `${allTotalsRows.length} totals rows, ${allSpreadsRows.length} spreads rows, ` +
      `${createdFixtures} new fixtures, ${totalCreditsUsed} credits used`
  );

  return result;
}

/**
 * Poll outright (league winner) odds for all leagues.
 * Resolves team names via resolveOddsApiName() and upserts to outright_odds table.
 */
export async function pollOutrights(
  lookup: TeamLookup,
  creditTracker: CreditTracker
): Promise<{ rowsUpserted: number; creditsUsed: number }> {
  log.info("Starting outright poll...");

  const { allEvents, totalCreditsUsed, creditsRemaining } =
    await fetchAllOutrights();

  creditTracker.recordUsage(totalCreditsUsed, creditsRemaining);

  const rows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  let unresolvedCount = 0;

  for (const { league, events } of allEvents) {
    for (const event of events) {
      for (const bk of event.bookmakers) {
        for (const market of bk.markets) {
          if (market.key !== "outrights") continue;

          for (const outcome of market.outcomes) {
            const resolved = resolveOddsApiName(outcome.name);
            if (resolved === outcome.name) {
              // Name wasn't in alias map — log for debugging but still store
              unresolvedCount++;
              log.debug(
                `Outright: unresolved team "${outcome.name}" in ${league}`
              );
            }

            rows.push({
              league,
              team: resolved,
              bookmaker: bk.key,
              outright_odds: outcome.price,
              implied_prob: 1 / outcome.price,
              snapshot_time: now,
            });
          }
        }
      }
    }
  }

  let rowsUpserted = 0;
  if (rows.length > 0) {
    try {
      const { inserted, failed } = await upsertBatched(
        "outright_odds",
        rows,
        "league,team,bookmaker,snapshot_time"
      );
      rowsUpserted = inserted;
      if (failed > 0) {
        log.warn(`${failed} outright rows failed to upsert`);
      }
    } catch (err) {
      log.warn(
        "Outright upsert failed (table may not exist)",
        err instanceof Error ? err.message : err
      );
    }
  }

  log.info(
    `Outright poll complete: ${rows.length} rows (${rowsUpserted} upserted), ` +
      `${unresolvedCount} unresolved names, ${totalCreditsUsed} credits used`
  );

  return { rowsUpserted, creditsUsed: totalCreditsUsed };
}
