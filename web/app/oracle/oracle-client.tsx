"use client";

import { useState, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
} from "recharts";
import type { OraclePriceRow, MatchInfo, PmPrice } from "./page";

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

// ─── Types ──────────────────────────────────────────────────
interface ChartPoint {
  date: string;
  price: number | null;
  matchResult?: "W" | "D" | "L";
}

interface TeamStats {
  team: string;
  league: string;
  currentPrice: number;
  currentElo: number;
  seasonDelta: number | null;
  annualizedVol: number | null;
  priceRange: [number, number] | null;
  pmImpliedPrice: number | null;
  divergence: number | null;
}

type SortKey = keyof Pick<
  TeamStats,
  "currentPrice" | "currentElo" | "seasonDelta" | "annualizedVol" | "pmImpliedPrice" | "divergence"
>;

// ─── Props ──────────────────────────────────────────────────
interface Props {
  priceHistory: OraclePriceRow[];
  matches: MatchInfo[];
  pmPrices: PmPrice[];
}

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

function getMatchResult(
  team: string,
  match: MatchInfo
): "W" | "D" | "L" | null {
  const sc = parseScore(match.score);
  if (!sc) return null;
  const [hg, ag] = sc;
  const isHome = match.home_team === team;
  const isAway = match.away_team === team;
  if (!isHome && !isAway) return null;
  if (hg === ag) return "D";
  if (isHome) return hg > ag ? "W" : "L";
  return ag > hg ? "W" : "L";
}

function computeAnnualizedVol(prices: number[]): number | null {
  if (prices.length < 10) return null;
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] === 0) continue;
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  if (returns.length < 5) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

function formatDateTick(dateStr: string): string {
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const d = new Date(dateStr + "T00:00:00Z");
  return months[d.getUTCMonth()];
}

// ─── Result color dot ───────────────────────────────────────
const RESULT_COLOR = {
  W: "#00e676",
  D: "#ffc107",
  L: "#ff1744",
};

