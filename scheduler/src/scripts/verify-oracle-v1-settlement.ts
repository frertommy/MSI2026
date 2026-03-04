/**
 * verify-oracle-v1-settlement.ts
 *
 * Verification script for the V1 Oracle B-layer settlement.
 * Checks coverage, KR health, B value sanity, and reproducibility.
 *
 * Usage:
 *   cd scheduler
 *   npx tsx src/scripts/verify-oracle-v1-settlement.ts
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

const ORACLE_V1_K = 30;

// ─── Helpers ────────────────────────────────────────────────

function normalizeOdds(
  homeOdds: number,
  drawOdds: number,
  awayOdds: number
): { homeProb: number; drawProb: number; awayProb: number } {
  const rH = 1 / homeOdds;
  const rD = 1 / drawOdds;
  const rA = 1 / awayOdds;
  const total = rH + rD + rA;
  return {
    homeProb: rH / total,
    drawProb: rD / total,
    awayProb: rA / total,
  };
}

async function fetchAll<T>(
  table: string,
  select: string,
  filters?: { column: string; op: string; value: unknown }[],
  orderBy?: { column: string; ascending: boolean }
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let query = sb.from(table).select(select).range(from, from + pageSize - 1);
    if (filters) {
      for (const f of filters) {
        if (f.op === "eq") query = query.eq(f.column, f.value);
        else if (f.op === "lt") query = query.lt(f.column, f.value);
      }
    }
    if (orderBy) {
      query = query.order(orderBy.column, { ascending: orderBy.ascending });
    }
    const { data, error } = await query;
    if (error) { console.error(`  ERROR fetching ${table}:`, error.message); break; }
    if (!data || data.length === 0) break;
    all.push(...(data as unknown as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ─── Section 1: Settlement Coverage ─────────────────────────

async function checkCoverage() {
  console.log("\n" + "═".repeat(70));
  console.log("  1. SETTLEMENT COVERAGE");
  console.log("═".repeat(70));

  // All finished matches
  const matches = await fetchAll<{
    fixture_id: number;
    home_team: string;
    away_team: string;
    date: string;
    score: string;
  }>("matches", "fixture_id, home_team, away_team, date, score", [
    { column: "status", op: "eq", value: "finished" },
  ]);

  // All settlement_log entries (just fixture_id and team_id)
  const settlements = await fetchAll<{
    fixture_id: number;
    team_id: string;
    delta_B: number;
  }>("settlement_log", "fixture_id, team_id, delta_B");

  // Build set of settled fixture_ids (a fixture is "settled" if BOTH teams have entries)
  const settlementsByFixture = new Map<number, Set<string>>();
  for (const s of settlements) {
    if (!settlementsByFixture.has(s.fixture_id)) {
      settlementsByFixture.set(s.fixture_id, new Set());
    }
    settlementsByFixture.get(s.fixture_id)!.add(s.team_id);
  }

  const fullySettled = new Set<number>();
  const partiallySettled = new Set<number>();
  for (const [fid, teams] of settlementsByFixture) {
    if (teams.size >= 2) fullySettled.add(fid);
    else partiallySettled.add(fid);
  }

  const unsettled = matches.filter(m => !fullySettled.has(m.fixture_id) && !partiallySettled.has(m.fixture_id));

  console.log(`\n  Total finished matches:        ${matches.length}`);
  console.log(`  Fully settled (both teams):    ${fullySettled.size}`);
  console.log(`  Partially settled:             ${partiallySettled.size}`);
  console.log(`  Unsettled:                     ${unsettled.length}`);
  console.log(`  Coverage:                      ${((fullySettled.size / matches.length) * 100).toFixed(1)}%`);

  if (fullySettled.size === matches.length) {
    console.log(`\n  ✅ PASS — All finished matches are settled`);
  } else if (fullySettled.size === 0) {
    console.log(`\n  ⚠️  WARN — No matches settled yet. Run settlement first.`);
  } else {
    console.log(`\n  ⚠️  WARN — ${unsettled.length} matches not yet settled`);
  }

  // Show first 10 unsettled
  if (unsettled.length > 0 && unsettled.length <= 50) {
    console.log(`\n  Unsettled fixtures (first 10):`);
    for (const m of unsettled.slice(0, 10)) {
      console.log(`    ${m.fixture_id}  ${m.date}  ${m.home_team} vs ${m.away_team}  [${m.score}]`);
    }
    if (unsettled.length > 10) {
      console.log(`    ... and ${unsettled.length - 10} more`);
    }
  }

  // Check for partially settled
  if (partiallySettled.size > 0) {
    console.log(`\n  ❌ FAIL — ${partiallySettled.size} fixtures are partially settled (only 1 team):`);
    for (const fid of [...partiallySettled].slice(0, 5)) {
      const teams = settlementsByFixture.get(fid);
      console.log(`    fixture ${fid}: settled for [${[...(teams ?? [])].join(", ")}]`);
    }
  }

  return { matches, settlements, fullySettled };
}

// ─── Section 2: KR Snapshot Health ──────────────────────────

async function checkKRHealth(settlements: { fixture_id: number; team_id: string; delta_B: number }[]) {
  console.log("\n" + "═".repeat(70));
  console.log("  2. KR SNAPSHOT HEALTH (oracle_kr_snapshots)");
  console.log("═".repeat(70));

  // Read directly from oracle_kr_snapshots — the authoritative frozen KR store
  const krSnapshots = await fetchAll<{
    fixture_id: number;
    bookmaker_count: number;
    home_prob: number;
    draw_prob: number;
    away_prob: number;
    home_expected_score: number;
    away_expected_score: number;
    method: string;
    freeze_timestamp: string;
  }>("oracle_kr_snapshots", "fixture_id, bookmaker_count, home_prob, draw_prob, away_prob, home_expected_score, away_expected_score, method, freeze_timestamp");

  // Also check settlement_log for fixtures with insufficient KR (error entries)
  const failureEntries = await fetchAll<{
    fixture_id: number;
    trace_payload: Record<string, unknown> | null;
  }>("settlement_log", "fixture_id, trace_payload");

  const failedFixtureIds = new Set<number>();
  for (const entry of failureEntries) {
    if (entry.trace_payload && entry.trace_payload.error === "insufficient_kr_snapshots") {
      failedFixtureIds.add(entry.fixture_id);
    }
  }

  // Get settled fixture IDs to check coverage
  const settledFixtureIds = new Set(settlements.map(s => s.fixture_id));

  let thinKR = 0;
  let healthyKR = 0;
  const thinFixtures: { fixture_id: number; count: number }[] = [];

  for (const snap of krSnapshots) {
    if (snap.bookmaker_count < 3) {
      thinKR++;
      thinFixtures.push({ fixture_id: snap.fixture_id, count: snap.bookmaker_count });
    } else {
      healthyKR++;
    }
  }

  // Fixtures settled but with no KR snapshot (shouldn't happen, but check)
  const missingKR = [...settledFixtureIds].filter(
    fid => !krSnapshots.some(s => s.fixture_id === fid) && !failedFixtureIds.has(fid)
  );

  console.log(`\n  KR snapshots in table:          ${krSnapshots.length}`);
  console.log(`  Healthy (≥3 bookmakers):        ${healthyKR}`);
  console.log(`  Thin (< 3 bookmakers):          ${thinKR}`);
  console.log(`  Failed (insufficient KR):       ${failedFixtureIds.size}`);
  console.log(`  Settled without KR snapshot:    ${missingKR.length}`);

  if (failedFixtureIds.size === 0 && thinKR === 0 && missingKR.length === 0) {
    console.log(`\n  ✅ PASS — All KR snapshots have sufficient bookmaker coverage`);
  } else {
    if (failedFixtureIds.size > 0) {
      console.log(`\n  ❌ FAIL — ${failedFixtureIds.size} fixtures failed settlement due to insufficient KR:`);
      for (const fid of [...failedFixtureIds].slice(0, 5)) {
        console.log(`    fixture ${fid}`);
      }
    }
    if (thinKR > 0) {
      console.log(`\n  ⚠️  WARN — ${thinKR} fixtures settled with thin KR (< 3 books):`);
      for (const f of thinFixtures.slice(0, 5)) {
        console.log(`    fixture ${f.fixture_id}: ${f.count} bookmaker(s)`);
      }
    }
    if (missingKR.length > 0) {
      console.log(`\n  ⚠️  WARN — ${missingKR.length} settled fixtures have no oracle_kr_snapshots entry:`);
      for (const fid of missingKR.slice(0, 5)) {
        console.log(`    fixture ${fid}`);
      }
    }
  }
}

// ─── Section 3: B Value Sanity ──────────────────────────────

async function checkBValues() {
  console.log("\n" + "═".repeat(70));
  console.log("  3. B VALUE SANITY");
  console.log("═".repeat(70));

  // Load all team_oracle_state rows
  const teamStates = await fetchAll<{
    team_id: string;
    B_value: number;
    season: string;
    updated_at: string;
  }>("team_oracle_state", "team_id, B_value, season, updated_at");

  // Load settlement counts per team
  const settlements = await fetchAll<{
    team_id: string;
    delta_B: number;
    settled_at: string;
    trace_payload: Record<string, unknown> | null;
  }>("settlement_log", "team_id, delta_B, settled_at, trace_payload");

  // Group settlements by team
  const byTeam = new Map<string, typeof settlements>();
  for (const s of settlements) {
    if (!byTeam.has(s.team_id)) byTeam.set(s.team_id, []);
    byTeam.get(s.team_id)!.push(s);
  }

  console.log(`\n  Teams in oracle_state:          ${teamStates.length}`);
  console.log(`  Teams with settlements:         ${byTeam.size}`);

  let zeroWithSettlements = 0;
  let largeDeltas = 0;
  const issues: string[] = [];

  // Sort by B_value descending for display
  teamStates.sort((a, b) => Number(b.B_value) - Number(a.B_value));

  console.log(`\n  Team B Values (top 10 / bottom 10):\n`);
  console.log(`  ${"Team".padEnd(28)} ${"B_value".padStart(10)} ${"Matches".padStart(8)} ${"First".padStart(12)} ${"Last".padStart(12)}`);
  console.log(`  ${"─".repeat(72)}`);

  const displayTeams = [
    ...teamStates.slice(0, 10),
    ...(teamStates.length > 20 ? [null] : []), // separator
    ...teamStates.slice(-10),
  ];

  for (const team of displayTeams) {
    if (team === null) {
      console.log(`  ${"...".padEnd(28)}`);
      continue;
    }

    const teamSettlements = byTeam.get(team.team_id) ?? [];
    const validSettlements = teamSettlements.filter(
      s => s.trace_payload && !s.trace_payload.error
    );
    const dates = validSettlements.map(s => s.settled_at).sort();
    const first = dates[0]?.slice(0, 10) ?? "—";
    const last = dates[dates.length - 1]?.slice(0, 10) ?? "—";

    console.log(
      `  ${team.team_id.padEnd(28)} ${Number(team.B_value).toFixed(2).padStart(10)} ${validSettlements.length.toString().padStart(8)} ${first.padStart(12)} ${last.padStart(12)}`
    );

    // Check: B=0 but has settlements with real deltas
    if (Number(team.B_value) === 0 && validSettlements.length > 0) {
      const totalDelta = validSettlements.reduce((s, v) => s + Number(v.delta_B), 0);
      if (Math.abs(totalDelta) > 0.01) {
        zeroWithSettlements++;
        issues.push(`${team.team_id}: B=0 but ${validSettlements.length} settlements (sum ΔB=${totalDelta.toFixed(2)})`);
      }
    }

    // Check: any single delta_B exceeding ±25
    for (const s of validSettlements) {
      if (Math.abs(Number(s.delta_B)) > 25) {
        largeDeltas++;
        issues.push(`${team.team_id}: large ΔB=${Number(s.delta_B).toFixed(2)} in a single settlement`);
      }
    }
  }

  console.log();
  if (zeroWithSettlements === 0 && largeDeltas === 0) {
    console.log(`  ✅ PASS — All B values look healthy`);
  } else {
    if (zeroWithSettlements > 0) {
      console.log(`  ❌ FAIL — ${zeroWithSettlements} teams have B=0 despite having settlements (write failure?):`);
      for (const issue of issues.filter(i => i.includes("B=0"))) {
        console.log(`    ${issue}`);
      }
    }
    if (largeDeltas > 0) {
      console.log(`  ⚠️  WARN — ${largeDeltas} settlement(s) with |ΔB| > 25 (possible data issue):`);
      for (const issue of issues.filter(i => i.includes("large"))) {
        console.log(`    ${issue}`);
      }
    }
  }
}

// ─── Section 4: Reproducibility Spot-Check ──────────────────

async function checkReproducibility() {
  console.log("\n" + "═".repeat(70));
  console.log("  4. REPRODUCIBILITY SPOT-CHECK");
  console.log("═".repeat(70));

  // Get 5 most recently settled fixtures that have a valid trace
  const { data: recentSettlements, error: recentErr } = await sb
    .from("settlement_log")
    .select("settlement_id, fixture_id, team_id, E_KR, actual_score_S, delta_B, trace_payload")
    .not("trace_payload->>error", "is", null as unknown as string)  // skip failures... actually we want non-failures
    .order("settled_at", { ascending: false })
    .limit(50);

  if (recentErr) {
    console.log(`\n  ❌ ERROR — Could not load settlement_log: ${recentErr.message}`);
    return;
  }

  // Filter to settlements with valid trace_payload (no error field)
  const validSettlements = ((recentSettlements ?? []) as {
    settlement_id: number;
    fixture_id: number;
    team_id: string;
    E_KR: number;
    actual_score_S: number;
    delta_B: number;
    trace_payload: Record<string, unknown> | null;
  }[]).filter(s => s.trace_payload && !s.trace_payload.error);

  // Deduplicate by fixture_id, take first 5 unique
  const seenFixtures = new Set<number>();
  const spotChecks: typeof validSettlements = [];
  for (const s of validSettlements) {
    if (seenFixtures.has(s.fixture_id)) continue;
    seenFixtures.add(s.fixture_id);
    spotChecks.push(s);
    if (spotChecks.length >= 5) break;
  }

  if (spotChecks.length === 0) {
    console.log(`\n  ⚠️  WARN — No valid settlements found for spot-check`);
    return;
  }

  console.log(`\n  Checking ${spotChecks.length} most recently settled fixtures:\n`);

  let passCount = 0;
  let failCount = 0;

  for (const s of spotChecks) {
    const trace = s.trace_payload!;
    const K = (trace.K as number) ?? ORACLE_V1_K;
    const perspective = trace.perspective as string;

    // Recompute consensus from stored bookmaker data
    const bookmakers = (trace.bookmakers ?? []) as {
      bookmaker: string;
      homeProb: number;
      drawProb: number;
      awayProb: number;
    }[];

    if (bookmakers.length === 0) {
      console.log(`  fixture ${s.fixture_id} (${s.team_id}): ⚠️  SKIP — no bookmaker data in trace`);
      continue;
    }

    const n = bookmakers.length;
    const recomputedHomeProb = bookmakers.reduce((sum, b) => sum + b.homeProb, 0) / n;
    const recomputedDrawProb = bookmakers.reduce((sum, b) => sum + b.drawProb, 0) / n;
    const recomputedAwayProb = bookmakers.reduce((sum, b) => sum + b.awayProb, 0) / n;

    let E_KR_recomputed: number;
    if (perspective === "home") {
      E_KR_recomputed = recomputedHomeProb + 0.5 * recomputedDrawProb;
    } else {
      E_KR_recomputed = recomputedAwayProb + 0.5 * recomputedDrawProb;
    }

    const delta_B_recomputed = K * (Number(s.actual_score_S) - E_KR_recomputed);

    const storedDelta = Number(s.delta_B);
    const diff = Math.abs(delta_B_recomputed - storedDelta);
    const match = diff < 0.001; // allow tiny floating point difference

    if (match) {
      passCount++;
      console.log(
        `  fixture ${s.fixture_id} (${s.team_id.padEnd(22)}): ` +
        `✅ PASS  stored=${storedDelta.toFixed(4)}  recomputed=${delta_B_recomputed.toFixed(4)}  diff=${diff.toFixed(6)}`
      );
    } else {
      failCount++;
      console.log(
        `  fixture ${s.fixture_id} (${s.team_id.padEnd(22)}): ` +
        `❌ FAIL  stored=${storedDelta.toFixed(4)}  recomputed=${delta_B_recomputed.toFixed(4)}  diff=${diff.toFixed(6)}`
      );
    }
  }

  console.log();
  if (failCount === 0) {
    console.log(`  ✅ PASS — All ${passCount} spot-checks reproduced correctly`);
  } else {
    console.log(`  ❌ FAIL — ${failCount}/${spotChecks.length} spot-checks failed reproducibility`);
  }
}

// ─── Section 5: M1 Health ───────────────────────────────────

async function checkM1Health() {
  console.log("\n" + "═".repeat(70));
  console.log("  5. M1 MARKET LAYER HEALTH");
  console.log("═".repeat(70));

  // Load all team_oracle_state rows
  const teamStates = await fetchAll<{
    team_id: string;
    B_value: number;
    M1_value: number;
    published_index: number;
    confidence_score: number | null;
    next_fixture_id: number | null;
    last_market_refresh_ts: string | null;
  }>("team_oracle_state", "team_id, B_value, M1_value, published_index, confidence_score, next_fixture_id, last_market_refresh_ts");

  if (teamStates.length === 0) {
    console.log("\n  ⚠️  WARN — No teams in team_oracle_state. Run settlement + M1 refresh first.");
    return;
  }

  // Load all upcoming matches to check for missing next_fixture_id
  const upcomingMatches = await fetchAll<{
    fixture_id: number;
    home_team: string;
    away_team: string;
    date: string;
  }>("matches", "fixture_id, home_team, away_team, date", [
    { column: "status", op: "eq", value: "upcoming" },
  ]);

  // Build set of teams that have upcoming fixtures
  const teamsWithUpcoming = new Set<string>();
  for (const m of upcomingMatches) {
    teamsWithUpcoming.add(m.home_team);
    teamsWithUpcoming.add(m.away_team);
  }

  let indexMismatch = 0;
  let staleRefresh = 0;
  let missingNextFixture = 0;
  let withM1 = 0;
  let withoutM1 = 0;

  // Sort by published_index descending for display
  teamStates.sort((a, b) => Number(b.published_index) - Number(a.published_index));

  console.log(`\n  Teams in oracle_state: ${teamStates.length}`);
  console.log(`\n  ${"Team".padEnd(28)} ${"B".padStart(8)} ${"M1".padStart(8)} ${"Index".padStart(8)} ${"Conf".padStart(6)} ${"NextFix".padStart(9)} ${"Refreshed".padStart(20)}`);
  console.log(`  ${"─".repeat(89)}`);

  const displayTeams = [
    ...teamStates.slice(0, 10),
    ...(teamStates.length > 20 ? [null] : []),
    ...teamStates.slice(-10),
  ];

  for (const team of displayTeams) {
    if (team === null) {
      console.log(`  ${"...".padEnd(28)}`);
      continue;
    }

    const B = Number(team.B_value);
    const M1 = Number(team.M1_value);
    const idx = Number(team.published_index);
    const conf = team.confidence_score != null ? Number(team.confidence_score) : null;
    const refreshTs = team.last_market_refresh_ts
      ? team.last_market_refresh_ts.slice(0, 19).replace("T", " ")
      : "—";

    console.log(
      `  ${team.team_id.padEnd(28)} ${B.toFixed(2).padStart(8)} ${M1.toFixed(2).padStart(8)} ${idx.toFixed(2).padStart(8)} ${(conf != null ? conf.toFixed(3) : "—").padStart(6)} ${(team.next_fixture_id?.toString() ?? "—").padStart(9)} ${refreshTs.padStart(20)}`
    );

    if (Math.abs(M1) > 0.001) withM1++;
    else withoutM1++;

    // Check: published_index must equal B + M1
    const expectedIndex = B + M1;
    if (Math.abs(idx - expectedIndex) > 0.01) {
      indexMismatch++;
    }

    // Check: confidence > 0 but refresh older than 2 hours
    if (conf != null && conf > 0 && team.last_market_refresh_ts) {
      const refreshAge = (Date.now() - new Date(team.last_market_refresh_ts).getTime()) / (1000 * 3600);
      if (refreshAge > 2) {
        staleRefresh++;
      }
    }

    // Check: next_fixture_id is null but team has upcoming matches
    if (team.next_fixture_id == null && teamsWithUpcoming.has(team.team_id)) {
      missingNextFixture++;
    }
  }

  console.log(`\n  Teams with non-zero M1:    ${withM1}`);
  console.log(`  Teams with M1 = 0:         ${withoutM1}`);

  // Results
  console.log();
  let allPassed = true;

  if (indexMismatch > 0) {
    allPassed = false;
    console.log(`  ❌ FAIL — ${indexMismatch} teams have published_index ≠ B_value + M1_value (write bug)`);
  }
  if (staleRefresh > 0) {
    allPassed = false;
    console.log(`  ⚠️  WARN — ${staleRefresh} teams have confidence > 0 but last_market_refresh_ts is older than 2 hours`);
  }
  if (missingNextFixture > 0) {
    allPassed = false;
    console.log(`  ⚠️  WARN — ${missingNextFixture} teams have next_fixture_id = null but have upcoming matches in the matches table`);
  }
  if (allPassed) {
    console.log(`  ✅ PASS — All M1 values look healthy`);
  }
}

// ─── Section 6: Cycle Health ─────────────────────────────────

async function checkCycleHealth() {
  console.log("\n" + "═".repeat(70));
  console.log("  6. CYCLE HEALTH");
  console.log("═".repeat(70));

  // Load all team_oracle_state rows with updated_at + live match data
  const teamStates = await fetchAll<{
    team_id: string;
    B_value: number;
    M1_value: number;
    published_index: number;
    updated_at: string;
    last_market_refresh_ts: string | null;
  }>("team_oracle_state", "team_id, B_value, M1_value, published_index, updated_at, last_market_refresh_ts");

  if (teamStates.length === 0) {
    console.log("\n  ⚠️  WARN — No teams in team_oracle_state. Oracle V1 cycle has not run yet.");
    return;
  }

  // Find currently live matches → frozen teams
  const liveMatches = await fetchAll<{
    fixture_id: number;
    home_team: string;
    away_team: string;
  }>("matches", "fixture_id, home_team, away_team", [
    { column: "status", op: "eq", value: "live" },
  ]);

  const frozenTeams = new Set<string>();
  for (const m of liveMatches) {
    frozenTeams.add(m.home_team);
    frozenTeams.add(m.away_team);
  }

  // Last cycle timestamp — most recent updated_at across all teams
  const latestUpdate = teamStates
    .map(t => new Date(t.updated_at).getTime())
    .reduce((a, b) => Math.max(a, b), 0);

  const lastCycleAgo = (Date.now() - latestUpdate) / 1000;
  const lastCycleTs = new Date(latestUpdate).toISOString().slice(0, 19).replace("T", " ");

  console.log(`\n  Last cycle:                    ${lastCycleTs} (${lastCycleAgo.toFixed(0)}s ago)`);
  console.log(`  Total teams:                   ${teamStates.length}`);
  console.log(`  Currently frozen (live):       ${frozenTeams.size}`);

  if (frozenTeams.size > 0) {
    console.log(`  Frozen teams:`);
    for (const t of frozenTeams) {
      console.log(`    • ${t}`);
    }
  }

  // Teams with updated_at older than 10 minutes
  const staleThreshold = 10 * 60 * 1000; // 10 minutes
  const staleTeams = teamStates.filter(
    t => (Date.now() - new Date(t.updated_at).getTime()) > staleThreshold && !frozenTeams.has(t.team_id)
  );

  // Teams where published_index = B_value exactly (M1 effectively zero)
  const noM1Teams = teamStates.filter(
    t => Math.abs(Number(t.published_index) - Number(t.B_value)) < 0.001
  );

  console.log(`\n  Teams with M1 = 0 (index = B): ${noM1Teams.length}/${teamStates.length}`);

  // Results
  console.log();
  let allPassed = true;

  if (lastCycleAgo > 300) {
    // > 5 minutes since last cycle
    allPassed = false;
    console.log(`  ⚠️  WARN — Last cycle was ${(lastCycleAgo / 60).toFixed(1)} min ago (expected ≤ 1 min)`);
  }

  if (staleTeams.length > 0) {
    allPassed = false;
    console.log(`  ⚠️  WARN — ${staleTeams.length} non-frozen teams have updated_at older than 10 min:`);
    for (const t of staleTeams.slice(0, 10)) {
      const age = ((Date.now() - new Date(t.updated_at).getTime()) / 60000).toFixed(1);
      console.log(`    ${t.team_id.padEnd(28)} updated ${age} min ago`);
    }
    if (staleTeams.length > 10) {
      console.log(`    ... and ${staleTeams.length - 10} more`);
    }
  }

  if (frozenTeams.size > 10) {
    allPassed = false;
    console.log(`  ⚠️  WARN — ${frozenTeams.size} teams frozen (unusually high — more than 5 live matches?)`);
  }

  if (allPassed) {
    console.log(`  ✅ PASS — Cycle health looks good`);
  }
}

// ─── Section 7: Price History ────────────────────────────────

async function checkPriceHistory() {
  console.log("\n" + "═".repeat(70));
  console.log("  7. PRICE HISTORY");
  console.log("═".repeat(70));

  // Load all price history rows
  const priceHistory = await fetchAll<{
    team: string;
    league: string;
    timestamp: string;
    B_value: number;
    M1_value: number;
    published_index: number;
    publish_reason: string;
    source_fixture_id: number | null;
  }>("oracle_price_history", "team, league, timestamp, B_value, M1_value, published_index, publish_reason, source_fixture_id");

  if (priceHistory.length === 0) {
    console.log("\n  ⚠️  WARN — No rows in oracle_price_history. Settlement or bootstrap hasn't run yet.");
    return;
  }

  // Count by reason
  const byReason = new Map<string, number>();
  for (const row of priceHistory) {
    byReason.set(row.publish_reason, (byReason.get(row.publish_reason) ?? 0) + 1);
  }

  // Count distinct teams
  const distinctTeams = new Set(priceHistory.map(r => r.team));

  // Find time range
  const timestamps = priceHistory.map(r => new Date(r.timestamp).getTime());
  const earliest = new Date(Math.min(...timestamps)).toISOString().slice(0, 19);
  const latest = new Date(Math.max(...timestamps)).toISOString().slice(0, 19);

  console.log(`\n  Total price history rows:       ${priceHistory.length}`);
  console.log(`  Distinct teams:                 ${distinctTeams.size}`);
  console.log(`  Time range:                     ${earliest} → ${latest}`);
  console.log(`\n  By publish_reason:`);
  for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason.padEnd(22)} ${count}`);
  }

  // Check: every settled fixture should have 2 price history rows (home + away)
  const settlementRows = priceHistory.filter(r => r.publish_reason === "settlement");
  const settlementFixtures = new Map<number, number>();
  for (const row of settlementRows) {
    if (row.source_fixture_id != null) {
      settlementFixtures.set(
        row.source_fixture_id,
        (settlementFixtures.get(row.source_fixture_id) ?? 0) + 1
      );
    }
  }

  const partialSettlementPH = [...settlementFixtures.entries()].filter(([, count]) => count < 2);

  // Check: B_value + M1_value should equal published_index
  let indexMismatch = 0;
  for (const row of priceHistory) {
    const expected = Number(row.B_value) + Number(row.M1_value);
    if (Math.abs(Number(row.published_index) - expected) > 0.01) {
      indexMismatch++;
    }
  }

  // Results
  console.log();
  let allPassed = true;

  if (partialSettlementPH.length > 0) {
    allPassed = false;
    console.log(`  ⚠️  WARN — ${partialSettlementPH.length} fixtures have < 2 settlement price history entries:`);
    for (const [fid, count] of partialSettlementPH.slice(0, 5)) {
      console.log(`    fixture ${fid}: ${count} row(s)`);
    }
  }

  if (indexMismatch > 0) {
    allPassed = false;
    console.log(`  ❌ FAIL — ${indexMismatch} price history rows have published_index ≠ B_value + M1_value`);
  }

  if (allPassed) {
    console.log(`  ✅ PASS — Price history looks healthy`);
  }
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log("\n" + "═".repeat(70));
  console.log("  ORACLE V1 — VERIFICATION REPORT");
  console.log("  " + new Date().toISOString());
  console.log("═".repeat(70));

  const { settlements } = await checkCoverage();
  await checkKRHealth(settlements);
  await checkBValues();
  await checkReproducibility();
  await checkM1Health();
  await checkCycleHealth();
  await checkPriceHistory();

  console.log("\n" + "═".repeat(70));
  console.log("  VERIFICATION COMPLETE");
  console.log("═".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
