"use client";

import { useState, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { PriceHistoryRow, V2Point } from "./page";

// ─── Constants ───────────────────────────────────────────────
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
  fontSize: "11px",
};

const INITIAL_SHOW = 20;

// ─── Props ──────────────────────────────────────────────────
interface Props {
  startingElos: { team: string; league: string; startingElo: number }[];
  priceHistory: PriceHistoryRow[];
  v2Series: Record<string, V2Point[]>;
}

// ─── Merge helper ───────────────────────────────────────────
interface ChartPoint {
  date: string;
  current?: number;
  v2?: number;
}

function mergeTimelines(
  currentPrices: PriceHistoryRow[],
  v2Points: V2Point[]
): ChartPoint[] {
  const map = new Map<string, ChartPoint>();

  for (const p of v2Points) {
    if (!map.has(p.date)) map.set(p.date, { date: p.date });
    map.get(p.date)!.v2 = Math.round(p.price * 100) / 100;
  }

  for (const p of currentPrices) {
    if (!map.has(p.date)) map.set(p.date, { date: p.date });
    map.get(p.date)!.current =
      Math.round(p.dollar_price * 100) / 100;
  }

  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Stats helpers ──────────────────────────────────────────
function pctDelta(pts: V2Point[]): number | null {
  if (pts.length < 2) return null;
  const first = pts[0].price;
  const last = pts[pts.length - 1].price;
  if (first === 0) return null;
  return ((last - first) / first) * 100;
}

function annualizedVol(pts: V2Point[]): number | null {
  if (pts.length < 10) return null;
  const returns: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i - 1].price === 0) continue;
    returns.push((pts[i].price - pts[i - 1].price) / pts[i - 1].price);
  }
  if (returns.length < 5) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

function priceRange(pts: V2Point[]): [number, number] | null {
  if (pts.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    if (p.price < min) min = p.price;
    if (p.price > max) max = p.price;
  }
  return [Math.round(min * 100) / 100, Math.round(max * 100) / 100];
}

// ─── Format month ticks ─────────────────────────────────────
function formatDateTick(dateStr: string): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const d = new Date(dateStr + "T00:00:00Z");
  return months[d.getUTCMonth()];
}

