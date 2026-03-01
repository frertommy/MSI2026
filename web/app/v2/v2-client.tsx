"use client";

import { useState, useMemo } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ScatterChart,
  Scatter,
  CartesianGrid,
} from "recharts";
import type { LatestTeamPrice, PriceHistoryRow, MatchRow } from "./page";

// ─── Constants ───────────────────────────────────────────────
const INITIAL_ELO = 1500;
const DOLLAR_SPREAD = 220;
const DEFAULT_SCALE = 600;
const SHOCK_ELO = 25;

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

const tooltipStyle = {
  backgroundColor: "#111",
  border: "1px solid #333",
  borderRadius: "4px",
  fontFamily: "monospace",
  fontSize: "12px",
};

// ─── Formulas ────────────────────────────────────────────────
function v1Price(elo: number): number {
  return 100 / (1 + Math.exp(-(elo - INITIAL_ELO) / DOLLAR_SPREAD));
}

function v2Price(elo: number, scale: number): number {
  return 50 * Math.exp((elo - INITIAL_ELO) / scale);
}

function v1Sensitivity(elo: number): number {
  const p = v1Price(elo);
  const p1 = v1Price(elo + 1);
  return p > 0 ? ((p1 - p) / p) * 100 : 0;
}

function v2Sensitivity(scale: number): number {
  // Constant: d/d(elo) of 50*exp((elo-1500)/s) = (1/s)*price
  // % per point = (1/s) * 100
  return (1 / scale) * 100;
}

// ─── Quality Index Computation ──────────────────────────────
function computeIndexes(teams: LatestTeamPrice[], scale: number) {
  if (teams.length === 0) {
    return {
      sensitivityRange: { v1: 0, v2: 0 },
      eliteVolatility: { v1: 0, v2: 0 },
      shockUniformity: { v1: 0, v2: 0 },
      worstAsymmetry: { v1: 0, v2: 0 },
      priceSpread: { v1: 0, v2: 0 },
      avgDailyMove: { v1: 0, v2: 0 },
    };
  }

  const v1Sens = teams.map((t) => v1Sensitivity(t.implied_elo));
  const v2SensConst = v2Sensitivity(scale);

  // Index 1: Sensitivity Range (max/min ratio)
  const v1SensMax = Math.max(...v1Sens);
  const v1SensMin = Math.min(...v1Sens.filter((s) => s > 0.001));
  const sensitivityRange = {
    v1: v1SensMin > 0 ? v1SensMax / v1SensMin : 0,
    v2: 1.0, // constant sensitivity → ratio = 1
  };

  // Index 2: Elite Club Volatility (top 8 by Elo)
  const sorted = [...teams].sort((a, b) => b.implied_elo - a.implied_elo);
  const top8 = sorted.slice(0, 8);
  const top8V1Sens = top8.map((t) => v1Sensitivity(t.implied_elo));
  const eliteVolatility = {
    v1: top8V1Sens.reduce((s, v) => s + v, 0) / top8V1Sens.length,
    v2: v2SensConst,
  };

  // Index 3: Shock Uniformity (CV of % moves from +25 Elo shock)
  const v1ShockPcts = teams.map((t) => {
    const cur = v1Price(t.implied_elo);
    const shocked = v1Price(t.implied_elo + SHOCK_ELO);
    return cur > 0 ? ((shocked - cur) / cur) * 100 : 0;
  });
  const v2ShockPct = (Math.exp(SHOCK_ELO / scale) - 1) * 100;

  const v1ShockMean = v1ShockPcts.reduce((s, v) => s + v, 0) / v1ShockPcts.length;
  const v1ShockStd = Math.sqrt(
    v1ShockPcts.reduce((s, v) => s + (v - v1ShockMean) ** 2, 0) / v1ShockPcts.length
  );
  const shockUniformity = {
    v1: v1ShockMean > 0 ? v1ShockStd / v1ShockMean : 0,
    v2: 0, // all identical → CV = 0
  };

  // Index 4: Worst-Case Asymmetry (max/min of shock % moves)
  const v1ShockMax = Math.max(...v1ShockPcts);
  const v1ShockMin = Math.min(...v1ShockPcts.filter((s) => s > 0.01));
  const worstAsymmetry = {
    v1: v1ShockMin > 0 ? v1ShockMax / v1ShockMin : 0,
    v2: 1.0,
  };

  // Index 5: Price Spread (max/min prices)
  const v1Prices = teams.map((t) => t.dollar_price);
  const v2Prices = teams.map((t) => v2Price(t.implied_elo, scale));
  const priceSpread = {
    v1: Math.min(...v1Prices) > 0 ? Math.max(...v1Prices) / Math.min(...v1Prices) : 0,
    v2: Math.min(...v2Prices) > 0 ? Math.max(...v2Prices) / Math.min(...v2Prices) : 0,
  };

  return {
    sensitivityRange,
    eliteVolatility,
    shockUniformity,
    worstAsymmetry,
    priceSpread,
    avgDailyMove: { v1: 0, v2: 0 }, // computed separately with history
  };
}

