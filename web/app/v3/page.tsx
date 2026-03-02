import { supabase } from "@/lib/supabase";
import { V3Client } from "./v3-client";

// ─── Types ─────────────────────────────────────────────────
export interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
}

export interface OddsConsensus {
  fixture_id: number;
  homeProb: number;
  drawProb: number;
  awayProb: number;
}

export interface PriceHistoryRow {
  team: string;
  date: string;
  dollar_price: number;
  implied_elo: number;
}

// ─── Legacy name map (copied from pricing-engine.ts) ───────
export const LEGACY_NAME_MAP: Record<string, string> = {
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
  "Sevilla": "Sevilla FC",
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

const LEGACY_URL =
  "https://raw.githubusercontent.com/frertommy/MSI/main/data/msi_daily.json";

// ─── Paginated fetch helper ────────────────────────────────
async function fetchAll<T>(
  table: string,
  select: string,
  filters?: Record<string, string | number>,
  orderCol?: string
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (filters) {
      for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    }
    if (orderCol) q = q.order(orderCol, { ascending: true });
    const { data, error } = await q;
    if (error) {
      console.error(`${table} fetch error:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ─── Fetch legacy Elos from GitHub ─────────────────────────
async function fetchLegacyElos(): Promise<Record<string, number>> {
  try {
    const res = await fetch(LEGACY_URL, { next: { revalidate: 3600 } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: Record<string, Array<{ date: string; rating: number }>> =
      await res.json();

    const result: Record<string, number> = {};
    for (const [legacyName, entries] of Object.entries(data)) {
      if (!entries || entries.length === 0) continue;
      // Last entry = most recent rating
      const last = entries[entries.length - 1];
      const apiName = LEGACY_NAME_MAP[legacyName] ?? legacyName;
      result[apiName] = last.rating;
    }
    return result;
  } catch (err) {
    console.error("Legacy Elo fetch failed:", err);
    return {};
  }
}

// ─── Fetch closing odds and compute consensus ──────────────
async function fetchClosingOddsConsensus(): Promise<OddsConsensus[]> {
  interface OddsRow {
    fixture_id: number;
    home_odds: number | null;
    away_odds: number | null;
    draw_odds: number | null;
  }

  const rawOdds = await fetchAll<OddsRow>(
    "odds_snapshots",
    "fixture_id, home_odds, away_odds, draw_odds",
    { days_before_kickoff: 1 }
  );

  const grouped = new Map<number, { home: number[]; draw: number[]; away: number[] }>();
  for (const row of rawOdds) {
    if (!row.home_odds || !row.away_odds || !row.draw_odds) continue;
    if (row.home_odds <= 0 || row.away_odds <= 0 || row.draw_odds <= 0) continue;
    if (!grouped.has(row.fixture_id)) {
      grouped.set(row.fixture_id, { home: [], draw: [], away: [] });
    }
    const entry = grouped.get(row.fixture_id)!;
    entry.home.push(1 / row.home_odds);
    entry.draw.push(1 / row.draw_odds);
    entry.away.push(1 / row.away_odds);
  }

  const result: OddsConsensus[] = [];
  for (const [fid, { home, draw, away }] of grouped) {
    const rawHome = home.reduce((a, b) => a + b, 0) / home.length;
    const rawDraw = draw.reduce((a, b) => a + b, 0) / draw.length;
    const rawAway = away.reduce((a, b) => a + b, 0) / away.length;
    const total = rawHome + rawDraw + rawAway;
    result.push({
      fixture_id: fid,
      homeProb: rawHome / total,
      drawProb: rawDraw / total,
      awayProb: rawAway / total,
    });
  }

  return result;
}

// ─── Server component ──────────────────────────────────────
export const revalidate = 300;

export default async function V3Page() {
  const [legacyElos, matches, oddsConsensus, priceHistory] = await Promise.all([
    fetchLegacyElos(),
    fetchAll<MatchRow>(
      "matches",
      "fixture_id, date, league, home_team, away_team, score, status",
      undefined,
      "date"
    ),
    fetchClosingOddsConsensus(),
    fetchAll<PriceHistoryRow>(
      "team_prices",
      "team, date, dollar_price, implied_elo",
      { model: "oracle" },
      "date"
    ),
  ]);

  // Determine all teams from matches
  const teamLeagues = new Map<string, string>();
  for (const m of matches) {
    if (!teamLeagues.has(m.home_team)) teamLeagues.set(m.home_team, m.league);
    if (!teamLeagues.has(m.away_team)) teamLeagues.set(m.away_team, m.league);
  }

  // Build starting elos: legacy if available, else 1500
  const startingElosArr = [...teamLeagues.entries()].map(([team, league]) => ({
    team,
    league,
    startingElo: legacyElos[team] ?? 1500,
  }));

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto max-w-[1600px] flex items-center gap-4">
          <a
            href="/"
            className="text-muted hover:text-foreground transition-colors text-sm"
          >
            &larr; Rankings
          </a>
          <div className="h-2 w-2 rounded-full bg-accent-green animate-pulse" />
          <h1 className="text-lg font-bold tracking-wider text-foreground uppercase">
            Simulation
          </h1>
          <div className="flex items-center gap-4 ml-auto">
            <a
              href="/matches"
              className="text-xs text-accent-green hover:text-foreground transition-colors font-mono uppercase tracking-wider"
            >
              Matches &rarr;
            </a>
            <a
              href="/analytics"
              className="text-xs text-accent-green hover:text-foreground transition-colors font-mono uppercase tracking-wider"
            >
              Analytics &rarr;
            </a>
            <a
              href="/v2"
              className="text-xs text-accent-green hover:text-foreground transition-colors font-mono uppercase tracking-wider"
            >
              V2 Pricing &rarr;
            </a>
            <span className="text-xs text-muted font-mono">
              {startingElosArr.length} teams &middot; {matches.length} matches &middot;{" "}
              {oddsConsensus.length} odds
            </span>
          </div>
        </div>
      </header>
      <V3Client
        startingElos={startingElosArr}
        matches={matches}
        oddsConsensus={oddsConsensus}
        priceHistory={priceHistory}
      />
    </div>
  );
}
