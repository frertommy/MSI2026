"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
  BarChart,
  Bar,
  Cell,
  ReferenceLine,
} from "recharts";
import { supabase } from "@/lib/supabase";

// ─── Types ──────────────────────────────────────────────────
interface PriceRow {
  date: string;
  dollar_price: number;
  implied_elo: number;
  drift_elo: number | null;
  confidence: number;
  matches_in_window: number;
}

interface MatchRow {
  fixture_id: number;
  date: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
}

interface XgRow {
  fixture_id: number;
  home_team: string;
  away_team: string;
  home_xg: number;
  away_xg: number;
}

interface ProbRow {
  fixture_id: number;
  date: string;
  home_team: string;
  away_team: string;
  implied_home_win: number;
  implied_draw: number;
  implied_away_win: number;
  bookmaker_home_win: number;
  bookmaker_draw: number;
  bookmaker_away_win: number;
}

interface LivePriceRow {
  timestamp: string;
  dollar_price: number;
  implied_elo: number;
  blend_mode: string;
  fixture_id: number | null;
}

// Enriched match for display
interface EnrichedMatch {
  fixture_id: number;
  date: string;
  opponent: string;
  isHome: boolean;
  score: string;
  status: string;
  homeGoals: number;
  awayGoals: number;
  result: "W" | "D" | "L";
  teamXg: number | null;
  opponentXg: number | null;
  surprise: number | null;
  xgMult: number | null;
  priceImpact: number | null;
  postPrice: number | null;
}

// ─── Constants ──────────────────────────────────────────────
const LEAGUE_SHORT: Record<string, string> = {
  "Premier League": "EPL",
  "La Liga": "ESP",
  Bundesliga: "BUN",
  "Serie A": "ITA",
  "Ligue 1": "FRA",
};

const LEAGUE_COLOR: Record<string, string> = {
  "Premier League": "#a855f7",
  "La Liga": "#fb923c",
  Bundesliga: "#f87171",
  "Serie A": "#60a5fa",
  "Ligue 1": "#22d3ee",
};

const RESULT_COLOR = { W: "#00e676", D: "#ffc107", L: "#ff1744" };

const TIME_RANGES = [
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "ALL", days: 9999 },
];

const tooltipStyle = {
  backgroundColor: "#111",
  border: "1px solid #333",
  borderRadius: "4px",
  fontFamily: "monospace",
  fontSize: "11px",
};

// ─── Helpers ────────────────────────────────────────────────
function parseScore(score: string): [number, number] | null {
  if (!score) return null;
  const parts = score.split("-");
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0].trim());
  const a = parseInt(parts[1].trim());
  if (isNaN(h) || isNaN(a)) return null;
  return [h, a];
}

