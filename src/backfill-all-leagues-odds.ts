/**
 * Full-season historical odds backfill — all 5 leagues.
 *
 * Queries The Odds API historical endpoint every 6 hours from season start
 * through the point where live polling took over.
 *
 * - EPL:    Aug 3 2025 → Feb 6 2026  (historical backfill covers Feb 7+)
 * - Others: Aug 3 2025 → Feb 26 2026 (live poller started Feb 27)
 *
 * 6h intervals = 4 snapshots/day.
 * Credit cost: ~39,360 (3,936 calls × 10 credits each)
 *
 * Usage:  npx tsx src/backfill-all-leagues-odds.ts
 * Delete this script after use.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ─────────────────────────────────────────────────
const ODDS_API_KEY = process.env.ODDS_API_KEY!;
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

if (!ODDS_API_KEY) { console.error("Missing ODDS_API_KEY"); process.exit(1); }

// RESUMED — EPL and La Liga already done; Bundesliga resuming from Dec 11
const LEAGUES: Record<string, { sportKey: string; from: string; to: string }> = {
  Bundesliga: {
    sportKey: "soccer_germany_bundesliga",
    from: "2025-12-11T00:00:00Z",
    to:   "2026-02-26T18:00:00Z",
  },
  "Serie A": {
    sportKey: "soccer_italy_serie_a",
    from: "2025-08-03T00:00:00Z",
    to:   "2026-02-26T18:00:00Z",
  },
  "Ligue 1": {
    sportKey: "soccer_france_ligue_one",
    from: "2025-08-03T00:00:00Z",
    to:   "2026-02-26T18:00:00Z",
  },
};

const STEP_HOURS = 6;
const RATE_LIMIT_MS = 1200; // 1.2s between calls to be safe
const BATCH_SIZE = 500;

// ─── Team aliases ───────────────────────────────────────────
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
  sportKey: string,
  dateISO: string
): Promise<{ data: HistoricalEvent[]; timestamp: string; creditsRemaining: number | null }> {
  const url =
    `https://api.the-odds-api.com/v4/historical/sports/${sportKey}/odds` +
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
  leagueName: string,
  lookup: MatchLookup
): Promise<number | null> {
  const resolvedHome = resolveOddsApiName(event.home_team);
  const resolvedAway = resolveOddsApiName(event.away_team);
  const fixtureId = syntheticFixtureId(event.id);
  const date = event.commence_time.slice(0, 10);

  const row = {
    fixture_id: fixtureId,
    date,
    league: leagueName,
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

  // Add to lookup
  const entry: MatchEntry = {
    fixture_id: fixtureId,
    date,
    league: leagueName,
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

  return fixtureId;
}

// ─── Generate timestamps ────────────────────────────────────
function generateTimestamps(from: string, to: string, stepHours: number): string[] {
  const start = new Date(from);
  const end = new Date(to);
  const timestamps: string[] = [];
  let current = new Date(start);
  while (current <= end) {
    timestamps.push(current.toISOString().replace(/\.\d{3}Z$/, "Z"));
    current = new Date(current.getTime() + stepHours * 60 * 60 * 1000);
  }
  return timestamps;
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  console.log("═══ All-League Historical Odds Backfill ═══\n");

  // 1. Build match lookup
  console.log("Loading matches from Supabase...");
  const matches = await fetchAllMatches();
  const lookup = buildLookup(matches);
  console.log(`  ${matches.length} matches loaded\n`);

  // 2. Plan the work
  const plan: { league: string; sportKey: string; timestamps: string[] }[] = [];
  let totalCalls = 0;

  for (const [league, cfg] of Object.entries(LEAGUES)) {
    const timestamps = generateTimestamps(cfg.from, cfg.to, STEP_HOURS);
    plan.push({ league, sportKey: cfg.sportKey, timestamps });
    totalCalls += timestamps.length;
    console.log(`  ${league}: ${timestamps.length} snapshots (${cfg.from.slice(0,10)} → ${cfg.to.slice(0,10)})`);
  }

  const estimatedCredits = totalCalls * 10;
  const estimatedTime = Math.round(totalCalls * RATE_LIMIT_MS / 1000 / 60);
  console.log(`\n  Total API calls: ${totalCalls.toLocaleString()}`);
  console.log(`  Estimated credits: ~${estimatedCredits.toLocaleString()}`);
  console.log(`  Estimated time: ~${estimatedTime} minutes\n`);

  // 3. Execute league by league
  let grandTotalRows = 0;
  let grandTotalFailed = 0;
  let grandTotalEvents = 0;
  let grandTotalCredits = 0;
  let grandCreatedFixtures = 0;
  let latestRemaining: number | null = null;
  const allFixtureIds = new Set<number>();
  let callsDone = 0;

  for (const { league, sportKey, timestamps } of plan) {
    console.log(`\n─── ${league} (${sportKey}) ───`);
    console.log(`  ${timestamps.length} snapshots to fetch\n`);

    let leagueRows = 0;
    let leagueFailed = 0;
    let leagueEvents = 0;

    for (let i = 0; i < timestamps.length; i++) {
      const isoDate = timestamps[i];
      callsDone++;

      try {
        const { data: events, timestamp, creditsRemaining } =
          await fetchHistoricalSnapshot(sportKey, isoDate);

        grandTotalCredits += 10;
        if (creditsRemaining !== null) latestRemaining = creditsRemaining;

        const snapshotTime = timestamp;
        const rows: Record<string, unknown>[] = [];

        for (const event of events) {
          let fixtureId = matchToFixture(
            event.home_team,
            event.away_team,
            event.commence_time,
            lookup
          );

          if (fixtureId === null) {
            fixtureId = await createFixture(event, league, lookup);
            if (fixtureId !== null) grandCreatedFixtures++;
            else continue;
          }

          allFixtureIds.add(fixtureId);

          // days_before_kickoff
          const kickoff = new Date(event.commence_time);
          const snapshotDate = new Date(snapshotTime);
          const daysBefore = Math.max(
            0,
            Math.round((kickoff.getTime() - snapshotDate.getTime()) / 86400000)
          );

          // h2h odds
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

        leagueEvents += events.length;

        if (rows.length > 0) {
          const { inserted, failed } = await upsertBatch(rows);
          leagueRows += inserted;
          leagueFailed += failed;
        }

        // Progress every 20 calls or at the end
        if ((i + 1) % 20 === 0 || i === timestamps.length - 1) {
          const pct = ((callsDone / totalCalls) * 100).toFixed(1);
          console.log(
            `  [${pct}%] ${callsDone}/${totalCalls} | ` +
            `${isoDate.slice(0, 13)}:00Z | ` +
            `${events.length} events | ` +
            `credits left: ${latestRemaining ?? "?"}`
          );
        }
      } catch (err) {
        console.error(
          `  FAIL ${isoDate}:`,
          err instanceof Error ? err.message : err
        );
        grandTotalCredits += 10;
      }

      await sleep(RATE_LIMIT_MS);
    }

    grandTotalRows += leagueRows;
    grandTotalFailed += leagueFailed;
    grandTotalEvents += leagueEvents;

    console.log(`\n  ${league} done: ${leagueRows} rows, ${leagueFailed} failed, ${leagueEvents} events`);
  }

  // 4. Summary
  console.log("\n═══════════════════════════════════════");
  console.log("═══ Backfill Complete ═══");
  console.log(`  Total snapshots inserted: ${grandTotalRows.toLocaleString()}`);
  console.log(`  Failed rows:             ${grandTotalFailed.toLocaleString()}`);
  console.log(`  Events processed:        ${grandTotalEvents.toLocaleString()}`);
  console.log(`  Unique fixtures:         ${allFixtureIds.size}`);
  console.log(`  Fixtures created:        ${grandCreatedFixtures}`);
  console.log(`  Credits used:            ~${grandTotalCredits.toLocaleString()}`);
  console.log(`  Credits remaining:       ${latestRemaining ?? "unknown"}`);

  // DB totals
  const { count } = await sb
    .from("odds_snapshots")
    .select("*", { count: "exact", head: true });
  console.log(`\n  Total odds_snapshots in DB: ${(count ?? 0).toLocaleString()}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
