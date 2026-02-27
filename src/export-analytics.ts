import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";

const sb = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_KEY as string
);

// ─── Types ───────────────────────────────────────────────────
interface PriceRow {
  team: string;
  league: string;
  date: string;
  model: string;
  dollar_price: number;
  implied_elo: number;
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

const MODELS = ["smooth", "reactive", "sharp", "oracle"];
const LEAGUES = ["Premier League", "La Liga", "Bundesliga", "Serie A", "Ligue 1"];

// ─── Paginated fetch ─────────────────────────────────────────
async function fetchAll<T>(table: string, select: string): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .range(from, from + pageSize - 1);
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

// ─── Helpers ─────────────────────────────────────────────────
function parseScore(score: string): [number, number] | null {
  const p = score.split("-");
  if (p.length !== 2) return null;
  const h = parseInt(p[0]);
  const a = parseInt(p[1]);
  if (isNaN(h) || isNaN(a)) return null;
  return [h, a];
}

function pearsonCorr(a: number[], b: number[], len: number): number | null {
  if (len < 3) return null;
  const meanA = a.slice(0, len).reduce((s, v) => s + v, 0) / len;
  const meanB = b.slice(0, len).reduce((s, v) => s + v, 0) / len;
  let num = 0, denA = 0, denB = 0;
  for (let k = 0; k < len; k++) {
    num += (a[k] - meanA) * (b[k] - meanB);
    denA += (a[k] - meanA) ** 2;
    denB += (b[k] - meanB) ** 2;
  }
  const denom = Math.sqrt(denA * denB);
  return denom > 0 ? num / denom : null;
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log("Fetching data from Supabase...");
  const [prices, probs, matches] = await Promise.all([
    fetchAll<PriceRow>("team_prices", "team, league, date, model, dollar_price, implied_elo"),
    fetchAll<MatchProbRow>(
      "match_probabilities",
      "fixture_id, model, date, home_team, away_team, implied_home_win, implied_draw, implied_away_win, bookmaker_home_win, bookmaker_draw, bookmaker_away_win, edge_home, edge_draw, edge_away"
    ),
    fetchAll<MatchRow>("matches", "fixture_id, date, league, home_team, away_team, score"),
  ]);
  console.log(`  ${prices.length} prices, ${probs.length} predictions, ${matches.length} matches`);

  // ─── Build lookup structures ───────────────────────────
  const teamMatchDates = new Map<string, Set<string>>();
  for (const m of matches) {
    if (!teamMatchDates.has(m.home_team)) teamMatchDates.set(m.home_team, new Set());
    if (!teamMatchDates.has(m.away_team)) teamMatchDates.set(m.away_team, new Set());
    teamMatchDates.get(m.home_team)!.add(m.date);
    teamMatchDates.get(m.away_team)!.add(m.date);
  }

  // Group prices: model → team → sorted rows
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

  // ─── 1. Volatility stats per model ─────────────────────
  console.log("Computing volatility...");
  const volatility: Record<string, unknown>[] = [];
  for (const model of MODELS) {
    const mt = byModelTeam.get(model)!;
    const allChanges: number[] = [];
    const matchDayChanges: number[] = [];
    const nonMatchDayChanges: number[] = [];

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

    const avg = (arr: number[]) =>
      arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const stdev = (arr: number[]) => {
      if (arr.length < 2) return 0;
      const m = avg(arr);
      return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
    };

    const mdVol = avg(matchDayChanges);
    const nmdVol = avg(nonMatchDayChanges);

    volatility.push({
      model,
      avg_daily_change: round(avg(allChanges), 6),
      daily_stdev: round(stdev(allChanges), 6),
      match_day_vol: round(mdVol, 6),
      non_match_day_vol: round(nmdVol, 6),
      vol_ratio: round(nmdVol > 0 ? mdVol / nmdVol : 0, 4),
      n_changes: allChanges.length,
      n_match_day: matchDayChanges.length,
      n_non_match_day: nonMatchDayChanges.length,
    });
  }

  // ─── 2. Brier scores ──────────────────────────────────
  console.log("Computing Brier scores...");
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

  const brier_scores: Record<string, unknown>[] = [];
  for (const model of MODELS) {
    const modelProbs = probs.filter((p) => p.model === model);
    let sum = 0;
    let n = 0;
    let sumHome = 0, sumDraw = 0, sumAway = 0;
    for (const p of modelProbs) {
      const actual = actualResults.get(p.fixture_id);
      if (!actual) continue;
      const bH = (p.implied_home_win - actual.h) ** 2;
      const bD = (p.implied_draw - actual.d) ** 2;
      const bA = (p.implied_away_win - actual.a) ** 2;
      sum += bH + bD + bA;
      sumHome += bH;
      sumDraw += bD;
      sumAway += bA;
      n++;
    }
    brier_scores.push({
      model,
      brier: round(n > 0 ? sum / n : 0, 6),
      brier_home: round(n > 0 ? sumHome / n : 0, 6),
      brier_draw: round(n > 0 ? sumDraw / n : 0, 6),
      brier_away: round(n > 0 ? sumAway / n : 0, 6),
      n_matches: n,
    });
  }

  // ─── 3. Arb frequency ─────────────────────────────────
  console.log("Computing arb frequency...");
  const arb_frequency: Record<string, unknown>[] = [];
  for (const model of MODELS) {
    const modelProbs = probs.filter((p) => p.model === model);
    let arbs3 = 0, arbs5 = 0, arbs10 = 0;
    let maxEdge = 0;
    let maxEdgeMatch = "";
    for (const p of modelProbs) {
      const edges = [Math.abs(p.edge_home), Math.abs(p.edge_draw), Math.abs(p.edge_away)];
      const peak = Math.max(...edges);
      if (peak > maxEdge) {
        maxEdge = peak;
        maxEdgeMatch = `${p.home_team} vs ${p.away_team} (${p.date})`;
      }
      if (peak > 0.03) arbs3++;
      if (peak > 0.05) arbs5++;
      if (peak > 0.10) arbs10++;
    }
    arb_frequency.push({
      model,
      total_matches: modelProbs.length,
      edges_gt_3pct: arbs3,
      edges_gt_5pct: arbs5,
      edges_gt_10pct: arbs10,
      pct_gt_3: round(modelProbs.length > 0 ? (arbs3 / modelProbs.length) * 100 : 0, 2),
      pct_gt_5: round(modelProbs.length > 0 ? (arbs5 / modelProbs.length) * 100 : 0, 2),
      max_edge: round(maxEdge * 100, 2),
      max_edge_match: maxEdgeMatch,
    });
  }

  // ─── 4. Cross-team correlation per league ──────────────
  console.log("Computing cross-team correlations...");
  const cross_team_correlations: Record<string, unknown>[] = [];
  for (const league of LEAGUES) {
    for (const model of MODELS) {
      const mt = byModelTeam.get(model)!;
      const leagueTeams: string[] = [];
      for (const [team, rows] of mt) {
        if (rows.length > 0 && rows[0].league === league) leagueTeams.push(team);
      }

      if (leagueTeams.length < 2) {
        cross_team_correlations.push({ league, model, avg_correlation: 0, n_pairs: 0 });
        continue;
      }

      const changeVectors = new Map<string, number[]>();
      for (const team of leagueTeams) {
        const rows = mt.get(team)!;
        const changes: number[] = [];
        for (let i = 1; i < rows.length; i++) {
          changes.push(rows[i].dollar_price - rows[i - 1].dollar_price);
        }
        changeVectors.set(team, changes);
      }

      let corrSum = 0;
      let corrCount = 0;
      for (let i = 0; i < leagueTeams.length; i++) {
        for (let j = i + 1; j < leagueTeams.length; j++) {
          const a = changeVectors.get(leagueTeams[i])!;
          const b = changeVectors.get(leagueTeams[j])!;
          const len = Math.min(a.length, b.length);
          const c = pearsonCorr(a, b, len);
          if (c !== null) {
            corrSum += c;
            corrCount++;
          }
        }
      }

      cross_team_correlations.push({
        league,
        model,
        avg_correlation: round(corrCount > 0 ? corrSum / corrCount : 0, 6),
        n_pairs: corrCount,
        n_teams: leagueTeams.length,
      });
    }
  }

  // ─── 5. Top 5 teams by market cap (latest oracle price) ─
  console.log("Building top-5 price series...");
  const oracleTeam = byModelTeam.get("oracle")!;
  const latestPrices: { team: string; league: string; price: number }[] = [];
  for (const [team, rows] of oracleTeam) {
    if (rows.length === 0) continue;
    latestPrices.push({
      team,
      league: rows[0].league,
      price: rows[rows.length - 1].dollar_price,
    });
  }
  latestPrices.sort((a, b) => b.price - a.price);
  const top5 = latestPrices.slice(0, 5);

  console.log(`  Top 5: ${top5.map((t) => `${t.team} ($${t.price})`).join(", ")}`);

  const top5_daily_prices: Record<string, unknown>[] = [];
  for (const { team, league } of top5) {
    const teamSeries: Record<string, unknown> = { team, league, models: {} };
    for (const model of MODELS) {
      const rows = byModelTeam.get(model)!.get(team) ?? [];
      (teamSeries.models as Record<string, unknown>)[model] = rows.map((r) => ({
        date: r.date,
        dollar_price: r.dollar_price,
        implied_elo: r.implied_elo,
      }));
    }
    top5_daily_prices.push(teamSeries);
  }

  // ─── Assemble export ──────────────────────────────────
  const exportData = {
    generated_at: new Date().toISOString(),
    data_range: { start: "2026-01-01", end: "2026-02-26" },
    totals: {
      teams: new Set(prices.map((p) => p.team)).size,
      matches: matches.length,
      price_rows: prices.length,
      prediction_rows: probs.length,
      models: MODELS,
      leagues: LEAGUES,
    },
    volatility,
    brier_scores,
    arb_frequency,
    cross_team_correlations,
    top5_teams_by_price: top5.map((t) => ({
      team: t.team,
      league: t.league,
      latest_oracle_price: t.price,
    })),
    top5_daily_prices,
  };

  const outPath = "data/analytics-export.json";
  writeFileSync(outPath, JSON.stringify(exportData, null, 2));
  const sizeMB = (Buffer.byteLength(JSON.stringify(exportData, null, 2)) / 1024 / 1024).toFixed(2);
  console.log(`\nWrote ${outPath} (${sizeMB} MB)`);

  // ─── Print summary ────────────────────────────────────
  console.log("\n═══════════════════════════════════════");
  console.log("EXPORT SUMMARY");
  console.log("═══════════════════════════════════════");
  console.log(`Models: ${MODELS.join(", ")}`);
  for (const v of volatility) {
    const vr = v as { model: string; avg_daily_change: number; vol_ratio: number };
    console.log(`  ${vr.model}: avg|ΔP|=$${vr.avg_daily_change.toFixed(4)}, match-day ratio=${vr.vol_ratio.toFixed(2)}x`);
  }
  console.log("\nBrier scores:");
  for (const b of brier_scores) {
    const br = b as { model: string; brier: number; n_matches: number };
    console.log(`  ${br.model}: ${br.brier.toFixed(4)} (${br.n_matches} matches)`);
  }
  console.log("\nArb frequency (>3%):");
  for (const a of arb_frequency) {
    const ar = a as { model: string; pct_gt_3: number; edges_gt_3pct: number };
    console.log(`  ${ar.model}: ${ar.pct_gt_3}% (${ar.edges_gt_3pct} matches)`);
  }
}

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
