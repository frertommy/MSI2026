/**
 * arsenal-csv-export.ts
 *
 * Exports a comprehensive Arsenal FC CSV with:
 *   1. All matches played this season (results, scores, home/away)
 *   2. All odds snapshot data for those matches (per bookmaker, per snapshot)
 *   3. Arsenal's recentered Elo (from team_prices.implied_elo)
 *   4. Arsenal's raw Elo WITHOUT global re-centering (replayed from match data)
 *
 * Produces TWO CSV files:
 *   - arsenal-matches.csv   (one row per match-day, with Elo + result)
 *   - arsenal-odds.csv      (one row per odds snapshot across all Arsenal fixtures)
 *
 * Usage:
 *   cd scheduler && npx tsx src/scripts/arsenal-csv-export.ts
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in env (or .env).
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { resolve } from "path";

// ─── Config ──────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_KEY ?? "";
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_KEY");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const TEAM = "Arsenal";
const SEASON_START = "2025-08-01";
const INITIAL_ELO = 1500;
const SHOCK_K = 30;
const CARRY_DECAY_RATE = 0.002;
const MA_WINDOW = 45;
const LEGACY_URL = "https://raw.githubusercontent.com/frertommy/MSI/main/data/msi_daily.json";

const TEAM_ALIASES = ["Arsenal"];

// ─── Helpers ─────────────────────────────────────────────────
async function fetchAll<T>(
  table: string,
  select: string,
  filters: [string, string, unknown][] = [],
  orderCol?: string
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    let q = sb.from(table).select(select).range(from, from + PAGE - 1);
    for (const [col, op, val] of filters) {
      if (op === "eq") q = q.eq(col, val);
      else if (op === "gte") q = q.gte(col, val);
      else if (op === "in") q = q.in(col, val as unknown[]);
    }
    if (orderCol) q = q.order(orderCol, { ascending: true });
    const { data, error } = await q;
    if (error) { console.error(`  ${table} error:`, error.message); break; }
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function parseScore(score: string): [number, number] | null {
  const parts = score.split("-");
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0].trim());
  const a = parseInt(parts[1].trim());
  if (isNaN(h) || isNaN(a)) return null;
  return [h, a];
}

function eloExpectedScore(rA: number, rB: number): number {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

function addDays(date: string, n: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function allDates(start: string, end: string): string[] {
  const dates: string[] = [];
  let d = start;
  while (d <= end) { dates.push(d); d = addDays(d, 1); }
  return dates;
}

function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsvRow(vals: unknown[]): string {
  return vals.map(csvEscape).join(",");
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`Arsenal CSV export: ${SEASON_START} → ${today}`);
  console.log("─".repeat(60));

  // ── 1. Load ALL matches (we need all teams for Elo replay) ──
  console.log("Loading all matches...");
  interface MatchRow {
    fixture_id: number; date: string; league: string;
    home_team: string; away_team: string; score: string; status: string;
  }
  const rawMatches = await fetchAll<MatchRow>(
    "matches",
    "fixture_id, date, league, home_team, away_team, score, status",
    [["date", "gte", SEASON_START]],
    "date"
  );

  // Deduplicate (same as pricing engine)
  const byKey = new Map<string, MatchRow>();
  for (const m of rawMatches) {
    const key = `${m.date}|${m.home_team}|${m.away_team}`;
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, m); }
    else if (m.status === "finished" && existing.status !== "finished") { byKey.set(key, m); }
    else if (m.score && m.score !== "N/A" && (!existing.score || existing.score === "N/A")) { byKey.set(key, m); }
  }
  const allMatches = [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date));
  console.log(`  ${rawMatches.length} raw → ${allMatches.length} deduplicated matches`);

  // ── 2. Load Arsenal team_prices (stored recentered Elo) ──
  console.log("Loading Arsenal team_prices...");
  interface PriceRow {
    team: string; date: string; implied_elo: number;
    dollar_price: number; drift_elo: number;
  }
  // Try both names
  let prices: PriceRow[] = [];
  for (const alias of TEAM_ALIASES) {
    const p = await fetchAll<PriceRow>(
      "team_prices",
      "team, date, implied_elo, dollar_price, drift_elo",
      [["team", "eq", alias], ["model", "eq", "oracle"]],
      "date"
    );
    if (p.length > prices.length) prices = p;
  }
  console.log(`  ${prices.length} daily price rows`);
  const priceByDate = new Map(prices.map(p => [p.date, p]));

  // ── 3. Identify Arsenal matches ──
  const arsenalMatches = allMatches.filter(
    m => m.home_team === TEAM || m.away_team === TEAM
  );
  console.log(`  ${arsenalMatches.length} Arsenal matches this season`);

  // Collect all fixture IDs for Arsenal matches (including synthetic duplicates)
  const arsenalFixtureIds = new Set<number>();
  const allFixtureIdsByKey = new Map<string, number[]>();
  for (const m of rawMatches) {
    if (m.home_team !== TEAM && m.away_team !== TEAM) continue;
    const key = `${m.date}|${m.home_team}|${m.away_team}`;
    if (!allFixtureIdsByKey.has(key)) allFixtureIdsByKey.set(key, []);
    allFixtureIdsByKey.get(key)!.push(m.fixture_id);
    arsenalFixtureIds.add(m.fixture_id);
  }

  // ── 4. Load ALL odds snapshots for Arsenal fixtures ──
  console.log(`Loading odds snapshots for ${arsenalFixtureIds.size} fixture IDs...`);
  interface OddsRow {
    fixture_id: number; bookmaker: string; snapshot_time: string;
    home_odds: number | null; away_odds: number | null; draw_odds: number | null;
    days_before_kickoff: number | null;
  }
  const fids = [...arsenalFixtureIds];
  const allOdds: OddsRow[] = [];
  const BATCH = 30;
  for (let i = 0; i < fids.length; i += BATCH) {
    const batch = fids.slice(i, i + BATCH);
    const rows = await fetchAll<OddsRow>(
      "odds_snapshots",
      "fixture_id, bookmaker, snapshot_time, home_odds, away_odds, draw_odds, days_before_kickoff",
      [["fixture_id", "in", batch]],
      "snapshot_time"
    );
    allOdds.push(...rows);
    process.stderr.write(`  Fetched batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(fids.length / BATCH)} (${rows.length} rows)\n`);
  }
  console.log(`  ${allOdds.length} total odds snapshots`);

  // ── 5. Elo replay — compute BOTH recentered and raw ──
  console.log("Replaying Elo engine for raw (un-recentered) values...");

  // Fetch legacy starting Elos
  let legacyElos = new Map<string, number>();
  try {
    const resp = await fetch(LEGACY_URL);
    if (resp.ok) {
      const data = await resp.json() as Record<string, { date: string; rating: number }[]>;
      // DB name → legacy JSON name mapping
      // The DB uses short names (e.g. "Arsenal") while the legacy JSON
      // also uses short names but sometimes slightly different.
      // For most EPL teams they match directly.
      const LEGACY_MAP: Record<string, string> = {
        "Arsenal": "Arsenal",
        "Chelsea": "Chelsea",
        "Manchester City": "Manchester City",
        "Liverpool": "Liverpool",
        "Manchester United": "Manchester United",
        "Tottenham": "Tottenham",
        "Newcastle Utd": "Newcastle Utd",
        "Aston Villa": "Aston Villa",
        "Brighton": "Brighton",
        "Bournemouth": "Bournemouth",
        "Wolverhampton Wanderers": "Wolverhampton Wanderers",
        "West Ham": "West Ham",
        "Everton": "Everton",
        "Nottingham Forest": "Nottingham Forest",
        "Crystal Palace": "Crystal Palace",
        "Brentford": "Brentford",
        "Fulham": "Fulham",
        "Ipswich": "Ipswich",
        "Leicester": "Leicester",
        "Southampton": "Southampton",
      };
      // Also try direct name match from legacy data
      for (const [teamName, entries] of Object.entries(data)) {
        if (!legacyElos.has(teamName)) {
          const pre = entries.filter(e => e.date < SEASON_START);
          const start = pre.length > 0 ? pre[pre.length - 1].rating : entries[0].rating;
          legacyElos.set(teamName, start);
        }
      }
      for (const [canonical, legacyName] of Object.entries(LEGACY_MAP)) {
        const entries = data[legacyName];
        if (!entries || entries.length === 0) continue;
        const pre = entries.filter(e => e.date < SEASON_START);
        const start = pre.length > 0 ? pre[pre.length - 1].rating : entries[0].rating;
        legacyElos.set(canonical, start);
      }
      console.log(`  Legacy Elos loaded for ${legacyElos.size} teams`);
    }
  } catch { console.warn("  Failed to fetch legacy Elos, using 1500 for all"); }

  // Gather all teams
  const allTeams = new Set<string>();
  for (const m of allMatches) { allTeams.add(m.home_team); allTeams.add(m.away_team); }

  // Initialize Elos
  const teamElo = new Map<string, number>();
  const teamEloHistory = new Map<string, number[]>();
  const teamLastMatch = new Map<string, string>();
  for (const t of allTeams) {
    const elo = legacyElos.get(t) ?? INITIAL_ELO;
    teamElo.set(t, elo);
    teamEloHistory.set(t, [elo]);
  }

  // Day-by-day replay
  const matchesByDate = new Map<string, MatchRow[]>();
  for (const m of allMatches) {
    if (!matchesByDate.has(m.date)) matchesByDate.set(m.date, []);
    matchesByDate.get(m.date)!.push(m);
  }

  // Store Arsenal's daily Elo (raw and recentered)
  const arsenalEloByDate = new Map<string, { raw: number; recentered: number }>();
  const dates = allDates(SEASON_START, today);

  for (const date of dates) {
    const todaysMatches = matchesByDate.get(date) ?? [];
    const playingToday = new Set<string>();
    for (const m of todaysMatches) { playingToday.add(m.home_team); playingToday.add(m.away_team); }

    // 1. Carry decay for non-playing teams
    for (const [team, elo] of teamElo) {
      if (playingToday.has(team)) continue;
      const lastMatch = teamLastMatch.get(team);
      if (!lastMatch) continue;
      const daysSince = Math.round((new Date(date).getTime() - new Date(lastMatch).getTime()) / 86400000);
      if (daysSince <= 0) continue;
      const history = teamEloHistory.get(team) ?? [elo];
      const maSlice = history.slice(-MA_WINDOW);
      const ma45 = maSlice.reduce((a, b) => a + b, 0) / maSlice.length;
      const decayFactor = Math.max(0.5, 1 - CARRY_DECAY_RATE * daysSince);
      teamElo.set(team, ma45 + (elo - ma45) * decayFactor);
    }

    // 2. Match shocks
    for (const m of todaysMatches) {
      if (m.status !== "finished") continue;
      const sc = parseScore(m.score);
      if (!sc) continue;
      const [hg, ag] = sc;
      const homeElo = teamElo.get(m.home_team) ?? INITIAL_ELO;
      const awayElo = teamElo.get(m.away_team) ?? INITIAL_ELO;
      const homeActual = hg > ag ? 1 : hg === ag ? 0.5 : 0;
      const awayActual = 1 - homeActual;
      const homeExpected = eloExpectedScore(homeElo, awayElo);
      const awayExpected = 1 - homeExpected;
      const homeShock = SHOCK_K * (homeActual - homeExpected);
      const awayShock = SHOCK_K * (awayActual - awayExpected);
      teamElo.set(m.home_team, homeElo + homeShock);
      teamElo.set(m.away_team, awayElo + awayShock);
      teamLastMatch.set(m.home_team, date);
      teamLastMatch.set(m.away_team, date);
    }

    // Capture Arsenal's RAW Elo (before re-centering)
    const arsenalRaw = teamElo.get(TEAM) ?? INITIAL_ELO;

    // 3. Re-center all Elos to mean 1500
    const allElos = [...teamElo.values()];
    const globalMean = allElos.reduce((a, b) => a + b, 0) / allElos.length;
    const shift = INITIAL_ELO - globalMean;
    for (const [team, elo] of teamElo) {
      teamElo.set(team, elo + shift);
    }

    const arsenalRecentered = teamElo.get(TEAM) ?? INITIAL_ELO;
    arsenalEloByDate.set(date, { raw: arsenalRaw, recentered: arsenalRecentered });

    // 4. Update histories
    for (const [team, elo] of teamElo) {
      const hist = teamEloHistory.get(team)!;
      hist.push(elo);
      if (hist.length > MA_WINDOW + 30) hist.splice(0, hist.length - MA_WINDOW - 10);
    }
  }
  console.log(`  Elo replay complete: ${dates.length} days`);

  // ── 6. Build match lookup for Arsenal ──
  const arsenalMatchByDate = new Map<string, MatchRow>();
  for (const m of arsenalMatches) arsenalMatchByDate.set(m.date, m);

  // ── 7. Write CSV 1: arsenal-matches.csv ──
  console.log("Writing arsenal-matches.csv...");
  const matchHeaders = [
    "date", "opponent", "venue", "score", "result", "status",
    "fixture_id", "league",
    "elo_recentered", "elo_raw_no_recenter",
    "elo_recentered_stored", "dollar_price", "drift_elo",
    "elo_delta_recentered", "elo_delta_raw"
  ];

  const matchRows: string[] = [matchHeaders.join(",")];
  let prevRecentered: number | null = null;
  let prevRaw: number | null = null;

  for (const date of dates) {
    const m = arsenalMatchByDate.get(date);
    const elos = arsenalEloByDate.get(date);
    const price = priceByDate.get(date);

    if (!m && !price && !elos) continue; // skip empty days with no data at all

    // Only output rows where there's a match OR there's a stored price
    if (!m && !price) continue;

    const isHome = m ? m.home_team === TEAM : null;
    const opponent = m ? (isHome ? m.away_team : m.home_team) : "";
    const venue = m ? (isHome ? "H" : "A") : "";
    const score = m?.score ?? "";
    let result = "";
    if (m && m.status === "finished" && m.score) {
      const sc = parseScore(m.score);
      if (sc) {
        const [hg, ag] = sc;
        if (hg === ag) result = "D";
        else if (isHome) result = hg > ag ? "W" : "L";
        else result = ag > hg ? "W" : "L";
      }
    }

    const recentered = elos?.recentered ?? null;
    const raw = elos?.raw ?? null;
    const deltaR = prevRecentered !== null && recentered !== null ? recentered - prevRecentered : null;
    const deltaRaw = prevRaw !== null && raw !== null ? raw - prevRaw : null;

    matchRows.push(toCsvRow([
      date,
      opponent,
      venue,
      score,
      result,
      m?.status ?? "",
      m?.fixture_id ?? "",
      m?.league ?? price?.team ? "Premier League" : "",
      recentered !== null ? Math.round(recentered * 10) / 10 : "",
      raw !== null ? Math.round(raw * 10) / 10 : "",
      price?.implied_elo ?? "",
      price?.dollar_price ?? "",
      price?.drift_elo ?? "",
      deltaR !== null ? Math.round(deltaR * 10) / 10 : "",
      deltaRaw !== null ? Math.round(deltaRaw * 10) / 10 : "",
    ]));

    if (recentered !== null) prevRecentered = recentered;
    if (raw !== null) prevRaw = raw;
  }

  const matchCsvPath = resolve(process.cwd(), "..", "data", "arsenal-matches.csv");
  writeFileSync(matchCsvPath, matchRows.join("\n"), "utf-8");
  console.log(`  ✓ ${matchRows.length - 1} rows → ${matchCsvPath}`);

  // ── 8. Write CSV 2: arsenal-odds.csv ──
  console.log("Writing arsenal-odds.csv...");

  // Build fixture → match metadata lookup
  const fixtureMeta = new Map<number, { date: string; home_team: string; away_team: string; score: string }>();
  for (const m of arsenalMatches) {
    fixtureMeta.set(m.fixture_id, { date: m.date, home_team: m.home_team, away_team: m.away_team, score: m.score });
  }
  // Also map synthetic fixture IDs
  for (const [key, fids] of allFixtureIdsByKey) {
    const [date, home, away] = key.split("|");
    for (const fid of fids) {
      if (!fixtureMeta.has(fid)) {
        const match = arsenalMatches.find(m => m.date === date && m.home_team === home && m.away_team === away);
        if (match) fixtureMeta.set(fid, { date: match.date, home_team: match.home_team, away_team: match.away_team, score: match.score });
      }
    }
  }

  const oddsHeaders = [
    "fixture_id", "match_date", "home_team", "away_team", "score",
    "arsenal_venue", "bookmaker", "snapshot_time", "days_before_kickoff",
    "home_odds", "draw_odds", "away_odds",
    "arsenal_win_odds", "arsenal_draw_odds", "arsenal_lose_odds",
    "arsenal_win_implied_prob", "arsenal_draw_implied_prob", "arsenal_lose_implied_prob"
  ];

  const oddsRows: string[] = [oddsHeaders.join(",")];

  for (const o of allOdds) {
    const meta = fixtureMeta.get(o.fixture_id);
    if (!meta) continue;

    const isHome = meta.home_team === TEAM;
    const arsenalWin = isHome ? o.home_odds : o.away_odds;
    const arsenalLose = isHome ? o.away_odds : o.home_odds;
    const arsenalDraw = o.draw_odds;

    // Implied probabilities (normalized)
    let winProb = "", drawProb = "", loseProb = "";
    if (arsenalWin && arsenalDraw && arsenalLose &&
        arsenalWin > 1 && arsenalDraw > 1 && arsenalLose > 1) {
      const rawW = 1 / arsenalWin;
      const rawD = 1 / arsenalDraw;
      const rawL = 1 / arsenalLose;
      const total = rawW + rawD + rawL;
      winProb = (rawW / total * 100).toFixed(2);
      drawProb = (rawD / total * 100).toFixed(2);
      loseProb = (rawL / total * 100).toFixed(2);
    }

    oddsRows.push(toCsvRow([
      o.fixture_id,
      meta.date,
      meta.home_team,
      meta.away_team,
      meta.score,
      isHome ? "H" : "A",
      o.bookmaker,
      o.snapshot_time,
      o.days_before_kickoff ?? "",
      o.home_odds ?? "",
      o.draw_odds ?? "",
      o.away_odds ?? "",
      arsenalWin ?? "",
      arsenalDraw ?? "",
      arsenalLose ?? "",
      winProb,
      drawProb,
      loseProb,
    ]));
  }

  const oddsCsvPath = resolve(process.cwd(), "..", "data", "arsenal-odds.csv");
  writeFileSync(oddsCsvPath, oddsRows.join("\n"), "utf-8");
  console.log(`  ✓ ${oddsRows.length - 1} rows → ${oddsCsvPath}`);

  // ── Summary ──
  console.log("");
  console.log("═".repeat(60));
  console.log("  EXPORT COMPLETE");
  console.log("═".repeat(60));
  console.log(`  arsenal-matches.csv : ${matchRows.length - 1} rows (daily Elo + match results)`);
  console.log(`  arsenal-odds.csv    : ${oddsRows.length - 1} rows (all odds snapshots)`);
  console.log("");
  console.log("  Columns in arsenal-matches.csv:");
  console.log("    elo_recentered       = replayed Elo (global mean pinned to 1500)");
  console.log("    elo_raw_no_recenter  = replayed Elo WITHOUT re-centering");
  console.log("    elo_recentered_stored= implied_elo from team_prices (includes odds blend)");
  console.log("    drift_elo            = odds-implied Elo when blend active");
  console.log("");
  console.log("  The difference between recentered and raw shows how much the");
  console.log("  global pool shift affects Arsenal's rating on any given day.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
