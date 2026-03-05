/**
 * export-csvs.ts — Export 7 CSV snapshots from the Oracle V1 Supabase database.
 *
 * Usage: npx tsx data/v1.4-overview/export-csvs.ts
 *
 * Requires SUPABASE_URL and SUPABASE_KEY in .env (scheduler/.env)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

// ─── Setup ──────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = __dirname;

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY. Set them in .env or environment.");
  process.exit(1);
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── CSV Helpers ────────────────────────────────────────────

function escapeCSV(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = typeof val === "object" ? JSON.stringify(val) : String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCSV(filename: string, headers: string[], rows: Record<string, unknown>[]): number {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map(h => escapeCSV(row[h])).join(","));
  }
  const filepath = path.join(OUT_DIR, filename);
  fs.writeFileSync(filepath, lines.join("\n") + "\n", "utf8");
  return rows.length;
}

// ─── Paginated fetch ────────────────────────────────────────

interface PaginateOpts {
  table: string;
  select: string;
  order: { column: string; ascending: boolean };
  filters?: Array<{ method: "eq" | "gte" | "gte_date"; column: string; value: string | number }>;
  limit?: number;
}

async function fetchPaginated(opts: PaginateOpts): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  const pageSize = 1000;
  let from = 0;
  const maxRows = opts.limit ?? Infinity;

  while (all.length < maxRows) {
    let query = sb.from(opts.table).select(opts.select);

    if (opts.filters) {
      for (const f of opts.filters) {
        if (f.method === "eq") query = query.eq(f.column, f.value);
        else if (f.method === "gte" || f.method === "gte_date") query = query.gte(f.column, f.value);
      }
    }

    query = query.order(opts.order.column, { ascending: opts.order.ascending });

    const effectivePageSize = Math.min(pageSize, maxRows - all.length);
    query = query.range(from, from + effectivePageSize - 1);

    const { data, error } = await query;

    if (error) {
      console.error(`  ERROR fetching ${opts.table}: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;

    all.push(...(data as Record<string, unknown>[]));
    if (data.length < effectivePageSize) break;
    from += effectivePageSize;
  }

  return all;
}

// ─── Export Functions ────────────────────────────────────────

async function exportSettlementLog(): Promise<number> {
  console.log("Exporting settlement_log_full.csv...");

  const rows = await fetchPaginated({
    table: "settlement_log",
    select: "fixture_id, team_id, e_kr, actual_score_s, delta_b, b_before, b_after, settled_at, trace_payload",
    order: { column: "settled_at", ascending: true },
  });

  // Extract trace_payload fields
  const transformed = rows.map(r => {
    const tp = r.trace_payload as Record<string, unknown> | null;
    return {
      fixture_id: r.fixture_id,
      team_id: r.team_id,
      e_kr: r.e_kr,
      actual_score_s: r.actual_score_s,
      delta_b: r.delta_b,
      b_before: r.b_before,
      b_after: r.b_after,
      settled_at: r.settled_at,
      bookmaker_count: tp?.bookmaker_count ?? "",
      perspective: tp?.perspective ?? "",
    };
  });

  return writeCSV("settlement_log_full.csv",
    ["fixture_id", "team_id", "e_kr", "actual_score_s", "delta_b", "b_before", "b_after", "settled_at", "bookmaker_count", "perspective"],
    transformed
  );
}

async function exportTeamOracleState(): Promise<number> {
  console.log("Exporting team_oracle_state.csv...");

  const rows = await fetchPaginated({
    table: "team_oracle_state",
    select: "*",
    order: { column: "team_id", ascending: true },
  });

  if (rows.length === 0) return 0;

  const headers = Object.keys(rows[0]);
  return writeCSV("team_oracle_state.csv", headers, rows);
}

async function exportPriceHistory(): Promise<number> {
  console.log("Exporting oracle_price_history.csv...");

  const rows = await fetchPaginated({
    table: "oracle_price_history",
    select: "team, league, timestamp, b_value, m1_value, l_value, f_value, published_index, confidence_score, source_fixture_id, publish_reason",
    order: { column: "timestamp", ascending: true },
  });

  return writeCSV("oracle_price_history.csv",
    ["team", "league", "timestamp", "b_value", "m1_value", "l_value", "f_value", "published_index", "confidence_score", "source_fixture_id", "publish_reason"],
    rows
  );
}

async function exportKRSnapshots(): Promise<number> {
  console.log("Exporting oracle_kr_snapshots.csv...");

  const rows = await fetchPaginated({
    table: "oracle_kr_snapshots",
    select: "fixture_id, bookmaker_count, home_prob, draw_prob, away_prob, home_expected_score, away_expected_score, method, kr_degraded, freeze_timestamp",
    order: { column: "freeze_timestamp", ascending: true },
  });

  return writeCSV("oracle_kr_snapshots.csv",
    ["fixture_id", "bookmaker_count", "home_prob", "draw_prob", "away_prob", "home_expected_score", "away_expected_score", "method", "kr_degraded", "freeze_timestamp"],
    rows
  );
}

async function exportMatchesWithOdds(): Promise<number> {
  console.log("Exporting matches_with_odds.csv...");

  // Fetch matches
  const matches = await fetchPaginated({
    table: "matches",
    select: "fixture_id, date, league, home_team, away_team, score, status, commence_time",
    order: { column: "date", ascending: true },
    filters: [{ method: "gte", column: "date", value: "2025-08-01" }],
  });

  // Fetch KR snapshots for bookmaker count
  const krRows = await fetchPaginated({
    table: "oracle_kr_snapshots",
    select: "fixture_id, bookmaker_count, method",
    order: { column: "fixture_id", ascending: true },
  });

  // Build KR lookup
  const krMap = new Map<number, { bookmaker_count: unknown; method: unknown }>();
  for (const kr of krRows) {
    krMap.set(kr.fixture_id as number, {
      bookmaker_count: kr.bookmaker_count,
      method: kr.method,
    });
  }

  // Join
  const joined = matches.map(m => {
    const kr = krMap.get(m.fixture_id as number);
    return {
      fixture_id: m.fixture_id,
      date: m.date,
      league: m.league,
      home_team: m.home_team,
      away_team: m.away_team,
      score: m.score,
      status: m.status,
      commence_time: m.commence_time,
      kr_bookmaker_count: kr?.bookmaker_count ?? "",
      kr_method: kr?.method ?? "",
    };
  });

  return writeCSV("matches_with_odds.csv",
    ["fixture_id", "date", "league", "home_team", "away_team", "score", "status", "commence_time", "kr_bookmaker_count", "kr_method"],
    joined
  );
}

async function exportOutrightOdds(): Promise<number> {
  console.log("Exporting outright_odds_latest.csv...");

  const rows = await fetchPaginated({
    table: "outright_odds",
    select: "league, team, bookmaker, outright_odds, implied_prob, snapshot_time",
    order: { column: "snapshot_time", ascending: false },
    limit: 5000,
  });

  // Dedup: keep latest per (league, team, bookmaker)
  const seen = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const key = `${r.league}|${r.team}|${r.bookmaker}`;
    if (!seen.has(key)) {
      seen.set(key, r);
    }
  }

  const deduped = [...seen.values()];
  // Sort by league, team for readability
  deduped.sort((a, b) => {
    const la = String(a.league), lb = String(b.league);
    if (la !== lb) return la.localeCompare(lb);
    return String(a.team).localeCompare(String(b.team));
  });

  return writeCSV("outright_odds_latest.csv",
    ["league", "team", "bookmaker", "outright_odds", "implied_prob", "snapshot_time"],
    deduped
  );
}

async function exportOddsSample30d(): Promise<number> {
  console.log("Exporting odds_sample_30d.csv...");

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const rows = await fetchPaginated({
    table: "odds_snapshots",
    select: "fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time",
    order: { column: "fixture_id", ascending: true },
    filters: [{ method: "gte", column: "snapshot_time", value: thirtyDaysAgo }],
  });

  return writeCSV("odds_sample_30d.csv",
    ["fixture_id", "bookmaker", "home_odds", "draw_odds", "away_odds", "snapshot_time"],
    rows
  );
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log("Oracle V1.4 CSV Export");
  console.log("=".repeat(50));
  console.log(`Output directory: ${OUT_DIR}`);
  console.log();

  const results: [string, number][] = [];

  try {
    results.push(["settlement_log_full.csv", await exportSettlementLog()]);
    results.push(["team_oracle_state.csv", await exportTeamOracleState()]);
    results.push(["oracle_price_history.csv", await exportPriceHistory()]);
    results.push(["oracle_kr_snapshots.csv", await exportKRSnapshots()]);
    results.push(["matches_with_odds.csv", await exportMatchesWithOdds()]);
    results.push(["outright_odds_latest.csv", await exportOutrightOdds()]);
    results.push(["odds_sample_30d.csv", await exportOddsSample30d()]);
  } catch (err) {
    console.error("Fatal error during export:", err);
    process.exit(1);
  }

  console.log();
  console.log("Export complete:");
  const maxName = Math.max(...results.map(([name]) => name.length));
  for (const [name, count] of results) {
    console.log(`  ${name.padEnd(maxName + 2)} — ${count.toLocaleString()} rows`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
