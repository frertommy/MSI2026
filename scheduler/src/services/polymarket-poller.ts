/**
 * Polymarket data poller — analytics/validation only, does NOT feed pricing engine.
 * Polls match odds and futures from the Gamma API (free, no auth, no credits).
 */
import { getSupabase } from "../api/supabase-client.js";
import {
  resolveOddsApiName,
  matchEventToFixture,
  type TeamLookup,
} from "../utils/team-names.js";
import { POLYMARKET_SERIES_IDS, POLYMARKET_FUTURES_SLUGS } from "../config.js";
import { log } from "../logger.js";
import type { LiveOddsEvent } from "../types.js";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const BATCH_SIZE = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Polymarket team name cleaning ──────────────────────────
// Polymarket uses "Arsenal FC", "Brighton & Hove Albion FC", "AFC Bournemouth", etc.
function cleanPolymarketName(raw: string): string {
  let name = raw.trim();
  name = name.replace(/\s+FC$/i, "");
  name = name.replace(/\s+AFC$/i, "");
  name = name.replace(/^AFC\s+/i, "");
  name = name.replace(/\s+SCO$/i, "");
  name = name.replace(/&/g, "and");
  name = name.replace(/\s+04\s+/, " ");
  name = name.replace(/\s+de\s+Madrid$/i, "");
  return name.trim();
}

function resolvePolymarketName(name: string): string {
  return resolveOddsApiName(cleanPolymarketName(name));
}

// ─── Gamma API types ────────────────────────────────────────
interface GammaMarket {
  id: string;
  question: string;
  outcomes: string; // JSON string: '["Yes", "No"]'
  outcomePrices: string; // JSON string: '["0.485", "0.515"]'
  volumeNum: number;
  groupItemTitle?: string;
  active: boolean;
  closed: boolean;
}

interface GammaEvent {
  id: number;
  title: string;
  volume: number;
  markets: GammaMarket[];
}

// ─── Classify market type from question / event title ───────
function classifyMarket(question: string, eventTitle: string): string {
  const q = question.toLowerCase();
  const t = eventTitle.toLowerCase();
  if (t.includes("- exact score")) return "exact_score";
  if (t.includes("- player props")) return "player_prop";
  if (t.includes("- halftime")) return "halftime";
  if (t.includes("- total corners")) return "corners";
  if (q.includes("spread:")) return "spread";
  if (q.includes("o/u ")) return "total";
  if (q.includes("win") || q.includes("draw")) return "moneyline";
  return "other";
}

// ─── Parse team names from event title ──────────────────────
function parseMatchTeams(
  title: string
): { home: string; away: string } | null {
  const baseTitle = title.split(" - ")[0].trim();
  const m = baseTitle.match(/^(.+?)\s+vs\.\s+(.+?)$/);
  if (!m) return null;
  return { home: m[1].trim(), away: m[2].trim() };
}

// ─── Fetch all events for a series (paginated) ──────────────
async function fetchSeriesEvents(seriesId: string): Promise<GammaEvent[]> {
  const all: GammaEvent[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${GAMMA_BASE}/events?series_id=${seriesId}&active=true&closed=false&limit=${limit}&offset=${offset}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      log.warn(`Polymarket API HTTP ${resp.status} for series ${seriesId}`);
      break;
    }
    const data = (await resp.json()) as GammaEvent[];
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < limit) break;
    offset += limit;
    await sleep(300);
  }

  return all;
}

// ─── Build previous volume map for delta calculation ────────
async function getPreviousVolumes(
  table: string,
  eventIds: string[]
): Promise<Map<string, number>> {
  const sb = getSupabase();
  const prevMap = new Map<string, number>();
  if (eventIds.length === 0) return prevMap;

  // Query in batches of 50 event IDs
  for (let i = 0; i < eventIds.length; i += 50) {
    const batch = eventIds.slice(i, i + 50);
    const { data } = await sb
      .from(table)
      .select("polymarket_event_id, market_question, volume")
      .in("polymarket_event_id", batch)
      .order("snapshot_time", { ascending: false })
      .limit(1000);

    if (data) {
      for (const row of data) {
        const key = `${row.polymarket_event_id}|${row.market_question}`;
        if (!prevMap.has(key)) {
          prevMap.set(key, row.volume ?? 0);
        }
      }
    }
  }

  return prevMap;
}