// ─── TeamChart ──────────────────────────────────────────────
function TeamChart({
  team,
  league,
  data,
  stats,
  matchPoints,
  large,
}: {
  team: string;
  league: string;
  data: ChartPoint[];
  stats: TeamStats;
  matchPoints: { date: string; price: number; result: "W" | "D" | "L" }[];
  large?: boolean;
}) {
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

  const height = large ? 280 : 165;

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
          <span>Elo {Math.round(stats.currentElo)}</span>
          <span className="text-accent-green">
            ${stats.currentPrice.toFixed(2)}
          </span>
          {stats.pmImpliedPrice !== null && (
            <span className="text-cyan-400">
              PM ${stats.pmImpliedPrice.toFixed(0)}
            </span>
          )}
          {stats.seasonDelta !== null && (
            <span
              className={
                stats.seasonDelta >= 0 ? "text-accent-green" : "text-red-400"
              }
            >
              {stats.seasonDelta >= 0 ? "+" : ""}
              {stats.seasonDelta.toFixed(1)}%
            </span>
          )}
          {stats.annualizedVol !== null && (
            <span>vol {stats.annualizedVol.toFixed(0)}%</span>
          )}
          {stats.priceRange && (
            <span>
              ${stats.priceRange[0].toFixed(0)}&ndash;${stats.priceRange[1].toFixed(0)}
            </span>
          )}
        </span>
      </div>

      {/* Chart */}
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          >
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
              formatter={(value: any) => {
                if (value == null) return ["-", "Price"];
                return [`$${Number(value).toFixed(2)}`, "Price"];
              }}
              labelFormatter={(label: any) => String(label)}
            />
            <Line
              type="monotone"
              dataKey="price"
              stroke="#00e676"
              dot={false}
              strokeWidth={1.5}
              connectNulls
            />
            {/* Match result markers */}
            {matchPoints.map((mp, i) => (
              <ReferenceDot
                key={i}
                x={mp.date}
                y={mp.price}
                r={3}
                fill={RESULT_COLOR[mp.result]}
                stroke="none"
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Main OracleClient ──────────────────────────────────────
export function OracleClient({ priceHistory, matches, pmPrices }: Props) {
  const [activeLeague, setActiveLeague] = useState<string>("All");
  const [showAll, setShowAll] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("currentPrice");
  const [sortAsc, setSortAsc] = useState(false);

  // PM price lookup
  const pmByTeam = useMemo(() => {
    const map = new Map<string, PmPrice>();
    for (const pm of pmPrices) {
      map.set(pm.team, pm);
    }
    return map;
  }, [pmPrices]);

  // Group prices by team
  const pricesByTeam = useMemo(() => {
    const map = new Map<string, OraclePriceRow[]>();
    for (const r of priceHistory) {
      if (!map.has(r.team)) map.set(r.team, []);
      map.get(r.team)!.push(r);
    }
    return map;
  }, [priceHistory]);

  // Match lookup: team → matches involving that team
  const matchesByTeam = useMemo(() => {
    const map = new Map<string, MatchInfo[]>();
    for (const m of matches) {
      if (!map.has(m.home_team)) map.set(m.home_team, []);
      if (!map.has(m.away_team)) map.set(m.away_team, []);
      map.get(m.home_team)!.push(m);
      map.get(m.away_team)!.push(m);
    }
    return map;
  }, [matches]);

  // Compute stats per team
  const teamStats = useMemo(() => {
    const stats: TeamStats[] = [];
    for (const [team, rows] of pricesByTeam) {
      if (rows.length === 0) continue;
      const prices = rows.map((r) => r.dollar_price);
      const first = prices[0];
      const last = prices[prices.length - 1];
      const lastRow = rows[rows.length - 1];

      let min = Infinity;
      let max = -Infinity;
      for (const p of prices) {
        if (p < min) min = p;
        if (p > max) max = p;
      }

      const pm = pmByTeam.get(team);
      const pmImpliedPrice = pm ? pm.impliedPrice : null;
      const divergence = pmImpliedPrice !== null ? Math.round((last - pmImpliedPrice) * 100) / 100 : null;

      stats.push({
        team,
        league: lastRow.league,
        currentPrice: last,
        currentElo: lastRow.implied_elo,
        seasonDelta: first > 0 ? ((last - first) / first) * 100 : null,
        annualizedVol: computeAnnualizedVol(prices),
        priceRange: [
          Math.round(min * 100) / 100,
          Math.round(max * 100) / 100,
        ],
        pmImpliedPrice,
        divergence,
      });
    }
    return stats;
  }, [pricesByTeam, pmByTeam]);

  // Build chart data per team
  const chartDataByTeam = useMemo(() => {
    const map = new Map<
      string,
      { data: ChartPoint[]; matchPoints: { date: string; price: number; result: "W" | "D" | "L" }[] }
    >();

    for (const [team, rows] of pricesByTeam) {
      // Price map for quick lookup
      const priceMap = new Map<string, number>();
      const data: ChartPoint[] = rows.map((r) => {
        priceMap.set(r.date, r.dollar_price);
        return { date: r.date, price: r.dollar_price };
      });

      // Match result markers
      const teamMatches = matchesByTeam.get(team) ?? [];
      const matchPoints: { date: string; price: number; result: "W" | "D" | "L" }[] = [];
      for (const m of teamMatches) {
        const result = getMatchResult(team, m);
        if (!result) continue;
        const price = priceMap.get(m.date);
        if (price !== undefined) {
          matchPoints.push({ date: m.date, price, result });
        }
      }

      map.set(team, { data, matchPoints });
    }
    return map;
  }, [pricesByTeam, matchesByTeam]);

  // Filter & sort
  const filteredTeams = useMemo(() => {
    let teams = teamStats;
    if (activeLeague !== "All") {
      const fullName = Object.entries(LEAGUE_SHORT).find(
        ([, v]) => v === activeLeague
      )?.[0];
      if (fullName) {
        teams = teams.filter((t) => t.league === fullName);
      }
    }
    return [...teams].sort((a, b) => {
      const aVal = a[sortKey] ?? -Infinity;
      const bVal = b[sortKey] ?? -Infinity;
      return sortAsc ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
  }, [teamStats, activeLeague, sortKey, sortAsc]);

  const displayTeams = showAll ? filteredTeams : filteredTeams.slice(0, INITIAL_SHOW);
  const leagues = ["All", "EPL", "ESP", "BUN", "ITA", "FRA"];

  // Selected team for featured chart
  const featured = selectedTeam ?? (filteredTeams.length > 0 ? filteredTeams[0].team : null);
  const featuredStats = teamStats.find((t) => t.team === featured);
  const featuredChart = featured ? chartDataByTeam.get(featured) : null;

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  }

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortAsc ? " ▲" : " ▼") : "";

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
                setSelectedTeam(null);
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
        </div>
      </div>

      {/* Spec summary */}
      <div className="border border-border rounded-lg p-3 bg-card/50 text-xs font-mono text-muted">
        <span className="text-foreground font-bold">Oracle 1b:</span>{" "}
        price = max($10, (elo &minus; 1000) / 5) &middot; K=40 &middot;
        forward-looking BT (14d) &middot; freshness exp(&minus;h/72) &middot;
        live shocks 0.5&times; &middot; carry decay 0.15%/d &rarr; 45d MA &middot;
        xG [0.4, 1.8]
      </div>

      {/* Featured team chart */}
      {featured && featuredStats && featuredChart && (
        <TeamChart
          team={featured}
          league={featuredStats.league}
          data={featuredChart.data}
          stats={featuredStats}
          matchPoints={featuredChart.matchPoints}
          large
        />
      )}

      {/* Sortable team table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="bg-card border-b border-border text-muted">
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">Team</th>
                <th className="px-3 py-2 text-left">League</th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("currentPrice")}
                >
                  Price{sortArrow("currentPrice")}
                </th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("currentElo")}
                >
                  Elo{sortArrow("currentElo")}
                </th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("pmImpliedPrice")}
                >
                  PM Implied{sortArrow("pmImpliedPrice")}
                </th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("divergence")}
                >
                  Divergence{sortArrow("divergence")}
                </th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("seasonDelta")}
                >
                  Season &Delta;{sortArrow("seasonDelta")}
                </th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("annualizedVol")}
                >
                  Ann. Vol{sortArrow("annualizedVol")}
                </th>
                <th className="px-3 py-2 text-right">Range</th>
              </tr>
            </thead>
            <tbody>
              {filteredTeams.map((t, i) => {
                const isSelected = t.team === featured;
                return (
                  <tr
                    key={t.team}
                    className={`border-b border-border cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-accent-green/10"
                        : "hover:bg-card/50"
                    }`}
                    onClick={() => setSelectedTeam(t.team)}
                  >
                    <td className="px-3 py-2 text-muted">{i + 1}</td>
                    <td className="px-3 py-2 text-foreground flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{
                          backgroundColor: LEAGUE_COLOR[t.league] ?? "#888",
                        }}
                      />
                      {t.team}
                    </td>
                    <td className="px-3 py-2 text-muted">
                      {LEAGUE_SHORT[t.league] ?? t.league}
                    </td>
                    <td className="px-3 py-2 text-right text-accent-green">
                      ${t.currentPrice.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {Math.round(t.currentElo)}
                    </td>
                    <td className="px-3 py-2 text-right text-cyan-400">
                      {t.pmImpliedPrice !== null
                        ? `$${t.pmImpliedPrice.toFixed(2)}`
                        : "—"}
                    </td>
                    <td
                      className={`px-3 py-2 text-right ${
                        t.divergence !== null
                          ? t.divergence >= 0
                            ? "text-accent-green"
                            : "text-red-400"
                          : "text-muted"
                      }`}
                    >
                      {t.divergence !== null
                        ? `${t.divergence >= 0 ? "+" : ""}${t.divergence.toFixed(2)}`
                        : "—"}
                    </td>
                    <td
                      className={`px-3 py-2 text-right ${
                        t.seasonDelta !== null
                          ? t.seasonDelta >= 0
                            ? "text-accent-green"
                            : "text-red-400"
                          : "text-muted"
                      }`}
                    >
                      {t.seasonDelta !== null
                        ? `${t.seasonDelta >= 0 ? "+" : ""}${t.seasonDelta.toFixed(1)}%`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-muted">
                      {t.annualizedVol !== null
                        ? `${t.annualizedVol.toFixed(0)}%`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-muted">
                      {t.priceRange
                        ? `$${t.priceRange[0].toFixed(0)}–$${t.priceRange[1].toFixed(0)}`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Team charts grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {displayTeams.map((t) => {
          const chart = chartDataByTeam.get(t.team);
          if (!chart) return null;
          return (
            <div
              key={t.team}
              onClick={() => setSelectedTeam(t.team)}
              className="cursor-pointer"
            >
              <TeamChart
                team={t.team}
                league={t.league}
                data={chart.data}
                stats={t}
                matchPoints={chart.matchPoints}
              />
            </div>
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
