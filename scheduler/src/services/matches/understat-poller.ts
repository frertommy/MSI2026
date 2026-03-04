/**
 * Understat xG poller — scrapes expected goals data from Understat league pages.
 * Data is stored in match_xg table and used by the pricing engine to scale
 * shock magnitude: dominant wins get amplified, lucky wins get dampened.
 *
 * Understat is free, no API key needed. We rate-limit with 500ms delays.
 */
import { getSupabase, upsertBatched, fetchAllRows } from "../../core/supabase.js";
import { log } from "../../core/logger.js";

// ─── Understat league slugs ───────────────────────────────────
const UNDERSTAT_SLUGS: Record<string, string> = {
  "Premier League": "EPL",
  "La Liga": "La_liga",
  Bundesliga: "Bundesliga",
  "Serie A": "Serie_A",
  "Ligue 1": "Ligue_1",
};

// Current season: 2025 = 2025/26
const SEASON = 2025;

// ─── Understat name → matches table name ─────────────────────
// Only map names that differ between Understat and our matches table.
// Most names match directly (Arsenal, Chelsea, Liverpool, etc.).
const UNDERSTAT_NAME_MAP: Record<string, string> = {
  // Premier League
  "Newcastle United": "Newcastle",
  "Wolverhampton Wanderers": "Wolves",

  // La Liga
  "Real Oviedo": "Oviedo",

  // Bundesliga
  "Augsburg": "FC Augsburg",
  "Bayern Munich": "Bayern München",
  "Borussia M.Gladbach": "Borussia Mönchengladbach",
  "FC Cologne": "1. FC Köln",
  "FC Heidenheim": "1. FC Heidenheim",
  "Freiburg": "SC Freiburg",
  "Hoffenheim": "1899 Hoffenheim",
  "Mainz 05": "FSV Mainz 05",
  "RasenBallsport Leipzig": "RB Leipzig",
  "St. Pauli": "FC St. Pauli",
  "Wolfsburg": "VfL Wolfsburg",

  // Serie A
  "Parma Calcio 1913": "Parma",
  "Roma": "AS Roma",
  "Verona": "Hellas Verona",

  // Ligue 1
  "Brest": "Stade Brestois 29",
};

function resolveUnderstatName(name: string): string {
  return UNDERSTAT_NAME_MAP[name] ?? name;
}

// ─── Understat data types ─────────────────────────────────────
// API response uses short keys: h/a instead of home/away
interface UnderstatMatch {
  id: string;
  isResult: boolean;
  datetime: string;
  h: { title: string; id: string; short_title: string };
  a: { title: string; id: string; short_title: string };
  goals: { h: string; a: string };
  xG: { h: string; a: string };
  forecast: { w: string; d: string; l: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Fetch one league via Understat AJAX API ─────────────────
async function fetchLeague(slug: string): Promise<UnderstatMatch[]> {
  const url = `https://understat.com/getLeagueData/${slug}/${SEASON}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json",
      "Referer": `https://understat.com/league/${slug}/${SEASON}`,
    },
  });

  if (!resp.ok) {
    throw new Error(`Understat HTTP ${resp.status} for ${slug}`);
  }

  const data = await resp.json();
  return (data.dates ?? []) as UnderstatMatch[];
}

// ─── Batch fixture lookup ─────────────────────────────────────
// Load all matches into an in-memory map for fast lookup instead of
// 1,241 individual DB queries. Keys: "date|home|away" and "±1day|home|away".
async function buildFixtureLookup(): Promise<Map<string, number>> {
  const lookup = new Map<string, number>();
  const rows = await fetchAllRows<Record<string, unknown>>(
    "matches",
    "fixture_id, date, home_team, away_team"
  );

  for (const r of rows) {
    const fid = r.fixture_id as number;
    const date = String(r.date);
    const home = String(r.home_team);
    const away = String(r.away_team);

    // Exact date key
    lookup.set(`${date}|${home}|${away}`, fid);

    // ±1 day for timezone edge cases
    const d = new Date(date);
    const dayBefore = new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
    const dayAfter = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
    // Only set fuzzy keys if they don't overwrite an exact match
    if (!lookup.has(`${dayBefore}|${home}|${away}`)) {
      lookup.set(`${dayBefore}|${home}|${away}`, fid);
    }
    if (!lookup.has(`${dayAfter}|${home}|${away}`)) {
      lookup.set(`${dayAfter}|${home}|${away}`, fid);
    }
  }

  log.info(`  Fixture lookup: ${rows.length} matches loaded`);
  return lookup;
}