function xgMultiplier(
  teamXg: number,
  opponentXg: number,
  goalDiff: number
): number {
  const sign = goalDiff > 0 ? 1 : goalDiff < 0 ? -1 : 0;
  const raw = 1.0 + 0.3 * (teamXg - opponentXg) * sign;
  return Math.max(0.4, Math.min(1.8, raw));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function formatDateTick(dateStr: string): string {
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const d = new Date(dateStr + "T00:00:00Z");
  return months[d.getUTCMonth()];
}

// Paginated fetch helper
async function fetchAllPages<T>(
  table: string,
  select: string,
  filters: { col: string; op: "eq" | "gte"; val: string | number }[],
  orderCol?: string
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase
      .from(table)
      .select(select)
      .range(from, from + pageSize - 1);
    for (const f of filters) {
      if (f.op === "eq") q = q.eq(f.col, f.val);
      else if (f.op === "gte") q = q.gte(f.col, f.val);
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

// ═══════════════════════════════════════════════════════════════
// CompareClient — Trading-focused single-oracle team detail
// ═══════════════════════════════════════════════════════════════
export function CompareClient({
  teams,
  initialTeam,
  teamLeagues,
}: {
  teams: string[];
  initialTeam?: string;
  teamLeagues: Record<string, string>;
}) {
  const [selectedTeam, setSelectedTeam] = useState(initialTeam || teams[0] || "");
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [xgData, setXgData] = useState<XgRow[]>([]);
  const [probs, setProbs] = useState<ProbRow[]>([]);
  const [livePrices, setLivePrices] = useState<LivePriceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [timeRange, setTimeRange] = useState(9999);

  // ─── Data Fetch ────────────────────────────────────────────
  const fetchData = useCallback(async (team: string) => {
    if (!team) return;
    setLoading(true);

    const [
      priceData,
      homeMatches,
      awayMatches,
      homeXg,
      awayXg,
      homeProbs,
      awayProbs,
    ] = await Promise.all([
      fetchAllPages<PriceRow>(
        "team_prices",
        "date, dollar_price, implied_elo, drift_elo, confidence, matches_in_window",
        [
          { col: "team", op: "eq", val: team },
          { col: "model", op: "eq", val: "oracle" },
        ],
        "date"
      ),
      fetchAllPages<MatchRow>(
        "matches",
        "fixture_id, date, home_team, away_team, score, status",
        [{ col: "home_team", op: "eq", val: team }],
        "date"
      ),
      fetchAllPages<MatchRow>(
        "matches",
        "fixture_id, date, home_team, away_team, score, status",
        [{ col: "away_team", op: "eq", val: team }],
        "date"
      ),
      supabase
        .from("match_xg")
        .select("fixture_id, home_team, away_team, home_xg, away_xg")
        .eq("home_team", team),
      supabase
        .from("match_xg")
        .select("fixture_id, home_team, away_team, home_xg, away_xg")
        .eq("away_team", team),
      supabase
        .from("match_probabilities")
        .select(
          "fixture_id, date, home_team, away_team, implied_home_win, implied_draw, implied_away_win, bookmaker_home_win, bookmaker_draw, bookmaker_away_win"
        )
        .eq("model", "oracle")
        .eq("home_team", team),
      supabase
        .from("match_probabilities")
        .select(
          "fixture_id, date, home_team, away_team, implied_home_win, implied_draw, implied_away_win, bookmaker_home_win, bookmaker_draw, bookmaker_away_win"
        )
        .eq("model", "oracle")
        .eq("away_team", team),
    ]);

    setPrices(priceData);

    // Deduplicate by fixture_id (home+away queries can return same row)
    const dedup = <T extends { fixture_id: number }>(arr: T[]): T[] => {
      const seen = new Set<number>();
      return arr.filter((r) => {
        if (seen.has(r.fixture_id)) return false;
        seen.add(r.fixture_id);
        return true;
      });
    };

    // DB has duplicate fixtures (different fixture_ids, same date/teams).
    // Prefer finished matches over upcoming, keep only one per matchup.
    const allMatches = dedup([...homeMatches, ...awayMatches]);
    const matchByKey = new Map<string, MatchRow>();
    for (const m of allMatches) {
      const key = `${m.date}|${m.home_team}|${m.away_team}`;
      const existing = matchByKey.get(key);
      if (!existing) {
        matchByKey.set(key, m);
      } else if (m.status === "finished" && existing.status !== "finished") {
        matchByKey.set(key, m);
      } else if (
        m.score && m.score !== "N/A" &&
        (!existing.score || existing.score === "N/A")
      ) {
        matchByKey.set(key, m);
      }
    }
    setMatches([...matchByKey.values()]);
    setXgData(
      dedup([
        ...((homeXg.data ?? []) as XgRow[]),
        ...((awayXg.data ?? []) as XgRow[]),
      ])
    );
    setProbs(
      dedup([
        ...((homeProbs.data ?? []) as ProbRow[]),
        ...((awayProbs.data ?? []) as ProbRow[]),
      ])
    );

    // Fetch live prices (last 24h) — gracefully handles missing table
    try {
      const { data: liveData } = await supabase
        .from("live_prices")
        .select("timestamp, dollar_price, implied_elo, blend_mode, fixture_id")
        .eq("team", team)
        .eq("model", "oracle")
        .gte("timestamp", new Date(Date.now() - 86400000).toISOString())
        .order("timestamp", { ascending: true });
      setLivePrices((liveData ?? []) as LivePriceRow[]);
    } catch {
      setLivePrices([]);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData(selectedTeam);
  }, [selectedTeam, fetchData]);

  // ─── Time range filter ─────────────────────────────────────
  const startDate = useMemo(() => {
    if (timeRange >= 9999) return "2020-01-01";
    return new Date(Date.now() - timeRange * 86400000)
      .toISOString()
      .slice(0, 10);
  }, [timeRange]);

  const filteredPrices = useMemo(
    () => prices.filter((p) => p.date >= startDate),
    [prices, startDate]
  );

  // ─── Lookup maps ───────────────────────────────────────────
  const priceByDate = useMemo(() => {
    const m = new Map<string, PriceRow>();
    for (const p of prices) m.set(p.date, p);
    return m;
  }, [prices]);

  const xgByFixture = useMemo(() => {
    const m = new Map<number, XgRow>();
    for (const x of xgData) m.set(x.fixture_id, x);
    return m;
  }, [xgData]);

  const probByFixture = useMemo(() => {
    const m = new Map<number, ProbRow>();
    for (const p of probs) m.set(p.fixture_id, p);
    return m;
  }, [probs]);

  // ─── Enriched matches ──────────────────────────────────────
  const enrichedMatches = useMemo(() => {
    const team = selectedTeam;
    const result: EnrichedMatch[] = [];

    for (const m of matches) {
      const sc = parseScore(m.score);
      const isHome = m.home_team === team;
      const opponent = isHome ? m.away_team : m.home_team;

      if (!sc) {
        // Upcoming match — include but with nulls
        if (m.status !== "finished") {
          result.push({
            fixture_id: m.fixture_id,
            date: m.date,
            opponent,
            isHome,
            score: m.score,
            status: m.status,
            homeGoals: 0,
            awayGoals: 0,
            result: "D",
            teamXg: null,
            opponentXg: null,
            surprise: null,
            xgMult: null,
            priceImpact: null,
            postPrice: null,
          });
        }
        continue;
      }

      const [hg, ag] = sc;
      let matchResult: "W" | "D" | "L";
      if (hg === ag) matchResult = "D";
      else if (isHome) matchResult = hg > ag ? "W" : "L";
      else matchResult = ag > hg ? "W" : "L";

      // xG
      const xg = xgByFixture.get(m.fixture_id);
      const teamXg = xg ? (isHome ? xg.home_xg : xg.away_xg) : null;
      const opponentXg = xg ? (isHome ? xg.away_xg : xg.home_xg) : null;

      // Surprise from match_probabilities
      const prob = probByFixture.get(m.fixture_id);
      let surprise: number | null = null;
      if (prob) {
        const homeExpected =
          prob.implied_home_win * 1 + prob.implied_draw * 0.5;
        const homeActual = hg > ag ? 1 : hg === ag ? 0.5 : 0;
        surprise = isHome
          ? homeActual - homeExpected
          : 1 - homeActual - (1 - homeExpected);
      }

      // xG multiplier
      let xgMult: number | null = null;
      if (teamXg !== null && opponentXg !== null) {
        const goalDiff = isHome ? hg - ag : ag - hg;
        xgMult = xgMultiplier(teamXg, opponentXg, goalDiff);
      }

      // Price impact
      const priceOnDate = priceByDate.get(m.date);
      // Find previous day's price
      const dateIdx = prices.findIndex((p) => p.date === m.date);
      const prevPrice = dateIdx > 0 ? prices[dateIdx - 1] : null;
      const priceImpact =
        priceOnDate && prevPrice
          ? priceOnDate.dollar_price - prevPrice.dollar_price
          : null;

      result.push({
        fixture_id: m.fixture_id,
        date: m.date,
        opponent,
        isHome,
        score: m.score,
        status: m.status,
        homeGoals: hg,
        awayGoals: ag,
        result: matchResult,
        teamXg,
        opponentXg,
        surprise,
        xgMult,
        priceImpact,
        postPrice: priceOnDate?.dollar_price ?? null,
      });
    }

    return result.sort((a, b) => b.date.localeCompare(a.date));
  }, [matches, selectedTeam, xgByFixture, probByFixture, priceByDate, prices]);

  const finishedMatches = useMemo(
    () =>
      enrichedMatches.filter(
        (m) => m.status === "finished" && m.date >= startDate
      ),
    [enrichedMatches, startDate]
  );

  const upcomingMatches = useMemo(
    () =>
      enrichedMatches
        .filter((m) => m.status !== "finished")
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, 5),
    [enrichedMatches]
  );

  // ─── Chart data ────────────────────────────────────────────
  const chartData = useMemo(
    () =>
      filteredPrices.map((p) => ({
        date: p.date,
        price: p.dollar_price,
      })),
    [filteredPrices]
  );

  // Live price overlay data — merge into chartData by date, add livePrice field
  const chartDataWithLive = useMemo(() => {
    if (livePrices.length === 0) return chartData;

    // Build a map of date → latest live price for that date
    const livePriceByDate = new Map<string, number>();
    for (const lp of livePrices) {
      const date = lp.timestamp.slice(0, 10);
      livePriceByDate.set(date, lp.dollar_price); // latest wins (sorted asc)
    }

    // Merge into chart data
    return chartData.map((pt) => ({
      ...pt,
      livePrice: livePriceByDate.get(pt.date) ?? null,
    }));
  }, [chartData, livePrices]);

  // Match dots on chart
  const matchDots = useMemo(() => {
    const dots: {
      date: string;
      price: number;
      result: "W" | "D" | "L";
      r: number;
      tooltip: string;
    }[] = [];

    for (const m of finishedMatches) {
      const priceRow = priceByDate.get(m.date);
      if (!priceRow) continue;

      const absSurprise = m.surprise !== null ? Math.abs(m.surprise) : 0;
      const radius = clamp(4 + absSurprise * 12, 4, 10);

      const tipParts = [
        `${m.date} · ${m.isHome ? "vs" : "@"} ${m.opponent}`,
        `Score: ${m.score} (${m.result})`,
      ];
      if (m.teamXg !== null && m.opponentXg !== null)
        tipParts.push(
          `xG: ${m.teamXg.toFixed(2)} − ${m.opponentXg.toFixed(2)}`
        );
      if (m.surprise !== null)
        tipParts.push(`Surprise: ${m.surprise >= 0 ? "+" : ""}${m.surprise.toFixed(3)}`);
      if (m.xgMult !== null)
        tipParts.push(`xG Mult: ${m.xgMult.toFixed(2)}×`);
      if (m.priceImpact !== null)
        tipParts.push(
          `Impact: ${m.priceImpact >= 0 ? "+" : ""}$${m.priceImpact.toFixed(2)}`
        );

      dots.push({
        date: m.date,
        price: priceRow.dollar_price,
        result: m.result,
        r: radius,
        tooltip: tipParts.join("\n"),
      });
    }
    return dots;
  }, [finishedMatches, priceByDate]);

  // Month ticks for X-axis
  const monthTicks = useMemo(() => {
    const seen = new Set<string>();
    const ticks: string[] = [];
    for (const pt of chartData) {
      const ym = pt.date.slice(0, 7);
      if (!seen.has(ym)) {
        seen.add(ym);
        ticks.push(pt.date);
      }
    }
    return ticks;
  }, [chartData]);

  // ─── Header stats ──────────────────────────────────────────
  const headerStats = useMemo(() => {
    if (filteredPrices.length === 0)
      return {
        currentPrice: 0,
        currentElo: 0,
        seasonReturn: null as number | null,
        return7d: null as number | null,
        return30d: null as number | null,
        record: { w: 0, d: 0, l: 0 },
      };

    const latest = prices[prices.length - 1];
    const first = prices[0];
    const currentPrice = latest?.dollar_price ?? 0;
    const currentElo = latest?.implied_elo ?? 0;

    const seasonReturn =
      first && first.dollar_price > 0
        ? ((currentPrice - first.dollar_price) / first.dollar_price) * 100
        : null;

    // 7d / 30d returns
    const today = new Date().toISOString().slice(0, 10);
    const d7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const d30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const priceAtOrBefore = (target: string) => {
      let best: PriceRow | null = null;
      for (const p of prices) {
        if (p.date <= target) best = p;
        else break;
      }
      return best;
    };

    const p7 = priceAtOrBefore(d7);
    const p30 = priceAtOrBefore(d30);

    const return7d =
      p7 && p7.dollar_price > 0
        ? ((currentPrice - p7.dollar_price) / p7.dollar_price) * 100
        : null;
    const return30d =
      p30 && p30.dollar_price > 0
        ? ((currentPrice - p30.dollar_price) / p30.dollar_price) * 100
        : null;

    // W-D-L record
    const allFinished = enrichedMatches.filter(
      (m) => m.status === "finished" && parseScore(m.score) !== null
    );
    const record = { w: 0, d: 0, l: 0 };
    for (const m of allFinished) {
      if (m.result === "W") record.w++;
      else if (m.result === "D") record.d++;
      else record.l++;
    }

    return { currentPrice, currentElo, seasonReturn, return7d, return30d, record };
  }, [prices, filteredPrices, enrichedMatches]);

  // ─── Trading stats ─────────────────────────────────────────
  const tradingStats = useMemo(() => {
    // Daily returns
    const returns: number[] = [];
    for (let i = 1; i < filteredPrices.length; i++) {
      const prev = filteredPrices[i - 1].dollar_price;
      if (prev > 0) {
        returns.push(
          ((filteredPrices[i].dollar_price - prev) / prev) * 100
        );
      }
    }

    // Annualized volatility
    let annVol: number | null = null;
    if (returns.length >= 10) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance =
        returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
      annVol = Math.sqrt(variance) * Math.sqrt(365);
    }

    // Win/loss streaks
    const finishedSorted = [...finishedMatches].sort((a, b) =>
      a.date.localeCompare(b.date)
    );
    let currentStreak = "";
    let currentStreakLen = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    let tmpWin = 0;
    let tmpLoss = 0;
    for (const m of finishedSorted) {
      if (m.result === "W") {
        tmpWin++;
        tmpLoss = 0;
        if (tmpWin > maxWinStreak) maxWinStreak = tmpWin;
      } else if (m.result === "L") {
        tmpLoss++;
        tmpWin = 0;
        if (tmpLoss > maxLossStreak) maxLossStreak = tmpLoss;
      } else {
        tmpWin = 0;
        tmpLoss = 0;
      }
    }
    // Current streak
    for (let i = finishedSorted.length - 1; i >= 0; i--) {
      const r = finishedSorted[i].result;
      if (currentStreak === "") {
        currentStreak = r;
        currentStreakLen = 1;
      } else if (r === currentStreak) {
        currentStreakLen++;
      } else {
        break;
      }
    }

    // Mean reversion: correlation of return(t) with return(t+1)
    let meanReversion: number | null = null;
    if (returns.length >= 10) {
      const n = returns.length - 1;
      const xMean = returns.slice(0, n).reduce((a, b) => a + b, 0) / n;
      const yMean = returns.slice(1).reduce((a, b) => a + b, 0) / n;
      let num = 0;
      let denX = 0;
      let denY = 0;
      for (let i = 0; i < n; i++) {
        const dx = returns[i] - xMean;
        const dy = returns[i + 1] - yMean;
        num += dx * dy;
        denX += dx * dx;
        denY += dy * dy;
      }
      const denom = Math.sqrt(denX * denY);
      meanReversion = denom > 0 ? num / denom : 0;
    }

    // Odds accuracy: average |oracle - bookmaker| across matches
    let oddsAccuracy: number | null = null;
    const withProbs = finishedMatches.filter((m) => m.surprise !== null);
    if (withProbs.length > 0) {
      let totalEdge = 0;
      for (const m of withProbs) {
        const prob = probByFixture.get(m.fixture_id);
        if (prob) {
          totalEdge +=
            (Math.abs(prob.implied_home_win - prob.bookmaker_home_win) +
              Math.abs(prob.implied_draw - prob.bookmaker_draw) +
              Math.abs(prob.implied_away_win - prob.bookmaker_away_win)) /
            3;
        }
      }
      oddsAccuracy = totalEdge / withProbs.length;
    }

    // xG luck index: avg(goals - xG)
    let xgLuck: number | null = null;
    const withXg = finishedMatches.filter(
      (m) => m.teamXg !== null && m.opponentXg !== null
    );
    if (withXg.length > 0) {
      let totalLuck = 0;
      for (const m of withXg) {
        const teamGoals = m.isHome ? m.homeGoals : m.awayGoals;
        totalLuck += teamGoals - m.teamXg!;
      }
      xgLuck = totalLuck / withXg.length;
    }

    // Surprise distribution
    const withSurprise = finishedMatches.filter((m) => m.surprise !== null);
    let avgSurprise = 0;
    let upsetPct = 0;
    if (withSurprise.length > 0) {
      avgSurprise =
        withSurprise.reduce((a, m) => a + Math.abs(m.surprise!), 0) /
        withSurprise.length;
      upsetPct =
        (withSurprise.filter((m) => Math.abs(m.surprise!) > 0.2).length /
          withSurprise.length) *
        100;
    }

    return {
      annVol,
      currentStreak: currentStreakLen > 0 ? `${currentStreakLen}${currentStreak}` : "—",
      maxWinStreak,
      maxLossStreak,
      meanReversion,
      oddsAccuracy,
      xgLuck,
      avgSurprise,
      upsetPct,
    };
  }, [filteredPrices, finishedMatches, probByFixture]);

  // ─── Return distribution histogram ─────────────────────────
  const histogramData = useMemo(() => {
    const returns: number[] = [];
    for (let i = 1; i < filteredPrices.length; i++) {
      const prev = filteredPrices[i - 1].dollar_price;
      if (prev > 0) {
        returns.push(
          ((filteredPrices[i].dollar_price - prev) / prev) * 100
        );
      }
    }

    // Bucket into 0.5% bins from -5% to +5%
    const buckets: { bin: string; count: number; midpoint: number }[] = [];
    for (let b = -5; b < 5; b += 0.5) {
      const lo = b;
      const hi = b + 0.5;
      const label = `${lo >= 0 ? "+" : ""}${lo.toFixed(1)}%`;
      const count = returns.filter((r) => r >= lo && r < hi).length;
      buckets.push({ bin: label, count, midpoint: (lo + hi) / 2 });
    }
    return buckets;
  }, [filteredPrices]);

  // ─── Custom tooltip for chart dots ─────────────────────────
  const league = teamLeagues[selectedTeam] ?? "";

  // ─── Render ────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Team selector + time range */}
      <div className="flex flex-wrap items-center gap-4">
        <select
          value={selectedTeam}
          onChange={(e) => setSelectedTeam(e.target.value)}
          className="bg-surface border border-border rounded px-3 py-2 text-sm text-foreground font-mono focus:outline-none focus:border-accent-green"
        >
          {teams.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <div className="flex gap-1 ml-auto">
          {TIME_RANGES.map((tr) => (
            <button
              key={tr.label}
              onClick={() => setTimeRange(tr.days)}
              className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded border transition-all ${
                timeRange === tr.days
                  ? "bg-foreground text-background border-foreground"
                  : "bg-transparent text-muted border-border hover:border-muted"
              }`}
            >
              {tr.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="space-y-6 animate-pulse">
          <div className="border border-border rounded-lg p-6 bg-surface">
            <div className="h-5 w-64 rounded bg-border/50 mb-6" />
            <div className="h-[400px] rounded bg-border/30 flex items-center justify-center">
              <div className="flex items-center gap-2 text-muted text-sm font-mono">
                <div className="h-4 w-4 rounded-full border-2 border-accent-green border-t-transparent animate-spin" />
                Loading team data...
              </div>
            </div>
          </div>
        </div>
      )}

      {!loading && prices.length > 0 && (
        <>
          {/* ── Section 1: Header Bar ────────────────────── */}
          <div className="border border-border rounded-lg p-4 bg-surface">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              {/* Team name + league */}
              <div className="flex items-center gap-3">
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: LEAGUE_COLOR[league] ?? "#888" }}
                />
                <span className="text-lg font-bold text-foreground">
                  {selectedTeam}
                </span>
                <span
                  className="text-xs font-mono px-2 py-0.5 rounded"
                  style={{
                    color: LEAGUE_COLOR[league] ?? "#888",
                    border: `1px solid ${LEAGUE_COLOR[league] ?? "#333"}`,
                  }}
                >
                  {LEAGUE_SHORT[league] ?? league}
                </span>
              </div>

              <div className="h-5 w-px bg-border hidden sm:block" />

              {/* Price */}
              <div className="text-center">
                <div className="text-xs text-muted uppercase">Price</div>
                <div className="text-accent-green font-bold text-lg font-mono">
                  ${headerStats.currentPrice.toFixed(2)}
                </div>
              </div>

              <div className="h-5 w-px bg-border hidden sm:block" />

              {/* Elo */}
              <div className="text-center">
                <div className="text-xs text-muted uppercase">Elo</div>
                <div className="text-foreground font-bold font-mono">
                  {Math.round(headerStats.currentElo)}
                </div>
              </div>

              <div className="h-5 w-px bg-border hidden sm:block" />

              {/* Record */}
              <div className="text-center">
                <div className="text-xs text-muted uppercase">Record</div>
                <div className="font-mono text-sm">
                  <span className="text-accent-green">{headerStats.record.w}W</span>
                  {" "}
                  <span className="text-accent-amber">{headerStats.record.d}D</span>
                  {" "}
                  <span className="text-accent-red">{headerStats.record.l}L</span>
                </div>
              </div>

              <div className="h-5 w-px bg-border hidden sm:block" />

              {/* Returns */}
              <div className="text-center">
                <div className="text-xs text-muted uppercase">Season</div>
                <div
                  className={`font-mono text-sm font-bold ${
                    headerStats.seasonReturn !== null && headerStats.seasonReturn >= 0
                      ? "text-accent-green"
                      : "text-accent-red"
                  }`}
                >
                  {headerStats.seasonReturn !== null
                    ? `${headerStats.seasonReturn >= 0 ? "+" : ""}${headerStats.seasonReturn.toFixed(1)}%`
                    : "—"}
                </div>
              </div>

              {headerStats.return7d !== null && (
                <>
                  <div className="h-5 w-px bg-border hidden sm:block" />
                  <div className="text-center">
                    <div className="text-xs text-muted uppercase">7d</div>
                    <div
                      className={`font-mono text-sm ${
                        headerStats.return7d >= 0
                          ? "text-accent-green"
                          : "text-accent-red"
                      }`}
                    >
                      {headerStats.return7d >= 0 ? "+" : ""}
                      {headerStats.return7d.toFixed(1)}%
                    </div>
                  </div>
                </>
              )}

              {headerStats.return30d !== null && (
                <>
                  <div className="h-5 w-px bg-border hidden sm:block" />
                  <div className="text-center">
                    <div className="text-xs text-muted uppercase">30d</div>
                    <div
                      className={`font-mono text-sm ${
                        headerStats.return30d >= 0
                          ? "text-accent-green"
                          : "text-accent-red"
                      }`}
                    >
                      {headerStats.return30d >= 0 ? "+" : ""}
                      {headerStats.return30d.toFixed(1)}%
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ── Section 2: Price Chart ───────────────────── */}
          <div className="border border-border rounded-lg p-4 bg-surface">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-bold uppercase tracking-wider text-muted">
                Price History
              </h2>
              {/* Legend */}
              <div className="flex items-center gap-4 text-xs font-mono text-muted">
                {livePrices.length > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-4 h-0.5 inline-block" style={{ borderTop: "2px dashed #00e676" }} />
                    <span className="text-[#00e676]">Live</span>
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-accent-green inline-block" />
                  Win
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-accent-amber inline-block" />
                  Draw
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-accent-red inline-block" />
                  Loss
                </span>
                <span className="text-muted/60 ml-2">dot size = surprise</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={400}>
              <LineChart
                data={chartDataWithLive}
                margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#1e1e1e"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  ticks={monthTicks}
                  tickFormatter={
                    timeRange <= 30
                      ? (d: string) => d.slice(5)
                      : formatDateTick
                  }
                  tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={{ stroke: "#333" }}
                  tickLine={false}
                />
                <YAxis
                  domain={["auto", "auto"]}
                  tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={false}
                  tickLine={false}
                  width={45}
                  tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={((value: any, name: any) => [
                    `$${Number(value).toFixed(2)}`,
                    name === "livePrice" ? "Live" : "Price",
                  ]) as never}
                  labelFormatter={(label: any) => String(label)}
                />
                <Line
                  type="monotone"
                  dataKey="price"
                  stroke="#ffffff"
                  dot={false}
                  strokeWidth={2}
                  connectNulls
                />
                {/* Live price overlay (green dashed) */}
                {livePrices.length > 0 && (
                  <Line
                    type="monotone"
                    dataKey="livePrice"
                    stroke="#00e676"
                    dot={false}
                    strokeWidth={2}
                    strokeDasharray="6 3"
                    connectNulls
                  />
                )}
                {/* Match event dots */}
                {matchDots.map((dot, i) => (
                  <ReferenceDot
                    key={i}
                    x={dot.date}
                    y={dot.price}
                    r={dot.r}
                    fill={RESULT_COLOR[dot.result]}
                    stroke="none"
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* ── Section 3: Match Log ──────────────────────── */}
          {finishedMatches.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 bg-surface border-b border-border">
                <h2 className="text-xs font-bold uppercase tracking-wider text-muted">
                  Match Log — {finishedMatches.length} matches
                </h2>
              </div>
              <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                <table className="w-full text-xs font-mono">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="border-b border-border text-muted">
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-left">Opponent</th>
                      <th className="px-3 py-2 text-center">H/A</th>
                      <th className="px-3 py-2 text-center">Score</th>
                      <th className="px-3 py-2 text-right">xG</th>
                      <th className="px-3 py-2 text-right">Surprise</th>
                      <th className="px-3 py-2 text-right">xG Mult</th>
                      <th className="px-3 py-2 text-right">Impact</th>
                      <th className="px-3 py-2 text-right">Post $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {finishedMatches.map((m) => (
                      <tr
                        key={m.fixture_id}
                        className="border-b border-border/50 hover:bg-surface-hover transition-colors"
                      >
                        <td className="px-3 py-2 text-muted">{m.date}</td>
                        <td className="px-3 py-2 text-foreground">
                          {m.isHome ? "vs " : "@ "}
                          {m.opponent}
                        </td>
                        <td className="px-3 py-2 text-center text-muted">
                          {m.isHome ? "H" : "A"}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span
                            style={{ color: RESULT_COLOR[m.result] }}
                          >
                            {m.score}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-muted">
                          {m.teamXg !== null && m.opponentXg !== null
                            ? `${m.teamXg.toFixed(1)}–${m.opponentXg.toFixed(1)}`
                            : "—"}
                        </td>
                        <td
                          className={`px-3 py-2 text-right ${
                            m.surprise !== null
                              ? m.surprise >= 0
                                ? "text-accent-green"
                                : "text-accent-red"
                              : "text-muted"
                          }`}
                        >
                          {m.surprise !== null
                            ? `${m.surprise >= 0 ? "+" : ""}${m.surprise.toFixed(3)}`
                            : "—"}
                        </td>
                        <td
                          className={`px-3 py-2 text-right ${
                            m.xgMult !== null
                              ? m.xgMult >= 1
                                ? "text-accent-green"
                                : "text-accent-red"
                              : "text-muted"
                          }`}
                        >
                          {m.xgMult !== null
                            ? `${m.xgMult.toFixed(2)}×`
                            : "—"}
                        </td>
                        <td
                          className={`px-3 py-2 text-right ${
                            m.priceImpact !== null
                              ? m.priceImpact >= 0
                                ? "text-accent-green"
                                : "text-accent-red"
                              : "text-muted"
                          }`}
                        >
                          {m.priceImpact !== null
                            ? `${m.priceImpact >= 0 ? "+" : ""}$${m.priceImpact.toFixed(2)}`
                            : "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-foreground">
                          {m.postPrice !== null
                            ? `$${m.postPrice.toFixed(2)}`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Section 4: Trading Stats ──────────────────── */}
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-3">
              Trading Statistics
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {/* Volatility */}
              <div className="border border-border rounded-lg p-4 bg-surface">
                <div className="text-xs text-muted uppercase mb-1">
                  Ann. Volatility
                </div>
                <div className="text-lg font-bold font-mono text-foreground">
                  {tradingStats.annVol !== null
                    ? `${tradingStats.annVol.toFixed(1)}%`
                    : "—"}
                </div>
              </div>

              {/* Streaks */}
              <div className="border border-border rounded-lg p-4 bg-surface">
                <div className="text-xs text-muted uppercase mb-1">Streaks</div>
                <div className="text-lg font-bold font-mono">
                  <span
                    className={
                      tradingStats.currentStreak.endsWith("W")
                        ? "text-accent-green"
                        : tradingStats.currentStreak.endsWith("L")
                        ? "text-accent-red"
                        : tradingStats.currentStreak.endsWith("D")
                        ? "text-accent-amber"
                        : "text-foreground"
                    }
                  >
                    {tradingStats.currentStreak}
                  </span>
                </div>
                <div className="text-xs text-muted mt-1 font-mono">
                  Max W: {tradingStats.maxWinStreak} · Max L:{" "}
                  {tradingStats.maxLossStreak}
                </div>
              </div>

              {/* Mean Reversion */}
              <div className="border border-border rounded-lg p-4 bg-surface">
                <div className="text-xs text-muted uppercase mb-1">
                  Mean Reversion
                </div>
                <div
                  className={`text-lg font-bold font-mono ${
                    tradingStats.meanReversion !== null
                      ? tradingStats.meanReversion < 0
                        ? "text-accent-green"
                        : "text-accent-amber"
                      : "text-foreground"
                  }`}
                >
                  {tradingStats.meanReversion !== null
                    ? `ρ = ${tradingStats.meanReversion.toFixed(3)}`
                    : "—"}
                </div>
                <div className="text-xs text-muted mt-1 font-mono">
                  {tradingStats.meanReversion !== null
                    ? tradingStats.meanReversion < -0.1
                      ? "Mean-reverting"
                      : tradingStats.meanReversion > 0.1
                      ? "Trending"
                      : "Neutral"
                    : ""}
                </div>
              </div>

              {/* Odds Accuracy */}
              <div className="border border-border rounded-lg p-4 bg-surface">
                <div className="text-xs text-muted uppercase mb-1">
                  Avg Edge vs Books
                </div>
                <div className="text-lg font-bold font-mono text-foreground">
                  {tradingStats.oddsAccuracy !== null
                    ? `${(tradingStats.oddsAccuracy * 100).toFixed(1)}%`
                    : "—"}
                </div>
              </div>

              {/* xG Luck */}
              <div className="border border-border rounded-lg p-4 bg-surface">
                <div className="text-xs text-muted uppercase mb-1">
                  xG Luck Index
                </div>
                <div
                  className={`text-lg font-bold font-mono ${
                    tradingStats.xgLuck !== null
                      ? tradingStats.xgLuck >= 0
                        ? "text-accent-green"
                        : "text-accent-red"
                      : "text-foreground"
                  }`}
                >
                  {tradingStats.xgLuck !== null
                    ? `${tradingStats.xgLuck >= 0 ? "+" : ""}${tradingStats.xgLuck.toFixed(2)}`
                    : "—"}
                </div>
                <div className="text-xs text-muted mt-1 font-mono">
                  {tradingStats.xgLuck !== null
                    ? tradingStats.xgLuck > 0.15
                      ? "Running lucky"
                      : tradingStats.xgLuck < -0.15
                      ? "Running unlucky"
                      : "Neutral"
                    : ""}
                </div>
              </div>

              {/* Surprise Distribution */}
              <div className="border border-border rounded-lg p-4 bg-surface">
                <div className="text-xs text-muted uppercase mb-1">
                  Surprise Magnitude
                </div>
                <div className="text-lg font-bold font-mono text-foreground">
                  {tradingStats.avgSurprise.toFixed(3)}
                </div>
                <div className="text-xs text-muted mt-1 font-mono">
                  {tradingStats.upsetPct.toFixed(0)}% upsets (&gt;0.2)
                </div>
              </div>
            </div>
          </div>

          {/* ── Section 5: Upcoming Fixtures ──────────────── */}
          {upcomingMatches.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 bg-surface border-b border-border">
                <h2 className="text-xs font-bold uppercase tracking-wider text-muted">
                  Upcoming Fixtures
                </h2>
              </div>
              <div className="divide-y divide-border/50">
                {upcomingMatches.map((m) => {
                  const prob = probByFixture.get(m.fixture_id);
                  return (
                    <div
                      key={m.fixture_id}
                      className="flex items-center justify-between px-4 py-3 text-sm font-mono hover:bg-surface-hover transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-muted text-xs w-20">
                          {m.date}
                        </span>
                        <span className="text-foreground">
                          {m.isHome ? "vs " : "@ "}
                          {m.opponent}
                        </span>
                        <span className="text-muted text-xs">
                          ({m.isHome ? "H" : "A"})
                        </span>
                      </div>
                      {prob && (
                        <div className="flex gap-3 text-xs">
                          <span className="text-accent-green">
                            W{" "}
                            {(
                              (m.isHome
                                ? prob.implied_home_win
                                : prob.implied_away_win) * 100
                            ).toFixed(0)}
                            %
                          </span>
                          <span className="text-accent-amber">
                            D {(prob.implied_draw * 100).toFixed(0)}%
                          </span>
                          <span className="text-accent-red">
                            L{" "}
                            {(
                              (m.isHome
                                ? prob.implied_away_win
                                : prob.implied_home_win) * 100
                            ).toFixed(0)}
                            %
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Section 6: Return Distribution ─────────────── */}
          {histogramData.some((b) => b.count > 0) && (
            <div className="border border-border rounded-lg p-4 bg-surface">
              <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-4">
                Daily Return Distribution
              </h2>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={histogramData}
                  margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#1e1e1e"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="bin"
                    tick={{ fill: "#666", fontSize: 9, fontFamily: "monospace" }}
                    axisLine={{ stroke: "#333" }}
                    tickLine={false}
                    interval={1}
                  />
                  <YAxis
                    tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                    axisLine={false}
                    tickLine={false}
                    width={30}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    formatter={((value: any) => [
                      `${value} days`,
                      "Count",
                    ]) as never}
                  />
                  <ReferenceLine x="0.0%" stroke="#666" strokeDasharray="3 3" />
                  <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                    {histogramData.map((entry, i) => (
                      <Cell
                        key={i}
                        fill={entry.midpoint >= 0 ? "#00e676" : "#ff1744"}
                        fillOpacity={0.7}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}

      {!loading && prices.length === 0 && (
        <div className="text-center text-muted py-12 text-sm font-mono border border-border rounded">
          Select a team to view trading details.
        </div>
      )}
    </div>
  );
}
