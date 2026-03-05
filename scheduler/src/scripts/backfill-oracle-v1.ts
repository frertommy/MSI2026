/**
 * backfill-oracle-v1.ts — One-time V1 Oracle initialization.
 *
 * Phase 1: Seed B_value from legacy pre-season Elo (team_prices.implied_elo
 *          or legacy MSI JSON). Clamp to [1300, 1700].
 * Phase 2: Replay all finished current-season matches through settleFixture().
 * Phase 3: Print summary.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-oracle-v1.ts              # dry-run
 *   npx tsx src/scripts/backfill-oracle-v1.ts --force       # execute (overwrites existing state)
 *   npx tsx src/scripts/backfill-oracle-v1.ts --dry-run     # explicit dry-run
 *
 * This script does NOT reimplement settlement math. It calls settleFixture()
 * from oracle-v1-settlement.ts for every match.
 */
import "dotenv/config";
import { getSupabase } from "../api/supabase-client.js";
import { settleFixture } from "../services/oracle-v1-settlement.js";
import { ORACLE_V1_BASELINE_ELO, ORACLE_V1_SETTLEMENT_START_DATE } from "../config.js";

// ─── CLI flags ──────────────────────────────────────────────
const FORCE = process.argv.includes("--force");
const DRY_RUN = process.argv.includes("--dry-run") || (!FORCE && !process.argv.includes("--execute"));

// ─── Constants ──────────────────────────────────────────────
const SEED_CLAMP_MIN = 1300;
const SEED_CLAMP_MAX = 2100;
const SEASON = "2025-26";

const LEGACY_URL = "https://raw.githubusercontent.com/frertommy/MSI/main/data/msi_daily.json";

