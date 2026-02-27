import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BATCH_SIZE = 500;

async function insertBatched(
  table: string,
  rows: Record<string, unknown>[],
  onConflict?: string
) {
  let inserted = 0;
  let failed = 0;
  const total = rows.length;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const query = onConflict
      ? supabase.from(table).upsert(batch, { onConflict, ignoreDuplicates: true })
      : supabase.from(table).insert(batch);
    const { error } = await query;
    if (error) {
      console.error(
        `\n  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ERROR — ${error.message}`
      );
      failed += batch.length;
    } else {
      inserted += batch.length;
    }
    const pct = Math.round(((i + batch.length) / total) * 100);
    process.stdout.write(
      `\r  [${table}] ${i + batch.length}/${total} (${pct}%)`
    );
  }

  console.log(
    `\n  Done: ${inserted} inserted, ${failed} failed out of ${total}`
  );
  return { inserted, failed };
}

async function uploadMatches() {
  console.log("=== Uploading matches ===");

  // Check how many already exist
  const { count } = await supabase
    .from("matches")
    .select("*", { count: "exact", head: true });
  if (count && count >= 391) {
    console.log(`  Already have ${count} rows. Skipping.`);
    return { inserted: 0, failed: 0 };
  }

  const matchesPath = path.resolve("data/processed/matches.json");
  const matches: {
    fixtureId: number;
    date: string;
    league: string;
    homeTeam: string;
    awayTeam: string;
    score: string;
    status: string;
  }[] = JSON.parse(fs.readFileSync(matchesPath, "utf-8"));

  const rows = matches.map((m) => ({
    fixture_id: m.fixtureId,
    date: m.date,
    league: m.league,
    home_team: m.homeTeam,
    away_team: m.awayTeam,
    score: m.score,
    status: m.status,
  }));

  console.log(`  ${rows.length} matches to insert`);
  return insertBatched("matches", rows);
}

async function uploadOdds() {
  console.log("=== Uploading odds_snapshots ===");

  const oddsPath = path.resolve("data/odds-api/processed/odds.json");
  const fixtures: {
    fixtureId: number;
    homeTeam: string;
    awayTeam: string;
    league: string;
    kickoff: string;
    snapshots: {
      daysBeforeKickoff: number;
      timestamp: string | null;
      bookmakers: {
        bookmaker: string;
        home: number | null;
        away: number | null;
        draw: number | null;
        last_update: string;
      }[];
    }[];
  }[] = JSON.parse(fs.readFileSync(oddsPath, "utf-8"));

  // Flatten: one row per fixture × snapshot × bookmaker
  // Columns: fixture_id, bookmaker, days_before_kickoff, home_odds, away_odds, draw_odds, source, snapshot_time
  const rows: Record<string, unknown>[] = [];
  for (const f of fixtures) {
    for (const snap of f.snapshots) {
      for (const bk of snap.bookmakers) {
        rows.push({
          fixture_id: f.fixtureId,
          days_before_kickoff: snap.daysBeforeKickoff,
          snapshot_time: snap.timestamp,
          bookmaker: bk.bookmaker,
          home_odds: bk.home,
          away_odds: bk.away,
          draw_odds: bk.draw,
          source: "the-odds-api",
        });
      }
    }
  }

  // Deduplicate by unique key (fixture_id, source, bookmaker, snapshot_time)
  const seen = new Set<string>();
  const uniqueRows = rows.filter((r) => {
    const key = `${r.fixture_id}|${r.source}|${r.bookmaker}|${r.snapshot_time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(
    `  ${rows.length} total rows, ${uniqueRows.length} after dedup`
  );
  return insertBatched(
    "odds_snapshots",
    uniqueRows,
    "fixture_id,source,bookmaker,snapshot_time"
  );
}

async function uploadInjuries() {
  console.log("=== Uploading injuries ===");

  const injDir = path.resolve("data/api-football/raw/injuries");
  const files = fs.readdirSync(injDir).filter((f) => f.endsWith(".json"));

  const rows: Record<string, unknown>[] = [];
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(injDir, file), "utf-8"));
    const response = raw.response ?? [];
    for (const entry of response) {
      rows.push({
        fixture_id: entry.fixture?.id,
        player_name: entry.player?.name,
        team: entry.team?.name,
        type: entry.player?.type,
        reason: entry.player?.reason,
      });
    }
  }

  console.log(`  ${rows.length} injury records to insert`);
  return insertBatched("injuries", rows);
}

async function main() {
  const start = Date.now();

  const matchResult = await uploadMatches();
  const oddsResult = await uploadOdds();
  const injResult = await uploadInjuries();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n=== Complete in ${elapsed}s ===`);
  console.log(
    `  matches: ${matchResult.inserted} inserted, ${matchResult.failed} failed`
  );
  console.log(
    `  odds_snapshots: ${oddsResult.inserted} inserted, ${oddsResult.failed} failed`
  );
  console.log(
    `  injuries: ${injResult.inserted} inserted, ${injResult.failed} failed`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
