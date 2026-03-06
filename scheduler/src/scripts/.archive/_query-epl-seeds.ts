/**
 * Query EPL team seeds: the 2025-08-01 oracle implied_elo values (which were 
 * the post-clamped seeds from the legacy MSI JSON), plus fetch the raw 
 * legacy JSON values to show what was clamped.
 */
import "dotenv/config";
import { getSupabase } from "../api/supabase-client.js";

const CLAMP_MIN = 1300;
const CLAMP_MAX = 1700;
const BASELINE = 1500;

// Legacy MSI JSON name map (from the backfill script)
const LEGACY_NAME_MAP: Record<string, string> = {
  "Arsenal": "Arsenal FC",
  "Aston Villa": "Aston Villa FC",
  "Bournemouth": "AFC Bournemouth",
  "Brentford": "Brentford FC",
  "Brighton": "Brighton & Hove Albion FC",
  "Burnley": "Burnley FC",
  "Chelsea": "Chelsea FC",
  "Crystal Palace": "Crystal Palace FC",
  "Everton": "Everton FC",
  "Fulham": "Fulham FC",
  "Liverpool": "Liverpool FC",
  "Manchester City": "Manchester City FC",
  "Manchester United": "Manchester United FC",
  "Newcastle": "Newcastle United FC",
  "Nottingham Forest": "Nottingham Forest FC",
  "Southampton": "Southampton FC",
  "Tottenham": "Tottenham Hotspur FC",
  "West Ham": "West Ham United FC",
  "Wolves": "Wolverhampton Wanderers FC",
  "Sunderland": "Sunderland AFC",
  "Leeds": "Leeds United FC",
  "Ipswich": "Ipswich Town FC",
  "Leicester": "Leicester City FC",
};

const LEGACY_URL = "https://raw.githubusercontent.com/frertommy/MSI/main/data/msi_daily.json";