// ═══════════════════════════════════════════════════════════════
// pollUnderstatXg — scrape all 5 leagues, upsert to match_xg
// ═══════════════════════════════════════════════════════════════
export async function pollUnderstatXg(): Promise<{
  rowsUpserted: number;
  matchesScraped: number;
  fixturesMatched: number;
}> {
  log.info("Understat: polling xG data...");

  // Build in-memory fixture lookup (replaces 1,241 individual DB queries)
  const fixtureLookup = await buildFixtureLookup();

  const rows: Record<string, unknown>[] = [];
  let totalMatches = 0;
  let fixturesMatched = 0;
  const unmatchedNames = new Set<string>();

  const leagues = Object.entries(UNDERSTAT_SLUGS);

  for (let i = 0; i < leagues.length; i++) {
    const [league, slug] = leagues[i];

    try {
      const matches = await fetchLeague(slug);
      const completed = matches.filter((m) => m.isResult);
      totalMatches += completed.length;
      log.info(`  Understat ${league}: ${completed.length} completed matches`);

      for (const m of completed) {
        const homeTeam = resolveUnderstatName(m.h.title);
        const awayTeam = resolveUnderstatName(m.a.title);
        const date = m.datetime.slice(0, 10); // "2026-01-15 17:30:00" → "2026-01-15"

        const key = `${date}|${homeTeam}|${awayTeam}`;
        const fixtureId = fixtureLookup.get(key) ?? null;
        if (fixtureId !== null) {
          fixturesMatched++;
        } else {
          unmatchedNames.add(`${homeTeam} vs ${awayTeam}`);
        }

        rows.push({
          understat_id: m.id,
          league,
          date,
          home_team: homeTeam,
          away_team: awayTeam,
          home_goals: parseInt(m.goals.h) || 0,
          away_goals: parseInt(m.goals.a) || 0,
          home_xg: parseFloat(m.xG.h) || 0,
          away_xg: parseFloat(m.xG.a) || 0,
          home_forecast_win: parseFloat(m.forecast.w) || null,
          away_forecast_win: parseFloat(m.forecast.l) || null,
          draw_forecast: parseFloat(m.forecast.d) || null,
          fixture_id: fixtureId,
        });
      }
    } catch (err) {
      log.warn(
        `Understat ${league} scrape failed`,
        err instanceof Error ? err.message : err
      );
    }

    // Rate limit between leagues
    if (i < leagues.length - 1) await sleep(500);
  }

  if (unmatchedNames.size > 0) {
    log.warn(`  ${unmatchedNames.size} unmatched team pairs: ${[...unmatchedNames].slice(0, 10).join(", ")}${unmatchedNames.size > 10 ? "..." : ""}`);
  }

  if (rows.length === 0) {
    log.info("Understat: no completed matches found");
    return { rowsUpserted: 0, matchesScraped: 0, fixturesMatched: 0 };
  }

  const { inserted, failed } = await upsertBatched(
    "match_xg",
    rows,
    "understat_id"
  );
  log.info(
    `Understat: ${inserted} upserted, ${failed} failed, ${fixturesMatched}/${totalMatches} matched to fixtures`
  );

  return {
    rowsUpserted: inserted,
    matchesScraped: totalMatches,
    fixturesMatched,
  };
}

// ═══════════════════════════════════════════════════════════════
// loadXgData — load xG data for the pricing engine
// ═══════════════════════════════════════════════════════════════
export interface XgEntry {
  home_xg: number;
  away_xg: number;
  home_goals: number;
  away_goals: number;
}

export async function loadXgData(): Promise<{
  byFixtureId: Map<number, XgEntry>;
  byKey: Map<string, XgEntry>;
}> {
  const byFixtureId = new Map<number, XgEntry>();
  const byKey = new Map<string, XgEntry>();

  try {
    const rows = await fetchAllRows<Record<string, unknown>>(
      "match_xg",
      "fixture_id, date, home_team, away_team, home_xg, away_xg, home_goals, away_goals"
    );

    for (const r of rows) {
      const entry: XgEntry = {
        home_xg: r.home_xg as number,
        away_xg: r.away_xg as number,
        home_goals: r.home_goals as number,
        away_goals: r.away_goals as number,
      };

      if (r.fixture_id != null) {
        byFixtureId.set(r.fixture_id as number, entry);
      }

      // Fallback key: "date|home|away"
      const key = `${r.date}|${r.home_team}|${r.away_team}`;
      byKey.set(key, entry);
    }

    log.info(
      `Loaded xG data: ${byFixtureId.size} by fixture_id, ${byKey.size} by key`
    );
  } catch (err) {
    log.warn(
      "Failed to load xG data — shocks will use multiplier=1.0",
      err instanceof Error ? err.message : err
    );
  }

  return { byFixtureId, byKey };
}