// ─── TeamChart ──────────────────────────────────────────────
function TeamChart({
  team,
  league,
  elo,
  data,
  v2Points,
}: {
  team: string;
  league: string;
  elo: number;
  data: ChartPoint[];
  v2Points: V2Point[];
}) {
  const delta = pctDelta(v2Points);
  const vol = annualizedVol(v2Points);
  const range = priceRange(v2Points);
  const lastPrice = v2Points.length > 0 ? v2Points[v2Points.length - 1].price : null;

  // Month ticks: one per month
  const monthTicks = useMemo(() => {
    const seen = new Set<string>();
    const ticks: string[] = [];
    for (const pt of data) {
      const ym = pt.date.slice(0, 7);
      if (!seen.has(ym)) {
        seen.add(ym);
        ticks.push(pt.date);
      }
    }
    return ticks;
  }, [data]);

  return (
    <div className="border border-border rounded-lg p-4 bg-card">
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: LEAGUE_COLOR[league] ?? "#888" }}
        />
        <span className="font-bold text-foreground text-sm truncate">
          {team}
        </span>
        <span className="text-xs text-muted font-mono ml-auto flex gap-3 flex-shrink-0">
          <span>
            Elo {Math.round(elo)}
          </span>
          {lastPrice !== null && (
            <span className="text-accent-green">
              ${lastPrice.toFixed(0)}
            </span>
          )}
          {delta !== null && (
            <span className={delta >= 0 ? "text-accent-green" : "text-red-400"}>
              {delta >= 0 ? "+" : ""}
              {delta.toFixed(1)}%
            </span>
          )}
          {vol !== null && (
            <span>vol {vol.toFixed(0)}%</span>
          )}
          {range && (
            <span>
              ${range[0].toFixed(0)}–${range[1].toFixed(0)}
            </span>
          )}
        </span>
      </div>

      {/* Chart */}
      <div style={{ width: "100%", height: 165 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="date"
              ticks={monthTicks}
              tickFormatter={formatDateTick}
              tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
              axisLine={{ stroke: "#333" }}
              tickLine={false}
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
              axisLine={false}
              tickLine={false}
              width={40}
              tickFormatter={(v: number) => `$${v.toFixed(0)}`}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={(value: any, name: any) => {
                if (value == null) return ["-", String(name)];
                return [
                  `$${Number(value).toFixed(2)}`,
                  name === "current" ? "Current" : "V2",
                ];
              }}
              labelFormatter={(label: any) => String(label)}
            />
            <Line
              type="monotone"
              dataKey="current"
              stroke="#ff6b6b"
              dot={false}
              strokeWidth={1.5}
              connectNulls
              name="current"
            />
            <Line
              type="monotone"
              dataKey="v2"
              stroke="#00e676"
              dot={false}
              strokeWidth={1.5}
              connectNulls
              name="v2"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Main V3Client ──────────────────────────────────────────
export function V3Client({ startingElos, priceHistory, v2Series }: Props) {
  const [activeLeague, setActiveLeague] = useState<string>("All");
  const [showAll, setShowAll] = useState(false);

  // Group current price history by team
  const currentByTeam = useMemo(() => {
    const map = new Map<string, PriceHistoryRow[]>();
    for (const r of priceHistory) {
      if (!map.has(r.team)) map.set(r.team, []);
      map.get(r.team)!.push(r);
    }
    return map;
  }, [priceHistory]);

  // Filter and sort teams
  const filteredTeams = useMemo(() => {
    let teams = startingElos;
    if (activeLeague !== "All") {
      // Reverse lookup full league name from short code
      const fullName = Object.entries(LEAGUE_SHORT).find(
        ([, v]) => v === activeLeague
      )?.[0];
      if (fullName) {
        teams = teams.filter((t) => t.league === fullName);
      }
    }
    // Sort by V2 latest elo desc (fallback to starting elo)
    return [...teams].sort((a, b) => {
      const aV2 = v2Series[a.team];
      const bV2 = v2Series[b.team];
      const aElo = aV2 && aV2.length > 0 ? aV2[aV2.length - 1].elo : a.startingElo;
      const bElo = bV2 && bV2.length > 0 ? bV2[bV2.length - 1].elo : b.startingElo;
      return bElo - aElo;
    });
  }, [startingElos, activeLeague, v2Series]);

  const displayTeams = showAll ? filteredTeams : filteredTeams.slice(0, INITIAL_SHOW);

  const leagues = ["All", "EPL", "ESP", "BUN", "ITA", "FRA"];

  return (
    <div className="space-y-6">
      {/* Controls row */}
      <div className="flex items-center gap-4 flex-wrap">
        {/* League filter */}
        <div className="flex gap-1">
          {leagues.map((l) => (
            <button
              key={l}
              onClick={() => {
                setActiveLeague(l);
                setShowAll(false);
              }}
              className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors ${
                activeLeague === l
                  ? "bg-accent-green text-background font-bold"
                  : "bg-card text-muted hover:text-foreground border border-border"
              }`}
            >
              {l}
            </button>
          ))}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 ml-auto text-xs font-mono text-muted">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-[#ff6b6b] inline-block rounded" />
            Current Oracle
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-[#00e676] inline-block rounded" />
            V2 Oracle
          </span>
        </div>
      </div>

      {/* V2 spec summary */}
      <div className="border border-border rounded-lg p-3 bg-card/50 text-xs font-mono text-muted">
        <span className="text-foreground font-bold">V2 Spec:</span>{" "}
        price = max($10, (elo − 800) / 5) &middot; K=20 &middot;
        carry decay 0.1%/day → 45d MA &middot;
        xG mult [0.4, 1.8] &middot; shocks permanent
      </div>

      {/* Team charts grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {displayTeams.map((t) => {
          const v2 = v2Series[t.team] ?? [];
          const current = currentByTeam.get(t.team) ?? [];
          const merged = mergeTimelines(current, v2);
          const latestElo =
            v2.length > 0 ? v2[v2.length - 1].elo : t.startingElo;

          return (
            <TeamChart
              key={t.team}
              team={t.team}
              league={t.league}
              elo={latestElo}
              data={merged}
              v2Points={v2}
            />
          );
        })}
      </div>

      {/* Show all toggle */}
      {!showAll && filteredTeams.length > INITIAL_SHOW && (
        <div className="text-center">
          <button
            onClick={() => setShowAll(true)}
            className="px-6 py-2 text-xs font-mono text-accent-green border border-accent-green/30 rounded-lg hover:bg-accent-green/10 transition-colors"
          >
            Show all {filteredTeams.length} teams
          </button>
        </div>
      )}

      {showAll && filteredTeams.length > INITIAL_SHOW && (
        <div className="text-center">
          <button
            onClick={() => setShowAll(false)}
            className="px-6 py-2 text-xs font-mono text-muted border border-border rounded-lg hover:text-foreground transition-colors"
          >
            Show top {INITIAL_SHOW} only
          </button>
        </div>
      )}
    </div>
  );
}