async function main() {
  const sb = getSupabase();

  console.log("\n══════════════════════════════════════════════════════════════════════════════");
  console.log("  EPL TEAM PRE-SEASON IMPLIED ELO: RAW vs CLAMPED");
  console.log("══════════════════════════════════════════════════════════════════════════════\n");

  // 1. Get the initial (2025-08-01) oracle rows for all EPL teams from team_prices
  //    These represent the B_value AFTER clamping was applied
  const { data: seedRows, error: seedErr } = await sb
    .from("team_prices")
    .select("team, implied_elo, date")
    .eq("model", "oracle")
    .eq("league", "Premier League")
    .eq("date", "2025-08-01");

  if (seedErr) {
    console.error("Seed query error:", seedErr.message);
    return;
  }

  const seedMap = new Map<string, number>();
  for (const row of (seedRows ?? [])) {
    seedMap.set(row.team, Number(row.implied_elo));
  }

  console.log(`Found ${seedMap.size} EPL teams with oracle data on 2025-08-01\n`);

  // 2. Fetch the legacy MSI JSON to get the raw unclamped values
  console.log("Fetching legacy MSI JSON from GitHub...");
  let legacyElos = new Map<string, { elo: number; date: string }>();
  try {
    const resp = await fetch(LEGACY_URL);
    if (resp.ok) {
      const data = (await resp.json()) as Record<string, { date: string; rating: number }[]>;
      for (const [legacyName, entries] of Object.entries(data)) {
        if (!entries || entries.length === 0) continue;
        // Get last entry before 2025-08-01
        const preSeason = entries.filter(e => e.date < "2025-08-01");
        if (preSeason.length > 0) {
          const last = preSeason[preSeason.length - 1];
          legacyElos.set(legacyName, { elo: last.rating, date: last.date });
        }
      }
      console.log(`Legacy JSON: ${legacyElos.size} teams with pre-season data\n`);
    }
  } catch (err) {
    console.error("Failed to fetch legacy JSON:", err);
  }

  // 3. Also get the team_oracle_state to see actual current B_values
  const { data: oracleState } = await sb
    .from("team_oracle_state")
    .select("team_id, b_value")
    .order("b_value", { ascending: false });

  const bValueMap = new Map<string, number>();
  for (const row of (oracleState ?? [])) {
    bValueMap.set(row.team_id, Number(row.b_value));
  }

  // 4. Build result table for all EPL teams in the matches
  const { data: matchData } = await sb
    .from("matches")
    .select("home_team, away_team")
    .eq("league", "Premier League")
    .gte("date", "2025-08-01")
    .limit(500);

  const eplTeams = new Set<string>();
  for (const m of (matchData ?? [])) {
    eplTeams.add(m.home_team);
    eplTeams.add(m.away_team);
  }
  const teamList = [...eplTeams].sort();

  console.log("═══════════════════════════════════════════════════════════════════════════════════════════════════");
  const hdr = [
    "Team".padEnd(22),
    "Raw Legacy Elo".padStart(15),
    "Clamped Seed".padStart(13),
    "Diff".padStart(8),
    "Current B".padStart(11),
    "Legacy Date".padStart(12),
    "Source".padStart(16),
  ].join("");
  console.log(hdr);
  console.log("─".repeat(97));

  interface RowData {
    team: string;
    rawElo: number | null;
    seedElo: number;
    diff: number;
    currentB: number | null;
    legacyDate: string;
    source: string;
    wasClamped: boolean;
  }

  const rows: RowData[] = [];

  for (const team of teamList) {
    const legacyName = LEGACY_NAME_MAP[team] || team;
    const legacy = legacyElos.get(legacyName);
    const seedValue = seedMap.get(team);
    const currentB = bValueMap.get(team);

    let rawElo: number | null = null;
    let source = "baseline_fallback";
    let legacyDate = "N/A";
    let seedElo = seedValue ?? BASELINE;

    if (legacy) {
      rawElo = legacy.elo;
      legacyDate = legacy.date;
      source = "legacy_json";
    }

    const clampedValue = rawElo !== null 
      ? Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, rawElo))
      : BASELINE;
    
    const diff = rawElo !== null ? rawElo - clampedValue : 0;
    const wasClamped = diff !== 0;

    rows.push({
      team,
      rawElo,
      seedElo: clampedValue,
      diff,
      currentB: currentB ?? null,
      legacyDate,
      source,
      wasClamped,
    });
  }

  // Sort by raw elo descending
  rows.sort((a, b) => {
    if (a.rawElo === null && b.rawElo === null) return 0;
    if (a.rawElo === null) return 1;
    if (b.rawElo === null) return -1;
    return b.rawElo - a.rawElo;
  });

  let clampedCount = 0;
  for (const r of rows) {
    const team = r.team.padEnd(22);
    const raw = r.rawElo !== null ? r.rawElo.toFixed(1).padStart(15) : "N/A".padStart(15);
    const seed = r.seedElo.toFixed(1).padStart(13);
    const diff = r.diff !== 0 ? (r.diff > 0 ? `+${r.diff.toFixed(1)}` : r.diff.toFixed(1)).padStart(8) : "0".padStart(8);
    const curB = r.currentB !== null ? r.currentB.toFixed(1).padStart(11) : "N/A".padStart(11);
    const date = r.legacyDate.padStart(12);
    const src = r.source.padStart(16);
    const marker = r.wasClamped ? " <<<" : "";

    console.log(`${team}${raw}${seed}${diff}${curB}${date}${src}${marker}`);
    if (r.wasClamped) clampedCount++;
  }

  console.log("─".repeat(97));
  console.log(`\nTeams clamped: ${clampedCount} / ${rows.length}`);
  console.log(`Clamp range: [${CLAMP_MIN}, ${CLAMP_MAX}]\n`);

  if (clampedCount > 0) {
    console.log("══════════════════════════════════════════════════════════");
    console.log("  CLAMPED TEAMS DETAIL");
    console.log("══════════════════════════════════════════════════════════\n");
    
    for (const r of rows.filter(x => x.wasClamped)) {
      const direction = r.diff > 0 ? "CLAMPED DOWN" : "CLAMPED UP";
      const lost = Math.abs(r.diff).toFixed(1);
      console.log(`  ${r.team.padEnd(22)} raw=${r.rawElo!.toFixed(1).padStart(7)} -> seed=${r.seedElo.toFixed(1).padStart(7)}  ${direction} by ${lost} points`);
      console.log(`    Current B_value: ${r.currentB?.toFixed(1) ?? "N/A"} (delta from seed: ${r.currentB !== null ? (r.currentB - r.seedElo).toFixed(1) : "N/A"})`);
      console.log(`    If unclamped seed were used, current B would be approx: ${r.currentB !== null ? (r.currentB + r.diff).toFixed(1) : "N/A"}`);
      console.log("");
    }
  }

  // Also show the team_oracle_state 2025-08-01 bootstrap values for comparison
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  CROSS-CHECK: team_prices oracle values on 2025-08-01");
  console.log("══════════════════════════════════════════════════════════\n");

  const seedList = [...seedMap.entries()].sort((a, b) => b[1] - a[1]);
  for (const [team, elo] of seedList) {
    const legacy = legacyElos.get(LEGACY_NAME_MAP[team] || team);
    const rawStr = legacy ? legacy.elo.toFixed(1).padStart(8) : "N/A".padStart(8);
    const diff = legacy ? (legacy.elo - elo).toFixed(1) : "N/A";
    console.log(`  ${team.padEnd(22)} seed_elo=${elo.toFixed(1).padStart(7)}  raw_legacy=${rawStr}  diff=${diff}`);
  }

  console.log("\nDone.\n");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
