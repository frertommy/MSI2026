/**
 * perp-spec-audit.ts — Comprehensive Oracle V1 audit against perpetual contract specs.
 *
 * Queries real data from settlement_log, team_oracle_state, oracle_price_history,
 * and oracle_kr_snapshots to evaluate readiness for tradable perpetual contracts.
 *
 * Usage:
 *   cd scheduler
 *   npx tsx src/scripts/perp-spec-audit.ts
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

function hr(title: string) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(70)}`);
}

function sub(title: string) {
  console.log(`\n--- ${title} ---`);
}

function pct(n: number, total: number): string {
  if (total === 0) return "N/A";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ─── Paginated fetch helper ──────────────────────────────────

async function fetchAll<T>(
  table: string,
  select: string,
  filters?: { column: string; op: string; value: unknown }[],
  order?: { column: string; ascending: boolean }
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    let query = sb.from(table).select(select).range(from, from + pageSize - 1);

    if (filters) {
      for (const f of filters) {
        if (f.op === "eq") query = query.eq(f.column, f.value);
        else if (f.op === "neq") query = query.neq(f.column, f.value);
        else if (f.op === "gt") query = query.gt(f.column, f.value);
        else if (f.op === "gte") query = query.gte(f.column, f.value);
        else if (f.op === "lt") query = query.lt(f.column, f.value);
      }
    }
    if (order) {
      query = query.order(order.column, { ascending: order.ascending });
    }

    const { data, error } = await query;
    if (error) {
      console.error(`  fetchAll(${table}) error: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return all;
}

// ═══════════════════════════════════════════════════════════════
// SPEC 1: "Price moves on matches"
// ═══════════════════════════════════════════════════════════════

async function auditSpec1_PriceMoves() {
  hr("SPEC 1: Price moves on matches");

  sub("1a. Settlement delta_b distribution");

  // Fetch all settlement_log entries
  const settlements = await fetchAll<{
    fixture_id: number;
    team_id: string;
    e_kr: number;
    actual_score_s: number;
    delta_b: number;
    b_before: number;
    b_after: number;
    settled_at: string;
  }>("settlement_log", "fixture_id, team_id, e_kr, actual_score_s, delta_b, b_before, b_after, settled_at");

  console.log(`  Total settlement entries: ${settlements.length}`);

  // Filter out failure entries (delta_b = 0 AND e_kr = 0 — insufficient KR)
  const valid = settlements.filter(s => !(s.delta_b === 0 && s.e_kr === 0));
  const failures = settlements.length - valid.length;
  console.log(`  Valid settlements: ${valid.length} (${failures} KR failures excluded)`);

  if (valid.length === 0) {
    console.log("  NO VALID SETTLEMENTS - cannot assess spec 1");
    return;
  }

  const absDeltaB = valid.map(s => Math.abs(Number(s.delta_b))).sort((a, b) => a - b);
  const rawDeltaB = valid.map(s => Number(s.delta_b)).sort((a, b) => a - b);

  console.log(`  Abs(delta_b) stats:`);
  console.log(`    Min:    ${absDeltaB[0].toFixed(2)}`);
  console.log(`    P10:    ${percentile(absDeltaB, 10).toFixed(2)}`);
  console.log(`    P25:    ${percentile(absDeltaB, 25).toFixed(2)}`);
  console.log(`    Median: ${percentile(absDeltaB, 50).toFixed(2)}`);
  console.log(`    Mean:   ${(absDeltaB.reduce((a, b) => a + b, 0) / absDeltaB.length).toFixed(2)}`);
  console.log(`    P75:    ${percentile(absDeltaB, 75).toFixed(2)}`);
  console.log(`    P90:    ${percentile(absDeltaB, 90).toFixed(2)}`);
  console.log(`    Max:    ${absDeltaB[absDeltaB.length - 1].toFixed(2)}`);

  console.log(`\n  Movement thresholds:`);
  for (const thresh of [1, 2, 5, 10, 15, 20, 25]) {
    const count = absDeltaB.filter(d => d >= thresh).length;
    console.log(`    |delta_b| >= ${thresh.toString().padStart(2)}: ${count.toString().padStart(4)} (${pct(count, valid.length)})`);
  }

  sub("1b. delta_b by match outcome");
  const wins = valid.filter(s => Number(s.actual_score_s) === 1);
  const draws = valid.filter(s => Number(s.actual_score_s) === 0.5);
  const losses = valid.filter(s => Number(s.actual_score_s) === 0);

  console.log(`  Wins:   ${wins.length} settlements`);
  if (wins.length > 0) {
    const winDeltas = wins.map(s => Number(s.delta_b)).sort((a, b) => a - b);
    console.log(`    delta_b range: [${winDeltas[0].toFixed(2)}, ${winDeltas[winDeltas.length - 1].toFixed(2)}]`);
    console.log(`    mean: ${(winDeltas.reduce((a, b) => a + b, 0) / winDeltas.length).toFixed(2)}`);
    console.log(`    median: ${percentile(winDeltas, 50).toFixed(2)}`);
  }

  console.log(`  Draws:  ${draws.length} settlements`);
  if (draws.length > 0) {
    const drawDeltas = draws.map(s => Number(s.delta_b)).sort((a, b) => a - b);
    console.log(`    delta_b range: [${drawDeltas[0].toFixed(2)}, ${drawDeltas[drawDeltas.length - 1].toFixed(2)}]`);
    console.log(`    mean: ${(drawDeltas.reduce((a, b) => a + b, 0) / drawDeltas.length).toFixed(2)}`);
    console.log(`    median: ${percentile(drawDeltas, 50).toFixed(2)}`);
  }

  console.log(`  Losses: ${losses.length} settlements`);
  if (losses.length > 0) {
    const lossDeltas = losses.map(s => Number(s.delta_b)).sort((a, b) => a - b);
    console.log(`    delta_b range: [${lossDeltas[0].toFixed(2)}, ${lossDeltas[lossDeltas.length - 1].toFixed(2)}]`);
    console.log(`    mean: ${(lossDeltas.reduce((a, b) => a + b, 0) / lossDeltas.length).toFixed(2)}`);
    console.log(`    median: ${percentile(lossDeltas, 50).toFixed(2)}`);
  }

  sub("1c. Current M1 distribution");
  const teamStates = await fetchAll<{
    team_id: string;
    b_value: number;
    m1_value: number;
    published_index: number;
    confidence_score: number | null;
    next_fixture_id: number | null;
  }>("team_oracle_state", "team_id, b_value, m1_value, published_index, confidence_score, next_fixture_id");

  console.log(`  Total teams in team_oracle_state: ${teamStates.length}`);

  const m1Values = teamStates.map(s => Number(s.m1_value)).sort((a, b) => a - b);
  const m1Zero = m1Values.filter(v => v === 0).length;
  const m1NonZero = m1Values.filter(v => v !== 0);

  console.log(`  M1 = 0 (no fixture / no odds): ${m1Zero} teams (${pct(m1Zero, teamStates.length)})`);
  console.log(`  M1 != 0: ${m1NonZero.length} teams`);

  if (m1NonZero.length > 0) {
    const absM1 = m1NonZero.map(Math.abs).sort((a, b) => a - b);
    console.log(`  Non-zero M1 abs stats:`);
    console.log(`    Min:    ${absM1[0].toFixed(2)}`);
    console.log(`    Median: ${percentile(absM1, 50).toFixed(2)}`);
    console.log(`    Mean:   ${(absM1.reduce((a, b) => a + b, 0) / absM1.length).toFixed(2)}`);
    console.log(`    Max:    ${absM1[absM1.length - 1].toFixed(2)}`);
  }

  if (m1NonZero.length > 0) {
    const sortedM1 = [...m1NonZero].sort((a, b) => a - b);
    console.log(`  M1 signed range: [${sortedM1[0].toFixed(2)}, ${sortedM1[sortedM1.length - 1].toFixed(2)}]`);
  }
}

// ═══════════════════════════════════════════════════════════════
// SPEC 2: "Arbitragable with bookmakers"
// ═══════════════════════════════════════════════════════════════

async function auditSpec2_Arbitrage() {
  hr("SPEC 2: Arbitragable with bookmakers");

  sub("2a. Mathematical relationship between index and bookmaker odds");
  console.log(`  Formula analysis (from code):`);
  console.log(`    B layer: cumulative Elo from settlement`);
  console.log(`    M1 layer: M1 = c(t) * (R_market - B), clamped +/-75`);
  console.log(`    Published = B + M1 = B + c(t)*(R_market - B)`);
  console.log(`    When c(t)=1: Published = R_market (pure odds-implied Elo)`);
  console.log(`    When c(t)=0: Published = B (pure settlement history)`);
  console.log(`    Typical c(t): 0.3-0.7 → partial blend`);
  console.log(``);
  console.log(`  For arbitrage, a trader needs:`);
  console.log(`    1. Clear conversion: bookmaker odds <-> expected index value`);
  console.log(`    2. Fast reaction: index must move quickly when odds change`);
  console.log(`    3. Predictable settlement: known formula at match end`);

  sub("2b. R_market computation chain");
  console.log(`  Odds -> powerDevigOdds() -> median consensus -> teamExpectedScore`);
  console.log(`  teamExpectedScore -> oddsImpliedStrength(es, opponentB, isHome, 65)`);
  console.log(`  R_market = opponentB + 400*log10(es/(1-es)) +/- 65 (home adj)`);
  console.log(``);
  console.log(`  KEY ISSUE: R_market depends on opponent's B value.`);
  console.log(`  This means the SAME odds produce DIFFERENT R_market values`);
  console.log(`  depending on who the opponent is, and the opponent's settlement history.`);
  console.log(`  This makes direct arb calculation non-trivial — you need`);
  console.log(`  both teams' current B values to convert odds to index.`);

  sub("2c. Confidence scalar components");
  console.log(`  c(t) = c_books * c_dispersion * c_recency * c_horizon`);
  console.log(`    c_books     = min(bookmaker_count / 5, 1)`);
  console.log(`    c_dispersion = 1 - min(spread / 0.08, 1)`);
  console.log(`    c_recency   = 1 - min(hours_since_latest / 48, 1)`);
  console.log(`    c_horizon   = 1 - min(days_to_kickoff / 10, 1)  [0 if no kickoff time]`);
  console.log(``);
  console.log(`  KEY ISSUE: c_horizon decays to 0 as fixture is 10+ days away.`);
  console.log(`  This means M1 effectively vanishes between match weeks.`);
  console.log(`  Index becomes pure B during these gaps — no market discovery.`);

  // Check KR snapshots for bookmaker count distribution
  const krSnapshots = await fetchAll<{
    fixture_id: number;
    bookmaker_count: number;
    home_prob: number;
    draw_prob: number;
    away_prob: number;
  }>("oracle_kr_snapshots", "fixture_id, bookmaker_count, home_prob, draw_prob, away_prob");

  console.log(`\n  KR Snapshots: ${krSnapshots.length} frozen fixtures`);
  if (krSnapshots.length > 0) {
    const bookCounts = krSnapshots.map(k => k.bookmaker_count).sort((a, b) => a - b);
    console.log(`  Bookmaker count distribution:`);
    console.log(`    Min:    ${bookCounts[0]}`);
    console.log(`    Median: ${percentile(bookCounts, 50).toFixed(0)}`);
    console.log(`    Mean:   ${(bookCounts.reduce((a, b) => a + b, 0) / bookCounts.length).toFixed(1)}`);
    console.log(`    Max:    ${bookCounts[bookCounts.length - 1]}`);

    // Count by bookmaker count
    const countMap = new Map<number, number>();
    for (const c of bookCounts) {
      countMap.set(c, (countMap.get(c) ?? 0) + 1);
    }
    console.log(`  By bookmaker count:`);
    for (const [cnt, freq] of [...countMap.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`    ${cnt} books: ${freq} fixtures (${pct(freq, krSnapshots.length)})`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// SPEC 3: "Clear cause → effect"
// ═══════════════════════════════════════════════════════════════

async function auditSpec3_CauseEffect() {
  hr("SPEC 3: Clear cause -> effect (win=up, loss=down)");

  const settlements = await fetchAll<{
    fixture_id: number;
    team_id: string;
    e_kr: number;
    actual_score_s: number;
    delta_b: number;
    b_before: number;
  }>("settlement_log", "fixture_id, team_id, e_kr, actual_score_s, delta_b, b_before");

  const valid = settlements.filter(s => !(Number(s.delta_b) === 0 && Number(s.e_kr) === 0));

  sub("3a. Win -> positive delta_b?");
  const wins = valid.filter(s => Number(s.actual_score_s) === 1);
  const winNegative = wins.filter(s => Number(s.delta_b) < 0);
  const winZero = wins.filter(s => Number(s.delta_b) === 0);
  console.log(`  Wins: ${wins.length}`);
  console.log(`  Win with delta_b < 0 (VIOLATION): ${winNegative.length}`);
  console.log(`  Win with delta_b = 0: ${winZero.length}`);
  console.log(`  Win with delta_b > 0 (correct): ${wins.length - winNegative.length - winZero.length}`);

  // Mathematically: delta_b = 30 * (1 - E_KR)
  // E_KR = P(win) + 0.5 * P(draw), always in [0, 1)
  // So delta_b = 30 * (1 - E_KR) which is always > 0 since E_KR < 1
  // But let's check if E_KR >= 1 ever happened
  const eKROnWins = wins.map(s => Number(s.e_kr)).sort((a, b) => a - b);
  if (eKROnWins.length > 0) {
    console.log(`  E_KR range for wins: [${eKROnWins[0].toFixed(4)}, ${eKROnWins[eKROnWins.length - 1].toFixed(4)}]`);
    const highEKR = wins.filter(s => Number(s.e_kr) > 0.9);
    console.log(`  Wins with E_KR > 0.9 (heavy fav, small delta): ${highEKR.length}`);
    if (highEKR.length > 0) {
      for (const s of highEKR.slice(0, 5)) {
        console.log(`    ${s.team_id}: E_KR=${Number(s.e_kr).toFixed(4)} -> delta_b=${Number(s.delta_b).toFixed(2)}`);
      }
    }
  }

  sub("3b. Loss -> negative delta_b?");
  const losses = valid.filter(s => Number(s.actual_score_s) === 0);
  const lossPositive = losses.filter(s => Number(s.delta_b) > 0);
  const lossZero = losses.filter(s => Number(s.delta_b) === 0);
  console.log(`  Losses: ${losses.length}`);
  console.log(`  Loss with delta_b > 0 (VIOLATION): ${lossPositive.length}`);
  console.log(`  Loss with delta_b = 0: ${lossZero.length}`);
  console.log(`  Loss with delta_b < 0 (correct): ${losses.length - lossPositive.length - lossZero.length}`);

  // delta_b = 30 * (0 - E_KR) = -30 * E_KR, always < 0 since E_KR > 0
  const eKROnLosses = losses.map(s => Number(s.e_kr)).sort((a, b) => a - b);
  if (eKROnLosses.length > 0) {
    console.log(`  E_KR range for losses: [${eKROnLosses[0].toFixed(4)}, ${eKROnLosses[eKROnLosses.length - 1].toFixed(4)}]`);
    const lowEKR = losses.filter(s => Number(s.e_kr) < 0.15);
    console.log(`  Losses with E_KR < 0.15 (underdog lost, small delta): ${lowEKR.length}`);
    if (lowEKR.length > 0) {
      for (const s of lowEKR.slice(0, 5)) {
        console.log(`    ${s.team_id}: E_KR=${Number(s.e_kr).toFixed(4)} -> delta_b=${Number(s.delta_b).toFixed(2)}`);
      }
    }
  }

  sub("3c. Draw -> depends on E_KR");
  const draws = valid.filter(s => Number(s.actual_score_s) === 0.5);
  const drawPositive = draws.filter(s => Number(s.delta_b) > 0);
  const drawNegative = draws.filter(s => Number(s.delta_b) < 0);
  const drawZero = draws.filter(s => Number(s.delta_b) === 0);
  console.log(`  Draws: ${draws.length}`);
  console.log(`    delta_b > 0 (underdog draw): ${drawPositive.length} (${pct(drawPositive.length, draws.length)})`);
  console.log(`    delta_b < 0 (favorite draw): ${drawNegative.length} (${pct(drawNegative.length, draws.length)})`);
  console.log(`    delta_b = 0 (E_KR = 0.5):    ${drawZero.length}`);

  // delta_b = 30 * (0.5 - E_KR)
  // Positive when E_KR < 0.5 (team was underdog → draw is good)
  // Negative when E_KR > 0.5 (team was favorite → draw is disappointing)
  console.log(`\n  NOTE: This is correct behavior for Elo. Draws SHOULD produce`);
  console.log(`  positive delta for underdogs and negative for favorites.`);
  console.log(`  But from a TRADER perspective, a draw is ambiguous — could`);
  console.log(`  move the index up OR down depending on pre-match odds.`);

  sub("3d. Magnitude analysis: are movements 'tradable'?");
  // What's the typical index value? And what % move does delta_b represent?
  const bValues = valid.map(s => Number(s.b_before)).filter(b => b !== 0);
  if (bValues.length > 0) {
    const sortedB = [...bValues].sort((a, b) => a - b);
    console.log(`  B_before distribution (non-zero):`);
    console.log(`    P10: ${percentile(sortedB, 10).toFixed(1)}`);
    console.log(`    Median: ${percentile(sortedB, 50).toFixed(1)}`);
    console.log(`    P90: ${percentile(sortedB, 90).toFixed(1)}`);

    const medianB = percentile(sortedB, 50);
    const absDeltaB = valid.map(s => Math.abs(Number(s.delta_b)));
    const medDelta = percentile(absDeltaB.sort((a, b) => a - b), 50);
    console.log(`\n  Median |delta_b| = ${medDelta.toFixed(2)} on median B = ${medianB.toFixed(1)}`);
    console.log(`  That's a ${((medDelta / medianB) * 100).toFixed(2)}% move per settlement`);
    console.log(`  (For reference: typical Elo K=30 with expected 50/50 → max swing of 15 pts)`);
  }
}

// ═══════════════════════════════════════════════════════════════
// SPEC 4: "Continuous price discovery"
// ═══════════════════════════════════════════════════════════════

async function auditSpec4_Continuity() {
  hr("SPEC 4: Continuous price discovery");

  sub("4a. Price history volume and frequency");

  // Get total count by publish_reason
  const priceHistory = await fetchAll<{
    team: string;
    timestamp: string;
    b_value: number;
    m1_value: number;
    published_index: number;
    publish_reason: string;
  }>("oracle_price_history", "team, timestamp, b_value, m1_value, published_index, publish_reason",
    undefined,
    { column: "timestamp", ascending: true }
  );

  console.log(`  Total oracle_price_history entries: ${priceHistory.length}`);

  // Count by reason
  const byReason = new Map<string, number>();
  for (const ph of priceHistory) {
    byReason.set(ph.publish_reason, (byReason.get(ph.publish_reason) ?? 0) + 1);
  }
  console.log(`  By publish_reason:`);
  for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason}: ${count} (${pct(count, priceHistory.length)})`);
  }

  sub("4b. Updates per team per day");
  // Group by team+day
  const teamDayCounts = new Map<string, number>();
  const teamDays = new Map<string, Set<string>>();
  for (const ph of priceHistory) {
    const day = ph.timestamp.slice(0, 10);
    const key = `${ph.team}|${day}`;
    teamDayCounts.set(key, (teamDayCounts.get(key) ?? 0) + 1);
    if (!teamDays.has(ph.team)) teamDays.set(ph.team, new Set());
    teamDays.get(ph.team)!.add(day);
  }

  const updatesPerTeamDay = [...teamDayCounts.values()].sort((a, b) => a - b);
  if (updatesPerTeamDay.length > 0) {
    console.log(`  Updates per team per day:`);
    console.log(`    Min:    ${updatesPerTeamDay[0]}`);
    console.log(`    P10:    ${percentile(updatesPerTeamDay, 10).toFixed(0)}`);
    console.log(`    Median: ${percentile(updatesPerTeamDay, 50).toFixed(0)}`);
    console.log(`    Mean:   ${(updatesPerTeamDay.reduce((a, b) => a + b, 0) / updatesPerTeamDay.length).toFixed(1)}`);
    console.log(`    P90:    ${percentile(updatesPerTeamDay, 90).toFixed(0)}`);
    console.log(`    Max:    ${updatesPerTeamDay[updatesPerTeamDay.length - 1]}`);
  }

  sub("4c. Gap analysis: time between consecutive updates (per team)");
  // Group by team, sorted by timestamp
  const byTeam = new Map<string, { timestamp: string; published_index: number }[]>();
  for (const ph of priceHistory) {
    if (!byTeam.has(ph.team)) byTeam.set(ph.team, []);
    byTeam.get(ph.team)!.push({ timestamp: ph.timestamp, published_index: Number(ph.published_index) });
  }

  const allGapsMinutes: number[] = [];
  const allJumps: number[] = [];

  for (const [team, entries] of byTeam) {
    // Already sorted by timestamp (global sort)
    for (let i = 1; i < entries.length; i++) {
      const gapMs = new Date(entries[i].timestamp).getTime() - new Date(entries[i - 1].timestamp).getTime();
      const gapMin = gapMs / (60 * 1000);
      allGapsMinutes.push(gapMin);

      const jump = Math.abs(entries[i].published_index - entries[i - 1].published_index);
      if (jump > 0.01) allJumps.push(jump);
    }
  }

  allGapsMinutes.sort((a, b) => a - b);
  if (allGapsMinutes.length > 0) {
    console.log(`  Gap between consecutive updates (minutes):`);
    console.log(`    Min:    ${allGapsMinutes[0].toFixed(1)}`);
    console.log(`    P10:    ${percentile(allGapsMinutes, 10).toFixed(1)}`);
    console.log(`    P25:    ${percentile(allGapsMinutes, 25).toFixed(1)}`);
    console.log(`    Median: ${percentile(allGapsMinutes, 50).toFixed(1)}`);
    console.log(`    P75:    ${percentile(allGapsMinutes, 75).toFixed(1)}`);
    console.log(`    P90:    ${percentile(allGapsMinutes, 90).toFixed(1)}`);
    console.log(`    Max:    ${allGapsMinutes[allGapsMinutes.length - 1].toFixed(1)} min (${(allGapsMinutes[allGapsMinutes.length - 1] / 60).toFixed(1)} hrs)`);

    const over1hr = allGapsMinutes.filter(g => g > 60).length;
    const over6hr = allGapsMinutes.filter(g => g > 360).length;
    const over24hr = allGapsMinutes.filter(g => g > 1440).length;
    console.log(`\n    Gaps > 1hr: ${over1hr} (${pct(over1hr, allGapsMinutes.length)})`);
    console.log(`    Gaps > 6hr: ${over6hr} (${pct(over6hr, allGapsMinutes.length)})`);
    console.log(`    Gaps > 24hr: ${over24hr} (${pct(over24hr, allGapsMinutes.length)})`);
  }

  sub("4d. Index jump size between consecutive updates");
  allJumps.sort((a, b) => a - b);
  if (allJumps.length > 0) {
    console.log(`  |published_index change| (non-zero) distribution:`);
    console.log(`    Count:  ${allJumps.length}`);
    console.log(`    Min:    ${allJumps[0].toFixed(2)}`);
    console.log(`    P10:    ${percentile(allJumps, 10).toFixed(2)}`);
    console.log(`    Median: ${percentile(allJumps, 50).toFixed(2)}`);
    console.log(`    P90:    ${percentile(allJumps, 90).toFixed(2)}`);
    console.log(`    Max:    ${allJumps[allJumps.length - 1].toFixed(2)}`);

    const bigJumps = allJumps.filter(j => j > 20).length;
    console.log(`\n    Jumps > 20 Elo points: ${bigJumps} (${pct(bigJumps, allJumps.length)})`);
  }

  sub("4e. Cycle frequency (scheduler poll interval)");
  console.log(`  From config.ts:`);
  console.log(`    PRIMARY_POLL_INTERVAL = 60s (1 minute)`);
  console.log(`    Oracle cycle runs every poll when ORACLE_V1_ENABLED=true`);
  console.log(`    M1 refreshes are parallel with concurrency limit of 5`);
  console.log(`    Each M1 refresh writes to oracle_price_history`);
  console.log(``);
  console.log(`  Effective rate: 1 update per team per ~1 min when scheduler is running`);
  console.log(`  BUT: if scheduler stops, no updates occur (no on-chain/decentralized fallback)`);
}

// ═══════════════════════════════════════════════════════════════
// SPEC 5: "Funding rate"
// ═══════════════════════════════════════════════════════════════

async function auditSpec5_FundingRate() {
  hr("SPEC 5: Funding rate mechanism");

  console.log(`  SEARCH RESULTS: "funding" / "perpetual" / "funding rate"`);
  console.log(`  - No funding rate code found in the codebase`);
  console.log(`  - No mark_price_snapshots table (referenced in feedback stub)`);
  console.log(`  - No position/trading/margin logic anywhere`);
  console.log(`  - No order book or AMM implementation`);
  console.log(``);

  console.log(`  FEEDBACK MECHANISM (oracle-v1-feedback.ts):`);
  console.log(`    F(t) = w(regime) * (MarkTWAP_elo - NaiveIndex)`);
  console.log(`    This is a STUB - getMarkPriceTWAP() always returns null`);
  console.log(`    So F = 0 for all teams always (no perp trading yet)`);
  console.log(``);

  console.log(`  WHAT EXISTS:`);
  console.log(`    - Feature flag: ORACLE_V1_FEEDBACK_ENABLED`);
  console.log(`    - Regime weights: live=0.15, prematch=0.10, between=0.05, offseason=0.05`);
  console.log(`    - MAX_F_ABS = 20 Elo cap`);
  console.log(`    - Sketch of mark price ingestion in comments`);
  console.log(``);

  console.log(`  WHAT DOESN'T EXIST:`);
  console.log(`    - No funding rate formula`);
  console.log(`    - No funding payment mechanism`);
  console.log(`    - No mark/index price distinction beyond the stub`);
  console.log(`    - No position management`);
  console.log(`    - No margin system`);
  console.log(`    - No order matching`);
  console.log(`    - No liquidation logic`);
}

// ═══════════════════════════════════════════════════════════════
// SPEC 6: "Settlement clarity"
// ═══════════════════════════════════════════════════════════════

async function auditSpec6_SettlementClarity() {
  hr("SPEC 6: Settlement clarity");

  sub("6a. Determinism and transparency");
  console.log(`  Formula: delta_B = K * (S - E_KR)`);
  console.log(`    K = 30 (fixed constant)`);
  console.log(`    S = 1.0 (win), 0.5 (draw), 0.0 (loss)`);
  console.log(`    E_KR = frozen from oracle_kr_snapshots (immutable)`);
  console.log(``);
  console.log(`  KR freezing process:`);
  console.log(`    1. Collect all pre-kickoff odds snapshots`);
  console.log(`    2. Prefer 6h window (degrade if <2 books)`);
  console.log(`    3. Power de-vig each bookmaker`);
  console.log(`    4. Median consensus + renormalize`);
  console.log(`    5. E_KR = P(win) + 0.5 * P(draw)`);
  console.log(`    6. Frozen once, never updated`);
  console.log(``);
  console.log(`  DETERMINISTIC? YES — given the frozen KR and the match result,`);
  console.log(`  anyone can compute delta_B exactly.`);

  sub("6b. Audit trail completeness");

  // Check settlement_log has trace_payload
  const sampleSettlements = await fetchAll<{
    fixture_id: number;
    team_id: string;
    trace_payload: unknown;
    delta_b: number;
    e_kr: number;
  }>("settlement_log", "fixture_id, team_id, trace_payload, delta_b, e_kr",
    undefined,
    { column: "settled_at", ascending: false }
  );

  const withTrace = sampleSettlements.filter(s => s.trace_payload !== null);
  const withoutTrace = sampleSettlements.filter(s => s.trace_payload === null);

  console.log(`  settlement_log entries: ${sampleSettlements.length}`);
  console.log(`  With trace_payload: ${withTrace.length} (${pct(withTrace.length, sampleSettlements.length)})`);
  console.log(`  Without trace_payload: ${withoutTrace.length}`);

  // Check a sample trace payload
  if (withTrace.length > 0) {
    const sample = withTrace[0];
    const tp = sample.trace_payload as Record<string, unknown>;
    console.log(`\n  Sample trace_payload keys: ${Object.keys(tp).join(", ")}`);
    console.log(`  Contains: K, score, kickoff_ts, bookmaker_count, consensus, bookmakers[]`);
  }

  sub("6c. Can a trader predict delta_B?");
  console.log(`  Pre-match: YES — if you know:`);
  console.log(`    1. The frozen E_KR (from oracle_kr_snapshots, publicly readable)`);
  console.log(`    2. The match result (W/D/L)`);
  console.log(`  Then delta_B = 30 * (S - E_KR) is trivially computable.`);
  console.log(``);
  console.log(`  Example predictions for a match with E_KR_home = 0.75:`);
  console.log(`    Home win:  delta_B = 30 * (1.0 - 0.75) = +7.50`);
  console.log(`    Draw:      delta_B = 30 * (0.5 - 0.75) = -7.50`);
  console.log(`    Home loss:  delta_B = 30 * (0.0 - 0.75) = -22.50`);
  console.log(``);
  console.log(`  CRITICAL NOTE: After settlement, M1 and confidence_score`);
  console.log(`  are RESET to 0. The published_index snaps to B_after.`);
  console.log(`  This creates a DISCONTINUITY — pre-match index (B + M1)`);
  console.log(`  becomes post-match index (B_after + 0).`);

  sub("6d. Settlement resets (M1=0 after settlement)");
  // Check how many settlements show b_after != published that would indicate M1 was reset
  const settlements = await fetchAll<{
    fixture_id: number;
    team_id: string;
    b_before: number;
    b_after: number;
    delta_b: number;
    e_kr: number;
    actual_score_s: number;
  }>("settlement_log", "fixture_id, team_id, b_before, b_after, delta_b, e_kr, actual_score_s");

  const validSettlements = settlements.filter(s => !(Number(s.delta_b) === 0 && Number(s.e_kr) === 0));

  // Verify b_after = b_before + delta_b
  let mismatch = 0;
  for (const s of validSettlements) {
    const expected = Number(s.b_before) + Number(s.delta_b);
    const actual = Number(s.b_after);
    if (Math.abs(expected - actual) > 0.01) {
      mismatch++;
    }
  }
  console.log(`  B_after = B_before + delta_b verification:`);
  console.log(`    Checked: ${validSettlements.length}`);
  console.log(`    Mismatches: ${mismatch}`);
  console.log(`    ${mismatch === 0 ? "PASS - all settlements are arithmetically consistent" : "FAIL"}`);
}

// ═══════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════

async function printSummary() {
  hr("SUMMARY: Perpetual Contract Readiness Assessment");

  console.log(`
  SPEC 1: Price moves on matches
  Rating: Evaluate from data above

  SPEC 2: Arbitragable with bookmakers
  Rating: Evaluate from data above

  SPEC 3: Clear cause -> effect (win=up, loss=down)
  Rating: Evaluate from data above

  SPEC 4: Continuous price discovery
  Rating: Evaluate from data above

  SPEC 5: Funding rate mechanism
  Rating: FAIL - No funding rate exists. Feedback stub returns F=0 always.

  SPEC 6: Settlement clarity
  Rating: Evaluate from data above
  `);
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log("Oracle V1 Perpetual Contract Spec Audit");
  console.log(`Run at: ${new Date().toISOString()}`);

  await auditSpec1_PriceMoves();
  await auditSpec2_Arbitrage();
  await auditSpec3_CauseEffect();
  await auditSpec4_Continuity();
  await auditSpec5_FundingRate();
  await auditSpec6_SettlementClarity();
  await printSummary();
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
