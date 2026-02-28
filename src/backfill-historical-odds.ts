/**
 * One-time backfill: Pull 7 days of hourly EPL historical odds from The Odds API
 * and store them in odds_snapshots for richer drift signal data.
 *
 * Usage:  npx tsx src/backfill-historical-odds.ts
 *
 * Credit cost: ~1,680 (168 calls × 10 credits each)
 * Delete this script after use — the hourly baseline poller handles ongoing coverage.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Supabase client ────────────────────────────────────────
const sb = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_KEY as string
);

// ─── Config ─────────────────────────────────────────────────
const ODDS_API_KEY = process.env.ODDS_API_KEY as string;
const SPORT_KEY = "soccer_epl";
const BACKFILL_DAYS = 7;
const HOURS = BACKFILL_DAYS * 24; // 168
const RATE_LIMIT_MS = 1000;
const BATCH_SIZE = 500;

// ─── Team aliases (reuse scheduler's map) ───────────────────
const aliasPath = path.resolve(__dirname, "../scheduler/src/data/team-aliases.json");
let aliasMap: Record<string, string> = {};
try {
  aliasMap = JSON.parse(fs.readFileSync(aliasPath, "utf-8"));
  console.log(`Loaded ${Object.keys(aliasMap).length} team aliases`);
} catch {
  console.warn("Could not load team-aliases.json — using raw names");
}

function resolveOddsApiName(name: string): string {
  return aliasMap[name] ?? name;
}

// ─── Helpers ────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

function syntheticFixtureId(oddsApiEventId: string): number {
  let hash = 0;
  for (let i = 0; i < oddsApiEventId.length; i++) {
    hash = (hash * 31 + oddsApiEventId.charCodeAt(i)) | 0;
  }
  return 9_000_000 + Math.abs(hash % 1_000_000);
}

// ─── Match lookup ───────────────────────────────────────────
interface MatchEntry {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
}

async function fetchAllMatches(): Promise<MatchEntry[]> {
  const all: MatchEntry[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("fixture_id, date, league, home_team, away_team")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Failed to fetch matches: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...(data as MatchEntry[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

interface MatchLookup {
  byExact: Map<string, MatchEntry[]>;
  byNorm: Map<string, MatchEntry[]>;
}

function buildLookup(matches: MatchEntry[]): MatchLookup {
  const byExact = new Map<string, MatchEntry[]>();
  const byNorm = new Map<string, MatchEntry[]>();

  for (const m of matches) {
    for (const name of [m.home_team, m.away_team]) {
      if (!byExact.has(name)) byExact.set(name, []);
      byExact.get(name)!.push(m);
      const n = normalize(name);
      if (!byNorm.has(n)) byNorm.set(n, []);
      byNorm.get(n)!.push(m);
    }
  }
  return { byExact, byNorm };
}

function matchToFixture(
  homeTeam: string,
  awayTeam: string,
  commenceTime: string,
  lookup: MatchLookup
): number | null {
  const resolvedHome = resolveOddsApiName(homeTeam);
  const resolvedAway = resolveOddsApiName(awayTeam);
  const eventDate = commenceTime.slice(0, 10);

  // Exact match
  const homeExact = lookup.byExact.get(resolvedHome) ?? [];
  const awayExact = lookup.byExact.get(resolvedAway) ?? [];

  if (homeExact.length > 0 && awayExact.length > 0) {
    const homeIds = new Set(
      homeExact.filter((m) => m.home_team === resolvedHome).map((m) => m.fixture_id)
    );
    for (const am of awayExact) {
      if (am.away_team !== resolvedAway) continue;
      if (!homeIds.has(am.fixture_id)) continue;
      const diff = Math.abs(
        new Date(eventDate).getTime() - new Date(am.date).getTime()
      );
      if (diff <= 2 * 86400000) return am.fixture_id;
    }
  }

  // Fuzzy match
  const homeNorm = normalize(resolvedHome);
  const awayNorm = normalize(resolvedAway);
  const homeMatches = lookup.byNorm.get(homeNorm) ?? [];
  const awayMatches = lookup.byNorm.get(awayNorm) ?? [];

  if (homeMatches.length === 0 || awayMatches.length === 0) return null;

  const homeIds = new Set(
    homeMatches.filter((m) => normalize(m.home_team) === homeNorm).map((m) => m.fixture_id)
  );
  for (const am of awayMatches) {
    if (normalize(am.away_team) !== awayNorm) continue;
    if (!homeIds.has(am.fixture_id)) continue;
    const diff = Math.abs(
      new Date(eventDate).getTime() - new Date(am.date).getTime()
    );
    if (diff <= 2 * 86400000) return am.fixture_id;
  }

  return null;
}

// ─── Historical API types ───────────────────────────────────
interface HistoricalResponse {
  timestamp: string;
  previous_timestamp: string | null;
  next_timestamp: string | null;
  data: HistoricalEvent[];
}

interface HistoricalEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: {
    key: string;
    title: string;
    markets: {
      key: string;
      last_update: string;
      outcomes: { name: string; price: number }[];
    }[];
  }[];
}

// ─── Fetch a single historical snapshot ─────────────────────
async function fetchHistoricalSnapshot(
  dateISO: string
): Promise<{ data: HistoricalEvent[]; timestamp: string; creditsRemaining: number | null }> {
  const url =
    `https://api.the-odds-api.com/v4/historical/sports/${SPORT_KEY}/odds` +
    `?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&date=${dateISO}`;

  const resp = await fetch(url);
  const remaining = resp.headers.get("x-requests-remaining");

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }

  const json = (await resp.json()) as HistoricalResponse;

  return {
    data: json.data ?? [],
    timestamp: json.timestamp ?? dateISO,
    creditsRemaining: remaining ? parseInt(remaining, 10) : null,
  };
}

// ─── Upsert helper ──────────────────────────────────────────
async function upsertBatch(
  rows: Record<string, unknown>[]
): Promise<{ inserted: number; failed: number }> {
  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from("odds_snapshots")
      .upsert(chunk, { onConflict: "fixture_id,source,bookmaker,snapshot_time" });

    if (error) {
      console.error(`  Upsert batch error: ${error.message}`);
      failed += chunk.length;
    } else {
      inserted += chunk.length;
    }
  }

  return { inserted, failed };
}

// ─── Create fixture for unmatched event ─────────────────────
async function createFixture(
  event: HistoricalEvent,
  lookup: MatchLookup
): Promise<number | null> {
  const resolvedHome = resolveOddsApiName(event.home_team);
  const resolvedAway = resolveOddsApiName(event.away_team);
  const fixtureId = syntheticFixtureId(event.id);
  const date = event.commence_time.slice(0, 10);

  const row = {
    fixture_id: fixtureId,
    date,
    league: "Premier League",
    home_team: resolvedHome,
    away_team: resolvedAway,
    score: "N/A",
    status: "upcoming",
  };

  const { error } = await sb
    .from("matches")
    .upsert([row], { onConflict: "fixture_id", ignoreDuplicates: true });

  if (error) {
    console.error(`  Failed to create fixture ${resolvedHome} vs ${resolvedAway}: ${error.message}`);
    return null;
  }

  // Add to lookup so subsequent hours find it
  const entry: MatchEntry = {
    fixture_id: fixtureId,
    date,
    league: "Premier League",
    home_team: resolvedHome,
    away_team: resolvedAway,
  };
  for (const name of [resolvedHome, resolvedAway]) {
    if (!lookup.byExact.has(name)) lookup.byExact.set(name, []);
    lookup.byExact.get(name)!.push(entry);
    const n = normalize(name);
    if (!lookup.byNorm.has(n)) lookup.byNorm.set(n, []);
    lookup.byNorm.get(n)!.push(entry);
  }

  console.log(`  Created fixture ${fixtureId}: ${resolvedHome} vs ${resolvedAway} (${date})`);
  return fixtureId;
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  console.log("═══ EPL Historical Odds Backfill ═══");
  console.log(`Backfilling ${HOURS} hourly snapshots (${BACKFILL_DAYS} days)`);
  console.log();

  // 1. Build match lookup
  console.log("Loading matches from Supabase...");
  const matches = await fetchAllMatches();
  const lookup = buildLookup(matches);
  console.log(`  ${matches.length} matches loaded`);
  console.log();

  // 2. Loop over hours
  const start = new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
  let totalRows = 0;
  let totalFailed = 0;
  let totalEvents = 0;
  let totalCreditsUsed = 0;
  let createdFixtures = 0;
  let latestRemaining: number | null = null;
  const fixtureIds = new Set<number>();

  for (let i = 0; i < HOURS; i++) {
    const date = new Date(start.getTime() + i * 60 * 60 * 1000);
    const isoDate = date.toISOString();

    try {
      const { data: events, timestamp, creditsRemaining } =
        await fetchHistoricalSnapshot(isoDate);

      totalCreditsUsed += 10; // historical endpoint costs 10 credits
      if (creditsRemaining !== null) latestRemaining = creditsRemaining;

      const snapshotTime = timestamp;
      const rows: Record<string, unknown>[] = [];

      for (const event of events) {
        // Match to fixture
        let fixtureId = matchToFixture(
          event.home_team,
          event.away_team,
          event.commence_time,
          lookup
        );

        if (fixtureId === null) {
          fixtureId = await createFixture(event, lookup);
          if (fixtureId !== null) createdFixtures++;
          else continue;
        }

        fixtureIds.add(fixtureId);

        // Compute days_before_kickoff
        const kickoff = new Date(event.commence_time);
        const snapshotDate = new Date(snapshotTime);
        const daysBefore = Math.max(
          0,
          Math.round((kickoff.getTime() - snapshotDate.getTime()) / 86400000)
        );

        // Extract h2h odds
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
              snapshot_time: snapshotTime,
              bookmaker: bk.key,
              home_odds: outcomes[event.home_team] ?? null,
              away_odds: outcomes[event.away_team] ?? null,
              draw_odds: outcomes["Draw"] ?? null,
              source: "the-odds-api-historical",
            });
          }
        }
      }

      totalEvents += events.length;

      // Upsert this hour's rows
      if (rows.length > 0) {
        const { inserted, failed } = await upsertBatch(rows);
        totalRows += inserted;
        totalFailed += failed;
      }

      // Progress log every 10 iterations
      if ((i + 1) % 10 === 0 || i === HOURS - 1) {
        const pct = (((i + 1) / HOURS) * 100).toFixed(1);
        console.log(
          `[${pct}%] Hour ${i + 1}/${HOURS} — ` +
            `${date.toISOString().slice(0, 13)}:00Z — ` +
            `${events.length} events, ${rows.length} rows, ` +
            `credits remaining: ${latestRemaining ?? "?"}`
        );
      }
    } catch (err) {
      console.error(
        `Hour ${i + 1} (${isoDate}) FAILED:`,
        err instanceof Error ? err.message : err
      );
      totalCreditsUsed += 10; // assume credit was used
    }

    // Rate limit
    if (i < HOURS - 1) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  // 3. Summary
  console.log();
  console.log("═══ Backfill Complete ═══");
  console.log(`  Total snapshots inserted: ${totalRows}`);
  console.log(`  Failed rows:             ${totalFailed}`);
  console.log(`  Events processed:        ${totalEvents}`);
  console.log(`  Unique fixtures:         ${fixtureIds.size}`);
  console.log(`  Fixtures created:        ${createdFixtures}`);
  console.log(`  Credits used:            ~${totalCreditsUsed}`);
  console.log(`  Credits remaining:       ${latestRemaining ?? "unknown"}`);
  console.log();
  console.log("Next step: npx tsx src/compute-prices.ts");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
