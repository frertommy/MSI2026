/**
 * cadence-audit-24h.ts — 24-Hour Snapshot Cadence Audit for Oracle Impact
 *
 * Sections:
 *   A) Snapshot cadence & completeness (quantitative)
 *   B) Oracle sensitivity: does 1/min help or just add noise?
 *   C) Identify the remaining bottleneck (if not cadence)
 *   D) Recommendations
 *
 * Run:  npx tsx src/scripts/cadence-audit-24h.ts
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("SUPABASE_URL / SUPABASE_KEY not set");

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Helpers ─────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1));
}

async function fetchAllPaginated<T>(
  table: string,
  select: string,
  filters: { fn: (q: any) => any }[] = [],
  orderCol?: string,
  ascending = true
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = sb.from(table).select(select).range(from, from + pageSize - 1);
    for (const f of filters) q = f.fn(q);
    if (orderCol) q = q.order(orderCol, { ascending });
    const { data, error } = await q;
    if (error) { console.error(`  fetch ${table} error: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

function fmt(n: number, d = 2): string { return n.toFixed(d); }
function pct(n: number): string { return (n * 100).toFixed(1) + "%"; }

// ─── Types ───────────────────────────────────────────────────

interface OddsSnap {
  fixture_id: number;
  bookmaker: string;
  home_odds: number | null;
  draw_odds: number | null;
  away_odds: number | null;
  snapshot_time: string;
}

interface MatchRow {
  fixture_id: number;
  date: string;
  home_team: string;
  away_team: string;
  status: string;
  league: string;
  commence_time: string | null;
}

interface PriceHistRow {
  team: string;
  timestamp: string;
  b_value: number;
  m1_value: number;
  published_index: number;
  publish_reason: string;
  confidence_score: number | null;
  source_fixture_id: number | null;
}

interface KRRow {
  fixture_id: number;
  bookmaker_count: number;
  home_prob: number;
  draw_prob: number;
  away_prob: number;
  kr_degraded: boolean | null;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  const h24ago = new Date(now.getTime() - 24 * 3600 * 1000);
  const h24agoStr = h24ago.toISOString();
  const h48ahead = new Date(now.getTime() + 48 * 3600 * 1000);
  const todayStr = now.toISOString().slice(0, 10);
  const yesterdayStr = new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const tomorrowStr = new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║       24-HOUR SNAPSHOT CADENCE AUDIT (Oracle Impact)        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Run time: ${now.toISOString()}`);
  console.log(`  Window:   ${h24agoStr} → now`);
  console.log();

  // ── Load fixtures in scope ───────────────────────────────────
  // Fixtures with kickoff in last 24h OR next 24h
  console.log("Loading fixtures in scope (kickoff ±24h)...");

  const allMatches = await fetchAllPaginated<MatchRow>(
    "matches",
    "fixture_id, date, home_team, away_team, status, league, commence_time",
    [{ fn: (q: any) => q.gte("date", yesterdayStr).lte("date", tomorrowStr) }],
    "date",
    true
  );

  // Also grab any EPL matches specifically
  const scopeMatches = allMatches.filter(m => {
    const kickoff = m.commence_time ? new Date(m.commence_time).getTime() : new Date(m.date + "T15:00:00Z").getTime();
    return kickoff >= h24ago.getTime() && kickoff <= h48ahead.getTime();
  });

  // Prefer EPL but include all leagues if EPL is thin
  const eplMatches = scopeMatches.filter(m => m.league === "Premier League");
  const focusMatches = eplMatches.length >= 3 ? eplMatches : scopeMatches;
  const focusLeague = eplMatches.length >= 3 ? "EPL-only" : "all-leagues";

  console.log(`  Total matches in date range: ${allMatches.length}`);
  console.log(`  Matches with kickoff ±24h: ${scopeMatches.length}`);
  console.log(`  Focus set (${focusLeague}): ${focusMatches.length}`);

  if (focusMatches.length === 0) {
    console.log("\n  ⚠  No fixtures in scope — nothing to audit. Exiting.");
    return;
  }

  for (const m of focusMatches.slice(0, 15)) {
    const ko = m.commence_time ?? m.date;
    console.log(`    ${m.fixture_id} │ ${m.home_team} vs ${m.away_team} │ ${ko} │ ${m.status} │ ${m.league}`);
  }
  if (focusMatches.length > 15) console.log(`    ... and ${focusMatches.length - 15} more`);
  console.log();

  const fixtureIds = focusMatches.map(m => m.fixture_id);
  const fixtureMap = new Map(focusMatches.map(m => [m.fixture_id, m]));

  // ── Load odds snapshots for scope fixtures ───────────────────
  console.log("Loading odds snapshots for scope fixtures (last 48h window)...");

  const h48ago = new Date(now.getTime() - 48 * 3600 * 1000);
  let allOdds: OddsSnap[] = [];

  // Fetch in batches of fixture IDs
  for (let i = 0; i < fixtureIds.length; i += 20) {
    const batch = fixtureIds.slice(i, i + 20);
    const batchOdds = await fetchAllPaginated<OddsSnap>(
      "odds_snapshots",
      "fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time",
      [
        { fn: (q: any) => q.in("fixture_id", batch) },
        { fn: (q: any) => q.gte("snapshot_time", h48ago.toISOString()) },
      ],
      "snapshot_time",
      true
    );
    allOdds.push(...batchOdds);
  }

  console.log(`  Total odds snapshots loaded: ${allOdds.length}`);

  // Group by fixture
  const oddsByFixture = new Map<number, OddsSnap[]>();
  for (const o of allOdds) {
    if (!oddsByFixture.has(o.fixture_id)) oddsByFixture.set(o.fixture_id, []);
    oddsByFixture.get(o.fixture_id)!.push(o);
  }

  // ════════════════════════════════════════════════════════════════
  // SECTION A: Snapshot cadence & completeness
  // ════════════════════════════════════════════════════════════════
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  SECTION A: Snapshot Cadence & Completeness                 ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  interface FixtureCadence {
    fixture_id: number;
    label: string;
    league: string;
    status: string;
    snapshot_count: number;
    unique_times: number;
    median_dt_min: number;
    p95_dt_min: number;
    pct_gt_2min: number;
    pct_gt_5min: number;
    pct_gt_10min: number;
    max_gap_min: number;
    avg_books: number;
    min_books: number;
    p10_books: number;
    last6h_avg_books: number;
    last6h_snapshots: number;
    pass_cadence: boolean;
    pass_books: boolean;
  }

  const cadenceResults: FixtureCadence[] = [];

  for (const fid of fixtureIds) {
    const match = fixtureMap.get(fid)!;
    const snaps = oddsByFixture.get(fid) ?? [];
    const label = `${match.home_team} vs ${match.away_team}`;
    const kickoffMs = match.commence_time
      ? new Date(match.commence_time).getTime()
      : new Date(match.date + "T15:00:00Z").getTime();

    if (snaps.length < 2) {
      cadenceResults.push({
        fixture_id: fid,
        label,
        league: match.league,
        status: match.status,
        snapshot_count: snaps.length,
        unique_times: snaps.length,
        median_dt_min: Infinity,
        p95_dt_min: Infinity,
        pct_gt_2min: 1,
        pct_gt_5min: 1,
        pct_gt_10min: 1,
        max_gap_min: Infinity,
        avg_books: snaps.length,
        min_books: snaps.length,
        p10_books: snaps.length,
        last6h_avg_books: 0,
        last6h_snapshots: 0,
        pass_cadence: false,
        pass_books: false,
      });
      continue;
    }

    // Get unique snapshot times (multiple books per time)
    const timeBookMap = new Map<string, Set<string>>();
    for (const s of snaps) {
      if (!timeBookMap.has(s.snapshot_time)) timeBookMap.set(s.snapshot_time, new Set());
      timeBookMap.get(s.snapshot_time)!.add(s.bookmaker);
    }

    const uniqueTimes = [...timeBookMap.keys()].sort();
    const bookCounts = uniqueTimes.map(t => timeBookMap.get(t)!.size);
    const bookCountsSorted = [...bookCounts].sort((a, b) => a - b);

    // Compute intervals between unique snapshot times
    const intervals: number[] = [];
    for (let i = 1; i < uniqueTimes.length; i++) {
      const dtMs = new Date(uniqueTimes[i]).getTime() - new Date(uniqueTimes[i - 1]).getTime();
      intervals.push(dtMs / 60000); // minutes
    }

    const intervalsSorted = [...intervals].sort((a, b) => a - b);

    // Last 6h before kickoff
    const last6hStart = kickoffMs - 6 * 3600 * 1000;
    const last6hTimes = uniqueTimes.filter(t => {
      const ts = new Date(t).getTime();
      return ts >= last6hStart && ts <= kickoffMs;
    });
    const last6hBookCounts = last6hTimes.map(t => timeBookMap.get(t)!.size);

    cadenceResults.push({
      fixture_id: fid,
      label,
      league: match.league,
      status: match.status,
      snapshot_count: snaps.length,
      unique_times: uniqueTimes.length,
      median_dt_min: median(intervals),
      p95_dt_min: percentile(intervalsSorted, 95),
      pct_gt_2min: intervals.filter(d => d > 2).length / Math.max(intervals.length, 1),
      pct_gt_5min: intervals.filter(d => d > 5).length / Math.max(intervals.length, 1),
      pct_gt_10min: intervals.filter(d => d > 10).length / Math.max(intervals.length, 1),
      max_gap_min: intervals.length > 0 ? Math.max(...intervals) : Infinity,
      avg_books: mean(bookCounts),
      min_books: Math.min(...bookCounts),
      p10_books: percentile(bookCountsSorted, 10),
      last6h_avg_books: mean(last6hBookCounts),
      last6h_snapshots: last6hTimes.length,
      pass_cadence:
        median(intervals) <= 1.2 &&
        percentile(intervalsSorted, 95) <= 2.5 &&
        intervals.filter(d => d > 5).length / Math.max(intervals.length, 1) <= 0.005 &&
        Math.max(...intervals) <= 10,
      pass_books:
        percentile(bookCountsSorted, 10) >= 3 &&
        mean(bookCounts) >= 6,
    });
  }

  // Summary table
  const validCadence = cadenceResults.filter(r => r.snapshot_count >= 2);
  console.log(`  Fixtures with data: ${validCadence.length} / ${cadenceResults.length}\n`);

  if (validCadence.length > 0) {
    // Aggregate stats
    const allMedianDts = validCadence.map(r => r.median_dt_min).filter(v => isFinite(v));
    const allP95Dts = validCadence.map(r => r.p95_dt_min).filter(v => isFinite(v));
    const allMaxGaps = validCadence.map(r => r.max_gap_min).filter(v => isFinite(v));

    console.log("  ┌─────────────────────────────────────────────────────┐");
    console.log("  │  AGGREGATE CADENCE STATS                            │");
    console.log("  ├─────────────────────────────────────────────────────┤");
    console.log(`  │  Median dt across fixtures:  ${fmt(median(allMedianDts))} min (threshold ≤1.2)  │`);
    console.log(`  │  Median p95 dt:              ${fmt(median(allP95Dts))} min (threshold ≤2.5)  │`);
    console.log(`  │  Worst max gap:              ${fmt(Math.max(...allMaxGaps))} min (threshold ≤10) │`);
    console.log(`  │  Pass cadence:  ${validCadence.filter(r => r.pass_cadence).length}/${validCadence.length} fixtures                       │`);
    console.log(`  │  Pass books:    ${validCadence.filter(r => r.pass_books).length}/${validCadence.length} fixtures                       │`);
    console.log("  └─────────────────────────────────────────────────────┘\n");

    // Per-fixture table (worst 10 by max gap)
    console.log("  WORST 10 FIXTURES BY MAX GAP:");
    console.log("  ┌────────┬──────────────────────────────────────┬────────┬────────┬──────────┬──────────┬────────┬──────┐");
    console.log("  │ fix_id │ match                                │ med_dt │ p95_dt │ max_gap  │ >5min %  │ snaps  │ books│");
    console.log("  ├────────┼──────────────────────────────────────┼────────┼────────┼──────────┼──────────┼────────┼──────┤");

    const byMaxGap = [...validCadence].sort((a, b) => b.max_gap_min - a.max_gap_min).slice(0, 10);
    for (const r of byMaxGap) {
      const lab = r.label.length > 36 ? r.label.slice(0, 33) + "..." : r.label.padEnd(36);
      const maxG = isFinite(r.max_gap_min) ? fmt(r.max_gap_min, 0).padStart(6) : "   N/A";
      console.log(
        `  │ ${String(r.fixture_id).padStart(6)} │ ${lab} │ ${fmt(r.median_dt_min).padStart(6)} │ ${fmt(r.p95_dt_min).padStart(6)} │ ${maxG}m  │ ${pct(r.pct_gt_5min).padStart(8)} │ ${String(r.unique_times).padStart(6)} │ ${fmt(r.avg_books, 1).padStart(5)}│`
      );
    }
    console.log("  └────────┴──────────────────────────────────────┴────────┴────────┴──────────┴──────────┴────────┴──────┘\n");

    // Per-fixture book coverage
    console.log("  BOOK COVERAGE (last 6h pre-kickoff):");
    console.log("  ┌────────┬──────────────────────────────────────┬──────────┬───────────┬──────────┬──────────┐");
    console.log("  │ fix_id │ match                                │ 6h_snaps │ 6h_books  │ min_bks  │ p10_bks  │");
    console.log("  ├────────┼──────────────────────────────────────┼──────────┼───────────┼──────────┼──────────┤");

    const byBooks = [...validCadence].sort((a, b) => a.last6h_avg_books - b.last6h_avg_books).slice(0, 10);
    for (const r of byBooks) {
      const lab = r.label.length > 36 ? r.label.slice(0, 33) + "..." : r.label.padEnd(36);
      console.log(
        `  │ ${String(r.fixture_id).padStart(6)} │ ${lab} │ ${String(r.last6h_snapshots).padStart(8)} │ ${fmt(r.last6h_avg_books, 1).padStart(9)} │ ${String(r.min_books).padStart(8)} │ ${String(r.p10_books).padStart(8)} │`
      );
    }
    console.log("  └────────┴──────────────────────────────────────┴──────────┴───────────┴──────────┴──────────┘\n");
  }

  // ════════════════════════════════════════════════════════════════
  // SECTION B: Oracle sensitivity — does 1/min help or just add noise?
  // ════════════════════════════════════════════════════════════════
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  SECTION B: Oracle Sensitivity — Signal vs Noise            ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Load oracle_price_history for the last 48h for teams in scope
  const teamsInScope = new Set<string>();
  for (const m of focusMatches) {
    teamsInScope.add(m.home_team);
    teamsInScope.add(m.away_team);
  }

  console.log(`  Loading oracle_price_history for ${teamsInScope.size} teams (last 48h)...`);

  let allPriceHist: PriceHistRow[] = [];
  const teamArr = [...teamsInScope];
  for (let i = 0; i < teamArr.length; i += 10) {
    const batch = teamArr.slice(i, i + 10);
    for (const team of batch) {
      const rows = await fetchAllPaginated<PriceHistRow>(
        "oracle_price_history",
        "team, timestamp, b_value, m1_value, published_index, publish_reason, confidence_score, source_fixture_id",
        [
          { fn: (q: any) => q.eq("team", team) },
          { fn: (q: any) => q.gte("timestamp", h48ago.toISOString()) },
        ],
        "timestamp",
        true
      );
      allPriceHist.push(...rows);
    }
  }

  console.log(`  Total price history rows: ${allPriceHist.length}\n`);

  // Group by team
  const phByTeam = new Map<string, PriceHistRow[]>();
  for (const r of allPriceHist) {
    if (!phByTeam.has(r.team)) phByTeam.set(r.team, []);
    phByTeam.get(r.team)!.push(r);
  }

  // Compute R_mkt proxy: we don't have raw R_mkt, but M1 = eff_conf * (R_mkt - B)
  // So ΔM1 per update is our best signal proxy
  interface TeamSensitivity {
    team: string;
    points: number;
    market_refreshes: number;
    median_delta_m1: number;
    p95_delta_m1: number;
    max_delta_m1: number;
    median_delta_idx: number;
    p95_delta_idx: number;
    noise_ratio_m1: number;
    last6h_total_m1_move: number;
    last6h_max_swing: number;
    last60m_total_m1_move: number;
    settlement_dips: number;
  }

  const sensitivityResults: TeamSensitivity[] = [];

  for (const [team, rows] of phByTeam) {
    const marketRefreshes = rows.filter(r => r.publish_reason === "market_refresh");
    if (marketRefreshes.length < 3) continue;

    // Delta M1 per consecutive market_refresh
    const deltaM1s: number[] = [];
    const deltaIdxs: number[] = [];
    for (let i = 1; i < marketRefreshes.length; i++) {
      deltaM1s.push(Math.abs(Number(marketRefreshes[i].m1_value) - Number(marketRefreshes[i - 1].m1_value)));
      deltaIdxs.push(Math.abs(Number(marketRefreshes[i].published_index) - Number(marketRefreshes[i - 1].published_index)));
    }

    const sortedDeltaM1 = [...deltaM1s].sort((a, b) => a - b);
    const sortedDeltaIdx = [...deltaIdxs].sort((a, b) => a - b);

    // Noise ratio: compute std of consecutive deltas vs std of 15-step deltas
    const m1Values = marketRefreshes.map(r => Number(r.m1_value));
    const delta1 = [];
    for (let i = 1; i < m1Values.length; i++) delta1.push(m1Values[i] - m1Values[i - 1]);
    const delta15 = [];
    for (let i = 15; i < m1Values.length; i++) delta15.push(m1Values[i] - m1Values[i - 15]);

    const noiseRatio = std(delta15) > 0 ? std(delta1) / std(delta15) : 0;

    // Last 6h and last 60m pre-kickoff analysis
    // Find the relevant fixture for this team
    const teamFixture = focusMatches.find(m => m.home_team === team || m.away_team === team);
    const kickoffMs = teamFixture?.commence_time
      ? new Date(teamFixture.commence_time).getTime()
      : teamFixture ? new Date(teamFixture.date + "T15:00:00Z").getTime() : now.getTime();

    const last6hRefreshes = marketRefreshes.filter(r => {
      const ts = new Date(r.timestamp).getTime();
      return ts >= kickoffMs - 6 * 3600 * 1000 && ts <= kickoffMs;
    });

    const last60mRefreshes = marketRefreshes.filter(r => {
      const ts = new Date(r.timestamp).getTime();
      return ts >= kickoffMs - 60 * 60 * 1000 && ts <= kickoffMs;
    });

    const last6hM1s = last6hRefreshes.map(r => Number(r.m1_value));
    const last60mM1s = last60mRefreshes.map(r => Number(r.m1_value));

    const last6hTotalMove = last6hM1s.length >= 2
      ? Math.abs(last6hM1s[last6hM1s.length - 1] - last6hM1s[0])
      : 0;
    const last6hMaxSwing = last6hM1s.length >= 2
      ? Math.max(...last6hM1s) - Math.min(...last6hM1s)
      : 0;
    const last60mTotalMove = last60mM1s.length >= 2
      ? Math.abs(last60mM1s[last60mM1s.length - 1] - last60mM1s[0])
      : 0;

    // Count settlement dips (M1 drops to 0 in settlement then recovers)
    let settlementDips = 0;
    for (let i = 1; i < rows.length - 1; i++) {
      if (
        rows[i].publish_reason === "settlement" &&
        Math.abs(Number(rows[i].m1_value)) < 0.01 &&
        Math.abs(Number(rows[i - 1].m1_value)) > 1
      ) {
        settlementDips++;
      }
    }

    sensitivityResults.push({
      team,
      points: rows.length,
      market_refreshes: marketRefreshes.length,
      median_delta_m1: median(deltaM1s),
      p95_delta_m1: percentile(sortedDeltaM1, 95),
      max_delta_m1: deltaM1s.length > 0 ? Math.max(...deltaM1s) : 0,
      median_delta_idx: median(deltaIdxs),
      p95_delta_idx: percentile(sortedDeltaIdx, 95),
      noise_ratio_m1: noiseRatio,
      last6h_total_m1_move: last6hTotalMove,
      last6h_max_swing: last6hMaxSwing,
      last60m_total_m1_move: last60mTotalMove,
      settlement_dips: settlementDips,
    });
  }

  if (sensitivityResults.length > 0) {
    // Aggregate
    const allNoiseRatios = sensitivityResults.map(r => r.noise_ratio_m1).filter(v => v > 0);
    const allMedianDeltaM1 = sensitivityResults.map(r => r.median_delta_m1);
    const allP95DeltaM1 = sensitivityResults.map(r => r.p95_delta_m1);

    console.log("  ┌─────────────────────────────────────────────────────┐");
    console.log("  │  AGGREGATE SENSITIVITY STATS                        │");
    console.log("  ├─────────────────────────────────────────────────────┤");
    console.log(`  │  Teams analyzed:             ${sensitivityResults.length.toString().padStart(5)}                  │`);
    console.log(`  │  Median |ΔM1| per update:    ${fmt(median(allMedianDeltaM1), 3).padStart(8)} Elo pts         │`);
    console.log(`  │  Median p95 |ΔM1|:           ${fmt(median(allP95DeltaM1), 3).padStart(8)} Elo pts         │`);
    console.log(`  │  Median noise ratio (1/15):  ${fmt(median(allNoiseRatios), 3).padStart(8)}                 │`);
    console.log(`  │  Teams with settlement dips: ${sensitivityResults.filter(r => r.settlement_dips > 0).length.toString().padStart(5)}                  │`);
    console.log("  └─────────────────────────────────────────────────────┘\n");

    // Signal vs Noise interpretation
    const medNR = median(allNoiseRatios);
    if (medNR > 0) {
      if (medNR > 0.5) {
        console.log("  NOISE VERDICT: High noise ratio (>0.5) — 1/min updates have significant");
        console.log("  per-update noise relative to the 15-update signal. Consider EWMA smoothing.\n");
      } else if (medNR > 0.3) {
        console.log("  NOISE VERDICT: Moderate noise ratio (0.3–0.5) — some per-update jitter");
        console.log("  exists but most signal comes through. Smoothing optional.\n");
      } else {
        console.log("  NOISE VERDICT: Low noise ratio (<0.3) — 1/min updates are clean.");
        console.log("  Each update carries meaningful signal. No smoothing needed.\n");
      }
    }

    // Per-team table
    console.log("  PER-TEAM SENSITIVITY (sorted by noise ratio):");
    console.log("  ┌────────────────────────────┬────────┬──────────┬──────────┬──────────┬──────────┬──────────┐");
    console.log("  │ team                       │ pts    │ med ΔM1  │ p95 ΔM1  │ noise_r  │ 6h_move  │ 60m_move │");
    console.log("  ├────────────────────────────┼────────┼──────────┼──────────┼──────────┼──────────┼──────────┤");

    const byNoise = [...sensitivityResults].sort((a, b) => b.noise_ratio_m1 - a.noise_ratio_m1);
    for (const r of byNoise.slice(0, 15)) {
      const name = r.team.length > 26 ? r.team.slice(0, 23) + "..." : r.team.padEnd(26);
      console.log(
        `  │ ${name} │ ${String(r.market_refreshes).padStart(6)} │ ${fmt(r.median_delta_m1, 3).padStart(8)} │ ${fmt(r.p95_delta_m1, 3).padStart(8)} │ ${fmt(r.noise_ratio_m1, 3).padStart(8)} │ ${fmt(r.last6h_total_m1_move, 2).padStart(8)} │ ${fmt(r.last60m_total_m1_move, 2).padStart(8)} │`
      );
    }
    console.log("  └────────────────────────────┴────────┴──────────┴──────────┴──────────┴──────────┴──────────┘\n");

    // Pre-kickoff capture analysis
    const teamsWithLast6h = sensitivityResults.filter(r => r.last6h_total_m1_move > 0 || r.last6h_max_swing > 0);
    if (teamsWithLast6h.length > 0) {
      console.log("  PRE-KICKOFF CAPTURE (last 6h → last 60m):");
      console.log("  ┌────────────────────────────┬──────────┬──────────┬──────────┬──────────┐");
      console.log("  │ team                       │ 6h_move  │ 6h_swing │ 60m_move │ captured │");
      console.log("  ├────────────────────────────┼──────────┼──────────┼──────────┼──────────┤");

      for (const r of teamsWithLast6h.slice(0, 15)) {
        const name = r.team.length > 26 ? r.team.slice(0, 23) + "..." : r.team.padEnd(26);
        const captured = r.last6h_max_swing > 0 ? (r.last6h_total_m1_move / r.last6h_max_swing > 0.3 ? "YES" : "partial") : "N/A";
        console.log(
          `  │ ${name} │ ${fmt(r.last6h_total_m1_move, 2).padStart(8)} │ ${fmt(r.last6h_max_swing, 2).padStart(8)} │ ${fmt(r.last60m_total_m1_move, 2).padStart(8)} │ ${captured.padStart(8)} │`
        );
      }
      console.log("  └────────────────────────────┴──────────┴──────────┴──────────┴──────────┘\n");
    }
  } else {
    console.log("  No market_refresh data with ≥3 points found for any team in scope.\n");
  }

  // ════════════════════════════════════════════════════════════════
  // SECTION C: Identify the remaining bottleneck
  // ════════════════════════════════════════════════════════════════
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  SECTION C: Bottleneck Identification                       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // C1: M1=0 events analysis
  console.log("  C1. M1=0 Events Analysis");
  let m1ZeroCount = 0;
  let m1ZeroLowBooks = 0;
  let m1ZeroHighConf = 0;
  const m1ZeroEvents: { team: string; ts: string; reason: string; conf: number | null; prev_m1: number | null }[] = [];

  for (const [team, rows] of phByTeam) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (Math.abs(Number(r.m1_value)) < 0.01 && r.publish_reason === "market_refresh") {
        m1ZeroCount++;
        const prevM1 = i > 0 ? Number(rows[i - 1].m1_value) : null;
        const conf = r.confidence_score != null ? Number(r.confidence_score) : null;

        if (conf !== null && conf < 0.1) m1ZeroLowBooks++;
        if (conf !== null && conf > 0.5) m1ZeroHighConf++;

        if (m1ZeroEvents.length < 20) {
          m1ZeroEvents.push({
            team,
            ts: r.timestamp,
            reason: conf !== null && conf < 0.1 ? "low_confidence" : conf === null ? "no_confidence" : "zero_gap",
            conf,
            prev_m1: prevM1,
          });
        }
      }
    }
  }

  const totalMR = [...phByTeam.values()].reduce((acc, rows) => acc + rows.filter(r => r.publish_reason === "market_refresh").length, 0);
  console.log(`    Total market_refresh rows:     ${totalMR}`);
  console.log(`    M1=0 in market_refresh:        ${m1ZeroCount} (${totalMR > 0 ? pct(m1ZeroCount / totalMR) : "N/A"})`);
  console.log(`    M1=0 due to low confidence:    ${m1ZeroLowBooks}`);
  console.log(`    M1=0 despite high confidence:  ${m1ZeroHighConf}`);

  if (m1ZeroEvents.length > 0) {
    console.log("\n    Sample M1=0 events:");
    for (const e of m1ZeroEvents.slice(0, 10)) {
      console.log(`      ${e.team.padEnd(25)} │ ${e.ts.slice(0, 19)} │ conf=${e.conf !== null ? fmt(e.conf, 3) : "null"} │ prev_m1=${e.prev_m1 !== null ? fmt(e.prev_m1, 2) : "null"} │ ${e.reason}`);
    }
  }
  console.log();

  // C2: Confidence distribution
  console.log("  C2. Confidence Distribution");
  const allConfs: number[] = [];
  for (const rows of phByTeam.values()) {
    for (const r of rows) {
      if (r.publish_reason === "market_refresh" && r.confidence_score != null) {
        allConfs.push(Number(r.confidence_score));
      }
    }
  }

  if (allConfs.length > 0) {
    const confSorted = [...allConfs].sort((a, b) => a - b);
    console.log(`    Samples:  ${allConfs.length}`);
    console.log(`    Median:   ${fmt(median(allConfs), 3)}`);
    console.log(`    p10:      ${fmt(percentile(confSorted, 10), 3)}`);
    console.log(`    p25:      ${fmt(percentile(confSorted, 25), 3)}`);
    console.log(`    p75:      ${fmt(percentile(confSorted, 75), 3)}`);
    console.log(`    p90:      ${fmt(percentile(confSorted, 90), 3)}`);
    console.log(`    <0.1:     ${allConfs.filter(c => c < 0.1).length} (${pct(allConfs.filter(c => c < 0.1).length / allConfs.length)})`);
    console.log(`    >0.5:     ${allConfs.filter(c => c > 0.5).length} (${pct(allConfs.filter(c => c > 0.5).length / allConfs.length)})`);
  } else {
    console.log("    No confidence data available.");
  }
  console.log();

  // C3: Clamp events (|M1| near 120)
  console.log("  C3. Clamp Events (|M1| ≥ 115)");
  const clampEvents: { team: string; ts: string; m1: number; conf: number | null; b: number; idx: number }[] = [];
  for (const [team, rows] of phByTeam) {
    for (const r of rows) {
      if (Math.abs(Number(r.m1_value)) >= 115) {
        clampEvents.push({
          team,
          ts: r.timestamp,
          m1: Number(r.m1_value),
          conf: r.confidence_score != null ? Number(r.confidence_score) : null,
          b: Number(r.b_value),
          idx: Number(r.published_index),
        });
      }
    }
  }

  console.log(`    Clamp events (|M1| ≥ 115): ${clampEvents.length}`);
  if (clampEvents.length > 0) {
    for (const e of clampEvents.slice(0, 10)) {
      console.log(`      ${e.team.padEnd(25)} │ ${e.ts.slice(0, 19)} │ M1=${fmt(e.m1).padStart(7)} │ conf=${e.conf !== null ? fmt(e.conf, 3) : "null"} │ B=${fmt(e.b)} │ idx=${fmt(e.idx)}`);
    }
  }
  console.log();

  // C4: Settlement artifact check (M1 dip to 0 at settlement)
  console.log("  C4. Settlement Artifacts (M1 dip to 0)");
  let totalSettlementRows = 0;
  let settlementWithZeroM1 = 0;
  let settlementWithCarriedM1 = 0;

  for (const rows of phByTeam.values()) {
    for (const r of rows) {
      if (r.publish_reason === "settlement") {
        totalSettlementRows++;
        if (Math.abs(Number(r.m1_value)) < 0.01) {
          settlementWithZeroM1++;
        } else {
          settlementWithCarriedM1++;
        }
      }
    }
  }

  console.log(`    Total settlement rows:    ${totalSettlementRows}`);
  console.log(`    With M1=0 (old bug):      ${settlementWithZeroM1}`);
  console.log(`    With M1 carried (fixed):  ${settlementWithCarriedM1}`);
  if (totalSettlementRows > 0) {
    console.log(`    Fix coverage:             ${pct(settlementWithCarriedM1 / totalSettlementRows)}`);
  }
  console.log();

  // C5: |M1| vs confidence correlation
  console.log("  C5. |M1| vs Confidence Correlation");
  const m1ConfPairs: { m1: number; conf: number }[] = [];
  for (const rows of phByTeam.values()) {
    for (const r of rows) {
      if (r.publish_reason === "market_refresh" && r.confidence_score != null) {
        m1ConfPairs.push({ m1: Math.abs(Number(r.m1_value)), conf: Number(r.confidence_score) });
      }
    }
  }

  if (m1ConfPairs.length > 10) {
    // Simple Pearson correlation
    const mM1 = mean(m1ConfPairs.map(p => p.m1));
    const mConf = mean(m1ConfPairs.map(p => p.conf));
    let num = 0, denM1 = 0, denConf = 0;
    for (const p of m1ConfPairs) {
      const dm = p.m1 - mM1;
      const dc = p.conf - mConf;
      num += dm * dc;
      denM1 += dm * dm;
      denConf += dc * dc;
    }
    const corr = denM1 > 0 && denConf > 0 ? num / Math.sqrt(denM1 * denConf) : 0;
    console.log(`    Pearson r(|M1|, confidence): ${fmt(corr, 4)}`);
    console.log(`    Samples: ${m1ConfPairs.length}`);
    if (corr > 0.3) {
      console.log("    → Positive correlation: higher confidence → larger M1 corrections. Expected.");
    } else if (corr < -0.1) {
      console.log("    → Negative correlation: surprising — low confidence teams get large M1? Investigate.");
    } else {
      console.log("    → Weak/no correlation: M1 magnitude decoupled from confidence.");
    }
  }
  console.log();

  // ════════════════════════════════════════════════════════════════
  // SECTION D: Recommendations
  // ════════════════════════════════════════════════════════════════
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  SECTION D: Recommendations                                ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Compute pass/fail
  const cadencePass = validCadence.length > 0 && validCadence.filter(r => r.pass_cadence).length / validCadence.length > 0.7;
  const booksPass = validCadence.length > 0 && validCadence.filter(r => r.pass_books).length / validCadence.length > 0.7;
  const noiseOk = sensitivityResults.length > 0 && median(sensitivityResults.map(r => r.noise_ratio_m1).filter(v => v > 0)) < 0.5;
  const settlementFixed = totalSettlementRows === 0 || settlementWithCarriedM1 / Math.max(totalSettlementRows, 1) > 0.5;

  console.log("  PASS/FAIL SUMMARY:");
  console.log(`    Cadence achieves ≤1.2min median:  ${cadencePass ? "PASS ✓" : "FAIL ✗"}`);
  console.log(`    Book coverage ≥3 p10 / ≥6 avg:    ${booksPass ? "PASS ✓" : "FAIL ✗"}`);
  console.log(`    Noise ratio acceptable (<0.5):     ${noiseOk ? "PASS ✓" : sensitivityResults.length > 0 ? "FAIL ✗" : "NO DATA"}`);
  console.log(`    Settlement dip fix deployed:       ${settlementFixed ? "PASS ✓" : "FAIL ✗"}`);
  console.log();

  // Determine recommendation category
  if (!cadencePass && validCadence.length > 0) {
    console.log("  RECOMMENDATION: 1/min cadence is NOT achieved");
    console.log("  ─────────────────────────────────────────────");
    console.log("  The scheduler is not delivering snapshots at 1/min for most fixtures.");
    console.log("  Action items:");
    console.log("    1. Check rate limits on The Odds API — are we hitting the ceiling?");
    console.log("    2. Verify scheduler poll interval is actually ~1 min (not 5–10 min)");
    console.log("    3. Check if API returns cached/stale data (same snapshot_time repeated)");
    console.log("    4. Add monitoring: alert if max_gap > 5 min for any priority fixture");
  } else if (cadencePass && !noiseOk && sensitivityResults.length > 0) {
    console.log("  RECOMMENDATION: 1/min achieved but adds noise → smooth R_mkt");
    console.log("  ────────────────────────────────────────────────────────────");
    console.log("  Cadence is good but per-update jitter is high.");
    console.log("  Action items:");
    console.log("    1. Apply 5-min EWMA to R_mkt before computing M1");
    console.log("    2. Or: compute M1 from 5-min TWAP of consensus probs");
    console.log("    3. Keep raw 1/min snapshots in odds_snapshots for audit trail");
    console.log("    4. Only publish smoothed M1 to oracle_price_history");
  } else if (cadencePass && noiseOk) {
    console.log("  RECOMMENDATION: 1/min is sufficient → keep current cadence");
    console.log("  ───────────────────────────────────────────────────────────");
    console.log("  Cadence is delivered and signal-to-noise is acceptable.");
    console.log("  Action items:");
    console.log("    1. No cadence changes needed");
    console.log("    2. Consider reducing to 5-min cadence for fixtures >24h away (cost saving)");
    console.log("    3. Maintain 1/min for fixtures within 6h of kickoff");
  } else if (validCadence.length === 0) {
    console.log("  RECOMMENDATION: Insufficient data to assess cadence");
    console.log("  ──────────────────────────────────────────────────────");
    console.log("  No fixtures with enough snapshots found in the 24h window.");
    console.log("  This could mean:");
    console.log("    1. No matches scheduled in the ±24h window");
    console.log("    2. Odds API not returning data for these fixtures");
    console.log("    3. Scheduler not running or not polling odds");
  }

  console.log();
  console.log("  CADENCE POLICY RECOMMENDATION:");
  console.log("  ┌──────────────────────┬──────────┬───────────────┐");
  console.log("  │ Time to kickoff      │ Cadence  │ Min books     │");
  console.log("  ├──────────────────────┼──────────┼───────────────┤");
  console.log("  │ > 7 days             │ 30 min   │ 2 (any)       │");
  console.log("  │ 1–7 days             │ 10 min   │ 3             │");
  console.log("  │ 6h – 24h             │ 5 min    │ 4             │");
  console.log("  │ 1h – 6h              │ 1 min    │ 5             │");
  console.log("  │ < 1h (pre-kickoff)   │ 1 min    │ 5             │");
  console.log("  │ Live                 │ frozen   │ N/A (use L)   │");
  console.log("  └──────────────────────┴──────────┴───────────────┘");
  console.log();

  console.log("  3 KEY CHARTS TO PRODUCE:");
  console.log("  1. Snapshot interval heatmap: fixture_id × time, color = gap length (minutes)");
  console.log("     → reveals systematic gaps (e.g., always at 3am, or API throttle windows)");
  console.log("  2. M1 volatility vs time-to-kickoff scatter: each dot = one team-fixture,");
  console.log("     x = hours to kickoff, y = |ΔM1| p95 → shows where signal concentrates");
  console.log("  3. Noise ratio histogram: x = noise_ratio (1-step / 15-step std), y = count");
  console.log("     → if bimodal, some teams are noisy while others are clean → investigate why");
  console.log();

  // GO / NO-GO
  const goNoGo = cadencePass && (noiseOk || sensitivityResults.length === 0) && (booksPass || validCadence.length === 0);
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log(`  │  VERDICT:  ${goNoGo ? "GO ✓  — Oracle launch cadence is sufficient" : "NO-GO ✗ — Fix cadence/noise issues before launch"}     │`);
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log();
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