// ─── Components ──────────────────────────────────────────────
function IndexCard({
  title,
  v1,
  v2,
  v1Label,
  v2Label,
  lowerBetter,
  unit,
}: {
  title: string;
  v1: number;
  v2: number;
  v1Label?: string;
  v2Label?: string;
  lowerBetter: boolean;
  unit?: string;
}) {
  const v1Better = lowerBetter ? v1 < v2 : v1 > v2;
  const v2Better = lowerBetter ? v2 < v1 : v2 > v1;
  const fmt = (n: number) => (unit === "%" ? `${n.toFixed(2)}%` : n.toFixed(2));

  return (
    <div className="border border-border rounded-lg p-3 bg-surface">
      <div className="text-[10px] text-muted uppercase tracking-wider mb-2 font-bold">
        {title}
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted font-mono">
            {v1Label ?? "logistic"}
          </span>
          <span
            className={`text-sm font-mono font-bold tabular-nums ${
              v1Better ? "text-accent-green" : "text-foreground"
            }`}
          >
            {fmt(v1)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted font-mono">
            {v2Label ?? "exponential"}
          </span>
          <span
            className={`text-sm font-mono font-bold tabular-nums ${
              v2Better ? "text-accent-green" : "text-foreground"
            }`}
          >
            {fmt(v2)}
          </span>
        </div>
      </div>
      <div className="mt-2 text-[9px] text-muted font-mono opacity-60">
        {lowerBetter ? "lower is better" : "higher is better"}
      </div>
    </div>
  );
}

// ─── Main Client Component ───────────────────────────────────
export function V2Client({
  latestPrices,
  priceHistory,
  matches,
}: {
  latestPrices: LatestTeamPrice[];
  priceHistory: PriceHistoryRow[];
  matches: MatchRow[];
}) {
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [activeLeague, setActiveLeague] = useState("All");
  const [sortCol, setSortCol] = useState<string>("elo");
  const [sortAsc, setSortAsc] = useState(false);

  const leagues = useMemo(
    () => [...new Set(latestPrices.map((t) => t.league))].sort(),
    [latestPrices]
  );

  // ─── Indexes ─────────────────────────────────────────────
  const indexes = useMemo(() => computeIndexes(latestPrices, scale), [latestPrices, scale]);

  // ─── Average daily % move from history ───────────────────
  const avgDailyMove = useMemo(() => {
    // Group history by team, sort by date
    const byTeam = new Map<string, PriceHistoryRow[]>();
    for (const r of priceHistory) {
      if (!byTeam.has(r.team)) byTeam.set(r.team, []);
      byTeam.get(r.team)!.push(r);
    }
    for (const rows of byTeam.values()) rows.sort((a, b) => a.date.localeCompare(b.date));

    let v1Sum = 0;
    let v2Sum = 0;
    let count = 0;

    for (const rows of byTeam.values()) {
      for (let i = 1; i < rows.length; i++) {
        const prevV1 = rows[i - 1].dollar_price;
        const curV1 = rows[i].dollar_price;
        if (prevV1 > 0) v1Sum += Math.abs((curV1 - prevV1) / prevV1) * 100;

        const prevV2 = v2Price(rows[i - 1].implied_elo, scale);
        const curV2 = v2Price(rows[i].implied_elo, scale);
        if (prevV2 > 0) v2Sum += Math.abs((curV2 - prevV2) / prevV2) * 100;

        count++;
      }
    }

    return {
      v1: count > 0 ? v1Sum / count : 0,
      v2: count > 0 ? v2Sum / count : 0,
    };
  }, [priceHistory, scale]);

  // ─── Table data ──────────────────────────────────────────
  const tableData = useMemo(() => {
    const data = latestPrices.map((t) => {
      const v2P = v2Price(t.implied_elo, scale);
      return {
        team: t.team,
        league: t.league,
        elo: t.implied_elo,
        v1Price: t.dollar_price,
        v2Price: v2P,
        v1Sens: v1Sensitivity(t.implied_elo),
        v2Sens: v2Sensitivity(scale),
        deltaPrice: v2P - t.dollar_price,
      };
    });

    // Filter
    const filtered =
      activeLeague === "All" ? data : data.filter((t) => t.league === activeLeague);

    // Sort
    filtered.sort((a, b) => {
      let va: number, vb: number;
      switch (sortCol) {
        case "team": return sortAsc ? a.team.localeCompare(b.team) : b.team.localeCompare(a.team);
        case "elo": va = a.elo; vb = b.elo; break;
        case "v1Price": va = a.v1Price; vb = b.v1Price; break;
        case "v2Price": va = a.v2Price; vb = b.v2Price; break;
        case "v1Sens": va = a.v1Sens; vb = b.v1Sens; break;
        case "v2Sens": va = a.v2Sens; vb = b.v2Sens; break;
        case "deltaPrice": va = a.deltaPrice; vb = b.deltaPrice; break;
        default: va = a.elo; vb = b.elo;
      }
      return sortAsc ? va! - vb! : vb! - va!;
    });

    return filtered;
  }, [latestPrices, scale, activeLeague, sortCol, sortAsc]);

  // ─── Chart A: Price curves ───────────────────────────────
  const priceCurveData = useMemo(() => {
    const points = [];
    for (let elo = 1200; elo <= 1900; elo += 5) {
      points.push({
        elo,
        v1: Math.round(v1Price(elo) * 100) / 100,
        v2: Math.round(v2Price(elo, scale) * 100) / 100,
      });
    }
    return points;
  }, [scale]);

  const teamScatter = useMemo(
    () =>
      latestPrices.map((t) => ({
        elo: t.implied_elo,
        v1: t.dollar_price,
        v2: v2Price(t.implied_elo, scale),
        team: t.team,
        league: t.league,
      })),
    [latestPrices, scale]
  );

  // ─── Chart B: Sensitivity curves ─────────────────────────
  const sensCurveData = useMemo(() => {
    const points = [];
    for (let elo = 1200; elo <= 1900; elo += 5) {
      points.push({
        elo,
        v1: Math.round(v1Sensitivity(elo) * 10000) / 10000,
        v2: Math.round(v2Sensitivity(scale) * 10000) / 10000,
      });
    }
    return points;
  }, [scale]);

  // ─── Chart C: Shock bar chart ────────────────────────────
  const shockBarData = useMemo(() => {
    const sorted = [...latestPrices].sort((a, b) => a.implied_elo - b.implied_elo);
    // Show bottom 10 + top 10 for readability
    const selected = sorted.length > 20
      ? [...sorted.slice(0, 10), ...sorted.slice(-10)]
      : sorted;

    return selected.map((t) => {
      const cur1 = v1Price(t.implied_elo);
      const shocked1 = v1Price(t.implied_elo + SHOCK_ELO);
      const cur2 = v2Price(t.implied_elo, scale);
      const shocked2 = v2Price(t.implied_elo + SHOCK_ELO, scale);
      const shortName = t.team.replace(/ FC$| CF$| BC$/, "").slice(0, 14);
      return {
        team: shortName,
        v1: cur1 > 0 ? Math.round(((shocked1 - cur1) / cur1) * 10000) / 100 : 0,
        v2: cur2 > 0 ? Math.round(((shocked2 - cur2) / cur2) * 10000) / 100 : 0,
      };
    });
  }, [latestPrices, scale]);

  // ─── Chart D: Historical rolling volatility ──────────────
  const rollingVolData = useMemo(() => {
    const byTeam = new Map<string, PriceHistoryRow[]>();
    for (const r of priceHistory) {
      if (!byTeam.has(r.team)) byTeam.set(r.team, []);
      byTeam.get(r.team)!.push(r);
    }
    for (const rows of byTeam.values()) rows.sort((a, b) => a.date.localeCompare(b.date));

    // Compute daily % changes per team
    const dailyByDate = new Map<string, { v1: number[]; v2: number[] }>();
    for (const rows of byTeam.values()) {
      for (let i = 1; i < rows.length; i++) {
        const date = rows[i].date;
        if (!dailyByDate.has(date)) dailyByDate.set(date, { v1: [], v2: [] });
        const entry = dailyByDate.get(date)!;

        const prevV1 = rows[i - 1].dollar_price;
        const curV1 = rows[i].dollar_price;
        if (prevV1 > 0) entry.v1.push(Math.abs((curV1 - prevV1) / prevV1) * 100);

        const prevV2 = v2Price(rows[i - 1].implied_elo, scale);
        const curV2 = v2Price(rows[i].implied_elo, scale);
        if (prevV2 > 0) entry.v2.push(Math.abs((curV2 - prevV2) / prevV2) * 100);
      }
    }

    const dates = [...dailyByDate.keys()].sort();
    const avg = (arr: number[]) => (arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

    // Rolling 7-day average
    const dailyAvgs = dates.map((d) => {
      const e = dailyByDate.get(d)!;
      return { date: d, v1: avg(e.v1), v2: avg(e.v2) };
    });

    const result = [];
    for (let i = 6; i < dailyAvgs.length; i++) {
      const window = dailyAvgs.slice(i - 6, i + 1);
      result.push({
        date: dailyAvgs[i].date,
        v1: Math.round((window.reduce((s, w) => s + w.v1, 0) / window.length) * 1000) / 1000,
        v2: Math.round((window.reduce((s, w) => s + w.v2, 0) / window.length) * 1000) / 1000,
      });
    }

    return result;
  }, [priceHistory, scale]);

  // ─── Sort handler ────────────────────────────────────────
  function handleSort(col: string) {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(false);
    }
  }

  const sortArrow = (col: string) =>
    sortCol === col ? (sortAsc ? " ↑" : " ↓") : "";

  const shockPctLabel = ((Math.exp(SHOCK_ELO / scale) - 1) * 100).toFixed(1);

  // ─── Render ──────────────────────────────────────────────
  return (
    <div className="space-y-8">
      {/* Scale slider */}
      <div className="border border-border rounded-lg p-4 bg-surface">
        <div className="flex items-center gap-6 flex-wrap">
          <div className="space-y-1">
            <label className="text-[10px] text-muted uppercase tracking-wider font-bold block">
              Exponential Scale
            </label>
            <div className="text-xs text-muted font-mono">
              Controls volatility (lower = more volatile)
            </div>
          </div>
          <input
            type="range"
            min={300}
            max={1000}
            step={50}
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            className="flex-1 min-w-[200px] accent-[#00e676]"
          />
          <div className="text-right min-w-[120px]">
            <div className="text-lg font-mono font-bold text-foreground">{scale}</div>
            <div className="text-[10px] text-muted font-mono">
              &plusmn;{SHOCK_ELO} Elo &asymp; &plusmn;{shockPctLabel}% for all teams
            </div>
          </div>
        </div>
      </div>

      {/* Quality index cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <IndexCard
          title="Sensitivity Range"
          v1={indexes.sensitivityRange.v1}
          v2={indexes.sensitivityRange.v2}
          lowerBetter={true}
          unit="x"
        />
        <IndexCard
          title="Elite Club Volatility"
          v1={indexes.eliteVolatility.v1}
          v2={indexes.eliteVolatility.v2}
          lowerBetter={false}
          unit="%"
        />
        <IndexCard
          title="Shock Uniformity"
          v1={indexes.shockUniformity.v1}
          v2={indexes.shockUniformity.v2}
          lowerBetter={true}
        />
        <IndexCard
          title="Worst-Case Asymmetry"
          v1={indexes.worstAsymmetry.v1}
          v2={indexes.worstAsymmetry.v2}
          lowerBetter={true}
          unit="x"
        />
        <IndexCard
          title="Price Spread"
          v1={indexes.priceSpread.v1}
          v2={indexes.priceSpread.v2}
          lowerBetter={false}
          unit="x"
        />
        <IndexCard
          title="Avg Daily % Move"
          v1={avgDailyMove.v1}
          v2={avgDailyMove.v2}
          lowerBetter={false}
          unit="%"
        />
      </div>

      {/* Section 1: Price Table */}
      <div className="space-y-4">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted border-b border-border pb-2">
          Side-by-Side Price Comparison
        </h2>

        {/* League filters */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setActiveLeague("All")}
            className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded border transition-all ${
              activeLeague === "All"
                ? "bg-foreground text-background border-foreground"
                : "bg-transparent text-muted border-border hover:border-muted hover:text-foreground"
            }`}
          >
            All ({latestPrices.length})
          </button>
          {leagues.map((league) => {
            const count = latestPrices.filter((t) => t.league === league).length;
            return (
              <button
                key={league}
                onClick={() => setActiveLeague(league)}
                className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded border transition-all ${
                  activeLeague === league
                    ? "bg-foreground text-background border-foreground"
                    : "bg-transparent text-muted border-border hover:border-muted hover:text-foreground"
                }`}
              >
                {LEAGUE_SHORT[league] || league} ({count})
              </button>
            );
          })}
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border text-muted">
                <th className="py-2 px-2 text-left">#</th>
                <th
                  className="py-2 px-2 text-left cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("team")}
                >
                  Team{sortArrow("team")}
                </th>
                <th className="py-2 px-2 text-left">League</th>
                <th
                  className="py-2 px-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("elo")}
                >
                  Elo{sortArrow("elo")}
                </th>
                <th
                  className="py-2 px-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("v1Price")}
                >
                  V1 Price{sortArrow("v1Price")}
                </th>
                <th
                  className="py-2 px-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("v2Price")}
                >
                  V2 Price{sortArrow("v2Price")}
                </th>
                <th
                  className="py-2 px-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("v1Sens")}
                >
                  V1 Sens{sortArrow("v1Sens")}
                </th>
                <th
                  className="py-2 px-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("v2Sens")}
                >
                  V2 Sens{sortArrow("v2Sens")}
                </th>
                <th
                  className="py-2 px-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("deltaPrice")}
                >
                  &Delta; Price{sortArrow("deltaPrice")}
                </th>
              </tr>
            </thead>
            <tbody>
              {tableData.map((row, i) => {
                // Sensitivity color: gradient from red (low) to green (high)
                const sensRatio =
                  indexes.sensitivityRange.v1 > 0
                    ? (row.v1Sens - 0.05) / (0.25 - 0.05)
                    : 0.5;
                const clampedRatio = Math.max(0, Math.min(1, sensRatio));
                const v1SensColor = `hsl(${clampedRatio * 120}, 70%, 50%)`;

                return (
                  <tr
                    key={row.team}
                    className="border-b border-border/30 hover:bg-surface-hover transition-colors"
                  >
                    <td className="py-1.5 px-2 text-muted">{i + 1}</td>
                    <td className="py-1.5 px-2 text-foreground font-bold truncate max-w-[180px]">
                      {row.team}
                    </td>
                    <td className="py-1.5 px-2">
                      <span style={{ color: LEAGUE_COLOR[row.league] }}>
                        {LEAGUE_SHORT[row.league] || row.league}
                      </span>
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {Math.round(row.elo)}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      ${row.v1Price.toFixed(2)}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-accent-green">
                      ${row.v2Price.toFixed(2)}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums" style={{ color: v1SensColor }}>
                      {row.v1Sens.toFixed(3)}%
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-accent-green">
                      {row.v2Sens.toFixed(3)}%
                    </td>
                    <td
                      className={`py-1.5 px-2 text-right tabular-nums ${
                        row.deltaPrice > 0 ? "text-accent-green" : row.deltaPrice < 0 ? "text-accent-red" : "text-muted"
                      }`}
                    >
                      {row.deltaPrice > 0 ? "+" : ""}
                      ${row.deltaPrice.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 2: Charts */}
      <div className="space-y-8">
        {/* Chart A: Price Curves */}
        <div className="space-y-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted border-b border-border pb-2">
            Chart A &mdash; Price Curves (Elo &rarr; Dollar Price)
          </h2>
          <div className="border border-border rounded-lg bg-surface p-4">
            <ResponsiveContainer width="100%" height={400}>
              <LineChart data={priceCurveData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" />
                <XAxis
                  dataKey="elo"
                  stroke="#666"
                  tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                  label={{ value: "Elo", position: "insideBottom", offset: -5, fill: "#666", fontSize: 11 }}
                />
                <YAxis
                  stroke="#666"
                  tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                  label={{ value: "Price ($)", angle: -90, position: "insideLeft", fill: "#666", fontSize: 11 }}
                />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend
                  wrapperStyle={{ fontFamily: "monospace", fontSize: 11 }}
                />
                <Line type="monotone" dataKey="v1" stroke="#ff1744" name="V1 Logistic" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="v2" stroke="#00e676" name="V2 Exponential" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
            {/* Scatter overlay note */}
            <div className="mt-2 text-[10px] text-muted font-mono">
              {latestPrices.length} teams plotted. V1 ceiling at $100, V2 unbounded above.
            </div>
          </div>
        </div>

        {/* Chart B: Sensitivity Curves */}
        <div className="space-y-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted border-b border-border pb-2">
            Chart B &mdash; Sensitivity (% Price Change per +1 Elo)
          </h2>
          <div className="border border-border rounded-lg bg-surface p-4">
            <ResponsiveContainer width="100%" height={350}>
              <LineChart data={sensCurveData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" />
                <XAxis
                  dataKey="elo"
                  stroke="#666"
                  tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                  label={{ value: "Elo", position: "insideBottom", offset: -5, fill: "#666", fontSize: 11 }}
                />
                <YAxis
                  stroke="#666"
                  tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                  label={{ value: "% / Elo pt", angle: -90, position: "insideLeft", fill: "#666", fontSize: 11 }}
                />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontFamily: "monospace", fontSize: 11 }} />
                <Line type="monotone" dataKey="v1" stroke="#ff1744" name="V1 Logistic" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="v2" stroke="#00e676" name="V2 Exponential" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
            <div className="mt-2 text-[10px] text-muted font-mono">
              V1 sensitivity peaks at Elo 1500 and dies at extremes. V2 is constant at {v2Sensitivity(scale).toFixed(3)}%/pt.
            </div>
          </div>
        </div>

        {/* Chart C: Shock Bar Chart */}
        <div className="space-y-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted border-b border-border pb-2">
            Chart C &mdash; +{SHOCK_ELO} Elo Shock: % Price Impact per Team
          </h2>
          <div className="border border-border rounded-lg bg-surface p-4">
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={shockBarData} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" />
                <XAxis
                  dataKey="team"
                  stroke="#666"
                  tick={{ fill: "#666", fontSize: 9, fontFamily: "monospace" }}
                  angle={-45}
                  textAnchor="end"
                  height={80}
                />
                <YAxis
                  stroke="#666"
                  tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                  label={{ value: "% move", angle: -90, position: "insideLeft", fill: "#666", fontSize: 11 }}
                />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontFamily: "monospace", fontSize: 11 }} />
                <Bar dataKey="v1" fill="#60a5fa" name="V1 Logistic" />
                <Bar dataKey="v2" fill="#00e676" name="V2 Exponential" />
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-2 text-[10px] text-muted font-mono">
              Bottom 10 + top 10 teams by Elo. V1 bars vary wildly; V2 bars are uniform at {shockPctLabel}%.
            </div>
          </div>
        </div>

        {/* Chart D: Historical Rolling Volatility */}
        {rollingVolData.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-xs font-bold uppercase tracking-wider text-muted border-b border-border pb-2">
              Chart D &mdash; Rolling 7-Day Average Daily % Move
            </h2>
            <div className="border border-border rounded-lg bg-surface p-4">
              <ResponsiveContainer width="100%" height={350}>
                <LineChart data={rollingVolData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" />
                  <XAxis
                    dataKey="date"
                    stroke="#666"
                    tick={{ fill: "#666", fontSize: 9, fontFamily: "monospace" }}
                    interval={Math.floor(rollingVolData.length / 8)}
                  />
                  <YAxis
                    stroke="#666"
                    tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                    label={{ value: "avg % move", angle: -90, position: "insideLeft", fill: "#666", fontSize: 11 }}
                  />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontFamily: "monospace", fontSize: 11 }} />
                  <Line type="monotone" dataKey="v1" stroke="#ff1744" name="V1 Logistic" dot={false} strokeWidth={1.5} />
                  <Line type="monotone" dataKey="v2" stroke="#00e676" name="V2 Exponential" dot={false} strokeWidth={1.5} />
                </LineChart>
              </ResponsiveContainer>
              <div className="mt-2 text-[10px] text-muted font-mono">
                V2 typically shows higher and more uniform daily % volatility across all Elo ranges.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
