/**
 * oracle-v1-audit.ts — Comprehensive Oracle V1 pipeline diagnostic audit.
 *
 * Runs 5 diagnostic queries against Supabase to find all remaining silent failures:
 *   A. Categorize why each M1=0 team has M1=0
 *   B. Verify fixture_id → odds_snapshots mapping for every team
 *   C. Check odds coverage by league (bookmaker counts)
 *   D. List remaining stale fixtures (status=upcoming, date < today)
 *   E. Run refreshM1 manually for 5 teams with debug traces
 *
 * Usage:
 *   cd scheduler && npx tsx src/scripts/oracle-v1-audit.ts
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

const today = new Date().toISOString().slice(0, 10);

function hr(title: string) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(70)}\n`);
}

function subhr(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}\n`);
}

// ══════════════════════════════════════════════════════════════════════
// Query A: Categorize why each M1=0 team has M1=0
// ══════════════════════════════════════════════════════════════════════

async function queryA() {
  hr("QUERY A: M1=0 Teams — Root Cause Categorization");

  // Get all teams from team_oracle_state
  const { data: allTeams, error } = await sb
    .from("team_oracle_state")
    .select("team_id, b_value, m1_value, published_index, confidence_score, next_fixture_id, last_market_refresh_ts")
    .order("team_id");

  if (error) {
    console.error("ERROR fetching team_oracle_state:", error.message);
    return;
  }

  if (!allTeams || allTeams.length === 0) {
    console.log("No teams found in team_oracle_state!");
    return;
  }

  const zeroM1 = allTeams.filter((t: any) => Math.abs(Number(t.m1_value)) < 0.01);
  const nonZeroM1 = allTeams.filter((t: any) => Math.abs(Number(t.m1_value)) >= 0.01);

  console.log(`Total teams: ${allTeams.length}`);
  console.log(`Teams with M1≠0: ${nonZeroM1.length}`);
  console.log(`Teams with M1=0: ${zeroM1.length}`);

  if (zeroM1.length === 0) {
    console.log("\n✅ All teams have non-zero M1 — no issues found!");
    return;
  }

  // Categorize each M1=0 team
  const categories: Record<string, { team: string; detail: string }[]> = {
    "no_next_fixture": [],
    "no_odds_for_fixture": [],
    "fewer_than_2_bookmakers": [],
    "confidence_zero_other": [],
    "stale_refresh": [],
    "unknown": [],
  };

  for (const team of zeroM1) {
    const teamId = team.team_id as string;
    const nextFixId = team.next_fixture_id as number | null;
    const lastRefresh = team.last_market_refresh_ts as string | null;

    // Check 1: No next fixture
    if (!nextFixId) {
      // Why no next fixture? Check if any upcoming matches exist
      const { data: upcoming } = await sb
        .from("matches")
        .select("fixture_id, date, home_team, away_team, status")
        .or(`home_team.eq.${teamId},away_team.eq.${teamId}`)
        .eq("status", "upcoming")
        .gte("date", today)
        .order("date", { ascending: true })
        .limit(3);

      const upcomingCount = upcoming?.length ?? 0;
      if (upcomingCount === 0) {
        categories["no_next_fixture"].push({
          team: teamId,
          detail: `No upcoming fixtures after ${today}`,
        });
      } else {
        categories["no_next_fixture"].push({
          team: teamId,
          detail: `Has ${upcomingCount} upcoming fixtures but next_fixture_id is NULL (refresh may not have run)`,
        });
      }
      continue;
    }

    // Check 2: Odds available for this fixture?
    const { count: oddsCount } = await sb
      .from("odds_snapshots")
      .select("*", { count: "exact", head: true })
      .eq("fixture_id", nextFixId);

    if (!oddsCount || oddsCount === 0) {
      // Check alt fixtures (same match, different ID)
      const { data: matchInfo } = await sb
        .from("matches")
        .select("home_team, away_team, date")
        .eq("fixture_id", nextFixId)
        .single();

      let altInfo = "";
      if (matchInfo) {
        const dayBefore = new Date(new Date(matchInfo.date).getTime() - 86400000).toISOString().slice(0, 10);
        const dayAfter = new Date(new Date(matchInfo.date).getTime() + 86400000).toISOString().slice(0, 10);
        const { data: alts } = await sb
          .from("matches")
          .select("fixture_id")
          .eq("home_team", matchInfo.home_team)
          .eq("away_team", matchInfo.away_team)
          .gte("date", dayBefore)
          .lte("date", dayAfter)
          .neq("fixture_id", nextFixId);

        if (alts && alts.length > 0) {
          for (const alt of alts) {
            const { count: altOdds } = await sb
              .from("odds_snapshots")
              .select("*", { count: "exact", head: true })
              .eq("fixture_id", alt.fixture_id);
            altInfo += ` alt=${alt.fixture_id}(${altOdds ?? 0} odds)`;
          }
        }
      }

      categories["no_odds_for_fixture"].push({
        team: teamId,
        detail: `fixture=${nextFixId} has 0 odds snapshots.${altInfo ? " Alts:" + altInfo : " No alt fixtures found."}`,
      });
      continue;
    }

    // Check 3: How many unique bookmakers?
    const { data: bookmakers } = await sb
      .from("odds_snapshots")
      .select("bookmaker")
      .eq("fixture_id", nextFixId);

    const uniqueBooks = new Set((bookmakers ?? []).map((b: any) => b.bookmaker));
    if (uniqueBooks.size < 2) {
      categories["fewer_than_2_bookmakers"].push({
        team: teamId,
        detail: `fixture=${nextFixId} has ${uniqueBooks.size} bookmaker(s): [${[...uniqueBooks].join(", ")}]`,
      });
      continue;
    }

    // Check 4: Confidence is 0?
    const conf = Number(team.confidence_score);
    if (conf === 0 || conf < 0.001) {
      categories["confidence_zero_other"].push({
        team: teamId,
        detail: `fixture=${nextFixId}, ${uniqueBooks.size} bookmakers, ${oddsCount} snapshots, confidence=${conf} (check c_books×c_dispersion×c_recency×c_horizon)`,
      });
      continue;
    }

    // Check 5: Stale refresh (last refresh > 24h ago)?
    if (lastRefresh) {
      const hoursSinceRefresh = (Date.now() - new Date(lastRefresh).getTime()) / (3600 * 1000);
      if (hoursSinceRefresh > 24) {
        categories["stale_refresh"].push({
          team: teamId,
          detail: `Last refresh ${hoursSinceRefresh.toFixed(1)}h ago (${lastRefresh})`,
        });
        continue;
      }
    }

    // Unknown reason
    categories["unknown"].push({
      team: teamId,
      detail: `fixture=${nextFixId}, ${uniqueBooks.size} books, ${oddsCount} snaps, conf=${Number(team.confidence_score).toFixed(4)}, last_refresh=${lastRefresh}`,
    });
  }

  // Print categorized results
  for (const [category, teams] of Object.entries(categories)) {
    if (teams.length === 0) continue;
    subhr(`${category.toUpperCase()} (${teams.length} teams)`);
    for (const t of teams) {
      console.log(`  ${t.team}: ${t.detail}`);
    }
  }

  // Summary table
  subhr("SUMMARY");
  console.log(`  ${"Category".padEnd(30)} Count`);
  console.log(`  ${"─".repeat(30)} ${"─".repeat(5)}`);
  for (const [cat, teams] of Object.entries(categories)) {
    if (teams.length > 0) {
      console.log(`  ${cat.padEnd(30)} ${teams.length}`);
    }
  }
  console.log(`  ${"─".repeat(30)} ${"─".repeat(5)}`);
  console.log(`  ${"TOTAL M1=0".padEnd(30)} ${zeroM1.length}`);
}

// ══════════════════════════════════════════════════════════════════════
// Query B: Verify fixture_id → odds_snapshots mapping for every team
// ══════════════════════════════════════════════════════════════════════

async function queryB() {
  hr("QUERY B: Fixture → Odds Mapping Verification");

  const { data: allTeams } = await sb
    .from("team_oracle_state")
    .select("team_id, next_fixture_id, m1_value, confidence_score")
    .order("team_id");

  if (!allTeams) {
    console.error("Failed to fetch teams");
    return;
  }

  const teamsWithFixture = allTeams.filter((t: any) => t.next_fixture_id);
  console.log(`Teams with next_fixture_id: ${teamsWithFixture.length}/${allTeams.length}`);

  const results: {
    team: string;
    fixture_id: number;
    odds_count: number;
    unique_books: number;
    m1: number;
    has_fallback: boolean;
  }[] = [];

  for (const team of teamsWithFixture) {
    const fixtureId = team.next_fixture_id as number;

    // Count odds snapshots
    const { count: oddsCount } = await sb
      .from("odds_snapshots")
      .select("*", { count: "exact", head: true })
      .eq("fixture_id", fixtureId);

    // Count unique bookmakers
    const { data: books } = await sb
      .from("odds_snapshots")
      .select("bookmaker")
      .eq("fixture_id", fixtureId);

    const uniqueBooks = new Set((books ?? []).map((b: any) => b.bookmaker)).size;

    // Check if fallback was needed (match has another fixture ID)
    const { data: matchInfo } = await sb
      .from("matches")
      .select("home_team, away_team, date")
      .eq("fixture_id", fixtureId)
      .single();

    let hasFallback = false;
    if (matchInfo && oddsCount === 0) {
      const dayBefore = new Date(new Date(matchInfo.date).getTime() - 86400000).toISOString().slice(0, 10);
      const dayAfter = new Date(new Date(matchInfo.date).getTime() + 86400000).toISOString().slice(0, 10);
      const { data: alts } = await sb
        .from("matches")
        .select("fixture_id")
        .eq("home_team", matchInfo.home_team)
        .eq("away_team", matchInfo.away_team)
        .gte("date", dayBefore)
        .lte("date", dayAfter)
        .neq("fixture_id", fixtureId);

      if (alts && alts.length > 0) {
        hasFallback = true;
      }
    }

    results.push({
      team: team.team_id as string,
      fixture_id: fixtureId,
      odds_count: oddsCount ?? 0,
      unique_books: uniqueBooks,
      m1: Number(team.m1_value),
      has_fallback: hasFallback,
    });
  }

  // Print results grouped by status
  const noOdds = results.filter(r => r.odds_count === 0);
  const lowBooks = results.filter(r => r.odds_count > 0 && r.unique_books < 2);
  const good = results.filter(r => r.unique_books >= 2);

  if (noOdds.length > 0) {
    subhr(`NO ODDS (${noOdds.length} teams)`);
    console.log(`  ${"Team".padEnd(25)} ${"Fixture".padEnd(12)} ${"Fallback?".padEnd(12)} M1`);
    for (const r of noOdds) {
      console.log(`  ${r.team.padEnd(25)} ${String(r.fixture_id).padEnd(12)} ${(r.has_fallback ? "YES" : "no").padEnd(12)} ${r.m1.toFixed(2)}`);
    }
  }

  if (lowBooks.length > 0) {
    subhr(`LOW BOOKMAKERS <2 (${lowBooks.length} teams)`);
    console.log(`  ${"Team".padEnd(25)} ${"Fixture".padEnd(12)} ${"Books".padEnd(8)} ${"Odds".padEnd(8)} M1`);
    for (const r of lowBooks) {
      console.log(`  ${r.team.padEnd(25)} ${String(r.fixture_id).padEnd(12)} ${String(r.unique_books).padEnd(8)} ${String(r.odds_count).padEnd(8)} ${r.m1.toFixed(2)}`);
    }
  }

  subhr(`HEALTHY (${good.length} teams)`);
  console.log(`  ${"Team".padEnd(25)} ${"Fixture".padEnd(12)} ${"Books".padEnd(8)} ${"Odds".padEnd(8)} M1`);
  for (const r of good.sort((a, b) => b.unique_books - a.unique_books).slice(0, 20)) {
    console.log(`  ${r.team.padEnd(25)} ${String(r.fixture_id).padEnd(12)} ${String(r.unique_books).padEnd(8)} ${String(r.odds_count).padEnd(8)} ${r.m1.toFixed(2)}`);
  }
  if (good.length > 20) {
    console.log(`  ... and ${good.length - 20} more healthy teams`);
  }

  subhr("SUMMARY");
  console.log(`  No odds:        ${noOdds.length} teams`);
  console.log(`  <2 bookmakers:  ${lowBooks.length} teams`);
  console.log(`  Healthy (≥2):   ${good.length} teams`);
}

// ══════════════════════════════════════════════════════════════════════
// Query C: Check odds coverage by league (bookmaker counts)
// ══════════════════════════════════════════════════════════════════════

async function queryC() {
  hr("QUERY C: Odds Coverage by League");

  // Get all upcoming fixtures grouped by league
  const { data: upcomingMatches } = await sb
    .from("matches")
    .select("fixture_id, league, home_team, away_team, date, commence_time, status")
    .eq("status", "upcoming")
    .gte("date", today)
    .order("date", { ascending: true });

  if (!upcomingMatches || upcomingMatches.length === 0) {
    console.log("No upcoming matches found!");
    return;
  }

  // Group by league
  const byLeague = new Map<string, typeof upcomingMatches>();
  for (const m of upcomingMatches) {
    const league = m.league as string;
    if (!byLeague.has(league)) byLeague.set(league, []);
    byLeague.get(league)!.push(m);
  }

  for (const [league, matches] of byLeague) {
    subhr(`${league} (${matches.length} upcoming fixtures)`);

    // Sample first 10 fixtures
    const sample = matches.slice(0, 10);
    console.log(`  ${"Fixture".padEnd(12)} ${"Date".padEnd(12)} ${"Match".padEnd(40)} ${"Odds".padEnd(8)} Books`);

    for (const m of sample) {
      const matchStr = `${m.home_team} vs ${m.away_team}`;

      // Count odds
      const { count: oddsCount } = await sb
        .from("odds_snapshots")
        .select("*", { count: "exact", head: true })
        .eq("fixture_id", m.fixture_id);

      // Count unique bookmakers
      let bookCount = 0;
      if (oddsCount && oddsCount > 0) {
        const { data: books } = await sb
          .from("odds_snapshots")
          .select("bookmaker")
          .eq("fixture_id", m.fixture_id);
        bookCount = new Set((books ?? []).map((b: any) => b.bookmaker)).size;
      }

      const flag = oddsCount === 0 ? " ⚠️" : bookCount < 3 ? " ⚡" : "";
      console.log(`  ${String(m.fixture_id).padEnd(12)} ${(m.date as string).padEnd(12)} ${matchStr.padEnd(40)} ${String(oddsCount ?? 0).padEnd(8)} ${bookCount}${flag}`);
    }

    if (matches.length > 10) {
      console.log(`  ... and ${matches.length - 10} more fixtures`);
    }
  }

  // Overall stats
  subhr("OVERALL STATS");
  let totalFixtures = 0;
  let totalWithOdds = 0;
  let totalWithout = 0;

  for (const [league, matches] of byLeague) {
    let withOdds = 0;
    let without = 0;

    for (const m of matches) {
      const { count } = await sb
        .from("odds_snapshots")
        .select("*", { count: "exact", head: true })
        .eq("fixture_id", m.fixture_id);

      if (count && count > 0) {
        withOdds++;
      } else {
        without++;
      }
    }

    totalFixtures += matches.length;
    totalWithOdds += withOdds;
    totalWithout += without;

    console.log(`  ${league.padEnd(20)} ${matches.length} fixtures: ${withOdds} with odds, ${without} without`);
  }
  console.log(`  ${"─".repeat(65)}`);
  console.log(`  ${"TOTAL".padEnd(20)} ${totalFixtures} fixtures: ${totalWithOdds} with odds, ${totalWithout} without`);
}

// ══════════════════════════════════════════════════════════════════════
// Query D: List remaining stale fixtures (status=upcoming, date < today)
// ══════════════════════════════════════════════════════════════════════

async function queryD() {
  hr("QUERY D: Stale Fixtures (status=upcoming, date < today)");

  const { data: staleFixtures, error } = await sb
    .from("matches")
    .select("fixture_id, league, home_team, away_team, date, commence_time, status")
    .eq("status", "upcoming")
    .lt("date", today)
    .order("date", { ascending: true });

  if (error) {
    console.error("ERROR:", error.message);
    return;
  }

  if (!staleFixtures || staleFixtures.length === 0) {
    console.log("✅ No stale fixtures found — all upcoming fixtures have date >= today.");
    return;
  }

  console.log(`⚠️  Found ${staleFixtures.length} stale fixtures (status=upcoming but date < ${today}):\n`);

  // Group by league
  const byLeague = new Map<string, typeof staleFixtures>();
  for (const m of staleFixtures) {
    const league = m.league as string;
    if (!byLeague.has(league)) byLeague.set(league, []);
    byLeague.get(league)!.push(m);
  }

  for (const [league, matches] of byLeague) {
    subhr(`${league} (${matches.length} stale)`);
    console.log(`  ${"Fixture".padEnd(12)} ${"Date".padEnd(12)} Match`);
    for (const m of matches.slice(0, 20)) {
      console.log(`  ${String(m.fixture_id).padEnd(12)} ${(m.date as string).padEnd(12)} ${m.home_team} vs ${m.away_team}`);
    }
    if (matches.length > 20) {
      console.log(`  ... and ${matches.length - 20} more`);
    }
  }

  subhr("ACTION NEEDED");
  console.log(`  These ${staleFixtures.length} fixtures should be updated to 'completed'/'cancelled'`);
  console.log(`  or their date should be corrected in the matches table.`);
  console.log(`  The .gte("date", today) filter in refreshM1 excludes them, but they're data dirt.`);
}

// ══════════════════════════════════════════════════════════════════════
// Query E: Run refreshM1 manually for 5 teams with debug traces
// ══════════════════════════════════════════════════════════════════════

async function queryE() {
  hr("QUERY E: Manual refreshM1 Trace for 5 Sample Teams");

  // Pick 5 diverse teams: 1 per league, prioritize teams that should have M1≠0
  const sampleTeams = [
    "Arsenal",          // EPL
    "Barcelona",        // La Liga
    "Bayern Munich",    // Bundesliga
    "Inter Milan",      // Serie A
    "Paris Saint Germain", // Ligue 1
  ];

  for (const team of sampleTeams) {
    subhr(`TRACE: ${team}`);

    // Step 1: Check team_oracle_state
    const { data: state } = await sb
      .from("team_oracle_state")
      .select("*")
      .eq("team_id", team)
      .single();

    if (!state) {
      console.log(`  ❌ Team "${team}" not found in team_oracle_state!`);
      continue;
    }

    console.log(`  State: B=${Number(state.b_value).toFixed(1)}, M1=${Number(state.m1_value).toFixed(2)}, idx=${Number(state.published_index).toFixed(2)}, conf=${Number(state.confidence_score).toFixed(4)}`);
    console.log(`  next_fixture_id=${state.next_fixture_id}, last_refresh=${state.last_market_refresh_ts}`);

    // Step 2: Check for live match
    const { data: liveMatches } = await sb
      .from("matches")
      .select("fixture_id, status")
      .or(`home_team.eq.${team},away_team.eq.${team}`)
      .eq("status", "live");

    if (liveMatches && liveMatches.length > 0) {
      console.log(`  ⚠️  Live match detected: fixture ${liveMatches[0].fixture_id} — M1 refresh would skip`);
      continue;
    }
    console.log(`  ✓ No live match`);

    // Step 3: Find next fixture
    const { data: nextFixtures } = await sb
      .from("matches")
      .select("fixture_id, date, home_team, away_team, commence_time")
      .or(`home_team.eq.${team},away_team.eq.${team}`)
      .eq("status", "upcoming")
      .gte("date", today)
      .order("date", { ascending: true })
      .order("commence_time", { ascending: true, nullsFirst: true })
      .limit(3);

    if (!nextFixtures || nextFixtures.length === 0) {
      console.log(`  ❌ No upcoming fixtures after ${today}`);
      continue;
    }

    const nf = nextFixtures[0] as any;
    const isHome = nf.home_team === team;
    const opponent = isHome ? nf.away_team : nf.home_team;
    const kickoffTs = nf.commence_time ?? `${nf.date}T23:59:59Z`;

    console.log(`  ✓ Next fixture: ${nf.fixture_id} — ${nf.home_team} vs ${nf.away_team} (${nf.date})`);
    console.log(`    commence_time=${nf.commence_time ?? "NULL"}, kickoffTs=${kickoffTs}`);
    console.log(`    Team is ${isHome ? "HOME" : "AWAY"} vs ${opponent}`);

    if (nextFixtures.length > 1) {
      console.log(`    (${nextFixtures.length - 1} more upcoming fixtures after this one)`);
    }

    // Step 4: Check odds for this fixture
    const { data: oddsData } = await sb
      .from("odds_snapshots")
      .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
      .eq("fixture_id", nf.fixture_id)
      .lt("snapshot_time", kickoffTs)
      .order("snapshot_time", { ascending: false });

    let allSnapshots = (oddsData ?? []);

    // Check fallback
    if (allSnapshots.length === 0) {
      console.log(`  ⚠️  Primary fixture ${nf.fixture_id} has 0 odds — checking fallback...`);

      const matchDate = nf.date;
      const dayBefore = new Date(new Date(matchDate).getTime() - 86400000).toISOString().slice(0, 10);
      const dayAfter = new Date(new Date(matchDate).getTime() + 86400000).toISOString().slice(0, 10);

      const { data: altFixtures } = await sb
        .from("matches")
        .select("fixture_id")
        .eq("home_team", nf.home_team)
        .eq("away_team", nf.away_team)
        .gte("date", dayBefore)
        .lte("date", dayAfter)
        .neq("fixture_id", nf.fixture_id);

      if (altFixtures && altFixtures.length > 0) {
        const altId = altFixtures[0].fixture_id;
        console.log(`    Found alt fixture: ${altId}`);

        const { data: altOdds } = await sb
          .from("odds_snapshots")
          .select("fixture_id, bookmaker, home_odds, draw_odds, away_odds, snapshot_time")
          .eq("fixture_id", altId)
          .lt("snapshot_time", kickoffTs)
          .order("snapshot_time", { ascending: false });

        if (altOdds && altOdds.length > 0) {
          allSnapshots = altOdds;
          console.log(`    ✓ Alt fixture ${altId} has ${altOdds.length} odds snapshots`);
        } else {
          console.log(`    ❌ Alt fixture ${altId} also has 0 odds`);
        }
      } else {
        console.log(`    ❌ No alt fixtures found`);
      }
    } else {
      console.log(`  ✓ Odds: ${allSnapshots.length} snapshots for fixture ${nf.fixture_id}`);
    }

    // Step 5: De-dup by bookmaker (latest per book)
    const latestByBook = new Map<string, any>();
    for (const snap of allSnapshots) {
      if (latestByBook.has(snap.bookmaker)) continue;
      if (snap.home_odds == null || snap.draw_odds == null || snap.away_odds == null) continue;
      if (snap.home_odds < 1.01 || snap.draw_odds < 1.01 || snap.away_odds < 1.01) continue;
      latestByBook.set(snap.bookmaker, snap);
    }

    console.log(`  ✓ Valid bookmakers: ${latestByBook.size} (after filtering nulls and <1.01)`);
    for (const [book, snap] of latestByBook) {
      console.log(`    ${book.padEnd(20)} H=${Number(snap.home_odds).toFixed(2)} D=${Number(snap.draw_odds).toFixed(2)} A=${Number(snap.away_odds).toFixed(2)} (${snap.snapshot_time})`);
    }

    if (latestByBook.size < 2) {
      console.log(`  ❌ Fewer than 2 bookmakers — M1 would be 0`);
      continue;
    }

    // Step 6: Compute confidence components
    const c_books = Math.min(latestByBook.size / 5, 1);

    // Win probs for dispersion (simplified — just use 1/odds normalized)
    const teamWinProbs: number[] = [];
    for (const [, snap] of latestByBook) {
      const h = 1 / snap.home_odds;
      const d = 1 / snap.draw_odds;
      const a = 1 / snap.away_odds;
      const total = h + d + a;
      teamWinProbs.push(isHome ? h / total : a / total);
    }
    const spread = Math.max(...teamWinProbs) - Math.min(...teamWinProbs);
    const c_dispersion = 1 - Math.min(spread / 0.08, 1);

    // Recency
    const latestTime = Math.max(
      ...Array.from(latestByBook.values()).map((s: any) => new Date(s.snapshot_time).getTime())
    );
    const hoursSince = (Date.now() - latestTime) / (3600 * 1000);
    const c_recency = 1 - Math.min(hoursSince / 48, 1);

    // Horizon
    const HORIZON_DAYS = 21;
    const kickoffMs = new Date(kickoffTs).getTime();
    let c_horizon = 1.0;
    if (isNaN(kickoffMs)) {
      c_horizon = 0;
    } else {
      const daysToKickoff = Math.max(0, (kickoffMs - Date.now()) / (24 * 3600 * 1000));
      c_horizon = Math.max(0, Math.min(1, 1 - daysToKickoff / HORIZON_DAYS));
    }

    const confidence = c_books * c_dispersion * c_recency;
    const eff_conf = confidence * c_horizon;

    console.log(`  Confidence components:`);
    console.log(`    c_books      = ${c_books.toFixed(4)} (${latestByBook.size} books / 5)`);
    console.log(`    c_dispersion = ${c_dispersion.toFixed(4)} (spread=${spread.toFixed(4)})`);
    console.log(`    c_recency    = ${c_recency.toFixed(4)} (${hoursSince.toFixed(1)}h since latest)`);
    console.log(`    c_horizon    = ${c_horizon.toFixed(4)} (kickoff=${kickoffTs})`);
    console.log(`    confidence   = ${confidence.toFixed(4)}`);
    console.log(`    eff_conf     = ${eff_conf.toFixed(4)}`);

    // Step 7: Expected M1
    const B = Number(state.b_value);

    // Get opponent B
    const { data: oppState } = await sb
      .from("team_oracle_state")
      .select("b_value")
      .eq("team_id", opponent)
      .single();

    const oppB = oppState ? Number(oppState.b_value) : 0;

    // Simple Elo implied strength (using median win prob)
    const medWinProb = teamWinProbs.sort((a, b) => a - b)[Math.floor(teamWinProbs.length / 2)];
    const expectedScore = medWinProb + 0.5 * (1 - medWinProb - (1 - medWinProb) * 0.3); // rough approx
    // For a proper estimate, use the Elo formula: E = 1/(1+10^((Rb-Ra)/400))
    // R_market = oppB + 400*log10(E/(1-E)) + (isHome ? 65 : -65)
    const teamExpScore = medWinProb + 0.15; // rough: add half-draw
    const clampedE = Math.max(0.01, Math.min(0.99, teamExpScore));
    const R_market_approx = oppB + 400 * Math.log10(clampedE / (1 - clampedE)) + (isHome ? 65 : -65);

    const M1_raw = R_market_approx - B;
    const M1_clamped = Math.max(-120, Math.min(120, eff_conf * M1_raw));

    console.log(`  Elo computation (approximate):`);
    console.log(`    B_value     = ${B.toFixed(1)}`);
    console.log(`    opponent_B  = ${oppB.toFixed(1)} (${opponent})`);
    console.log(`    medWinProb  = ${medWinProb.toFixed(4)}`);
    console.log(`    R_market    ≈ ${R_market_approx.toFixed(1)}`);
    console.log(`    M1_raw      = ${M1_raw.toFixed(2)}`);
    console.log(`    M1 (clamped)= ${M1_clamped.toFixed(2)}`);
    console.log(`    pub_index   ≈ ${(B + M1_clamped).toFixed(2)}`);

    // Compare with stored values
    const storedM1 = Number(state.m1_value);
    const diff = Math.abs(storedM1 - M1_clamped);
    if (diff > 5) {
      console.log(`  ⚠️  Stored M1=${storedM1.toFixed(2)} differs from computed ≈${M1_clamped.toFixed(2)} by ${diff.toFixed(2)} (approximate — power devig vs basic devig)`);
    } else {
      console.log(`  ✓ Stored M1=${storedM1.toFixed(2)} is close to computed ≈${M1_clamped.toFixed(2)}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║            ORACLE V1 PIPELINE DIAGNOSTIC AUDIT                     ║");
  console.log("║            " + new Date().toISOString() + "                      ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");

  await queryA();
  await queryB();
  await queryC();
  await queryD();
  await queryE();

  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║            AUDIT COMPLETE                                           ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