// API-Football name → legacy MSI JSON name
const LEGACY_NAME_MAP: Record<string, string> = {
  "1. FC Heidenheim": "1. FC Heidenheim 1846",
  "1899 Hoffenheim": "TSG 1899 Hoffenheim",
  "Alaves": "Deportivo Alavés",
  "Angers": "Angers SCO",
  "Arsenal": "Arsenal FC",
  "Aston Villa": "Aston Villa FC",
  "Atalanta": "Atalanta BC",
  "Atletico Madrid": "Club Atlético de Madrid",
  "Auxerre": "AJ Auxerre",
  "Barcelona": "FC Barcelona",
  "Bayer Leverkusen": "Bayer 04 Leverkusen",
  "Bayern München": "FC Bayern München",
  "Bologna": "Bologna FC 1909",
  "Bournemouth": "AFC Bournemouth",
  "Brentford": "Brentford FC",
  "Brighton": "Brighton & Hove Albion FC",
  "Burnley": "Burnley FC",
  "Cagliari": "Cagliari Calcio",
  "Celta Vigo": "RC Celta de Vigo",
  "Chelsea": "Chelsea FC",
  "Como": "Como 1907",
  "Crystal Palace": "Crystal Palace FC",
  "Espanyol": "RCD Espanyol de Barcelona",
  "Everton": "Everton FC",
  "FC St. Pauli": "FC St. Pauli 1910",
  "FSV Mainz 05": "1. FSV Mainz 05",
  "Fiorentina": "ACF Fiorentina",
  "Fulham": "Fulham FC",
  "Genoa": "Genoa CFC",
  "Getafe": "Getafe CF",
  "Girona": "Girona FC",
  "Hellas Verona": "Hellas Verona FC",
  "Inter": "FC Internazionale Milano",
  "Juventus": "Juventus FC",
  "Lazio": "SS Lazio",
  "Le Havre": "Le Havre AC",
  "Lecce": "US Lecce",
  "Lens": "Racing Club de Lens",
  "Levante": "Levante UD",
  "Lille": "Lille OSC",
  "Liverpool": "Liverpool FC",
  "Lorient": "FC Lorient",
  "Lyon": "Olympique Lyonnais",
  "Mallorca": "RCD Mallorca",
  "Manchester City": "Manchester City FC",
  "Manchester United": "Manchester United FC",
  "Marseille": "Olympique de Marseille",
  "Metz": "FC Metz",
  "Monaco": "AS Monaco FC",
  "Nantes": "FC Nantes",
  "Napoli": "SSC Napoli",
  "Newcastle": "Newcastle United FC",
  "Nice": "OGC Nice",
  "Nottingham Forest": "Nottingham Forest FC",
  "Osasuna": "CA Osasuna",
  "Paris Saint Germain": "Paris Saint-Germain FC",
  "Parma": "Parma Calcio 1913",
  "Pisa": "AC Pisa 1909",
  "Rayo Vallecano": "Rayo Vallecano de Madrid",
  "Real Betis": "Real Betis Balompié",
  "Real Madrid": "Real Madrid CF",
  "Real Sociedad": "Real Sociedad de Fútbol",
  "Rennes": "Stade Rennais FC 1901",
  "Sassuolo": "US Sassuolo Calcio",
  "Sevilla": "Sevilla CF",
  "Strasbourg": "RC Strasbourg Alsace",
  "Sunderland": "Sunderland AFC",
  "Torino": "Torino FC",
  "Tottenham": "Tottenham Hotspur FC",
  "Toulouse": "Toulouse FC",
  "Udinese": "Udinese Calcio",
  "Union Berlin": "1. FC Union Berlin",
  "Valencia": "Valencia CF",
  "Villarreal": "Villarreal CF",
  "Werder Bremen": "SV Werder Bremen",
  "West Ham": "West Ham United FC",
  "Wolves": "Wolverhampton Wanderers FC",
};

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const sb = getSupabase();

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  ORACLE V1 — BACKFILL (LEGACY SEED + SEASON REPLAY)");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY-RUN" : FORCE ? "FORCE (overwrite)" : "EXECUTE"}`);
  console.log("══════════════════════════════════════════════════════════════\n");

  // ═════════════════════════════════════════════════════════════
  // PHASE 0 — SAFETY CHECKS / DISCOVERY
  // ═════════════════════════════════════════════════════════════

  console.log("[Phase 0] Safety checks & discovery\n");

  // A) Active 2025-26 team universe
  const teamLeagueMap = new Map<string, string>(); // team → league
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("home_team, away_team, league")
      .gte("date", ORACLE_V1_SETTLEMENT_START_DATE)
      .lt("fixture_id", 9000000)
      .range(from, from + pageSize - 1);

    if (error) { console.error("  ERROR loading matches:", error.message); process.exit(1); }
    if (!data || data.length === 0) break;

    for (const m of data) {
      if (!teamLeagueMap.has(m.home_team)) teamLeagueMap.set(m.home_team, m.league);
      if (!teamLeagueMap.has(m.away_team)) teamLeagueMap.set(m.away_team, m.league);
    }

    if (data.length < pageSize) break;
    from += pageSize;
  }

  const activeTeams = [...teamLeagueMap.keys()].sort();
  console.log(`  Active 2025-26 teams: ${activeTeams.length}`);

  // B) Detect existing meaningful V1 state
  const { data: existingSettlements } = await sb
    .from("settlement_log")
    .select("settlement_id, delta_b")
    .neq("delta_b", 0)
    .limit(5);

  const { data: existingKR } = await sb
    .from("team_oracle_state")
    .select("team_id")
    .not("last_kr_fixture_id", "is", null)
    .limit(5);

  const hasExistingState =
    (existingSettlements && existingSettlements.length > 0) ||
    (existingKR && existingKR.length > 0);

  if (hasExistingState) {
    console.log(`  ⚠️  Existing V1 state detected:`);
    console.log(`     settlement_log entries with delta_B≠0: ${existingSettlements?.length ?? 0}+`);
    console.log(`     team_oracle_state with last_kr_fixture_id: ${existingKR?.length ?? 0}+`);

    if (!FORCE && !DRY_RUN) {
      console.error("\n  ❌ Aborting — use --force to overwrite existing V1 state.\n");
      process.exit(1);
    }
    if (FORCE) {
      console.log("     --force specified, will wipe and reseed.\n");
    }
  } else {
    console.log("  No existing meaningful V1 state detected.\n");
  }

  // ═════════════════════════════════════════════════════════════
  // PHASE 0.5 — FORCE CLEANUP (if --force)
  // ═════════════════════════════════════════════════════════════

  if (FORCE && !DRY_RUN) {
    console.log("[Phase 0.5] Force cleanup — wiping existing V1 state\n");

    // Get all current-season fixture_ids
    const seasonFixtures: number[] = [];
    let fFrom = 0;
    while (true) {
      const { data } = await sb
        .from("matches")
        .select("fixture_id")
        .gte("date", ORACLE_V1_SETTLEMENT_START_DATE)
        .range(fFrom, fFrom + pageSize - 1);

      if (!data || data.length === 0) break;
      seasonFixtures.push(...data.map(r => r.fixture_id));
      if (data.length < pageSize) break;
      fFrom += pageSize;
    }

    // Delete settlement_log for current-season fixtures (in batches)
    let slDeleted = 0;
    for (let i = 0; i < seasonFixtures.length; i += 500) {
      const batch = seasonFixtures.slice(i, i + 500);
      const { error } = await sb.from("settlement_log").delete().in("fixture_id", batch);
      if (error) console.warn(`  settlement_log delete error: ${error.message}`);
      else slDeleted += batch.length;
    }
    console.log(`  Deleted settlement_log entries for ${seasonFixtures.length} fixtures`);

    // Delete oracle_kr_snapshots for current-season fixtures
    for (let i = 0; i < seasonFixtures.length; i += 500) {
      const batch = seasonFixtures.slice(i, i + 500);
      await sb.from("oracle_kr_snapshots").delete().in("fixture_id", batch);
    }
    console.log(`  Deleted oracle_kr_snapshots for ${seasonFixtures.length} fixtures`);

    // Delete all oracle_price_history (settlement + bootstrap rows)
    const { error: phDelErr } = await sb.from("oracle_price_history").delete().neq("id", 0);
    if (phDelErr) console.warn(`  oracle_price_history delete error: ${phDelErr.message}`);
    else console.log("  Deleted all oracle_price_history rows");

    // Delete all team_oracle_state rows (will be re-seeded)
    const { error: tosDelErr } = await sb.from("team_oracle_state").delete().neq("team_id", "");
    if (tosDelErr) console.warn(`  team_oracle_state delete error: ${tosDelErr.message}`);
    else console.log("  Deleted all team_oracle_state rows");

    console.log("");
  }

  // ═════════════════════════════════════════════════════════════
  // PHASE 1 — SEED B FROM LEGACY PRE-SEASON PRIOR
  // ═════════════════════════════════════════════════════════════

  console.log("[Phase 1] Seeding B_value from legacy pre-season prior\n");
  console.log("  Seed source: team_prices.implied_elo (post-blend, fallback to legacy JSON)\n");

  // Source 1: team_prices.implied_elo — latest row per team before 2025-08-01
  // We query the max date per team, then get the implied_elo for that date.
  // Simpler approach: query all team_prices before cutoff ordered by date desc, dedupe by team.
  const preSeedMap = new Map<string, { elo: number; date: string }>();

  let tpFrom = 0;
  while (true) {
    const { data, error } = await sb
      .from("team_prices")
      .select("team, date, implied_elo")
      .eq("model", "oracle")
      .lt("date", ORACLE_V1_SETTLEMENT_START_DATE)
      .order("date", { ascending: false })
      .range(tpFrom, tpFrom + pageSize - 1);

    if (error) { console.warn("  team_prices query error:", error.message); break; }
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (!preSeedMap.has(row.team)) {
        preSeedMap.set(row.team, { elo: Number(row.implied_elo), date: row.date });
      }
    }

    if (data.length < pageSize) break;
    tpFrom += pageSize;
  }

  console.log(`  team_prices pre-season seeds available: ${preSeedMap.size}`);

  // Source 2: Legacy MSI JSON (fallback)
  let legacyElos = new Map<string, number>();
  try {
    const resp = await fetch(LEGACY_URL);
    if (resp.ok) {
      const data = (await resp.json()) as Record<string, { date: string; rating: number }[]>;
      for (const [legacyName, entries] of Object.entries(data)) {
        if (!entries || entries.length === 0) continue;
        const preSeason = entries.filter(e => e.date < ORACLE_V1_SETTLEMENT_START_DATE);
        if (preSeason.length > 0) {
          legacyElos.set(legacyName, preSeason[preSeason.length - 1].rating);
        }
      }
      console.log(`  Legacy MSI JSON seeds available: ${legacyElos.size}`);
    }
  } catch {
    console.warn("  Legacy MSI JSON fetch failed — using fallback only");
  }

  // Build seed assignments
  interface SeedInfo {
    team: string;
    league: string;
    seedValue: number;
    source: "team_prices" | "legacy_json" | "legacy_json_clamped" | "team_prices_clamped" | "baseline_fallback";
    sourceDate: string | null;
    rawValue: number;
  }

  const seeds: SeedInfo[] = [];

  for (const team of activeTeams) {
    const league = teamLeagueMap.get(team)!;
    let rawValue: number | null = null;
    let source: SeedInfo["source"] = "baseline_fallback";
    let sourceDate: string | null = null;

    // Try team_prices first
    const tpSeed = preSeedMap.get(team);
    if (tpSeed) {
      rawValue = tpSeed.elo;
      source = "team_prices";
      sourceDate = tpSeed.date;
    }

    // Fallback: legacy JSON
    if (rawValue === null) {
      const legacyName = LEGACY_NAME_MAP[team] || team;
      const legacyElo = legacyElos.get(legacyName);
      if (legacyElo !== undefined) {
        rawValue = legacyElo;
        source = "legacy_json";
        sourceDate = "pre-2025-08-01";
      }
    }

    // Ultimate fallback
    if (rawValue === null) {
      rawValue = ORACLE_V1_BASELINE_ELO;
      source = "baseline_fallback";
    }

    // Clamp
    const clamped = Math.max(SEED_CLAMP_MIN, Math.min(SEED_CLAMP_MAX, rawValue));
    if (clamped !== rawValue) {
      if (source === "team_prices") source = "team_prices_clamped";
      else if (source === "legacy_json") source = "legacy_json_clamped";
    }

    seeds.push({
      team,
      league,
      seedValue: Math.round(clamped * 10) / 10,
      source,
      sourceDate,
      rawValue: Math.round(rawValue * 10) / 10,
    });
  }

  // Seed stats
  const sourceStats = new Map<string, number>();
  for (const s of seeds) {
    sourceStats.set(s.source, (sourceStats.get(s.source) ?? 0) + 1);
  }

  console.log("\n  Seed source breakdown:");
  for (const [src, count] of [...sourceStats.entries()].sort()) {
    console.log(`    ${src}: ${count}`);
  }

  // Show first few
  console.log("\n  Sample seeds:");
  for (const s of seeds.slice(0, 15)) {
    const clampNote = s.seedValue !== s.rawValue ? ` (raw=${s.rawValue})` : "";
    console.log(`    ${s.team.padEnd(25)} B=${s.seedValue.toFixed(1).padStart(7)}  [${s.source}]${clampNote}  ${s.sourceDate ?? ""}`);
  }
  if (seeds.length > 15) console.log(`    ... and ${seeds.length - 15} more`);

  if (DRY_RUN) {
    console.log("\n  [DRY-RUN] Would seed these values. Skipping writes.\n");
  } else {
    // Write team_oracle_state
    const now = new Date().toISOString();
    const stateRows = seeds.map(s => ({
      team_id: s.team,
      season: SEASON,
      b_value: s.seedValue,
      m1_value: 0,
      published_index: s.seedValue,
      confidence_score: 0,
      next_fixture_id: null,
      last_kr_fixture_id: null,
      last_market_refresh_ts: null,
      updated_at: now,
    }));

    let seeded = 0;
    for (let i = 0; i < stateRows.length; i += 100) {
      const batch = stateRows.slice(i, i + 100);
      const { error } = await sb.from("team_oracle_state").upsert(batch, { onConflict: "team_id" });
      if (error) console.error(`  team_oracle_state upsert error: ${error.message}`);
      else seeded += batch.length;
    }
    console.log(`\n  Seeded ${seeded} teams into team_oracle_state`);

    // Write bootstrap price history
    const phRows = seeds.map(s => ({
      team: s.team,
      league: s.league,
      timestamp: now,
      b_value: s.seedValue,
      m1_value: 0,
      published_index: s.seedValue,
      confidence_score: 0,
      source_fixture_id: null,
      publish_reason: "bootstrap",
    }));

    let phInserted = 0;
    for (let i = 0; i < phRows.length; i += 100) {
      const batch = phRows.slice(i, i + 100);
      const { error } = await sb.from("oracle_price_history").insert(batch);
      if (error) console.error(`  oracle_price_history insert error: ${error.message}`);
      else phInserted += batch.length;
    }
    console.log(`  Wrote ${phInserted} bootstrap oracle_price_history rows`);
  }

  // ═════════════════════════════════════════════════════════════
  // PHASE 2 — REPLAY CURRENT SEASON THROUGH V1 SETTLEMENT
  // ═════════════════════════════════════════════════════════════

  console.log("\n[Phase 2] Replaying current-season matches through settleFixture()\n");

  // Load all finished current-season matches, ordered chronologically
  const replayMatches: { fixture_id: number; date: string; home_team: string; away_team: string; commence_time: string | null }[] = [];
  let rFrom = 0;

  while (true) {
    const { data, error } = await sb
      .from("matches")
      .select("fixture_id, date, home_team, away_team, commence_time")
      .eq("status", "finished")
      .gte("date", ORACLE_V1_SETTLEMENT_START_DATE)
      .lt("fixture_id", 9000000)
      .order("date", { ascending: true })
      .range(rFrom, rFrom + pageSize - 1);

    if (error) { console.error("  ERROR loading replay matches:", error.message); break; }
    if (!data || data.length === 0) break;
    replayMatches.push(...data);
    if (data.length < pageSize) break;
    rFrom += pageSize;
  }

  // Sort by commence_time (fallback to date)
  replayMatches.sort((a, b) => {
    const tsA = a.commence_time ?? `${a.date}T00:00:00Z`;
    const tsB = b.commence_time ?? `${b.date}T00:00:00Z`;
    return tsA.localeCompare(tsB);
  });

  console.log(`  Replay universe: ${replayMatches.length} finished matches (since ${ORACLE_V1_SETTLEMENT_START_DATE})`);

  if (DRY_RUN) {
    console.log("  [DRY-RUN] Would replay these matches. Skipping settlement.\n");

    // Still show what would happen
    const firstFew = replayMatches.slice(0, 5);
    for (const m of firstFew) {
      console.log(`    ${m.date} ${m.home_team} vs ${m.away_team} (fid=${m.fixture_id})`);
    }
    if (replayMatches.length > 5) console.log(`    ... and ${replayMatches.length - 5} more`);
  } else {
    let settled = 0;
    let skipped = 0;
    let failed = 0;
    const failures: { fixture_id: number; date: string; home: string; away: string; reason: string }[] = [];

    for (let i = 0; i < replayMatches.length; i++) {
      const m = replayMatches[i];

      if (i > 0 && i % 100 === 0) {
        console.log(`  Progress: ${i}/${replayMatches.length} (settled=${settled}, skipped=${skipped}, failed=${failed})`);
      }

      try {
        const result = await settleFixture(m.fixture_id);
        if (result.settled) {
          settled++;
        } else {
          skipped++;
          // Track failures (insufficient KR is the interesting one)
          if (result.skipped_reason && result.skipped_reason !== "already_settled") {
            failures.push({
              fixture_id: m.fixture_id,
              date: m.date,
              home: m.home_team,
              away: m.away_team,
              reason: result.skipped_reason,
            });
          }
        }
      } catch (err) {
        failed++;
        const reason = err instanceof Error ? err.message : String(err);
        failures.push({
          fixture_id: m.fixture_id,
          date: m.date,
          home: m.home_team,
          away: m.away_team,
          reason,
        });
      }
    }

    console.log(`\n  [Phase 2] Replay complete`);
    console.log(`    Total fixtures:  ${replayMatches.length}`);
    console.log(`    Settled:         ${settled}`);
    console.log(`    Skipped:         ${skipped}`);
    console.log(`    Failed:          ${failed}`);

    if (failures.length > 0) {
      console.log(`\n  Failed/skipped fixtures (non-idempotent):`);
      for (const f of failures.slice(0, 30)) {
        console.log(`    fid=${f.fixture_id}  ${f.date}  ${f.home} vs ${f.away}  reason=${f.reason}`);
      }
      if (failures.length > 30) console.log(`    ... and ${failures.length - 30} more`);
    }
  }

  // ═════════════════════════════════════════════════════════════
  // PHASE 3 — POST-BACKFILL SUMMARY
  // ═════════════════════════════════════════════════════════════

  console.log("\n[Phase 3] Post-backfill summary\n");

  if (!DRY_RUN) {
    // Read final state
    const { data: finalState } = await sb
      .from("team_oracle_state")
      .select("team_id, b_value, m1_value, published_index, last_kr_fixture_id")
      .order("b_value", { ascending: false });

    const allFinal = (finalState ?? []).map(r => ({
      team: r.team_id as string,
      B: Number(r.b_value),
      hasKR: r.last_kr_fixture_id !== null,
    }));

    // Seed source stats
    const fromLegacy = seeds.filter(s => s.source.startsWith("team_prices") || s.source.startsWith("legacy_json")).length;
    const fromFallback = seeds.filter(s => s.source === "baseline_fallback").length;

    console.log(`  Teams seeded:       ${seeds.length}`);
    console.log(`    from legacy:      ${fromLegacy}`);
    console.log(`    from fallback:    ${fromFallback}`);

    // Top 10
    const currentSeason = allFinal.filter(t => activeTeams.includes(t.team));
    console.log(`\n  Top 10 by B_value:`);
    for (const t of currentSeason.slice(0, 10)) {
      console.log(`    ${t.team.padEnd(25)} B=${t.B.toFixed(1).padStart(7)}`);
    }

    // Bottom 10
    console.log(`\n  Bottom 10 by B_value:`);
    for (const t of currentSeason.slice(-10).reverse()) {
      console.log(`    ${t.team.padEnd(25)} B=${t.B.toFixed(1).padStart(7)}`);
    }

    // Settlement coverage
    const { count: slCount } = await sb
      .from("settlement_log")
      .select("*", { count: "exact", head: true })
      .neq("delta_b", 0);

    const { count: bootstrapCount } = await sb
      .from("oracle_price_history")
      .select("*", { count: "exact", head: true })
      .eq("publish_reason", "bootstrap");

    console.log(`\n  settlement_log entries (delta_B≠0): ${slCount}`);
    console.log(`  oracle_price_history bootstrap rows: ${bootstrapCount}`);

    // Warnings
    const baselineTeams = currentSeason.filter(t => Math.abs(t.B - ORACLE_V1_BASELINE_ELO) < 1);
    if (baselineTeams.length > 5) {
      console.log(`\n  ⚠️  ${baselineTeams.length} teams still near baseline (B≈${ORACLE_V1_BASELINE_ELO})`);
    }

    const noKR = currentSeason.filter(t => !t.hasKR);
    if (noKR.length > 0) {
      console.log(`  ⚠️  ${noKR.length} teams have no settlement history (no KR frozen)`);
    }
  } else {
    console.log("  [DRY-RUN] No state was written. Run with --force to execute.");
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  BACKFILL COMPLETE");
  console.log("══════════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
