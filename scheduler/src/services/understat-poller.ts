/**
 * Understat xG poller — scrapes expected goals data from Understat league pages.
 * Data is stored in match_xg table and used by the pricing engine to scale
 * shock magnitude: dominant wins get amplified, lucky wins get dampened.
 *
 * Understat is free, no API key needed. We rate-limit with 500ms delays.
 */
import { getSupabase, upsertBatched, fetchAllRows } from "../api/supabase-client.js";
import { log } from "../logger.js";

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

// ─── Understat name → our canonical name (API-Football) ───────
// Understat uses short names like "Manchester United", our matches table
// stores "Manchester United FC". This maps Understat → canonical.
const UNDERSTAT_NAME_MAP: Record<string, string> = {
  // Premier League
  "Manchester United": "Manchester United FC",
  "Manchester City": "Manchester City FC",
  Arsenal: "Arsenal FC",
  Chelsea: "Chelsea FC",
  Liverpool: "Liverpool FC",
  "Tottenham Hotspur": "Tottenham Hotspur FC",
  "Tottenham": "Tottenham Hotspur FC",
  "Newcastle United": "Newcastle United FC",
  "Aston Villa": "Aston Villa FC",
  "West Ham United": "West Ham United FC",
  "West Ham": "West Ham United FC",
  Brighton: "Brighton & Hove Albion FC",
  "Brighton and Hove Albion": "Brighton & Hove Albion FC",
  Brentford: "Brentford FC",
  "Crystal Palace": "Crystal Palace FC",
  Fulham: "Fulham FC",
  Bournemouth: "AFC Bournemouth",
  Wolverhampton: "Wolverhampton Wanderers FC",
  "Wolverhampton Wanderers": "Wolverhampton Wanderers FC",
  Wolves: "Wolverhampton Wanderers FC",
  Everton: "Everton FC",
  "Nottingham Forest": "Nottingham Forest FC",
  Leicester: "Leicester City FC",
  "Leicester City": "Leicester City FC",
  Ipswich: "Ipswich Town FC",
  "Ipswich Town": "Ipswich Town FC",
  Southampton: "Southampton FC",
  Burnley: "Burnley FC",
  Leeds: "Leeds United FC",
  "Leeds United": "Leeds United FC",
  "Luton Town": "Luton Town FC",
  "Sheffield United": "Sheffield United FC",

  // La Liga
  "Real Madrid": "Real Madrid CF",
  Barcelona: "FC Barcelona",
  "Atletico Madrid": "Club Atlético de Madrid",
  "Athletic Club": "Athletic Club",
  "Real Sociedad": "Real Sociedad de Fútbol",
  "Real Betis": "Real Betis Balompié",
  Villarreal: "Villarreal CF",
  Sevilla: "Sevilla FC",
  Valencia: "Valencia CF",
  "Celta Vigo": "RC Celta de Vigo",
  Osasuna: "CA Osasuna",
  Mallorca: "RCD Mallorca",
  Getafe: "Getafe CF",
  "Rayo Vallecano": "Rayo Vallecano de Madrid",
  Girona: "Girona FC",
  Alaves: "Deportivo Alavés",
  Espanyol: "RCD Espanyol de Barcelona",
  "Las Palmas": "UD Las Palmas",
  Leganes: "CD Leganés",
  Valladolid: "Real Valladolid CF",

  // Bundesliga
  "Bayern Munich": "FC Bayern München",
  "Bayer Leverkusen": "Bayer 04 Leverkusen",
  "Borussia Dortmund": "BV Borussia 09 Dortmund",
  "RB Leipzig": "RasenBallsport Leipzig",
  "Eintracht Frankfurt": "Eintracht Frankfurt",
  "VfB Stuttgart": "VfB Stuttgart",
  Freiburg: "Sport-Club Freiburg",
  "SC Freiburg": "Sport-Club Freiburg",
  Wolfsburg: "VfL Wolfsburg",
  "VfL Wolfsburg": "VfL Wolfsburg",
  "Borussia M.Gladbach": "Borussia Mönchengladbach",
  "Borussia Monchengladbach": "Borussia Mönchengladbach",
  "Union Berlin": "1. FC Union Berlin",
  "Werder Bremen": "SV Werder Bremen",
  Augsburg: "FC Augsburg",
  "FC Augsburg": "FC Augsburg",
  Hoffenheim: "TSG 1899 Hoffenheim",
  Mainz: "1. FSV Mainz 05",
  "Mainz 05": "1. FSV Mainz 05",
  Heidenheim: "1. FC Heidenheim 1846",
  "FC Heidenheim": "1. FC Heidenheim 1846",
  "St. Pauli": "FC St. Pauli 1910",
  "FC St. Pauli": "FC St. Pauli 1910",
  Holstein: "Holstein Kiel",
  "Holstein Kiel": "Holstein Kiel",
  Bochum: "VfL Bochum 1848",
  "VfL Bochum": "VfL Bochum 1848",
  "Hamburger SV": "Hamburger SV",

  // Serie A
  Inter: "FC Internazionale Milano",
  "Inter Milan": "FC Internazionale Milano",
  Napoli: "SSC Napoli",
  Juventus: "Juventus FC",
  Milan: "AC Milan",
  "AC Milan": "AC Milan",
  Atalanta: "Atalanta BC",
  Lazio: "SS Lazio",
  Roma: "AS Roma",
  "AS Roma": "AS Roma",
  Fiorentina: "ACF Fiorentina",
  Bologna: "Bologna FC 1909",
  Torino: "Torino FC",
  Udinese: "Udinese Calcio",
  Genoa: "Genoa CFC",
  Cagliari: "Cagliari Calcio",
  Empoli: "Empoli FC",
  "Empoli FC": "Empoli FC",
  Parma: "Parma Calcio 1913",
  "Parma Calcio 1913": "Parma Calcio 1913",
  Como: "Como 1907",
  "Como 1907": "Como 1907",
  Verona: "Hellas Verona FC",
  "Hellas Verona": "Hellas Verona FC",
  Lecce: "US Lecce",
  Monza: "AC Monza",
  "AC Monza": "AC Monza",
  Sassuolo: "US Sassuolo Calcio",
  Venezia: "Venezia FC",
  "Venezia FC": "Venezia FC",

  // Ligue 1
  "Paris Saint Germain": "Paris Saint-Germain FC",
  "Paris Saint-Germain": "Paris Saint-Germain FC",
  Marseille: "Olympique de Marseille",
  Monaco: "AS Monaco FC",
  Lyon: "Olympique Lyonnais",
  Lille: "Lille OSC",
  Nice: "OGC Nice",
  Rennes: "Stade Rennais FC 1901",
  Lens: "Racing Club de Lens",
  Strasbourg: "RC Strasbourg Alsace",
  Toulouse: "Toulouse FC",
  Nantes: "FC Nantes",
  Montpellier: "Montpellier HSC",
  "Montpellier HSC": "Montpellier HSC",
  Reims: "Stade de Reims",
  "Stade de Reims": "Stade de Reims",
  Brest: "Stade Brestois 29",
  "Stade Brestois 29": "Stade Brestois 29",
  "Le Havre": "Le Havre AC",
  Auxerre: "AJ Auxerre",
  Angers: "Angers SCO",
  "Saint-Etienne": "AS Saint-Étienne",
  "Saint Etienne": "AS Saint-Étienne",
};

