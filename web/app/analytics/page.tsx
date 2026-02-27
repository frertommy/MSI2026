import { supabase } from "@/lib/supabase";
import { AnalyticsClient } from "./analytics-client";

// ─── Types ─────────────────────────────────────────────────
interface PriceRow {
  team: string;
  league: string;
  date: string;
  model: string;
  dollar_price: number;
}

interface MatchProbRow {
  fixture_id: number;
  model: string;
  date: string;
  home_team: string;
  away_team: string;
  implied_home_win: number;
  implied_draw: number;
  implied_away_win: number;
  bookmaker_home_win: number;
  bookmaker_draw: number;
  bookmaker_away_win: number;
  edge_home: number;
  edge_draw: number;
  edge_away: number;
}

interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
}

// ─── Paginated fetch helper ────────────────────────────────
async function fetchAll<T>(
  table: string,
  select: string,
  filters?: Record<string, string>
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (filters) {
      for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    }
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

// ─── Compute metrics ───────────────────────────────────────
const MODELS = ["smooth", "reactive", "sharp", "oracle"];
const LEAGUES = ["Premier League", "La Liga", "Bundesliga", "Serie A", "Ligue 1"];

function parseScore(score: string): [number, number] | null {
  const p = score.split("-");
  if (p.length !== 2) return null;
  const h = parseInt(p[0]);
  const a = parseInt(p[1]);
  if (isNaN(h) || isNaN(a)) return null;
  return [h, a];
}

export interface ModelVolatility {
  model: string;
  avgDailyChange: number;
  matchDayVol: number;
  nonMatchDayVol: number;
  volRatio: number;
}

export interface BrierResult {
  model: string;
  brier: number;
  n: number;
}

export interface ArbFrequency {
  model: string;
  total: number;
  arbs: number;
  pct: number;
}

export interface LeagueCorrelation {
  league: string;
  model: string;
  avgCorr: number;
}

export interface PriceHistBucket {
  bucket: string;
  smooth: number;
  reactive: number;
  sharp: number;
  oracle: number;
}

export interface RollingVolPoint {
  date: string;
  smooth: number;
  reactive: number;
  sharp: number;
  oracle: number;
}

function computeMetrics(
  prices: PriceRow[],
  probs: MatchProbRow[],
  matches: MatchRow[]
) {
  // Build match dates set for all teams
  const matchDates = new Set<string>();
  const teamMatchDates = new Map<string, Set<string>>();
  for (const m of matches) {
    matchDates.add(m.date);
    if (!teamMatchDates.has(m.home_team)) teamMatchDates.set(m.home_team, new Set());
    if (!teamMatchDates.has(m.away_team)) teamMatchDates.set(m.away_team, new Set());
    teamMatchDates.get(m.home_team)!.add(m.date);
    teamMatchDates.get(m.away_team)!.add(m.date);
  }

  // Group prices by model → team → sorted date array
  const byModelTeam = new Map<string, Map<string, PriceRow[]>>();
  for (const model of MODELS) byModelTeam.set(model, new Map());
  for (const p of prices) {
    const mt = byModelTeam.get(p.model);
    if (!mt) continue;
    if (!mt.has(p.team)) mt.set(p.team, []);
    mt.get(p.team)!.push(p);
  }
  for (const mt of byModelTeam.values()) {
    for (const rows of mt.values()) {
      rows.sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  // ─── 1. Daily volatility per model ─────────────────────
  const volatility: ModelVolatility[] = [];
  for (const model of MODELS) {
    const mt = byModelTeam.get(model)!;
    let allChanges: number[] = [];
    let matchDayChanges: number[] = [];
    let nonMatchDayChanges: number[] = [];

    for (const [team, rows] of mt) {
      const tmd = teamMatchDates.get(team) ?? new Set<string>();
      for (let i = 1; i < rows.length; i++) {
        const change = Math.abs(rows[i].dollar_price - rows[i - 1].dollar_price);
        allChanges.push(change);
        if (tmd.has(rows[i].date)) {
          matchDayChanges.push(change);
        } else {
          nonMatchDayChanges.push(change);
        }
      }
    }

    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const mdVol = avg(matchDayChanges);
    const nmdVol = avg(nonMatchDayChanges);

    volatility.push({
      model,
      avgDailyChange: avg(allChanges),
      matchDayVol: mdVol,
      nonMatchDayVol: nmdVol,
      volRatio: nmdVol > 0 ? mdVol / nmdVol : 0,
    });
  }

  // ─── 2. Brier score ────────────────────────────────────
  // Build actual results map: fixture_id → {homeWin, draw, awayWin}
  const actualResults = new Map<number, { h: number; d: number; a: number }>();
  for (const m of matches) {
    const sc = parseScore(m.score);
    if (!sc) continue;
    const [hg, ag] = sc;
    actualResults.set(m.fixture_id, {
      h: hg > ag ? 1 : 0,
      d: hg === ag ? 1 : 0,
      a: ag > hg ? 1 : 0,
    });
  }

  const brierResults: BrierResult[] = [];
  for (const model of MODELS) {
    const modelProbs = probs.filter((p) => p.model === model);
    let sum = 0;
    let n = 0;
    for (const p of modelProbs) {
      const actual = actualResults.get(p.fixture_id);
      if (!actual) continue;
      // Brier = avg of (predicted - actual)^2 for each outcome
      sum +=
        (p.implied_home_win - actual.h) ** 2 +
        (p.implied_draw - actual.d) ** 2 +
        (p.implied_away_win - actual.a) ** 2;
      n++;
    }
    brierResults.push({
      model,
      brier: n > 0 ? sum / n : 0,
      n,
    });
  }

  // ─── 3. Arb frequency (edges > 3%) ────────────────────
  const arbFreq: ArbFrequency[] = [];
  for (const model of MODELS) {
    const modelProbs = probs.filter((p) => p.model === model);
    let arbs = 0;
    for (const p of modelProbs) {
      if (
        Math.abs(p.edge_home) > 0.03 ||
        Math.abs(p.edge_draw) > 0.03 ||
        Math.abs(p.edge_away) > 0.03
      ) {
        arbs++;
      }
    }
    arbFreq.push({
      model,
      total: modelProbs.length,
      arbs,
      pct: modelProbs.length > 0 ? (arbs / modelProbs.length) * 100 : 0,
    });
  }

  // ─── 4. Cross-team correlation per league ──────────────
  // For each league+model: compute avg pairwise correlation of daily price changes
  const leagueCorr: LeagueCorrelation[] = [];
  for (const league of LEAGUES) {
    for (const model of MODELS) {
      const mt = byModelTeam.get(model)!;
      // Get teams in this league
      const leagueTeams: string[] = [];
      for (const [team, rows] of mt) {
        if (rows.length > 0 && rows[0].league === league) leagueTeams.push(team);
      }

      if (leagueTeams.length < 2) {
        leagueCorr.push({ league, model, avgCorr: 0 });
        continue;
      }

      // Build change vectors per team
      const changeVectors = new Map<string, number[]>();
      for (const team of leagueTeams) {
        const rows = mt.get(team)!;
        const changes: number[] = [];
        for (let i = 1; i < rows.length; i++) {
          changes.push(rows[i].dollar_price - rows[i - 1].dollar_price);
        }
        changeVectors.set(team, changes);
      }

      // Pairwise correlations (sample up to 20 pairs for speed)
      let corrSum = 0;
      let corrCount = 0;
      for (let i = 0; i < leagueTeams.length && corrCount < 40; i++) {
        for (let j = i + 1; j < leagueTeams.length && corrCount < 40; j++) {
          const a = changeVectors.get(leagueTeams[i])!;
          const b = changeVectors.get(leagueTeams[j])!;
          const len = Math.min(a.length, b.length);
          if (len < 3) continue;
          const meanA = a.slice(0, len).reduce((s, v) => s + v, 0) / len;
          const meanB = b.slice(0, len).reduce((s, v) => s + v, 0) / len;
          let num = 0, denA = 0, denB = 0;
          for (let k = 0; k < len; k++) {
            num += (a[k] - meanA) * (b[k] - meanB);
            denA += (a[k] - meanA) ** 2;
            denB += (b[k] - meanB) ** 2;
          }
          const denom = Math.sqrt(denA * denB);
          if (denom > 0) {
            corrSum += num / denom;
            corrCount++;
          }
        }
      }
      leagueCorr.push({
        league,
        model,
        avgCorr: corrCount > 0 ? corrSum / corrCount : 0,
      });
    }
  }

  // ─── 5. Price distribution histogram ───────────────────
  // Latest price per team per model, bucketed into ranges
  const buckets = ["$0-20", "$20-35", "$35-50", "$50-65", "$65-80", "$80-100"];
  const getBucket = (p: number) => {
    if (p < 20) return 0;
    if (p < 35) return 1;
    if (p < 50) return 2;
    if (p < 65) return 3;
    if (p < 80) return 4;
    return 5;
  };
  const histData: PriceHistBucket[] = buckets.map((b) => ({
    bucket: b,
    smooth: 0,
    reactive: 0,
    sharp: 0,
    oracle: 0,
  }));
  for (const model of MODELS) {
    const mt = byModelTeam.get(model)!;
    for (const [, rows] of mt) {
      if (rows.length === 0) continue;
      const latest = rows[rows.length - 1].dollar_price;
      const idx = getBucket(latest);
      (histData[idx] as unknown as Record<string, number>)[model]++;
    }
  }

  // ─── 6. Rolling 7-day volatility ──────────────────────
  // For each date, compute avg |daily change| across all teams over trailing 7 days
  const allDates = [...new Set(prices.map((p) => p.date))].sort();
  const rollingVol: RollingVolPoint[] = [];
  for (let di = 7; di < allDates.length; di++) {
    const date = allDates[di];
    const windowDates = new Set(allDates.slice(di - 6, di + 1));
    const point: Record<string, number> = { smooth: 0, reactive: 0, sharp: 0, oracle: 0 };
    const counts: Record<string, number> = { smooth: 0, reactive: 0, sharp: 0, oracle: 0 };

    for (const model of MODELS) {
      const mt = byModelTeam.get(model)!;
      for (const [, rows] of mt) {
        const windowRows = rows.filter((r) => windowDates.has(r.date));
        for (let i = 1; i < windowRows.length; i++) {
          point[model] += Math.abs(windowRows[i].dollar_price - windowRows[i - 1].dollar_price);
          counts[model]++;
        }
      }
      if (counts[model] > 0) point[model] /= counts[model];
    }
    rollingVol.push({
      date,
      smooth: Math.round(point.smooth * 1000) / 1000,
      reactive: Math.round(point.reactive * 1000) / 1000,
      sharp: Math.round(point.sharp * 1000) / 1000,
      oracle: Math.round(point.oracle * 1000) / 1000,
    });
  }

  return { volatility, brierResults, arbFreq, leagueCorr, histData, rollingVol };
}

// ─── Server component ──────────────────────────────────────
export const revalidate = 300;

export default async function AnalyticsPage() {
  const [prices, probs, matches] = await Promise.all([
    fetchAll<PriceRow>("team_prices", "team, league, date, model, dollar_price"),
    fetchAll<MatchProbRow>(
      "match_probabilities",
      "fixture_id, model, date, home_team, away_team, implied_home_win, implied_draw, implied_away_win, bookmaker_home_win, bookmaker_draw, bookmaker_away_win, edge_home, edge_draw, edge_away"
    ),
    fetchAll<MatchRow>("matches", "fixture_id, date, league, home_team, away_team, score"),
  ]);

  const metrics = computeMetrics(prices, probs, matches);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto max-w-7xl flex items-center gap-4">
          <a
            href="/"
            className="text-muted hover:text-foreground transition-colors text-sm"
          >
            &larr; Rankings
          </a>
          <div className="h-2 w-2 rounded-full bg-accent-green animate-pulse" />
          <h1 className="text-lg font-bold tracking-wider text-foreground uppercase">
            Model Analytics
          </h1>
          <span className="text-xs text-muted font-mono ml-auto">
            {prices.length} prices &middot; {probs.length} predictions &middot;{" "}
            {matches.length} matches
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <AnalyticsClient {...metrics} />
      </main>
    </div>
  );
}