// ─── Insert rows in batches ─────────────────────────────────
async function insertBatched(
  table: string,
  rows: Record<string, unknown>[]
): Promise<{ inserted: number; failed: number }> {
  const sb = getSupabase();
  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb.from(table).insert(chunk);

    if (error) {
      log.warn(`${table} batch insert error: ${error.message}`);
      failed += chunk.length;
    } else {
      inserted += chunk.length;
    }
  }

  return { inserted, failed };
}

// ═══════════════════════════════════════════════════════════════
// 1. pollPolymarketMatches — match-level odds for all 5 leagues
// ═══════════════════════════════════════════════════════════════
export async function pollPolymarketMatches(): Promise<{
  rowsInserted: number;
}> {
  log.info("Polymarket: polling match odds...");
  const allRows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  const allEventIds: string[] = [];

  const leagues = Object.entries(POLYMARKET_SERIES_IDS);

  for (let i = 0; i < leagues.length; i++) {
    const [league, seriesId] = leagues[i];

    try {
      const events = await fetchSeriesEvents(seriesId);
      log.info(`  Polymarket ${league}: ${events.length} events`);

      for (const event of events) {
        const teams = parseMatchTeams(event.title);
        if (!teams) continue; // skip non-match events

        const eventId = String(event.id);
        allEventIds.push(eventId);

        // Determine event type from title suffix
        const suffix = event.title.includes(" - ")
          ? event.title.split(" - ").slice(1).join(" - ").trim()
          : "";

        if (!suffix) {
          // ─── Base moneyline event: combine 3 binary markets ───
          const homeTeam = teams.home;
          const awayTeam = teams.away;
          let homeProb = 0;
          let drawProb = 0;
          let awayProb = 0;
          let totalVolume = 0;

          for (const mkt of event.markets) {
            if (mkt.closed || !mkt.active) continue;
            const prices = JSON.parse(mkt.outcomePrices) as string[];
            const yesPrice = parseFloat(prices[0]) || 0;
            totalVolume += mkt.volumeNum || 0;

            const git = (mkt.groupItemTitle ?? "").toLowerCase();
            if (git.startsWith("draw")) {
              drawProb = yesPrice;
            } else if (git === homeTeam.toLowerCase()) {
              homeProb = yesPrice;
            } else if (git === awayTeam.toLowerCase()) {
              awayProb = yesPrice;
            } else {
              // Fallback: check question text
              const q = mkt.question.toLowerCase();
              if (q.includes("draw")) drawProb = yesPrice;
              else if (q.includes(homeTeam.toLowerCase().slice(0, 10)))
                homeProb = yesPrice;
              else if (q.includes(awayTeam.toLowerCase().slice(0, 10)))
                awayProb = yesPrice;
            }
          }

          if (homeProb > 0 || drawProb > 0 || awayProb > 0) {
            allRows.push({
              league,
              event_title: event.title,
              polymarket_event_id: eventId,
              market_type: "moneyline",
              market_question: event.title,
              outcomes: [homeTeam, "Draw", awayTeam],
              outcome_prices: [
                Math.round(homeProb * 10000) / 10000,
                Math.round(drawProb * 10000) / 10000,
                Math.round(awayProb * 10000) / 10000,
              ],
              volume: Math.round(totalVolume * 100) / 100,
              volume_delta: 0,
              snapshot_time: now,
            });
          }
        } else {
          // ─── More Markets / Exact Score / Player Props / etc. ──
          for (const mkt of event.markets) {
            if (mkt.closed || !mkt.active) continue;

            const marketType = classifyMarket(mkt.question, event.title);
            let outcomes: unknown[];
            let prices: number[];

            try {
              outcomes = JSON.parse(mkt.outcomes);
              prices = (JSON.parse(mkt.outcomePrices) as string[]).map(
                (p) => Math.round(parseFloat(p) * 10000) / 10000
              );
            } catch {
              continue;
            }

            allRows.push({
              league,
              event_title: event.title,
              polymarket_event_id: eventId,
              market_type: marketType,
              market_question: mkt.question,
              outcomes,
              outcome_prices: prices,
              volume: Math.round((mkt.volumeNum || 0) * 100) / 100,
              volume_delta: 0,
              snapshot_time: now,
            });
          }
        }
      }
    } catch (err) {
      log.warn(
        `Polymarket ${league} poll failed`,
        err instanceof Error ? err.message : err
      );
    }

    // Rate limit between leagues
    if (i < leagues.length - 1) await sleep(500);
  }

  // ─── Compute volume deltas ────────────────────────────────
  if (allRows.length > 0) {
    const uniqueIds = [...new Set(allEventIds)];
    const prevMap = await getPreviousVolumes(
      "polymarket_match_odds",
      uniqueIds
    );

    for (const row of allRows) {
      const key = `${row.polymarket_event_id}|${row.market_question}`;
      const prevVol = prevMap.get(key);
      if (prevVol !== undefined && row.volume !== null) {
        row.volume_delta =
          Math.round(((row.volume as number) - prevVol) * 100) / 100;
      }
    }

    const { inserted, failed } = await insertBatched(
      "polymarket_match_odds",
      allRows
    );
    log.info(
      `Polymarket matches: ${inserted} rows inserted, ${failed} failed`
    );
    return { rowsInserted: inserted };
  }

  log.info("Polymarket matches: 0 rows");
  return { rowsInserted: 0 };
}