function resolveUnderstatName(name: string): string {
  return UNDERSTAT_NAME_MAP[name] ?? name;
}

// ─── Understat data types ─────────────────────────────────────
interface UnderstatMatch {
  id: string;
  isResult: boolean;
  datetime: string;
  home: { title: string; id: string };
  away: { title: string; id: string };
  goals: { h: string; a: string };
  xG: { h: string; a: string };
  forecast: { w: string; d: string; l: string };
}

// ─── Parse hex-encoded JSON from Understat ────────────────────
function decodeHex(encoded: string): string {
  return encoded.replace(/\\x([0-9A-Fa-f]{2})/g, (_match, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Scrape one league page ───────────────────────────────────
async function scrapeLeague(slug: string): Promise<UnderstatMatch[]> {
  const url = `https://understat.com/league/${slug}/${SEASON}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; MSI2026-bot/1.0; +https://github.com/frertommy/MSI2026)",
    },
  });

  if (!resp.ok) {
    throw new Error(`Understat HTTP ${resp.status} for ${slug}`);
  }

  const html = await resp.text();

  // Find the datesData JSON blob in a <script> tag
  const marker = "datesData";
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error(`datesData not found in ${slug} page`);
  }

  // Pattern: datesData = JSON.parse('...')
  const startQuote = html.indexOf("('", markerIdx);
  if (startQuote === -1) {
    throw new Error(`Could not find JSON.parse start quote for ${slug}`);
  }
  const endQuote = html.indexOf("')", startQuote + 2);
  if (endQuote === -1) {
    throw new Error(`Could not find JSON.parse end quote for ${slug}`);
  }

  const hexEncoded = html.slice(startQuote + 2, endQuote);
  const decoded = decodeHex(hexEncoded);

  let parsed: UnderstatMatch[];
  try {
    parsed = JSON.parse(decoded) as UnderstatMatch[];
  } catch (err) {
    throw new Error(
      `Failed to parse datesData JSON for ${slug}: ${err instanceof Error ? err.message : err}`
    );
  }

  return parsed;
}

// ─── Match to fixtures ────────────────────────────────────────
async function lookupFixtureId(
  date: string,
  homeTeam: string,
  awayTeam: string
): Promise<number | null> {
  const sb = getSupabase();

  // Try exact match first
  const { data } = await sb
    .from("matches")
    .select("fixture_id")
    .eq("date", date)
    .eq("home_team", homeTeam)
    .eq("away_team", awayTeam)
    .limit(1)
    .single();

  if (data) return data.fixture_id as number;

  // Try ±1 day for timezone edge cases
  const dateObj = new Date(date);
  const dayBefore = new Date(dateObj.getTime() - 86400000)
    .toISOString()
    .slice(0, 10);
  const dayAfter = new Date(dateObj.getTime() + 86400000)
    .toISOString()
    .slice(0, 10);

  for (const d of [dayBefore, dayAfter]) {
    const { data: fuzzy } = await sb
      .from("matches")
      .select("fixture_id")
      .eq("date", d)
      .eq("home_team", homeTeam)
      .eq("away_team", awayTeam)
      .limit(1)
      .single();
    if (fuzzy) return fuzzy.fixture_id as number;
  }

  return null;
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
  const rows: Record<string, unknown>[] = [];
  let totalMatches = 0;
  let fixturesMatched = 0;

  const leagues = Object.entries(UNDERSTAT_SLUGS);

  for (let i = 0; i < leagues.length; i++) {
    const [league, slug] = leagues[i];

    try {
      const matches = await scrapeLeague(slug);
      const completed = matches.filter((m) => m.isResult);
      totalMatches += completed.length;
      log.info(`  Understat ${league}: ${completed.length} completed matches`);

      for (const m of completed) {
        const homeTeam = resolveUnderstatName(m.home.title);
        const awayTeam = resolveUnderstatName(m.away.title);
        const date = m.datetime.slice(0, 10); // "2026-01-15 17:30:00" → "2026-01-15"

        const fixtureId = await lookupFixtureId(date, homeTeam, awayTeam);
        if (fixtureId !== null) fixturesMatched++;

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
