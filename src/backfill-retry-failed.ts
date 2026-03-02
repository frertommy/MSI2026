/**
 * Retry failed odds backfill calls:
 * 1. Ligue 1 network failures: Aug 30 18:00 → Sep 6 00:00 (27 timestamps)
 * 2. Re-run timestamps that had upsert batch errors with dedup logic
 *
 * Usage:  npx tsx src/backfill-retry-failed.ts
 * Delete after use.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ODDS_API_KEY = process.env.ODDS_API_KEY!;
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

if (!ODDS_API_KEY) { console.error("Missing ODDS_API_KEY"); process.exit(1); }

const RATE_LIMIT_MS = 1200;
const BATCH_SIZE = 200; // Smaller batches to reduce duplicate-key conflicts

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
  fixture_id: number; date: string; league: string; home_team: string; away_team: string;
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
  homeTeam: string, awayTeam: string, commenceTime: string, lookup: MatchLookup
): number | null {
  const resolvedHome = resolveOddsApiName(homeTeam);
  const resolvedAway = resolveOddsApiName(awayTeam);
  const eventDate = commenceTime.slice(0, 10);

  const homeExact = lookup.byExact.get(resolvedHome) ?? [];
  const awayExact = lookup.byExact.get(resolvedAway) ?? [];
  if (homeExact.length > 0 && awayExact.length > 0) {
    const homeIds = new Set(
      homeExact.filter((m) => m.home_team === resolvedHome).map((m) => m.fixture_id)
    );
    for (const am of awayExact) {
      if (am.away_team !== resolvedAway) continue;
      if (!homeIds.has(am.fixture_id)) continue;
      const diff = Math.abs(new Date(eventDate).getTime() - new Date(am.date).getTime());
      if (diff <= 2 * 86400000) return am.fixture_id;
    }
  }

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
    const diff = Math.abs(new Date(eventDate).getTime() - new Date(am.date).getTime());
    if (diff <= 2 * 86400000) return am.fixture_id;
  }
  return null;
}

// ─── Historical API ─────────────────────────────────────────
interface HistoricalResponse {
  timestamp: string;
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

async function fetchHistoricalSnapshot(
  sportKey: string, dateISO: string
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

// ─── Deduplicating upsert ───────────────────────────────────
async function upsertBatchDedup(
  rows: Record<string, unknown>[]
): Promise<{ inserted: number; failed: number }> {
  // Deduplicate: keep last row per (fixture_id, source, bookmaker, snapshot_time)
  const seen = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = `${row.fixture_id}|${row.source}|${row.bookmaker}|${row.snapshot_time}`;
    seen.set(key, row);
  }
  const dedupedRows = [...seen.values()];
  const dupsRemoved = rows.length - dedupedRows.length;
  if (dupsRemoved > 0) {
    console.log(`    Deduped: removed ${dupsRemoved} duplicate rows`);
  }

  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < dedupedRows.length; i += BATCH_SIZE) {
    const chunk = dedupedRows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from("odds_snapshots")
      .upsert(chunk, { onConflict: "fixture_id,source,bookmaker,snapshot_time" });

    if (error) {
      console.error(`    Upsert batch error: ${error.message}`);
      failed += chunk.length;
    } else {
      inserted += chunk.length;
    }
  }

  return { inserted, failed };
}

async function createFixture(
  event: HistoricalEvent, leagueName: string, lookup: MatchLookup
): Promise<number | null> {
  const resolvedHome = resolveOddsApiName(event.home_team);
  const resolvedAway = resolveOddsApiName(event.away_team);
  const fixtureId = syntheticFixtureId(event.id);
  const date = event.commence_time.slice(0, 10);

  const { error } = await sb
    .from("matches")
    .upsert([{
      fixture_id: fixtureId, date, league: leagueName,
      home_team: resolvedHome, away_team: resolvedAway,
      score: "N/A", status: "upcoming",
    }], { onConflict: "fixture_id", ignoreDuplicates: true });

  if (error) {
    console.error(`    Failed to create fixture: ${error.message}`);
    return null;
  }

  const entry: MatchEntry = { fixture_id: fixtureId, date, league: leagueName, home_team: resolvedHome, away_team: resolvedAway };
  for (const name of [resolvedHome, resolvedAway]) {
    if (!lookup.byExact.has(name)) lookup.byExact.set(name, []);
    lookup.byExact.get(name)!.push(entry);
    const n = normalize(name);
    if (!lookup.byNorm.has(n)) lookup.byNorm.set(n, []);
    lookup.byNorm.get(n)!.push(entry);
  }
  return fixtureId;
}

// ─── Process a single timestamp ─────────────────────────────
async function processSnapshot(
  sportKey: string, leagueName: string, isoDate: string, lookup: MatchLookup
): Promise<{ rows: number; failed: number; events: number }> {
  const { data: events, timestamp, creditsRemaining } =
    await fetchHistoricalSnapshot(sportKey, isoDate);

  const snapshotTime = timestamp;
  const rows: Record<string, unknown>[] = [];

  for (const event of events) {
    let fixtureId = matchToFixture(event.home_team, event.away_team, event.commence_time, lookup);
    if (fixtureId === null) {
      fixtureId = await createFixture(event, leagueName, lookup);
      if (fixtureId === null) continue;
    }

    const kickoff = new Date(event.commence_time);
    const snapshotDate = new Date(snapshotTime);
    const daysBefore = Math.max(0, Math.round((kickoff.getTime() - snapshotDate.getTime()) / 86400000));

    for (const bk of event.bookmakers) {
      for (const market of bk.markets) {
        if (market.key !== "h2h") continue;
        const outcomes: Record<string, number> = {};
        for (const o of market.outcomes) outcomes[o.name] = o.price;

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

  let inserted = 0;
  let failed = 0;
  if (rows.length > 0) {
    const result = await upsertBatchDedup(rows);
    inserted = result.inserted;
    failed = result.failed;
  }

  console.log(
    `  ${isoDate} | ${events.length} events | ${inserted} rows | credits: ${creditsRemaining ?? "?"}`
  );

  return { rows: inserted, failed, events: events.length };
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  console.log("═══ Retry Failed Backfill Calls ═══\n");

  const matches = await fetchAllMatches();
  const lookup = buildLookup(matches);
  console.log(`${matches.length} matches loaded\n`);

  let totalRows = 0;
  let totalFailed = 0;
  let totalEvents = 0;

  // ── 1. Ligue 1 network failures: Aug 30 18:00 → Sep 6 00:00 ──
  console.log("─── Ligue 1: Retrying network failures (Aug 30 – Sep 6) ───\n");

  const ligue1Timestamps: string[] = [];
  const start = new Date("2025-08-30T18:00:00Z");
  const end = new Date("2025-09-06T00:00:00Z");
  let cur = new Date(start);
  while (cur <= end) {
    ligue1Timestamps.push(cur.toISOString().replace(/\.\d{3}Z$/, "Z"));
    cur = new Date(cur.getTime() + 6 * 60 * 60 * 1000);
  }

  console.log(`  ${ligue1Timestamps.length} timestamps to retry\n`);

  for (let i = 0; i < ligue1Timestamps.length; i++) {
    try {
      const result = await processSnapshot(
        "soccer_france_ligue_one", "Ligue 1", ligue1Timestamps[i], lookup
      );
      totalRows += result.rows;
      totalFailed += result.failed;
      totalEvents += result.events;
    } catch (err) {
      console.error(`  FAIL ${ligue1Timestamps[i]}:`, err instanceof Error ? err.message : err);
    }
    if (i < ligue1Timestamps.length - 1) await sleep(RATE_LIMIT_MS);
  }

  // ── 2. La Liga upsert failures: re-fetch key date ranges ──
  // The batch errors occurred around Sep 6, Dec 20, Jan 9
  console.log("\n─── La Liga: Re-fetching timestamps with upsert errors ───\n");

  const laLigaRetry = [
    "2025-09-06T00:00:00Z", "2025-09-06T06:00:00Z", "2025-09-06T12:00:00Z", "2025-09-06T18:00:00Z",
    "2025-12-20T00:00:00Z", "2025-12-20T06:00:00Z", "2025-12-20T12:00:00Z", "2025-12-20T18:00:00Z",
    "2026-01-09T00:00:00Z", "2026-01-09T06:00:00Z", "2026-01-09T12:00:00Z", "2026-01-09T18:00:00Z",
  ];

  for (let i = 0; i < laLigaRetry.length; i++) {
    try {
      const result = await processSnapshot(
        "soccer_spain_la_liga", "La Liga", laLigaRetry[i], lookup
      );
      totalRows += result.rows;
      totalFailed += result.failed;
      totalEvents += result.events;
    } catch (err) {
      console.error(`  FAIL ${laLigaRetry[i]}:`, err instanceof Error ? err.message : err);
    }
    if (i < laLigaRetry.length - 1) await sleep(RATE_LIMIT_MS);
  }

  // ── 3. Serie A upsert failures: re-fetch key date ranges ──
  console.log("\n─── Serie A: Re-fetching timestamps with upsert errors ───\n");

  const serieARetry = [
    "2025-09-06T00:00:00Z", "2025-09-06T06:00:00Z", "2025-09-06T12:00:00Z", "2025-09-06T18:00:00Z",
    "2025-09-07T00:00:00Z", "2025-09-07T06:00:00Z", "2025-09-07T12:00:00Z", "2025-09-07T18:00:00Z",
    "2025-09-11T00:00:00Z", "2025-09-11T06:00:00Z", "2025-09-11T12:00:00Z", "2025-09-11T18:00:00Z",
    "2025-09-12T00:00:00Z", "2025-09-12T06:00:00Z", "2025-09-12T12:00:00Z", "2025-09-12T18:00:00Z",
  ];

  for (let i = 0; i < serieARetry.length; i++) {
    try {
      const result = await processSnapshot(
        "soccer_italy_serie_a", "Serie A", serieARetry[i], lookup
      );
      totalRows += result.rows;
      totalFailed += result.failed;
      totalEvents += result.events;
    } catch (err) {
      console.error(`  FAIL ${serieARetry[i]}:`, err instanceof Error ? err.message : err);
    }
    if (i < serieARetry.length - 1) await sleep(RATE_LIMIT_MS);
  }

  // ── 4. Bundesliga upsert failure ──
  console.log("\n─── Bundesliga: Re-fetching timestamps with upsert errors ───\n");

  const bundesligaRetry = [
    "2025-10-31T00:00:00Z", "2025-10-31T06:00:00Z", "2025-10-31T12:00:00Z", "2025-10-31T18:00:00Z",
  ];

  for (let i = 0; i < bundesligaRetry.length; i++) {
    try {
      const result = await processSnapshot(
        "soccer_germany_bundesliga", "Bundesliga", bundesligaRetry[i], lookup
      );
      totalRows += result.rows;
      totalFailed += result.failed;
      totalEvents += result.events;
    } catch (err) {
      console.error(`  FAIL ${bundesligaRetry[i]}:`, err instanceof Error ? err.message : err);
    }
    if (i < bundesligaRetry.length - 1) await sleep(RATE_LIMIT_MS);
  }

  // Summary
  console.log("\n═══ Retry Complete ═══");
  console.log(`  Rows inserted: ${totalRows}`);
  console.log(`  Failed:        ${totalFailed}`);
  console.log(`  Events:        ${totalEvents}`);

  const { count } = await sb.from("odds_snapshots").select("*", { count: "exact", head: true });
  console.log(`\n  Total odds_snapshots in DB: ${(count ?? 0).toLocaleString()}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
