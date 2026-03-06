import * as fs from "fs";
import * as path from "path";

// --- CSV Parser ---
function parseCSV(filePath: string): Record<string, string>[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCSVLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (vals[j] || "").trim();
    }
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

// --- Helpers ---
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function median(sorted: number[]): number {
  return percentile(sorted, 50);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function fmt(n: number, dec = 2): string {
  return n.toFixed(dec);
}

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

function padL(s: string, len: number): string {
  return s.padStart(len);
}

// --- Data Loading ---
const DATA_DIR = "/Users/future/Desktop/MSI2026/data/v1.4V2";

console.log("Loading CSVs...");
const settlements = parseCSV(path.join(DATA_DIR, "settlement_log_full.csv"));
const oracleState = parseCSV(path.join(DATA_DIR, "team_oracle_state.csv"));
const priceHistory = parseCSV(path.join(DATA_DIR, "oracle_price_history.csv"));
const matches = parseCSV(path.join(DATA_DIR, "matches_with_odds.csv"));
console.log(`  settlement_log_full:  ${settlements.length} rows`);
console.log(`  team_oracle_state:    ${oracleState.length} rows`);
console.log(`  oracle_price_history: ${priceHistory.length} rows`);
console.log(`  matches_with_odds:    ${matches.length} rows`);

const EPL_TEAMS = [
  "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton",
  "Burnley", "Chelsea", "Crystal Palace", "Everton", "Fulham",
  "Leeds", "Liverpool", "Manchester City", "Manchester United",
  "Newcastle", "Nottingham Forest", "Sunderland", "Tottenham",
  "West Ham", "Wolves",
];

const eplSet = new Set(EPL_TEAMS);

// Build oracle state lookup
const stateByTeam = new Map<string, Record<string, string>>();
for (const row of oracleState) {
  stateByTeam.set(row.team_id, row);
}

// Build fixture -> match date lookup from matches_with_odds
const fixtureDateMap = new Map<string, string>(); // fixture_id -> date
const fixtureLeagueMap = new Map<string, string>(); // fixture_id -> league
for (const m of matches) {
  fixtureDateMap.set(m.fixture_id, m.date);
  fixtureLeagueMap.set(m.fixture_id, m.league);
}

// Enrich settlements with real dates
for (const s of settlements) {
  (s as any)._realDate = fixtureDateMap.get(s.fixture_id) || "";
  (s as any)._league = fixtureLeagueMap.get(s.fixture_id) || "";
}

// ========================================================================
// SECTION 1: DELTA_B DISTRIBUTION
// ========================================================================
console.log("\n" + "=".repeat(80));
console.log("  1. DELTA_B DISTRIBUTION (settlement_log)");
console.log("=".repeat(80));

const absDeltaBs = settlements.map((r) => Math.abs(parseFloat(r.delta_b))).sort((a, b) => a - b);
const deltaBsRaw = settlements.map((r) => parseFloat(r.delta_b));
const totalSettlements = settlements.length;

console.log(`\n  Total settlements:     ${totalSettlements}`);
console.log(`  Mean |delta_b|:        ${fmt(mean(absDeltaBs))}`);
console.log(`  Median |delta_b|:      ${fmt(median(absDeltaBs))}`);
console.log(`  P5 |delta_b|:          ${fmt(percentile(absDeltaBs, 5))}`);
console.log(`  P25 |delta_b|:         ${fmt(percentile(absDeltaBs, 25))}`);
console.log(`  P75 |delta_b|:         ${fmt(percentile(absDeltaBs, 75))}`);
console.log(`  P95 |delta_b|:         ${fmt(percentile(absDeltaBs, 95))}`);
console.log(`  Min |delta_b|:         ${fmt(Math.min(...absDeltaBs))}`);
console.log(`  Max |delta_b|:         ${fmt(Math.max(...absDeltaBs))}`);

const bigMovers = absDeltaBs.filter((d) => d > 20).length;
const smallMovers = absDeltaBs.filter((d) => d < 5).length;
console.log(`\n  |delta_b| > 20 (big):  ${bigMovers} (${fmt((bigMovers / totalSettlements) * 100)}%)`);
console.log(`  |delta_b| < 5 (small): ${smallMovers} (${fmt((smallMovers / totalSettlements) * 100)}%)`);

// Price move = delta_b / 5
const absPriceMoves = absDeltaBs.map((d) => d / 5);
console.log(`\n  --- Price Move (delta_b / 5) ---`);
console.log(`  Mean |price_move|:     ${fmt(mean(absPriceMoves))}`);
console.log(`  Median |price_move|:   ${fmt(median(absPriceMoves))}`);
console.log(`  P5 |price_move|:       ${fmt(percentile(absPriceMoves, 5))}`);
console.log(`  P25 |price_move|:      ${fmt(percentile(absPriceMoves, 25))}`);
console.log(`  P75 |price_move|:      ${fmt(percentile(absPriceMoves, 75))}`);
console.log(`  P95 |price_move|:      ${fmt(percentile(absPriceMoves, 95))}`);

// ========================================================================
// SECTION 2: PER-TEAM B VOLATILITY
// ========================================================================
console.log("\n" + "=".repeat(80));
console.log("  2. PER-TEAM B VOLATILITY (EPL teams, settlement_log)");
console.log("=".repeat(80));

const eplSettlements = settlements.filter((r) => eplSet.has(r.team_id));
console.log(`\n  Total EPL settlements: ${eplSettlements.length}`);

// Group by team
const byTeam = new Map<string, typeof settlements>();
for (const row of eplSettlements) {
  if (!byTeam.has(row.team_id)) byTeam.set(row.team_id, []);
  byTeam.get(row.team_id)!.push(row);
}

console.log(
  `\n  ${pad("Team", 22)} ${padL("Sttl", 5)} ${padL("Sum|dB|", 9)} ${padL("Max|dB|", 9)} ${padL("CurrB", 9)} ${padL("Index", 8)} ${padL("M1", 8)}`
);
console.log("  " + "-".repeat(78));

const eplTeamStats: { team: string; settlements: number; sumAbsDb: number; maxAbsDb: number; currB: number; index: number; m1: number }[] = [];

for (const team of EPL_TEAMS) {
  const rows = byTeam.get(team) || [];
  const absDeltas = rows.map((r) => Math.abs(parseFloat(r.delta_b)));
  const sumAbsDb = absDeltas.reduce((a, b) => a + b, 0);
  const maxAbsDb = absDeltas.length > 0 ? Math.max(...absDeltas) : 0;
  const state = stateByTeam.get(team);
  const currB = state ? parseFloat(state.b_value) : 0;
  const index = state ? parseFloat(state.published_index) : 0;
  const m1 = state ? parseFloat(state.m1_value) : 0;

  eplTeamStats.push({ team, settlements: rows.length, sumAbsDb, maxAbsDb, currB, index, m1 });

  console.log(
    `  ${pad(team, 22)} ${padL(String(rows.length), 5)} ${padL(fmt(sumAbsDb, 1), 9)} ${padL(fmt(maxAbsDb, 1), 9)} ${padL(fmt(currB, 1), 9)} ${padL(fmt(index, 1), 8)} ${padL(fmt(m1, 1), 8)}`
  );
}

// ========================================================================
// SECTION 3: M1 LAYER ANALYSIS
// ========================================================================
console.log("\n" + "=".repeat(80));
console.log("  3. M1 LAYER ANALYSIS (team_oracle_state)");
console.log("=".repeat(80));

const allM1s = oracleState.map((r) => parseFloat(r.m1_value || "0"));
const absM1s = allM1s.map(Math.abs);
const activeM1s = allM1s.filter((m) => m !== 0);
const absActiveM1s = activeM1s.map(Math.abs).sort((a, b) => a - b);

const m1gt100 = absM1s.filter((m) => m > 100).length;
const m1gt50 = absM1s.filter((m) => m > 50).length;
const m1at120 = allM1s.filter((m) => Math.abs(m) === 120).length;

console.log(`\n  Total teams in oracle state: ${oracleState.length}`);
console.log(`  |M1| > 100:   ${m1gt100}`);
console.log(`  |M1| > 50:    ${m1gt50}`);
console.log(`  |M1| = 120:   ${m1at120} (at cap)`);
console.log(`  Active M1s (!=0): ${activeM1s.length}`);
console.log(`  Mean |M1| (active):   ${fmt(mean(absActiveM1s))}`);
console.log(`  Median |M1| (active): ${fmt(median(absActiveM1s))}`);

// Teams at M1 cap
const cappedTeams = oracleState.filter((r) => Math.abs(parseFloat(r.m1_value || "0")) === 120);
if (cappedTeams.length > 0) {
  console.log(`\n  Teams at M1 cap (+/-120):`);
  for (const t of cappedTeams) {
    console.log(`    ${pad(t.team_id, 28)} M1 = ${t.m1_value}`);
  }
}

// EPL M1 detail
console.log(`\n  EPL Team M1 Analysis:`);
console.log(`  ${pad("Team", 22)} ${padL("M1", 8)} ${padL("B", 9)} ${padL("Index", 9)}  M1 Direction`);
console.log("  " + "-".repeat(70));

for (const team of EPL_TEAMS) {
  const state = stateByTeam.get(team);
  if (!state) {
    console.log(`  ${pad(team, 22)}  (not in oracle state)`);
    continue;
  }
  const m1 = parseFloat(state.m1_value || "0");
  const b = parseFloat(state.b_value || "0");
  const idx = parseFloat(state.published_index || "0");

  let direction = "";
  if (m1 === 0) {
    direction = "neutral (M1=0)";
  } else if (m1 > 0) {
    direction = `pushing Index UP by ${fmt(m1, 1)} above B`;
  } else {
    direction = `pushing Index DOWN by ${fmt(Math.abs(m1), 1)} below B`;
  }

  console.log(
    `  ${pad(team, 22)} ${padL(fmt(m1, 1), 8)} ${padL(fmt(b, 1), 9)} ${padL(fmt(idx, 1), 9)}  ${direction}`
  );
}

// ========================================================================
// SECTION 4: PRICE RANGE & SPREAD
// ========================================================================
console.log("\n" + "=".repeat(80));
console.log("  4. PRICE RANGE & SPREAD (EPL teams)");
console.log("=".repeat(80));

const eplPrices: { team: string; price: number; index: number }[] = [];
for (const team of EPL_TEAMS) {
  const state = stateByTeam.get(team);
  if (!state) continue;
  const idx = parseFloat(state.published_index || "0");
  const price = (idx - 800) / 5;
  eplPrices.push({ team, price, index: idx });
}

eplPrices.sort((a, b) => b.price - a.price);

const prices = eplPrices.map((p) => p.price);
const highestPrice = Math.max(...prices);
const lowestPrice = Math.min(...prices);
const spread = highestPrice - lowestPrice;

console.log(`\n  Highest Price: ${fmt(highestPrice)} (${eplPrices[0].team})`);
console.log(`  Lowest Price:  ${fmt(lowestPrice)} (${eplPrices[eplPrices.length - 1].team})`);
console.log(`  Spread:        ${fmt(spread)}`);
console.log(`  Mean Price:    ${fmt(mean(prices))}`);

console.log(`\n  ${padL("#", 3)}  ${pad("Team", 22)} ${padL("Index", 9)} ${padL("Price", 9)}`);
console.log("  " + "-".repeat(48));
eplPrices.forEach((p, i) => {
  console.log(
    `  ${padL(String(i + 1), 3)}  ${pad(p.team, 22)} ${padL(fmt(p.index, 1), 9)} ${padL(fmt(p.price, 2), 9)}`
  );
});

// ========================================================================
// SECTION 5: MATCH FREQUENCY (using matches_with_odds real dates)
// ========================================================================
console.log("\n" + "=".repeat(80));
console.log("  5. MATCH FREQUENCY (settlement_log + matches_with_odds for real dates)");
console.log("=".repeat(80));

const msPerDay = 86400000;
const msPerWeek = 7 * msPerDay;

// NOTE: settled_at is from a bulk backfill (all 2026-03-05). Use match dates from matches_with_odds.
console.log("\n  NOTE: settled_at timestamps are from bulk backfill (all same day).");
console.log("  Using match dates from matches_with_odds.csv joined by fixture_id.\n");

// All settlements with real dates
const settlementsWithDates = settlements.filter((s) => (s as any)._realDate);
const allRealDates = settlementsWithDates
  .map((s) => new Date((s as any)._realDate))
  .filter((d) => !isNaN(d.getTime()))
  .sort((a, b) => a.getTime() - b.getTime());

// EPL settlements with real dates
const eplSettlementsWithDates = eplSettlements.filter((s) => (s as any)._realDate);
const eplRealDates = eplSettlementsWithDates
  .map((s) => new Date((s as any)._realDate))
  .filter((d) => !isNaN(d.getTime()))
  .sort((a, b) => a.getTime() - b.getTime());

if (allRealDates.length > 1) {
  const allSpanWeeks = (allRealDates[allRealDates.length - 1].getTime() - allRealDates[0].getTime()) / msPerWeek;
  const allPerWeek = settlementsWithDates.length / allSpanWeeks;
  console.log(`  All teams:`);
  console.log(`    Date range: ${allRealDates[0].toISOString().slice(0, 10)} to ${allRealDates[allRealDates.length - 1].toISOString().slice(0, 10)}`);
  console.log(`    Span: ${fmt(allSpanWeeks, 1)} weeks`);
  console.log(`    Total settlements with dates: ${settlementsWithDates.length}`);
  console.log(`    Avg settlements/week (all): ${fmt(allPerWeek, 1)}`);
  console.log(`    Avg matches/week (all): ${fmt(allPerWeek / 2, 1)} (2 rows per match)`);
} else {
  console.log(`  Could not determine date range for all teams.`);
}

if (eplRealDates.length > 1) {
  const eplSpanWeeks = (eplRealDates[eplRealDates.length - 1].getTime() - eplRealDates[0].getTime()) / msPerWeek;
  const eplPerWeek = eplSettlementsWithDates.length / eplSpanWeeks;
  console.log(`\n  EPL:`);
  console.log(`    Date range: ${eplRealDates[0].toISOString().slice(0, 10)} to ${eplRealDates[eplRealDates.length - 1].toISOString().slice(0, 10)}`);
  console.log(`    Span: ${fmt(eplSpanWeeks, 1)} weeks`);
  console.log(`    Total EPL settlements: ${eplSettlementsWithDates.length}`);
  console.log(`    Avg EPL settlements/week: ${fmt(eplPerWeek, 1)}`);
  console.log(`    Avg EPL matches/week: ${fmt(eplPerWeek / 2, 1)}`);
  console.log(`    Avg settlements/week per team: ${fmt(eplPerWeek / EPL_TEAMS.length, 2)}`);

  // Longest gap between EPL fixtures (by date)
  const eplFixtureDates = new Map<string, Date>();
  for (const row of eplSettlementsWithDates) {
    const d = new Date((row as any)._realDate);
    if (!isNaN(d.getTime())) {
      if (!eplFixtureDates.has(row.fixture_id) || d < eplFixtureDates.get(row.fixture_id)!) {
        eplFixtureDates.set(row.fixture_id, d);
      }
    }
  }
  const eplFixtureDatesSorted = [...eplFixtureDates.values()].sort((a, b) => a.getTime() - b.getTime());

  let maxGapDays = 0;
  let gapStart = "";
  let gapEnd = "";
  for (let i = 1; i < eplFixtureDatesSorted.length; i++) {
    const gap = (eplFixtureDatesSorted[i].getTime() - eplFixtureDatesSorted[i - 1].getTime()) / msPerDay;
    if (gap > maxGapDays) {
      maxGapDays = gap;
      gapStart = eplFixtureDatesSorted[i - 1].toISOString().slice(0, 10);
      gapEnd = eplFixtureDatesSorted[i].toISOString().slice(0, 10);
    }
  }
  console.log(`\n    Unique EPL fixtures: ${eplFixtureDates.size}`);
  console.log(`    Longest gap between EPL fixtures: ${fmt(maxGapDays, 1)} days (${gapStart} to ${gapEnd})`);

  // Settlements per gameweek (group by calendar week)
  const weekBuckets = new Map<string, number>();
  for (const d of eplRealDates) {
    const weekStart = new Date(d);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const key = weekStart.toISOString().slice(0, 10);
    weekBuckets.set(key, (weekBuckets.get(key) || 0) + 1);
  }
  const weekCounts = [...weekBuckets.values()];
  const weekCountsSorted = [...weekCounts].sort((a, b) => a - b);
  console.log(`\n    EPL settlements per calendar week:`);
  console.log(`      Weeks with EPL settlements: ${weekCounts.length}`);
  console.log(`      Mean per week:   ${fmt(mean(weekCounts), 1)}`);
  console.log(`      Median per week: ${fmt(median(weekCountsSorted), 1)}`);
  console.log(`      Min per week:    ${Math.min(...weekCounts)}`);
  console.log(`      Max per week:    ${Math.max(...weekCounts)}`);
  console.log(`      (Each match = 2 settlements, so ~${fmt(mean(weekCounts) / 2, 1)} matches/week)`);
} else {
  console.log(`  Could not determine EPL date range.`);
}

// ========================================================================
// SECTION 6: CAUSE -> EFFECT CLARITY
// ========================================================================
console.log("\n" + "=".repeat(80));
console.log("  6. CAUSE -> EFFECT CLARITY (settlement_log)");
console.log("=".repeat(80));

const wins = settlements.filter((r) => parseFloat(r.actual_score_s) === 1);
const losses = settlements.filter((r) => parseFloat(r.actual_score_s) === 0);
const draws = settlements.filter((r) => parseFloat(r.actual_score_s) === 0.5);

console.log(`\n  Results breakdown:`);
console.log(`    Wins (s=1):    ${wins.length}`);
console.log(`    Losses (s=0):  ${losses.length}`);
console.log(`    Draws (s=0.5): ${draws.length}`);
console.log(`    Total:         ${wins.length + losses.length + draws.length}`);

// Verify: wins always have delta_b > 0
const winsPositive = wins.filter((r) => parseFloat(r.delta_b) > 0).length;
const winsNegative = wins.filter((r) => parseFloat(r.delta_b) < 0).length;
const winsZero = wins.filter((r) => parseFloat(r.delta_b) === 0).length;
console.log(`\n  Win (s=1) delta_b check:`);
console.log(`    delta_b > 0: ${winsPositive} (${fmt((winsPositive / wins.length) * 100)}%)`);
console.log(`    delta_b < 0: ${winsNegative} (${fmt((winsNegative / wins.length) * 100)}%)`);
console.log(`    delta_b = 0: ${winsZero}`);
if (winsNegative === 0 && winsZero === 0) {
  console.log(`    VERIFIED: All wins have positive delta_b`);
} else {
  console.log(`    WARNING: ${winsNegative + winsZero} wins do NOT have positive delta_b`);
}

// Verify: losses always have delta_b < 0
const lossesNegative = losses.filter((r) => parseFloat(r.delta_b) < 0).length;
const lossesPositive = losses.filter((r) => parseFloat(r.delta_b) > 0).length;
const lossesZero = losses.filter((r) => parseFloat(r.delta_b) === 0).length;
console.log(`\n  Loss (s=0) delta_b check:`);
console.log(`    delta_b < 0: ${lossesNegative} (${fmt((lossesNegative / losses.length) * 100)}%)`);
console.log(`    delta_b > 0: ${lossesPositive} (${fmt((lossesPositive / losses.length) * 100)}%)`);
console.log(`    delta_b = 0: ${lossesZero}`);
if (lossesPositive === 0 && lossesZero === 0) {
  console.log(`    VERIFIED: All losses have negative delta_b`);
} else {
  console.log(`    WARNING: ${lossesPositive + lossesZero} losses do NOT have negative delta_b`);
}

// Draws
const drawDeltas = draws.map((r) => parseFloat(r.delta_b)).sort((a, b) => a - b);
const drawDeltasAbs = drawDeltas.map(Math.abs).sort((a, b) => a - b);
const drawsPositive = drawDeltas.filter((d) => d > 0).length;
const drawsNegative = drawDeltas.filter((d) => d < 0).length;
const drawsZero = drawDeltas.filter((d) => d === 0).length;

console.log(`\n  Draw (s=0.5) delta_b distribution:`);
console.log(`    delta_b > 0 (outperformed expectation): ${drawsPositive} (${fmt((drawsPositive / draws.length) * 100)}%)`);
console.log(`    delta_b < 0 (underperformed expectation): ${drawsNegative} (${fmt((drawsNegative / draws.length) * 100)}%)`);
console.log(`    delta_b = 0: ${drawsZero}`);
console.log(`    Mean delta_b (draws):    ${fmt(mean(drawDeltas))}`);
console.log(`    Mean |delta_b| (draws):  ${fmt(mean(drawDeltasAbs))}`);
console.log(`    Median delta_b (draws):  ${fmt(median(drawDeltas))}`);
console.log(`    Min delta_b (draws):     ${fmt(Math.min(...drawDeltas))}`);
console.log(`    Max delta_b (draws):     ${fmt(Math.max(...drawDeltas))}`);
console.log(`    P25 delta_b (draws):     ${fmt(percentile(drawDeltas, 25))}`);
console.log(`    P75 delta_b (draws):     ${fmt(percentile(drawDeltas, 75))}`);

// ========================================================================
// SECTION 7: BOOKMAKER COUNT
// ========================================================================
console.log("\n" + "=".repeat(80));
console.log("  7. BOOKMAKER COUNT (settlement_log)");
console.log("=".repeat(80));

const bmCounts = settlements.map((r) => parseInt(r.bookmaker_count, 10)).filter((n) => !isNaN(n));
const bmSorted = [...bmCounts].sort((a, b) => a - b);

console.log(`\n  Total rows with bookmaker_count: ${bmCounts.length}`);
console.log(`  Mean:   ${fmt(mean(bmCounts))}`);
console.log(`  Median: ${fmt(median(bmSorted))}`);
console.log(`  Min:    ${Math.min(...bmCounts)}`);
console.log(`  Max:    ${Math.max(...bmCounts)}`);

const bmLt10 = bmCounts.filter((b) => b < 10).length;
console.log(`\n  Settlements with < 10 bookmakers: ${bmLt10} (${fmt((bmLt10 / bmCounts.length) * 100)}%)`);

// Distribution breakdown
const bmBuckets = new Map<number, number>();
for (const b of bmCounts) {
  bmBuckets.set(b, (bmBuckets.get(b) || 0) + 1);
}
const bmKeys = [...bmBuckets.keys()].sort((a, b) => a - b);
console.log(`\n  Bookmaker count distribution:`);
console.log(`  ${padL("BM#", 5)} ${padL("Count", 7)} ${padL("%", 7)}  Bar`);
console.log("  " + "-".repeat(50));
for (const k of bmKeys) {
  const count = bmBuckets.get(k)!;
  const pct = (count / bmCounts.length) * 100;
  const barLen = Math.max(1, Math.round(pct));
  const bar = "#".repeat(barLen);
  console.log(`  ${padL(String(k), 5)} ${padL(String(count), 7)} ${padL(fmt(pct, 1), 7)}  ${bar}`);
}

// ========================================================================
// PERP VIABILITY SUMMARY
// ========================================================================
console.log("\n" + "=".repeat(80));
console.log("  PERP VIABILITY SUMMARY");
console.log("=".repeat(80));

const medianPriceMove = median(absPriceMoves);
const p95PriceMove = percentile(absPriceMoves, 95);
const meanPriceMove = mean(absPriceMoves);

// Use real dates for frequency
let eplPerWeekF = 0;
if (eplRealDates.length > 1) {
  const eplSpanWeeks = (eplRealDates[eplRealDates.length - 1].getTime() - eplRealDates[0].getTime()) / msPerWeek;
  eplPerWeekF = eplSettlementsWithDates.length / eplSpanWeeks;
}

console.log(`
  Key Metrics for Perpetual Trading:
  
  Price Movement per Match:
    Median |price_move|:  ${fmt(medianPriceMove)} points
    Mean |price_move|:    ${fmt(meanPriceMove)} points
    P95 |price_move|:     ${fmt(p95PriceMove)} points
  
  EPL Price Range:
    Spread (max - min):   ${fmt(spread)} points
    As % of mean price:   ${fmt((spread / mean(prices)) * 100, 1)}%
  
  Match Frequency (EPL):
    ~${fmt(eplPerWeekF, 1)} settlements/week
    = ~${fmt(eplPerWeekF / 2, 1)} matches/week (2 settlements per match)
  
  Cause-Effect Integrity:
    Win->Up:  ${winsPositive}/${wins.length} (${fmt((winsPositive / wins.length) * 100)}%)
    Loss->Dn: ${lossesNegative}/${losses.length} (${fmt((lossesNegative / losses.length) * 100)}%)
    Deterministic: ${winsNegative === 0 && lossesPositive === 0 ? "YES - perfectly clean" : "NO - anomalies found"}
  
  M1 Layer Impact:
    Teams at M1 cap (+/-120): ${m1at120}
    Mean |M1| (active):     ${fmt(mean(absActiveM1s))}
    M1 as avg % of Index:   ~${fmt((mean(absActiveM1s) / mean(oracleState.map(r => parseFloat(r.published_index || "0")))) * 100, 1)}%
  
  Bookmaker Data Quality:
    Min bookmakers: ${Math.min(...bmCounts)} | Mean: ${fmt(mean(bmCounts))} | Zero below 10: ${bmLt10 === 0 ? "YES" : "NO"}
`);

console.log("Analysis complete.");