// ═══════════════════════════════════════════════════════════════
// 2. pollPolymarketFutures — league winner markets (slug-based)
// ═══════════════════════════════════════════════════════════════
export async function pollPolymarketFutures(): Promise<{
  rowsInserted: number;
}> {
  log.info("Polymarket: polling futures...");
  const allRows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  const allEventIds: string[] = [];

  const leagues = Object.entries(POLYMARKET_FUTURES_SLUGS);

  for (let i = 0; i < leagues.length; i++) {
    const [league, slug] = leagues[i];

    try {
      const url = `${GAMMA_BASE}/events?slug=${slug}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        log.warn(`Polymarket futures ${league}: HTTP ${resp.status}`);
        continue;
      }

      const data = (await resp.json()) as GammaEvent[];
      if (!data || data.length === 0) {
        log.debug(`Polymarket futures ${league}: slug "${slug}" not found`);
        continue;
      }

      const event = data[0];
      const eventId = String(event.id);
      allEventIds.push(eventId);
      let teamCount = 0;

      // Each market is a binary "Will X win?" — one per team
      for (const mkt of event.markets) {
        if (mkt.closed || !mkt.active) continue;

        let prices: number[];
        try {
          const parsed = JSON.parse(mkt.outcomePrices) as string[];
          if (parsed.length === 0) continue;
          prices = parsed.map((p) => parseFloat(p));
        } catch {
          continue;
        }

        const yesPrice = prices[0] || 0;
        if (yesPrice <= 0) continue;

        // Extract team name from groupItemTitle or question
        const teamRaw =
          mkt.groupItemTitle ??
          mkt.question
            .replace(/^Will\s+(the\s+)?/i, "")
            .replace(/\s+win.*$/i, "")
            .trim();

        // Skip meta-markets like "Other", "Club A", etc.
        if (/^(other|club [a-z]|none)$/i.test(teamRaw)) continue;

        const team = resolvePolymarketName(teamRaw);
        teamCount++;

        allRows.push({
          league,
          team,
          implied_prob: Math.round(yesPrice * 10000) / 10000,
          price: Math.round((1 / yesPrice) * 100) / 100,
          volume: Math.round((mkt.volumeNum || 0) * 100) / 100,
          volume_delta: 0,
          polymarket_event_id: eventId,
          snapshot_time: now,
        });
      }

      log.info(`  Polymarket futures ${league}: ${teamCount} teams`);
    } catch (err) {
      log.warn(
        `Polymarket futures ${league} failed`,
        err instanceof Error ? err.message : err
      );
    }

    // Rate limit between leagues
    if (i < leagues.length - 1) await sleep(500);
  }

  if (allRows.length === 0) {
    log.info("Polymarket futures: no winner markets found");
    return { rowsInserted: 0 };
  }

  // ─── Compute volume deltas ────────────────────────────────
  const uniqueIds = [...new Set(allEventIds)];
  const prevMap = await getPreviousVolumes("polymarket_futures", uniqueIds);

  for (const row of allRows) {
    const key = `${row.polymarket_event_id}|${row.team}`;
    const prevVol = prevMap.get(key);
    if (prevVol !== undefined && row.volume !== null) {
      row.volume_delta =
        Math.round(((row.volume as number) - prevVol) * 100) / 100;
    }
  }

  const { inserted, failed } = await insertBatched(
    "polymarket_futures",
    allRows
  );
  log.info(`Polymarket futures: ${inserted} rows inserted, ${failed} failed`);
  return { rowsInserted: inserted };
}

// ═══════════════════════════════════════════════════════════════
// 3. matchPolymarketToFixtures — link events to our fixtures
// ═══════════════════════════════════════════════════════════════
export async function matchPolymarketToFixtures(
  lookup: TeamLookup
): Promise<{ matched: number }> {
  const sb = getSupabase();

  // Get unmatched events (fixture_id IS NULL)
  const { data: unmatched, error } = await sb
    .from("polymarket_match_odds")
    .select("polymarket_event_id, event_title")
    .is("fixture_id", null)
    .order("snapshot_time", { ascending: false })
    .limit(1000);

  if (error) {
    log.warn("Failed to query unmatched Polymarket rows:", error.message);
    return { matched: 0 };
  }

  if (!unmatched || unmatched.length === 0) {
    return { matched: 0 };
  }

  // Deduplicate by polymarket_event_id
  const seen = new Set<string>();
  const uniqueEvents: { polymarket_event_id: string; event_title: string }[] =
    [];

  for (const row of unmatched) {
    if (!seen.has(row.polymarket_event_id)) {
      seen.add(row.polymarket_event_id);
      uniqueEvents.push(row);
    }
  }

  let matchedCount = 0;

  for (const ev of uniqueEvents) {
    const teams = parseMatchTeams(ev.event_title);
    if (!teams) continue;

    const resolvedHome = resolvePolymarketName(teams.home);
    const resolvedAway = resolvePolymarketName(teams.away);

    // Build a synthetic LiveOddsEvent for the existing matcher
    const fakeEvent: LiveOddsEvent = {
      id: ev.polymarket_event_id,
      sport_key: "",
      commence_time: new Date().toISOString(), // approximate — will match within 2 day window
      home_team: resolvedHome,
      away_team: resolvedAway,
      bookmakers: [],
    };

    const fixtureId = matchEventToFixture(fakeEvent, lookup);
    if (fixtureId === null) continue;

    // Write the integer fixture_id directly — column is now bigint,
    // matching matches.fixture_id and odds_snapshots.fixture_id
    const { error: updateErr } = await sb
      .from("polymarket_match_odds")
      .update({ fixture_id: fixtureId })
      .eq("polymarket_event_id", ev.polymarket_event_id);

    if (updateErr) {
      log.warn(
        `Failed to update fixture_id for ${ev.polymarket_event_id}:`,
        updateErr.message
      );
    } else {
      matchedCount++;
      log.debug(
        `Matched Polymarket ${ev.event_title} → fixture ${fixtureId}`
      );
    }
  }

  if (matchedCount > 0) {
    log.info(
      `Polymarket fixture matching: ${matchedCount}/${uniqueEvents.length} matched`
    );
  }

  return { matched: matchedCount };
}
