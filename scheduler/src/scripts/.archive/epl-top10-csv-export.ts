/**
 * epl-top10-csv-export.ts  —  v2 (clean)
 *
 * Exports two CSVs per team into data/epl-top10/:
 *
 *   {team}-matches.csv
 *     One row per match. Canonical match_id, kickoff_utc, result,
 *     both teams' Elo (recentered + raw), dollar prices.
 *
 *   {team}-odds.csv
 *     One row per odds snapshot. Linked to match_id (not raw fixture_id).
 *     Raw decimal odds (no de-vig). Phase column (prematch / inplay).
 *
 * Key fixes over v1:
 *   - Canonical match_id: merges API-Football + synthetic fixture IDs
 *   - kickoff_utc: from commence_time where available, else derived from
 *     odds snapshot inflection (pre-match→in-play transition)
 *   - phase: prematch vs inplay based on kickoff_utc
 *   - Opponent Elo (recentered + raw) included on match rows
 *   - Odds are raw decimal (1X2), never de-vigged
 *
 * Usage:
 *   cd scheduler && npx tsx src/scripts/epl-top10-csv-export.ts
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

// ─── Config ──────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_KEY ?? "";
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE env vars"); process.exit(1); }
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const SEASON_START = "2025-08-01";
const INITIAL_ELO = 1500;
const SHOCK_K = 30;
const CARRY_DECAY_RATE = 0.002;
const MA_WINDOW = 45;
const LEGACY_URL = "https://raw.githubusercontent.com/frertommy/MSI/main/data/msi_daily.json";

// ─── Helpers ─────────────────────────────────────────────────
async function fetchAll<T>(
  table: string, select: string,
  filters: [string, string, unknown][] = [], orderCol?: string,
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
      else if (op === "or_eq") q = q.or(val as string);
    }
    if (orderCol) q = q.order(orderCol, { ascending: true });
    const { data, error } = await q;
    if (error) { console.error(`  ${table} err:`, error.message); break; }
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function parseScore(s: string): [number, number] | null {
  const p = s.split("-");
  if (p.length !== 2) return null;
  const h = parseInt(p[0].trim()), a = parseInt(p[1].trim());
  return isNaN(h) || isNaN(a) ? null : [h, a];
}

function eloES(rA: number, rB: number) { return 1 / (1 + Math.pow(10, (rB - rA) / 400)); }

function addDays(d: string, n: number) {
  const dt = new Date(d); dt.setDate(dt.getDate() + n); return dt.toISOString().slice(0, 10);
}

function allDates(s: string, e: string) {
  const out: string[] = []; let d = s; while (d <= e) { out.push(d); d = addDays(d, 1); } return out;
}

function csvEsc(v: unknown) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(vals: unknown[]) { return vals.map(csvEsc).join(","); }

function slugify(n: string) { return n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }

// ─── Types ───────────────────────────────────────────────────
interface RawMatch {
  fixture_id: number; date: string; league: string;
  home_team: string; away_team: string; score: string;
  status: string; commence_time: string | null;
}

interface CanonicalMatch {
  match_id: number;           // canonical fixture_id (prefer API-Football)
  all_fixture_ids: number[];  // all fixture_ids for this logical match
  date: string;
  kickoff_utc: string | null; // ISO datetime or null
  league: string;
  home_team: string;
  away_team: string;
  home_goals: number | null;
  away_goals: number | null;
  result: string;             // H / D / A / ""
  status: string;             // finished / live / upcoming
}

interface OddsRow {
  fixture_id: number; bookmaker: string; snapshot_time: string;
  home_odds: number | null; away_odds: number | null; draw_odds: number | null;
  days_before_kickoff: number | null;
}

interface PriceRow {
  team: string; date: string; implied_elo: number;
  dollar_price: number; drift_elo: number;
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`EPL Top 10 CSV export v2: ${SEASON_START} → ${today}`);
  console.log("═".repeat(70));

  // ── 0. Top 10 teams ──
  console.log("\nFinding top 10 EPL teams...");
  const { data: latestRow } = await sb
    .from("team_prices").select("date")
    .eq("model", "oracle").eq("league", "Premier League")
    .order("date", { ascending: false }).limit(1);
  const latestDate = latestRow?.[0]?.date;
  if (!latestDate) { console.error("No data"); process.exit(1); }

  const { data: rankings } = await sb
    .from("team_prices").select("team, dollar_price")
    .eq("model", "oracle").eq("league", "Premier League").eq("date", latestDate)
    .order("dollar_price", { ascending: false }).limit(10);
  const TOP_TEAMS = (rankings ?? []).map(r => r.team as string);
  for (const [i, t] of TOP_TEAMS.entries()) {
    console.log(`  ${(i + 1).toString().padStart(2)}. ${t.padEnd(25)} $${(rankings ?? [])[i]?.dollar_price?.toFixed(2)}`);
  }

  // ── 1. Load ALL raw matches ──
  console.log("\nLoading all matches...");
  const rawMatches = await fetchAll<RawMatch>(
    "matches",
    "fixture_id, date, league, home_team, away_team, score, status, commence_time",
    [["date", "gte", SEASON_START]], "date",
  );
  console.log(`  ${rawMatches.length} raw match rows`);

  // ── 2. Build canonical matches ──
  // Group by date|home|away → merge into one logical match per group
  console.log("Building canonical match identities...");
  const matchGroups = new Map<string, RawMatch[]>();
  for (const m of rawMatches) {
    const key = `${m.date}|${m.home_team}|${m.away_team}`;
    const arr = matchGroups.get(key) || [];
    arr.push(m);
    matchGroups.set(key, arr);
  }

  const canonicalMatches: CanonicalMatch[] = [];
  // Also build: fixture_id → canonical match_id
  const fidToMatchId = new Map<number, number>();

  for (const [, group] of matchGroups) {
    // Pick best row: prefer finished > live > upcoming, then API-Football ID < synthetic
    const sorted = [...group].sort((a, b) => {
      const statusOrder = (s: string) => s === "finished" ? 0 : s === "live" ? 1 : 2;
      const diff = statusOrder(a.status) - statusOrder(b.status);
      if (diff !== 0) return diff;
      return a.fixture_id - b.fixture_id; // prefer lower (API-Football) ID
    });
    const best = sorted[0];

    // Gather commence_time from whichever row has it
    let kickoff: string | null = null;
    for (const m of group) {
      if (m.commence_time) { kickoff = m.commence_time; break; }
    }

    const sc = best.score && best.score !== "N/A" ? parseScore(best.score) : null;
    let result = "";
    if (sc) {
      if (sc[0] > sc[1]) result = "H";
      else if (sc[0] < sc[1]) result = "A";
      else result = "D";
    }

    const canonical: CanonicalMatch = {
      match_id: best.fixture_id,
      all_fixture_ids: group.map(m => m.fixture_id),
      date: best.date,
      kickoff_utc: kickoff,
      league: best.league,
      home_team: best.home_team,
      away_team: best.away_team,
      home_goals: sc ? sc[0] : null,
      away_goals: sc ? sc[1] : null,
      result,
      status: best.status,
    };
    canonicalMatches.push(canonical);

    for (const fid of canonical.all_fixture_ids) {
      fidToMatchId.set(fid, canonical.match_id);
    }
  }
  canonicalMatches.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`  ${rawMatches.length} rows → ${canonicalMatches.length} canonical matches`);
  const withKickoff = canonicalMatches.filter(m => m.kickoff_utc).length;
  console.log(`  ${withKickoff} have kickoff_utc, ${canonicalMatches.length - withKickoff} will attempt derivation from odds`);

  // ── 3. Elo replay (all teams, once) ──
  console.log("\nReplaying Elo engine...");
  let legacyElos = new Map<string, number>();
  try {
    const resp = await fetch(LEGACY_URL);
    if (resp.ok) {
      const data = await resp.json() as Record<string, { date: string; rating: number }[]>;
      for (const [name, entries] of Object.entries(data)) {
        if (!entries || entries.length === 0) continue;
        const pre = entries.filter(e => e.date < SEASON_START);
        legacyElos.set(name, pre.length > 0 ? pre[pre.length - 1].rating : entries[0].rating);
      }
      console.log(`  Legacy Elos: ${legacyElos.size} teams`);
    }
  } catch { console.warn("  Legacy fetch failed"); }

  const allTeams = new Set<string>();
  for (const m of canonicalMatches) { allTeams.add(m.home_team); allTeams.add(m.away_team); }

  const teamElo = new Map<string, number>();
  const teamEloHistory = new Map<string, number[]>();
  const teamLastMatch = new Map<string, string>();
  for (const t of allTeams) {
    const elo = legacyElos.get(t) ?? INITIAL_ELO;
    teamElo.set(t, elo);
    teamEloHistory.set(t, [elo]);
  }

  const matchesByDate = new Map<string, CanonicalMatch[]>();
  for (const m of canonicalMatches) {
    const arr = matchesByDate.get(m.date) || [];
    arr.push(m);
    matchesByDate.set(m.date, arr);
  }

  // Store daily Elo for ALL teams: { raw, recentered }
  // Keyed: team → date → { raw, recentered }
  const eloStore = new Map<string, Map<string, { raw: number; recentered: number }>>();
  for (const t of allTeams) eloStore.set(t, new Map());

  const dates = allDates(SEASON_START, today);

  for (const date of dates) {
    const todaysMatches = matchesByDate.get(date) ?? [];
    const playingToday = new Set<string>();
    for (const m of todaysMatches) { playingToday.add(m.home_team); playingToday.add(m.away_team); }

    // Carry decay
    for (const [team, elo] of teamElo) {
      if (playingToday.has(team)) continue;
      const last = teamLastMatch.get(team);
      if (!last) continue;
      const ds = Math.round((new Date(date).getTime() - new Date(last).getTime()) / 86400000);
      if (ds <= 0) continue;
      const hist = teamEloHistory.get(team) ?? [elo];
      const ma = hist.slice(-MA_WINDOW);
      const anchor = ma.reduce((a, b) => a + b, 0) / ma.length;
      teamElo.set(team, anchor + (elo - anchor) * Math.max(0.5, 1 - CARRY_DECAY_RATE * ds));
    }

    // Match shocks
    for (const m of todaysMatches) {
      if (m.status !== "finished" || m.home_goals === null) continue;
      const hE = teamElo.get(m.home_team) ?? INITIAL_ELO;
      const aE = teamElo.get(m.away_team) ?? INITIAL_ELO;
      const hA = m.home_goals > m.away_goals! ? 1 : m.home_goals === m.away_goals ? 0.5 : 0;
      const hExp = eloES(hE, aE);
      teamElo.set(m.home_team, hE + SHOCK_K * (hA - hExp));
      teamElo.set(m.away_team, aE + SHOCK_K * ((1 - hA) - (1 - hExp)));
      teamLastMatch.set(m.home_team, date);
      teamLastMatch.set(m.away_team, date);
    }

    // Capture raw Elos BEFORE re-centering
    for (const t of allTeams) {
      eloStore.get(t)!.set(date, { raw: teamElo.get(t) ?? INITIAL_ELO, recentered: 0 });
    }

    // Re-center
    const vals = [...teamElo.values()];
    const shift = INITIAL_ELO - vals.reduce((a, b) => a + b, 0) / vals.length;
    for (const [t, e] of teamElo) teamElo.set(t, e + shift);

    // Store recentered
    for (const t of allTeams) {
      eloStore.get(t)!.get(date)!.recentered = teamElo.get(t) ?? INITIAL_ELO;
    }

    // Update histories
    for (const [t, e] of teamElo) {
      const h = teamEloHistory.get(t)!;
      h.push(e);
      if (h.length > MA_WINDOW + 30) h.splice(0, h.length - MA_WINDOW - 10);
    }
  }
  console.log(`  Elo replay: ${dates.length} days, ${allTeams.size} teams`);

  // ── 4. Create output directory ──
  const outDir = resolve(process.cwd(), "..", "data", "epl-top10");
  mkdirSync(outDir, { recursive: true });

  // ── 5. Per-team export ──
  const summary: { team: string; matches: number; odds: number }[] = [];

  for (const [idx, TEAM] of TOP_TEAMS.entries()) {
    const slug = slugify(TEAM);
    console.log(`\n[${(idx + 1).toString().padStart(2)}/${TOP_TEAMS.length}] ${TEAM}`);

    // Team matches (canonical)
    const teamMatches = canonicalMatches.filter(m => m.home_team === TEAM || m.away_team === TEAM);
    console.log(`  ${teamMatches.length} matches`);

    // All fixture IDs for this team's matches (for odds lookup)
    const teamFids = new Set<number>();
    for (const m of teamMatches) { for (const fid of m.all_fixture_ids) teamFids.add(fid); }

    // Load odds
    const fids = [...teamFids];
    const allOdds: OddsRow[] = [];
    for (let i = 0; i < fids.length; i += 30) {
      const batch = fids.slice(i, i + 30);
      const rows = await fetchAll<OddsRow>(
        "odds_snapshots",
        "fixture_id, bookmaker, snapshot_time, home_odds, away_odds, draw_odds, days_before_kickoff",
        [["fixture_id", "in", batch]], "snapshot_time",
      );
      allOdds.push(...rows);
    }
    console.log(`  ${allOdds.length} odds snapshots`);

    // Derive kickoff_utc for matches missing it, using odds inflection.
    // Only consider matchday snapshots (days_before_kickoff=0) to avoid
    // false positives from stale odds posted weeks before the match.
    // Strategy: find the earliest matchday snapshot where odds become
    // extreme (any 1X2 leg < 1.10 or > 50) — that's clearly in-play.
    // Kickoff ≈ a few minutes before that first extreme snapshot.
    // Fallback: match date + "15:00:00Z" (typical EPL weekend kick).
    const oddsByMatch = new Map<number, OddsRow[]>();
    for (const o of allOdds) {
      const mid = fidToMatchId.get(o.fixture_id);
      if (mid === undefined) continue;
      const arr = oddsByMatch.get(mid) || [];
      arr.push(o);
      oddsByMatch.set(mid, arr);
    }

    for (const m of teamMatches) {
      if (m.kickoff_utc) continue; // already have it
      const odds = oddsByMatch.get(m.match_id);
      if (!odds || odds.length === 0) continue;

      // Only matchday snapshots (days_before_kickoff=0) AND on the match date
      const matchdayOdds = odds.filter(o => {
        if (o.days_before_kickoff !== 0) return false;
        // Also verify the snapshot is actually on the match date
        const snapDate = o.snapshot_time.slice(0, 10);
        return snapDate === m.date;
      });

      // Sort by time
      matchdayOdds.sort((a, b) => a.snapshot_time.localeCompare(b.snapshot_time));

      // Find first matchday snapshot with extreme odds (clear in-play signal)
      let inflectionTime: string | null = null;
      for (const s of matchdayOdds) {
        const h = s.home_odds, d = s.draw_odds, a = s.away_odds;
        if (!h || !d || !a) continue;
        if (h < 1.10 || d < 1.10 || a < 1.10 || h > 50 || d > 50 || a > 50) {
          inflectionTime = s.snapshot_time;
          break;
        }
      }

      if (inflectionTime) {
        // Kickoff ≈ 5 min before first extreme odds snapshot
        const t = new Date(inflectionTime);
        t.setMinutes(t.getMinutes() - 5);
        m.kickoff_utc = t.toISOString();
      } else if (matchdayOdds.length > 0) {
        // No extreme odds found on matchday — might not have in-play data.
        // Use last prematch snapshot + ~2h as rough kickoff estimate.
        const lastPrematch = matchdayOdds[matchdayOdds.length - 1];
        const t = new Date(lastPrematch.snapshot_time);
        t.setHours(t.getHours() + 2);
        m.kickoff_utc = t.toISOString();
      } else if (m.status === "finished") {
        // No matchday odds at all — use date + 15:00 UTC
        m.kickoff_utc = `${m.date}T15:00:00Z`;
      }
    }

    // Load stored prices for this team
    const prices = await fetchAll<PriceRow>(
      "team_prices", "team, date, implied_elo, dollar_price, drift_elo",
      [["team", "eq", TEAM], ["model", "eq", "oracle"]], "date",
    );
    const priceByDate = new Map(prices.map(p => [p.date, p]));

    // ── Write matches CSV ──
    const mHeaders = [
      "match_id",
      "date",
      "kickoff_utc",
      "league",
      "home_team",
      "away_team",
      "home_goals",
      "away_goals",
      "result",
      "status",
      // Team perspective
      "team",
      "team_venue",
      "opponent",
      "team_goals",
      "opponent_goals",
      "team_result",
      // Team Elo (pure match-result, no odds blend)
      "team_elo_recentered",
      "team_elo_raw",
      // Team stored Elo (includes odds blend)
      "team_elo_blended",
      "team_dollar_price",
      "team_drift_elo",
      // Opponent Elo
      "opponent_elo_recentered",
      "opponent_elo_raw",
      // Opponent stored Elo
      "opponent_elo_blended",
      "opponent_dollar_price",
    ];

    const mRows: string[] = [mHeaders.join(",")];

    // Load opponent prices in bulk (for all opponents)
    const opponents = new Set(teamMatches.map(m => m.home_team === TEAM ? m.away_team : m.home_team));
    const oppPrices = new Map<string, Map<string, PriceRow>>();
    for (const opp of opponents) {
      const op = await fetchAll<PriceRow>(
        "team_prices", "team, date, implied_elo, dollar_price, drift_elo",
        [["team", "eq", opp], ["model", "eq", "oracle"]], "date",
      );
      oppPrices.set(opp, new Map(op.map(p => [p.date, p])));
    }

    for (const m of teamMatches) {
      const isHome = m.home_team === TEAM;
      const opp = isHome ? m.away_team : m.home_team;
      const teamGoals = isHome ? m.home_goals : m.away_goals;
      const oppGoals = isHome ? m.away_goals : m.home_goals;
      let teamResult = "";
      if (teamGoals !== null && oppGoals !== null) {
        teamResult = teamGoals > oppGoals ? "W" : teamGoals < oppGoals ? "L" : "D";
      }

      const tElo = eloStore.get(TEAM)?.get(m.date);
      const oElo = eloStore.get(opp)?.get(m.date);
      const tPrice = priceByDate.get(m.date);
      const oPrice = oppPrices.get(opp)?.get(m.date);

      mRows.push(csvRow([
        m.match_id, m.date, m.kickoff_utc ?? "",
        m.league, m.home_team, m.away_team,
        m.home_goals ?? "", m.away_goals ?? "",
        m.result, m.status,
        TEAM, isHome ? "H" : "A", opp,
        teamGoals ?? "", oppGoals ?? "", teamResult,
        tElo ? Math.round(tElo.recentered * 10) / 10 : "",
        tElo ? Math.round(tElo.raw * 10) / 10 : "",
        tPrice?.implied_elo ?? "", tPrice?.dollar_price ?? "", tPrice?.drift_elo ?? "",
        oElo ? Math.round(oElo.recentered * 10) / 10 : "",
        oElo ? Math.round(oElo.raw * 10) / 10 : "",
        oPrice?.implied_elo ?? "", oPrice?.dollar_price ?? "",
      ]));
    }

    writeFileSync(resolve(outDir, `${slug}-matches.csv`), mRows.join("\n"), "utf-8");

    // ── Write odds CSV ──
    const oHeaders = [
      "match_id",
      "match_date",
      "kickoff_utc",
      "home_team",
      "away_team",
      "bookmaker",
      "snapshot_time",
      "phase",
      "days_before_kickoff",
      // Raw decimal odds (not de-vigged)
      "home_odds",
      "draw_odds",
      "away_odds",
      // Team perspective (raw decimal, not de-vigged)
      "team",
      "team_venue",
      "team_win_odds",
      "team_draw_odds",
      "team_lose_odds",
    ];

    const oRows: string[] = [oHeaders.join(",")];

    for (const o of allOdds) {
      const mid = fidToMatchId.get(o.fixture_id);
      if (mid === undefined) continue;
      const m = teamMatches.find(tm => tm.match_id === mid);
      if (!m) continue;

      // Determine phase
      let phase = "prematch";
      if (m.kickoff_utc && o.snapshot_time) {
        const kickMs = new Date(m.kickoff_utc).getTime();
        const snapMs = new Date(o.snapshot_time).getTime();
        if (snapMs >= kickMs) phase = "inplay";
      }

      const isHome = m.home_team === TEAM;
      const teamWin = isHome ? o.home_odds : o.away_odds;
      const teamLose = isHome ? o.away_odds : o.home_odds;

      oRows.push(csvRow([
        mid, m.date, m.kickoff_utc ?? "",
        m.home_team, m.away_team,
        o.bookmaker, o.snapshot_time, phase,
        o.days_before_kickoff ?? "",
        o.home_odds ?? "", o.draw_odds ?? "", o.away_odds ?? "",
        TEAM, isHome ? "H" : "A",
        teamWin ?? "", o.draw_odds ?? "", teamLose ?? "",
      ]));
    }

    writeFileSync(resolve(outDir, `${slug}-odds.csv`), oRows.join("\n"), "utf-8");

    console.log(`  → ${slug}-matches.csv  (${mRows.length - 1} rows)`);
    console.log(`  → ${slug}-odds.csv     (${oRows.length - 1} rows)`);
    summary.push({ team: TEAM, matches: mRows.length - 1, odds: oRows.length - 1 });
  }

  // ── Summary ──
  console.log("\n" + "═".repeat(70));
  console.log("  EXPORT COMPLETE → data/epl-top10/");
  console.log("═".repeat(70));
  console.log("  Team                      │ Matches │ Odds Rows");
  console.log("  ──────────────────────────┼─────────┼──────────");
  let tM = 0, tO = 0;
  for (const s of summary) {
    console.log(`  ${s.team.padEnd(26)} │ ${s.matches.toString().padStart(7)} │ ${s.odds.toString().padStart(9)}`);
    tM += s.matches; tO += s.odds;
  }
  console.log("  ──────────────────────────┼─────────┼──────────");
  console.log(`  ${"TOTAL".padEnd(26)} │ ${tM.toString().padStart(7)} │ ${tO.toString().padStart(9)}`);
  console.log(`\n  Output: ${outDir}`);
  console.log("\n  CSV SCHEMA:");
  console.log("  ─────────────────────────────────────────────────────────");
  console.log("  {team}-matches.csv:");
  console.log("    match_id              Canonical (API-Football preferred, stable)");
  console.log("    kickoff_utc           Exact kickoff (from API-Football or derived from odds)");
  console.log("    home/away_goals       Parsed from score, null if not finished");
  console.log("    result                H/D/A from home perspective");
  console.log("    team_result           W/D/L from team perspective");
  console.log("    team_elo_recentered   Pure match-result Elo (global mean=1500)");
  console.log("    team_elo_raw          Pure match-result Elo (NO re-centering)");
  console.log("    team_elo_blended      Stored implied_elo (includes 30% odds blend)");
  console.log("    opponent_elo_*        Same columns for opponent");
  console.log("");
  console.log("  {team}-odds.csv:");
  console.log("    match_id              Links to matches CSV (1:N)");
  console.log("    phase                 prematch | inplay");
  console.log("    home/draw/away_odds   Raw decimal odds (NOT de-vigged)");
  console.log("    team_win/draw/lose    Same odds from team perspective");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
