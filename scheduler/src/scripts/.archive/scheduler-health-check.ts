/**
 * scheduler-health-check.ts
 * Comprehensive diagnostic for the per-minute Oracle V1 scheduler.
 *
 * Usage:  npx tsx src/scripts/scheduler-health-check.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, "../../.env") });

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

const LINE = "=".repeat(72);
const THIN = "-".repeat(72);

function header(title: string) {
  console.log(`\n${LINE}`);
  console.log(`  ${title}`);
  console.log(`${LINE}`);
}

function pad(s: string, n: number) {
  return s.padEnd(n);
}

/** Paginated fetch — returns ALL rows matching the query builder config */
async function fetchAll(
  table: string,
  select: string,
  filters: (q: any) => any,
  orderCol: string,
  ascending = true
): Promise<any[]> {
  const PAGE = 1000;
  let all: any[] = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(select).range(from, from + PAGE - 1);
    q = filters(q);
    q = q.order(orderCol, { ascending });
    const { data, error } = await q;
    if (error) {
      console.error(`  [ERROR fetching ${table}]: ${error.message}`);
      return all;
    }
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// -- Helpers --
function truncHour(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().slice(0, 13) + ":00Z";
}

function fmtTs(iso: string | null): string {
  if (!iso) return "(null)";
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function minutesBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60000;
}

const now = new Date();
const ago48h = new Date(now.getTime() - 48 * 3600_000).toISOString();
const ago24h = new Date(now.getTime() - 24 * 3600_000).toISOString();

const EPL_TEAMS = [
  "Arsenal", "Liverpool", "Manchester City", "Chelsea",
  "Newcastle", "Aston Villa", "Brighton", "Nottingham Forest",
  "Bournemouth", "Fulham", "Tottenham", "Manchester United",
  "West Ham", "Brentford", "Crystal Palace", "Everton",
  "Wolves", "Wolverhampton", "Ipswich", "Leicester", "Southampton",
];

function isEpl(team: string): boolean {
  const t = team.toLowerCase();
  return EPL_TEAMS.some(
    (e) => t.includes(e.toLowerCase()) || e.toLowerCase().includes(t)
  );
}

// ====================================================================
//  MAIN
// ====================================================================
(async () => {
  console.log(`\n  Scheduler Health Check -- ${now.toISOString()}`);
  console.log(`  Lookback: 48h from ${fmtTs(ago48h)}  |  24h from ${fmtTs(ago24h)}`);

  // == 1. ORACLE_PRICE_HISTORY -- Market Refresh Continuity ===========
  header("1. ORACLE_PRICE_HISTORY -- Market Refresh by Hour (48h)");

  console.log("  Fetching oracle_price_history (48h)...");
  const ophRows = await fetchAll(
    "oracle_price_history",
    "timestamp, publish_reason",
    (q: any) => q.gte("timestamp", ago48h),
    "timestamp",
    true
  );

  console.log(`  Total rows in last 48h: ${ophRows.length}`);

  // 1a) by publish_reason totals
  const byReason = new Map<string, number>();
  for (const r of ophRows) {
    byReason.set(r.publish_reason, (byReason.get(r.publish_reason) ?? 0) + 1);
  }
  console.log(`\n  Breakdown by publish_reason (48h):`);
  for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${pad(reason, 30)} ${count}`);
  }

  // 1b) market_refresh by hour
  const mrRows = ophRows.filter((r: any) => r.publish_reason === "market_refresh");
  const byHour = new Map<string, number>();
  for (const r of mrRows) {
    const h = truncHour(r.timestamp);
    byHour.set(h, (byHour.get(h) ?? 0) + 1);
  }

  console.log(`\n  market_refresh rows by hour:`);
  console.log(`  ${pad("Hour", 22)} | Count`);
  console.log(`  ${THIN.slice(0, 35)}`);
  const sortedHours = [...byHour.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [hour, count] of sortedHours) {
    console.log(`  ${pad(hour, 22)} | ${count}`);
  }

  // == 2. Per-Team Coverage (24h) =====================================
  header("2. ORACLE_PRICE_HISTORY -- Per-Team Coverage (24h)");

  console.log("  Fetching market_refresh rows (24h)...");
  const oph24 = await fetchAll(
    "oracle_price_history",
    "team, timestamp",
    (q: any) => q.gte("timestamp", ago24h).eq("publish_reason", "market_refresh"),
    "timestamp",
    true
  );

  const byTeam = new Map<string, number>();
  for (const r of oph24) {
    byTeam.set(r.team, (byTeam.get(r.team) ?? 0) + 1);
  }

  console.log(`  Total market_refresh rows (24h): ${oph24.length}`);
  console.log(`  Unique teams: ${byTeam.size}`);
  console.log(`\n  ${pad("Team", 30)} | Rows (24h)`);
  console.log(`  ${THIN.slice(0, 45)}`);

  const sortedTeams = [...byTeam.entries()].sort((a, b) => b[1] - a[1]);
  let eplCounts: number[] = [];
  for (const [team, count] of sortedTeams) {
    const epl = isEpl(team);
    const marker = epl ? " [EPL]" : "";
    if (epl) eplCounts.push(count);
    console.log(`  ${pad(team + marker, 30)} | ${count}`);
  }

  if (eplCounts.length > 0) {
    const min = Math.min(...eplCounts);
    const max = Math.max(...eplCounts);
    const avg = (eplCounts.reduce((a, b) => a + b, 0) / eplCounts.length).toFixed(1);
    console.log(`\n  EPL teams found: ${eplCounts.length}`);
    console.log(`  Min rows: ${min}  |  Max rows: ${max}  |  Avg rows: ${avg}`);
    console.log(`  Expected if 1-min cadence for 24h: ~1440 per team`);
  }

  // == 3. ODDS_SNAPSHOTS -- Are Odds Being Polled? ====================
  header("3. ODDS_SNAPSHOTS -- Rows per Hour (48h)");

  // Use a lighter query: fetch only snapshot_time, page through but stop if huge
  console.log("  Fetching odds_snapshots (48h) -- paginated...");

  // Try hour-by-hour counting approach to avoid huge pagination
  const oddsHours: { hour: string; count: number }[] = [];
  for (let h = 0; h < 48; h++) {
    const hStart = new Date(now.getTime() - (48 - h) * 3600_000).toISOString();
    const hEnd = new Date(now.getTime() - (47 - h) * 3600_000).toISOString();
    const { count, error } = await sb
      .from("odds_snapshots")
      .select("id", { count: "exact", head: true })
      .gte("snapshot_time", hStart)
      .lt("snapshot_time", hEnd);
    if (error) {
      console.log(`  [ERROR]: ${error.message}`);
      break;
    }
    const hourLabel = truncHour(hStart);
    oddsHours.push({ hour: hourLabel, count: count ?? 0 });
  }

  let totalOdds = 0;
  console.log(`\n  ${pad("Hour", 22)} | Count`);
  console.log(`  ${THIN.slice(0, 35)}`);
  for (const { hour, count } of oddsHours) {
    totalOdds += count;
    if (count > 0) {
      console.log(`  ${pad(hour, 22)} | ${count}`);
    }
  }
  console.log(`\n  Total odds_snapshots rows (48h): ${totalOdds}`);

  // == 4. API_CREDITS -- Recent Entries ===============================
  header("4. API_CREDITS -- Last 10 Entries");

  const { data: credits, error: credErr } = await sb
    .from("api_credits")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(10);

  if (credErr) {
    console.log(`\n  [ERROR or table not found]: ${credErr.message}`);
  } else if (!credits || credits.length === 0) {
    console.log(`\n  No api_credits rows found.`);
  } else {
    const cols = Object.keys(credits[0]);
    console.log(`\n  Columns: ${cols.join(", ")}`);
    console.log();
    for (const row of credits) {
      const parts = cols.map((c) => `${c}=${row[c] ?? "null"}`);
      console.log(`  ${parts.join("  |  ")}`);
    }
  }

  // == 5a. SETTLEMENT_LOG -- Recent Settlements =======================
  header("5a. SETTLEMENT_LOG -- Last 10 Settlements");

  const { data: settlements, error: settErr } = await sb
    .from("settlement_log")
    .select("*")
    .order("settled_at", { ascending: false })
    .limit(10);

  if (settErr) {
    console.log(`\n  [ERROR]: ${settErr.message}`);
  } else if (!settlements || settlements.length === 0) {
    console.log(`\n  No settlement_log rows found.`);
  } else {
    const cols = Object.keys(settlements[0]);
    console.log(`  Columns: ${cols.join(", ")}\n`);
    for (const s of settlements) {
      const matchId = s.match_id ?? s.fixture_id ?? "?";
      const home = s.home_team ?? "";
      const away = s.away_team ?? "";
      const result = s.result ?? s.winner ?? "?";
      console.log(`  ${fmtTs(s.settled_at)}  match=${matchId}  ${home} vs ${away}  result=${result}  price_delta=${s.price_delta ?? "?"}`);
    }
  }

  // 5b) Unsettled finished matches in last 48h
  header("5b. Unsettled Finished Matches (48h)");

  const { data: finishedMatches } = await sb
    .from("matches")
    .select("id, home_team, away_team, commence_time, status")
    .gte("commence_time", ago48h)
    .in("status", ["FT", "finished", "complete", "FINISHED"])
    .order("commence_time", { ascending: false });

  if (!finishedMatches || finishedMatches.length === 0) {
    console.log(`\n  No finished matches found in last 48h.`);

    // Also check for any finished matches regardless of date
    const { data: anyFinished } = await sb
      .from("matches")
      .select("id, home_team, away_team, commence_time, status")
      .in("status", ["FT", "finished", "complete", "FINISHED"])
      .order("commence_time", { ascending: false })
      .limit(5);
    if (anyFinished && anyFinished.length > 0) {
      console.log(`\n  Last 5 finished matches (any time):`);
      for (const m of anyFinished) {
        console.log(`    id=${m.id}  ${m.home_team} vs ${m.away_team}  commence=${fmtTs(m.commence_time)}  status=${m.status}`);
      }
    }
  } else {
    // Get settlement match IDs
    const { data: allSett } = await sb
      .from("settlement_log")
      .select("match_id, fixture_id")
      .order("settled_at", { ascending: false })
      .limit(5000);

    const settledIds = new Set<string>();
    if (allSett) {
      for (const s of allSett) {
        if (s.match_id) settledIds.add(String(s.match_id));
        if (s.fixture_id) settledIds.add(String(s.fixture_id));
      }
    }

    const unsettled = finishedMatches.filter(
      (m: any) => !settledIds.has(String(m.id))
    );

    console.log(`\n  Finished matches (48h): ${finishedMatches.length}`);
    console.log(`  Settled: ${finishedMatches.length - unsettled.length}`);
    console.log(`  UNSETTLED: ${unsettled.length}`);

    if (unsettled.length > 0) {
      console.log(`\n  Unsettled matches:`);
      for (const m of unsettled) {
        console.log(`    id=${m.id}  ${m.home_team} vs ${m.away_team}  commence=${fmtTs(m.commence_time)}  status=${m.status}`);
      }
    }
  }

  // == 6. TEAM_ORACLE_STATE -- Last Refresh Times =====================
  header("6. TEAM_ORACLE_STATE -- EPL Last Refresh Times");

  const { data: tosRows, error: tosErr } = await sb
    .from("team_oracle_state")
    .select("*")
    .order("last_market_refresh_ts", { ascending: false });

  if (tosErr) {
    console.log(`\n  [ERROR]: ${tosErr.message}`);
  } else if (!tosRows || tosRows.length === 0) {
    console.log(`\n  No team_oracle_state rows found.`);
  } else {
    const oneHourAgo = new Date(now.getTime() - 3600_000);
    // Discover column names from first row
    const cols = Object.keys(tosRows[0]);
    console.log(`  Columns: ${cols.join(", ")}\n`);

    const teamCol = cols.find(c => c === "team" || c === "team_name" || c === "name") ?? cols[0];
    const tsCol = cols.find(c => c.includes("market_refresh")) ?? "last_market_refresh_ts";

    console.log(`  ${pad("Team", 30)} | ${pad("last_market_refresh_ts", 24)} | Status`);
    console.log(`  ${THIN}`);

    let staleCount = 0;
    let eplShown = 0;
    for (const row of tosRows) {
      const team = row[teamCol] ?? "?";
      const ts = row[tsCol];
      if (!isEpl(team)) continue;
      eplShown++;
      const stale = ts ? new Date(ts) < oneHourAgo : true;
      if (stale) staleCount++;
      const status = stale ? "** STALE **" : "OK";
      console.log(`  ${pad(team, 30)} | ${pad(fmtTs(ts), 24)} | ${status}`);
    }

    const nonEplCount = tosRows.length - eplShown;
    console.log(`\n  Non-EPL teams in table: ${nonEplCount}`);
    console.log(`  EPL teams shown: ${eplShown}`);
    console.log(`  EPL teams stale (>1hr ago): ${staleCount}`);
  }

  // == 7. GAP ANALYSIS -- market_refresh gaps > 5 min (24h) ===========
  header("7. GAP ANALYSIS -- market_refresh gaps > 5 min (24h)");

  // Sort all market_refresh rows by timestamp
  const sorted = oph24.slice().sort(
    (a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  interface Gap {
    start: string;
    end: string;
    minutes: number;
  }
  const gaps: Gap[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].timestamp;
    const curr = sorted[i].timestamp;
    const mins = minutesBetween(prev, curr);
    if (mins > 5) {
      gaps.push({ start: prev, end: curr, minutes: Math.round(mins * 10) / 10 });
    }
  }

  gaps.sort((a, b) => b.minutes - a.minutes);

  console.log(`\n  Total market_refresh rows analyzed (24h): ${sorted.length}`);
  console.log(`  Gaps > 5 min found: ${gaps.length}`);

  if (gaps.length > 0) {
    console.log(`\n  Top ${Math.min(5, gaps.length)} longest gaps:`);
    console.log(`  ${pad("Gap Start", 22)} | ${pad("Gap End", 22)} | Minutes`);
    console.log(`  ${THIN.slice(0, 60)}`);
    for (const g of gaps.slice(0, 5)) {
      console.log(`  ${pad(fmtTs(g.start), 22)} | ${pad(fmtTs(g.end), 22)} | ${g.minutes}`);
    }
  } else {
    console.log(`  No gaps > 5 min found. Scheduler appears continuous.`);
  }

  // Per-team gap analysis for EPL teams
  console.log(`\n  Per-EPL-team gap analysis (top gap per team):`);
  const teamRows = new Map<string, string[]>();
  for (const r of oph24) {
    if (!teamRows.has(r.team)) teamRows.set(r.team, []);
    teamRows.get(r.team)!.push(r.timestamp);
  }

  const teamGaps: { team: string; maxGapMin: number; gapStart: string; gapEnd: string; totalRows: number }[] = [];
  for (const [team, timestamps] of teamRows) {
    if (!isEpl(team)) continue;
    const ts = timestamps.sort();
    let maxGap = 0;
    let gStart = "";
    let gEnd = "";
    for (let i = 1; i < ts.length; i++) {
      const mins = minutesBetween(ts[i - 1], ts[i]);
      if (mins > maxGap) {
        maxGap = mins;
        gStart = ts[i - 1];
        gEnd = ts[i];
      }
    }
    teamGaps.push({ team, maxGapMin: Math.round(maxGap * 10) / 10, gapStart: gStart, gapEnd: gEnd, totalRows: ts.length });
  }

  teamGaps.sort((a, b) => b.maxGapMin - a.maxGapMin);
  console.log(`  ${pad("Team", 30)} | Max Gap | Total Rows | Gap Window`);
  console.log(`  ${THIN}`);
  for (const g of teamGaps) {
    const warn = g.maxGapMin > 10 ? "  *** WARNING ***" : "";
    console.log(`  ${pad(g.team, 30)} | ${String(g.maxGapMin).padStart(6)} min | ${String(g.totalRows).padStart(6)} rows | ${fmtTs(g.gapStart)} -> ${fmtTs(g.gapEnd)}${warn}`);
  }

  // == SUMMARY ========================================================
  header("SUMMARY");
  console.log(`  oracle_price_history rows (48h):   ${ophRows.length}`);
  console.log(`    market_refresh rows:              ${mrRows.length}`);
  console.log(`  odds_snapshots rows (48h):          ${totalOdds}`);
  console.log(`  market_refresh rows (24h):          ${oph24.length}`);
  console.log(`  EPL teams with data (24h):          ${eplCounts.length}`);
  if (eplCounts.length > 0) {
    console.log(`  EPL min/max/avg rows per team:      ${Math.min(...eplCounts)} / ${Math.max(...eplCounts)} / ${(eplCounts.reduce((a, b) => a + b, 0) / eplCounts.length).toFixed(0)}`);
  }
  console.log(`  Cross-team gaps > 5 min (24h):      ${gaps.length}`);
  console.log(`  Per-team max gap (worst):            ${teamGaps.length > 0 ? teamGaps[0].maxGapMin + " min (" + teamGaps[0].team + ")" : "N/A"}`);
  console.log(`\n  Done.\n`);
})();
