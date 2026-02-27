// DEPRECATED: Legacy one-time script. The scheduler service now handles
// odds/injury fetching and writes directly to Supabase. Data files no
// longer live in the repo — all data is in Supabase.
import "dotenv/config";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const API_KEY = process.env.API_FOOTBALL_KEY;
if (!API_KEY) {
  console.error("Missing API_FOOTBALL_KEY in .env");
  process.exit(1);
}

const BASE_URL = "https://v3.football.api-sports.io";
const RATE_LIMIT = 30; // requests per minute
const DELAY_MS = Math.ceil((60 / RATE_LIMIT) * 1000); // ~2000ms between calls
const MAX_RETRIES = 3;

const ODDS_RAW = path.resolve("data/api-football/raw/odds");
const INJURIES_RAW = path.resolve("data/api-football/raw/injuries");
const PROCESSED_DIR = path.resolve("data/api-football/processed");

function sleep(ms: number) {
  execSync(`sleep ${(ms / 1000).toFixed(1)}`, { stdio: "ignore" });
}

function curlFetch(url: string): string {
  return execSync(
    `curl -s -H "x-apisports-key: ${API_KEY}" "${url}"`,
    { encoding: "utf-8", timeout: 30_000 },
  );
}

function fetchWithRetry(url: string, label: string): string | null {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const body = curlFetch(url);
      // Check for API error responses
      const parsed = JSON.parse(body);
      if (parsed.errors && Object.keys(parsed.errors).length > 0) {
        const errMsg = JSON.stringify(parsed.errors);
        if (errMsg.includes("rateLimit") || errMsg.includes("Too Many")) {
          console.warn(`  Rate limited on ${label}, waiting 60s...`);
          sleep(60_000);
          continue;
        }
      }
      return body;
    } catch (err) {
      const backoff = Math.pow(2, attempt) * 1000;
      console.warn(
        `  Attempt ${attempt}/${MAX_RETRIES} failed for ${label}: ${err instanceof Error ? err.message : err}`,
      );
      if (attempt < MAX_RETRIES) {
        console.warn(`  Retrying in ${backoff / 1000}s...`);
        sleep(backoff);
      }
    }
  }
  console.error(`  FAILED after ${MAX_RETRIES} attempts: ${label}`);
  return null;
}

interface QueueItem {
  fixtureId: number;
  type: "odds" | "injuries";
  url: string;
  rawPath: string;
}

function buildQueue(fixtureIds: number[]): QueueItem[] {
  const queue: QueueItem[] = [];
  for (const id of fixtureIds) {
    const oddsPath = path.join(ODDS_RAW, `${id}.json`);
    if (!fs.existsSync(oddsPath)) {
      queue.push({
        fixtureId: id,
        type: "odds",
        url: `${BASE_URL}/odds?fixture=${id}`,
        rawPath: oddsPath,
      });
    }
    const injPath = path.join(INJURIES_RAW, `${id}.json`);
    if (!fs.existsSync(injPath)) {
      queue.push({
        fixtureId: id,
        type: "injuries",
        url: `${BASE_URL}/injuries?fixture=${id}`,
        rawPath: injPath,
      });
    }
  }
  return queue;
}

interface OddsEntry {
  fixtureId: number;
  bookmakers: {
    name: string;
    bets: {
      name: string;
      values: { value: string; odd: string }[];
    }[];
  }[];
}

function processOdds(fixtureIds: number[]): OddsEntry[] {
  const results: OddsEntry[] = [];
  for (const id of fixtureIds) {
    const rawPath = path.join(ODDS_RAW, `${id}.json`);
    if (!fs.existsSync(rawPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(rawPath, "utf-8"));
      const response = data.response ?? [];
      if (response.length === 0) continue;
      const entry = response[0];
      results.push({
        fixtureId: id,
        bookmakers: (entry.bookmakers ?? []).map(
          (bk: { name: string; bets: { name: string; values: { value: string; odd: string }[] }[] }) => ({
            name: bk.name,
            bets: (bk.bets ?? []).map(
              (bet: { name: string; values: { value: string; odd: string }[] }) => ({
                name: bet.name,
                values: bet.values,
              }),
            ),
          }),
        ),
      });
    } catch {
      // skip malformed files
    }
  }
  return results;
}

function main() {
  // Load fixture IDs
  const matchesPath = path.resolve("data/processed/matches.json");
  if (!fs.existsSync(matchesPath)) {
    console.error("data/processed/matches.json not found. Run pull-matches first.");
    process.exit(1);
  }
  const matches: { fixtureId: number }[] = JSON.parse(
    fs.readFileSync(matchesPath, "utf-8"),
  );
  const fixtureIds = matches.map((m) => m.fixtureId);
  console.log(`Loaded ${fixtureIds.length} fixtures from matches.json`);

  // Create directories
  for (const dir of [ODDS_RAW, INJURIES_RAW, PROCESSED_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Build queue (skip already-fetched)
  const queue = buildQueue(fixtureIds);
  const skipped = fixtureIds.length * 2 - queue.length;
  console.log(
    `Queue: ${queue.length} calls remaining (${skipped} already cached)`,
  );
  if (queue.length > 0) {
    const estMin = Math.ceil((queue.length * DELAY_MS) / 60_000);
    console.log(
      `Rate limit: ${RATE_LIMIT}/min → ~${estMin} min estimated\n`,
    );
  }

  let completed = 0;
  let failed = 0;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const progress = `[${i + 1}/${queue.length}]`;
    process.stdout.write(
      `${progress} ${item.type} fixture=${item.fixtureId}... `,
    );

    const body = fetchWithRetry(item.url, `${item.type}/${item.fixtureId}`);
    if (body) {
      fs.writeFileSync(item.rawPath, body);
      console.log("OK");
      completed++;
    } else {
      console.log("FAILED");
      failed++;
    }

    // Rate-limit delay (skip on last item)
    if (i < queue.length - 1) {
      sleep(DELAY_MS);
    }
  }

  console.log(`\nFetch complete: ${completed} OK, ${failed} failed`);

  // Process odds into a single file
  console.log("Processing odds...");
  const odds = processOdds(fixtureIds);
  const oddsPath = path.join(PROCESSED_DIR, "odds.json");
  fs.writeFileSync(oddsPath, JSON.stringify(odds, null, 2));
  console.log(
    `Saved ${odds.length} fixtures with odds → ${oddsPath}`,
  );
}

main();
