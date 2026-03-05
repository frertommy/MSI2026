"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
} from "recharts";
import type { TeamOracleRow, SettlementRow, MatchRow, PriceHistoryRow } from "./page";

// ─── Constants ───────────────────────────────────────────────

const LEAGUE_SHORT: Record<string, string> = {
  "Premier League": "EPL",
  "La Liga": "ESP",
  Bundesliga: "BUN",
  "Serie A": "ITA",
  "Ligue 1": "FRA",
};

const LEAGUE_FULL: Record<string, string> = {
  EPL: "Premier League",
  ESP: "La Liga",
  BUN: "Bundesliga",
  ITA: "Serie A",
  FRA: "Ligue 1",
};

const LEAGUE_COLOR: Record<string, string> = {
  "Premier League": "text-purple-400",
  "La Liga": "text-orange-400",
  Bundesliga: "text-red-400",
  "Serie A": "text-blue-400",
  "Ligue 1": "text-cyan-400",
};

const LEAGUE_DOT_COLOR: Record<string, string> = {
  "Premier League": "#a855f7",
  "La Liga": "#fb923c",
  Bundesliga: "#f87171",
  "Serie A": "#60a5fa",
  "Ligue 1": "#22d3ee",
};

const RESULT_COLOR = {
  W: "#00e676",
  D: "#ffc107",
  L: "#ff1744",
};

const tooltipStyle = {
  backgroundColor: "#111",
  border: "1px solid #333",
  borderRadius: "4px",
  fontFamily: "monospace",
  fontSize: "11px",
};

// ─── Types ──────────────────────────────────────────────────

interface TeamTableRow {
  rank: number;
  team_id: string;
  league: string;
  published_index: number;
  B_value: number;
  M1_value: number;
  confidence_score: number | null;
  last_delta_B: number | null;
  next_match_label: string | null;
  settled_count: number;
  b_trend: number[]; // last 5 B_after values
  latest_settled_at: string | null;
}

type SortKey =
  | "published_index"
  | "B_value"
  | "M1_value"
  | "confidence_score"
  | "last_delta_B"
  | "settled_count";

interface ChartPoint {
  /** The corrected date used for x-axis (match date for settlements, real ts for market_refresh, season start for bootstrap) */
  date: string;
  /** Numeric epoch ms for proportional x-axis spacing */
  dateTs: number;
  /** Raw timestamp from oracle_price_history */
  rawTimestamp: string;
  published_index: number;
  B_value: number;
  M1_value: number;
  publish_reason: string;
  /** Only present for settlement rows */
  result?: "W" | "D" | "L";
  delta_B?: number;
  opponent?: string;
  fixture_id?: number;
}

type YAxisMode = "price" | "index";
type Timeframe = "1W" | "1M" | "3M" | "6M" | "SEASON";

const TIMEFRAME_DAYS: Record<Timeframe, number> = {
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "6M": 180,
  SEASON: 9999, // effectively no limit
};

const SEASON_START = "2025-08-01";

// ─── Props ──────────────────────────────────────────────────

interface Props {
  teamStates: TeamOracleRow[];
  settlements: SettlementRow[];
  matches: MatchRow[];
}

// ─── Helpers ────────────────────────────────────────────────

function resultFromS(s: number): "W" | "D" | "L" {
  if (s >= 0.9) return "W";
  if (s >= 0.4) return "D";
  return "L";
}

function daysUntil(dateStr: string): number {
  const now = new Date();
  const target = new Date(dateStr);
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
}

function formatDaysUntil(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "1d";
  return `${days}d`;
}

function indexToPrice(published_index: number): number {
  return Math.round(((published_index - 800) / 5) * 100) / 100;
}

// ─── Mini Sparkline ─────────────────────────────────────────

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-muted">—</span>;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const h = 16;
  const w = 48;
  const step = w / (values.length - 1);

  const points = values.map((v, i) => {
    const x = i * step;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const trending = values[values.length - 1] > values[0];

  return (
    <svg width={w} height={h} className="inline-block">
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={trending ? "#00e676" : "#ff1744"}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ─── Main Client Component ─────────────────────────────────

export function OracleV1Client({ teamStates, settlements, matches }: Props) {
  const [activeLeague, setActiveLeague] = useState<string>("All");
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("published_index");
  const [sortAsc, setSortAsc] = useState(false);
  const [yAxisMode, setYAxisMode] = useState<YAxisMode>("price");
  const [timeframe, setTimeframe] = useState<Timeframe>("SEASON");

  // ── On-demand price history (lazy-loaded per team) ────────
  const [priceHistoryCache, setPriceHistoryCache] = useState<Map<string, PriceHistoryRow[]>>(new Map());
  const [priceHistoryLoading, setPriceHistoryLoading] = useState(false);
  const fetchingRef = useRef<string | null>(null);

  const fetchPriceHistory = useCallback(async (team: string) => {
    if (priceHistoryCache.has(team)) return; // already cached
    if (fetchingRef.current === team) return; // already in-flight
    fetchingRef.current = team;
    setPriceHistoryLoading(true);
    try {
      const res = await fetch(`/api/price-history?team=${encodeURIComponent(team)}`);
      if (res.ok) {
        const data: PriceHistoryRow[] = await res.json();
        setPriceHistoryCache((prev) => {
          const next = new Map(prev);
          next.set(team, data);
          return next;
        });
      }
    } finally {
      setPriceHistoryLoading(false);
      fetchingRef.current = null;
    }
  }, [priceHistoryCache]);

  // Fetch price history when team is selected
  useEffect(() => {
    if (selectedTeam) {
      fetchPriceHistory(selectedTeam);
    }
  }, [selectedTeam, fetchPriceHistory]);

  // ── Derived lookups ────────────────────────────────────────

  // Team → league (from matches — find most common league for this team)
  const teamLeague = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const m of matches) {
      for (const t of [m.home_team, m.away_team]) {
        if (!map.has(t)) map.set(t, new Map());
        const leagueCount = map.get(t)!;
        leagueCount.set(m.league, (leagueCount.get(m.league) ?? 0) + 1);
      }
    }
    const result = new Map<string, string>();
    for (const [team, leagues] of map) {
      let best = "";
      let bestCount = 0;
      for (const [league, count] of leagues) {
        if (count > bestCount) {
          best = league;
          bestCount = count;
        }
      }
      if (best) result.set(team, best);
    }
    return result;
  }, [matches]);

  // Match lookup by fixture_id
  const matchById = useMemo(() => {
    const map = new Map<number, MatchRow>();
    for (const m of matches) map.set(m.fixture_id, m);
    return map;
  }, [matches]);

  // Settlements by team (already sorted by settled_at DESC from server)
  const settlementsByTeam = useMemo(() => {
    const map = new Map<string, SettlementRow[]>();
    for (const s of settlements) {
      if (s.has_error) continue; // skip failures
      if (!map.has(s.team_id)) map.set(s.team_id, []);
      map.get(s.team_id)!.push(s);
    }
    return map;
  }, [settlements]);

  // Earliest match date per team (for bootstrap rows)
  const earliestMatchDate = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of matches) {
      for (const t of [m.home_team, m.away_team]) {
        const existing = map.get(t);
        if (!existing || m.date < existing) {
          map.set(t, m.date);
        }
      }
    }
    return map;
  }, [matches]);

  // Settlement lookup: fixture_id+team → SettlementRow (for result/delta on chart)
  const settlementLookup = useMemo(() => {
    const map = new Map<string, SettlementRow>();
    for (const s of settlements) {
      if (s.has_error) continue;
      map.set(`${s.fixture_id}:${s.team_id}`, s);
    }
    return map;
  }, [settlements]);

  // ── Build table rows ──────────────────────────────────────

  const tableRows = useMemo(() => {
    const rows: TeamTableRow[] = [];

    for (const ts of teamStates) {
      const league = teamLeague.get(ts.team_id) ?? "";
      const teamSettlements = settlementsByTeam.get(ts.team_id) ?? [];

      // Last delta_B (most recent settlement)
      const lastDeltaB = teamSettlements.length > 0 ? Number(teamSettlements[0].delta_B) : null;

      // Next match label
      let nextMatchLabel: string | null = null;
      if (ts.next_fixture_id != null) {
        const match = matchById.get(ts.next_fixture_id);
        if (match) {
          const opponent =
            match.home_team === ts.team_id ? match.away_team : match.home_team;
          const days = daysUntil(match.commence_time ?? match.date);
          nextMatchLabel = `vs ${opponent} · ${formatDaysUntil(days)}`;
        }
      }

      // B trend: last 5 B_after values (chronological order = reversed from DESC)
      const last5 = teamSettlements.slice(0, 5).reverse();
      const bTrend = last5.map((s) => Number(s.B_after));

      // Latest settled_at
      const latestSettledAt = teamSettlements.length > 0
        ? teamSettlements[0].settled_at
        : null;

      rows.push({
        rank: 0,
        team_id: ts.team_id,
        league,
        published_index: Number(ts.published_index),
        B_value: Number(ts.B_value),
        M1_value: Number(ts.M1_value),
        confidence_score: ts.confidence_score != null ? Number(ts.confidence_score) : null,
        last_delta_B: lastDeltaB,
        next_match_label: nextMatchLabel,
        settled_count: teamSettlements.length,
        b_trend: bTrend,
        latest_settled_at: latestSettledAt,
      });
    }

    return rows;
  }, [teamStates, teamLeague, settlementsByTeam, matchById]);

  // ── Filter & sort ─────────────────────────────────────────

  const filteredRows = useMemo(() => {
    let rows = tableRows;
    if (activeLeague !== "All") {
      const fullName = LEAGUE_FULL[activeLeague];
      if (fullName) {
        rows = rows.filter((r) => r.league === fullName);
      }
    }

    const sorted = [...rows].sort((a, b) => {
      const aVal = a[sortKey] ?? -Infinity;
      const bVal = b[sortKey] ?? -Infinity;
      return sortAsc
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });

    // Assign ranks
    sorted.forEach((r, i) => (r.rank = i + 1));
    return sorted;
  }, [tableRows, activeLeague, sortKey, sortAsc]);

  // ── League filter counts ──────────────────────────────────

  const leagueCounts = useMemo(() => {
    const counts: Record<string, number> = { All: tableRows.length };
    for (const r of tableRows) {
      const short = LEAGUE_SHORT[r.league] ?? r.league;
      counts[short] = (counts[short] ?? 0) + 1;
    }
    return counts;
  }, [tableRows]);

  // ── Chart data for selected team (from lazy-loaded price history) ──

  const selectedData = useMemo((): ChartPoint[] | null => {
    const team = selectedTeam;
    if (!team) return null;

    const rows = priceHistoryCache.get(team);
    if (!rows || rows.length === 0) return null;

    // No client-side dedup needed — server already deduplicates market_refresh rows

    const points: ChartPoint[] = [];
    for (const ph of rows) {
      let date: string;

      if (ph.publish_reason === "settlement" && ph.source_fixture_id != null) {
        // Use the actual match date, not the backfill timestamp
        const match = matchById.get(ph.source_fixture_id);
        date = match ? match.date.slice(0, 10) : ph.timestamp.slice(0, 10);
      } else if (ph.publish_reason === "market_refresh" || ph.publish_reason === "live_update") {
        // Real-time M1 updates — timestamp is correct
        date = ph.timestamp.slice(0, 10);
      } else if (ph.publish_reason === "bootstrap") {
        // Use earliest match date for team, or season start
        date = earliestMatchDate.get(team)?.slice(0, 10) ?? SEASON_START;
      } else {
        date = ph.timestamp.slice(0, 10);
      }

      const point: ChartPoint = {
        date,
        dateTs: new Date(date + "T00:00:00Z").getTime(),
        rawTimestamp: ph.timestamp,
        published_index: Number(ph.published_index),
        B_value: Number(ph.B_value),
        M1_value: Number(ph.M1_value),
        publish_reason: ph.publish_reason,
      };

      // Enrich settlement points with result info
      if (ph.publish_reason === "settlement" && ph.source_fixture_id != null) {
        const sKey = `${ph.source_fixture_id}:${team}`;
        const settlement = settlementLookup.get(sKey);
        if (settlement) {
          point.result = resultFromS(Number(settlement.actual_score_S));
          point.delta_B = Number(settlement.delta_B);
        }
        const match = matchById.get(ph.source_fixture_id);
        if (match) {
          point.opponent =
            match.home_team === team ? match.away_team : match.home_team;
        }
        point.fixture_id = ph.source_fixture_id;
      }

      points.push(point);
    }

    // Sort by date (corrected), then by rawTimestamp within same date
    points.sort((a, b) => {
      const cmp = a.date.localeCompare(b.date);
      if (cmp !== 0) return cmp;
      return a.rawTimestamp.localeCompare(b.rawTimestamp);
    });

    return points;
  }, [selectedTeam, priceHistoryCache, matchById, earliestMatchDate, settlementLookup]);

  // ── Filtered chart data by timeframe ──────────────────────

  const filteredChartData = useMemo((): ChartPoint[] | null => {
    if (!selectedData || selectedData.length === 0) return selectedData;

    const days = TIMEFRAME_DAYS[timeframe];
    if (days >= 9999) return selectedData; // SEASON — show all

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const filtered = selectedData.filter((p) => p.date >= cutoffStr);

    // If no data in range, show last known value as flat line
    if (filtered.length === 0 && selectedData.length > 0) {
      const lastPoint = selectedData[selectedData.length - 1];
      const todayStr = new Date().toISOString().slice(0, 10);
      return [
        { ...lastPoint, date: cutoffStr, dateTs: new Date(cutoffStr + "T00:00:00Z").getTime() },
        { ...lastPoint, date: todayStr, dateTs: new Date(todayStr + "T00:00:00Z").getTime() },
      ];
    }

    return filtered;
  }, [selectedData, timeframe]);

  const selectedState = useMemo(
    () => teamStates.find((t) => t.team_id === selectedTeam) ?? null,
    [selectedTeam, teamStates]
  );

  // ── Sort handlers ─────────────────────────────────────────

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

  const leagues = ["All", "EPL", "BUN", "ESP", "FRA", "ITA"];

  // ── Render ────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Spec summary */}
      <div className="border border-border rounded-lg p-3 bg-surface/50 text-xs font-mono text-muted">
        <span className="text-foreground font-bold">Oracle V1:</span>{" "}
        B = &Sigma;(K &times; (S &minus; E_KR)) &middot; K=30 &middot; M1 = c(t) &times;
        (R_mkt &minus; B) &middot; Index = B + M1
      </div>

      {/* League filter pills */}
      <div className="flex flex-wrap gap-2">
        {leagues.map((l) => (
          <button
            key={l}
            onClick={() => {
              setActiveLeague(l);
              setSelectedTeam(null);
            }}
            className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded border transition-all font-mono ${
              activeLeague === l
                ? "bg-foreground text-background border-foreground"
                : "bg-transparent text-muted border-border hover:border-muted hover:text-foreground"
            }`}
          >
            {l} ({leagueCounts[l] ?? 0})
          </button>
        ))}
      </div>

      {/* Loading state for price history */}
      {selectedTeam && priceHistoryLoading && !priceHistoryCache.has(selectedTeam) && (
        <div className="border border-border rounded-lg p-4 bg-surface">
          <div className="flex items-center gap-3">
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{
                backgroundColor:
                  LEAGUE_DOT_COLOR[teamLeague.get(selectedTeam) ?? ""] ?? "#888",
              }}
            />
            <span className="font-bold text-foreground text-sm">
              {selectedTeam}
            </span>
            <span className="text-xs text-muted font-mono ml-auto animate-pulse">
              Loading chart data...
            </span>
          </div>
        </div>
      )}

      {/* Chart (shown when a team is selected and data is loaded) */}
      {selectedTeam && filteredChartData && filteredChartData.length > 0 && selectedState && (
        <div className="border border-border rounded-lg p-4 bg-surface">
          {/* Chart header */}
          <div className="flex items-center gap-3 mb-3">
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{
                backgroundColor:
                  LEAGUE_DOT_COLOR[teamLeague.get(selectedTeam) ?? ""] ?? "#888",
              }}
            />
            <span className="font-bold text-foreground text-sm">
              {selectedTeam}
            </span>
            <span className="text-xs text-muted font-mono ml-auto flex gap-4 flex-shrink-0">
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
            </span>
          </div>

          {/* Toggle row: $PRICE / INDEX + Timeframe */}
          <div className="flex flex-wrap items-center gap-3 mb-3">
            {/* Y-axis mode toggle */}
            <div className="flex rounded border border-border overflow-hidden">
              {(["price", "index"] as YAxisMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setYAxisMode(mode)}
                  className={`px-3 py-1 text-xs font-bold font-mono uppercase tracking-wider transition-all ${
                    yAxisMode === mode
                      ? "bg-foreground text-background"
                      : "bg-transparent text-muted hover:text-foreground"
                  }`}
                >
                  {mode === "price" ? "$PRICE" : "INDEX"}
                </button>
              ))}
            </div>

            {/* Timeframe toggle */}
            <div className="flex rounded border border-border overflow-hidden ml-auto">
              {(["1W", "1M", "3M", "6M", "SEASON"] as Timeframe[]).map((tf) => (
                <button
                  key={tf}
                  onClick={() => setTimeframe(tf)}
                  className={`px-2.5 py-1 text-xs font-bold font-mono tracking-wider transition-all ${
                    timeframe === tf
                      ? "bg-foreground text-background"
                      : "bg-transparent text-muted hover:text-foreground"
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>

          {/* Recharts — published_index over corrected dates */}
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={filteredChartData}
                margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
              >
                <XAxis
                  dataKey="dateTs"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={{ stroke: "#333" }}
                  tickLine={false}
                  tickFormatter={(v: number) => {
                    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                    const d = new Date(v);
                    return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
                  }}
                />
                <YAxis
                  domain={["auto", "auto"]}
                  tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={false}
                  tickLine={false}
                  width={yAxisMode === "price" ? 60 : 50}
                  tickFormatter={(v: number) =>
                    yAxisMode === "price"
                      ? `$${indexToPrice(v).toFixed(2)}`
                      : v.toFixed(1)
                  }
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const pt = payload[0].payload as ChartPoint;
                    const displayVal =
                      yAxisMode === "price"
                        ? `$${indexToPrice(pt.published_index).toFixed(2)}`
                        : pt.published_index.toFixed(1);
                    return (
                      <div style={tooltipStyle} className="p-2">
                        <div className="text-foreground font-bold">{pt.date}</div>
                        {pt.opponent && (
                          <div className="text-muted">vs {pt.opponent}</div>
                        )}
                        {pt.result && pt.delta_B != null && (
                          <div>
                            <span style={{ color: RESULT_COLOR[pt.result] }}>
                              {pt.result}
                            </span>
                            {" · "}
                            <span
                              style={{ color: pt.delta_B >= 0 ? "#00e676" : "#ff1744" }}
                            >
                              {pt.delta_B >= 0 ? "+" : ""}
                              {pt.delta_B.toFixed(2)}
                            </span>
                          </div>
                        )}
                        {!pt.result && (
                          <div className="text-muted text-[10px]">
                            {pt.publish_reason === "market_refresh" || pt.publish_reason === "live_update"
                              ? "M1 update"
                              : pt.publish_reason}
                          </div>
                        )}
                        <div className="text-foreground">
                          {yAxisMode === "price" ? "Price" : "Index"} = {displayVal}
                        </div>
                        <div className="text-muted text-[10px]">
                          B={pt.B_value.toFixed(1)} M1={pt.M1_value >= 0 ? "+" : ""}{pt.M1_value.toFixed(1)}
                        </div>
                      </div>
                    );
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="published_index"
                  stroke="#00e676"
                  dot={false}
                  strokeWidth={1.5}
                  connectNulls
                />
                {/* Result markers (settlement points only) */}
                {filteredChartData
                  .filter((pt) => pt.result)
                  .map((pt, i) => (
                    <ReferenceDot
                      key={i}
                      x={pt.dateTs}
                      y={pt.published_index}
                      r={4}
                      fill={RESULT_COLOR[pt.result!]}
                      stroke="none"
                    />
                  ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Stat row below chart */}
          <div className="mt-3 flex flex-wrap gap-4 text-xs font-mono text-muted border-t border-border pt-3">
            <span>
              Price{" "}
              <span className="text-foreground font-bold">
                ${indexToPrice(Number(selectedState.published_index)).toFixed(2)}
              </span>
            </span>
            <span>
              Index{" "}
              <span className="text-foreground font-bold">
                {Number(selectedState.published_index).toFixed(1)}
              </span>
            </span>
            <span>
              B{" "}
              <span className="text-foreground">
                {Number(selectedState.B_value).toFixed(2)}
              </span>
            </span>
            <span>
              M1{" "}
              <span
                className={
                  Number(selectedState.M1_value) > 0
                    ? "text-accent-green"
                    : Number(selectedState.M1_value) < 0
                    ? "text-accent-red"
                    : "text-muted"
                }
              >
                {Number(selectedState.M1_value) >= 0 ? "+" : ""}
                {Number(selectedState.M1_value).toFixed(2)}
              </span>
            </span>
            <span>
              Conf{" "}
              <span
                className={
                  selectedState.confidence_score != null &&
                  Number(selectedState.confidence_score) < 0.4
                    ? "text-muted italic"
                    : "text-foreground"
                }
              >
                {selectedState.confidence_score != null
                  ? `${(Number(selectedState.confidence_score) * 100).toFixed(0)}%`
                  : "—"}
              </span>
            </span>
            {(() => {
              const nextFix = selectedState.next_fixture_id
                ? matchById.get(selectedState.next_fixture_id)
                : null;
              if (!nextFix) return null;
              const opp =
                nextFix.home_team === selectedTeam
                  ? nextFix.away_team
                  : nextFix.home_team;
              return (
                <span>
                  Next{" "}
                  <span className="text-foreground">vs {opp}</span>
                </span>
              );
            })()}
            <span>
              Settled{" "}
              <span className="text-foreground">
                {(settlementsByTeam.get(selectedTeam) ?? []).length} matches
              </span>
            </span>
          </div>
        </div>
      )}

      {/* Team table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="bg-surface border-b border-border text-muted uppercase tracking-wider">
                <th className="px-3 py-2 text-right w-8">#</th>
                <th className="px-3 py-2 text-left">Team</th>
                <th className="px-3 py-2 text-left w-12">League</th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("published_index")}
                >
                  Index{sortArrow("published_index")}
                </th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("published_index")}
                >
                  $Price{sortArrow("published_index")}
                </th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("B_value")}
                >
                  B{sortArrow("B_value")}
                </th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("M1_value")}
                >
                  M1{sortArrow("M1_value")}
                </th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("confidence_score")}
                >
                  Conf{sortArrow("confidence_score")}
                </th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("last_delta_B")}
                >
                  Last &Delta;{sortArrow("last_delta_B")}
                </th>
                <th className="px-3 py-2 text-left hidden md:table-cell">Next</th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("settled_count")}
                >
                  Settled{sortArrow("settled_count")}
                </th>
                <th className="px-3 py-2 text-center hidden sm:table-cell">B Trend</th>
                <th className="px-3 py-2 text-right hidden lg:table-cell">Latest</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => {
                const isSelected = r.team_id === selectedTeam;
                return (
                  <tr
                    key={r.team_id}
                    onClick={() =>
                      setSelectedTeam(r.team_id === selectedTeam ? null : r.team_id)
                    }
                    className={`border-b border-border/50 cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-accent-green/10"
                        : "hover:bg-surface-hover"
                    }`}
                  >
                    {/* Rank */}
                    <td className="px-3 py-2 text-right text-muted">{r.rank}</td>

                    {/* Team */}
                    <td className="px-3 py-2 text-left text-foreground font-semibold">
                      {r.team_id}
                    </td>

                    {/* League */}
                    <td
                      className={`px-3 py-2 text-left font-bold ${
                        LEAGUE_COLOR[r.league] ?? "text-muted"
                      }`}
                    >
                      {LEAGUE_SHORT[r.league] ?? "—"}
                    </td>

                    {/* Index (published_index) — bold */}
                    <td className="px-3 py-2 text-right text-foreground font-bold">
                      {r.published_index.toFixed(2)}
                    </td>

                    {/* $Price — derived from published_index */}
                    <td className="px-3 py-2 text-right text-foreground font-bold">
                      ${indexToPrice(r.published_index).toFixed(2)}
                    </td>

                    {/* B */}
                    <td className="px-3 py-2 text-right text-foreground">
                      {r.B_value.toFixed(2)}
                    </td>

                    {/* M1 — colored */}
                    <td
                      className={`px-3 py-2 text-right ${
                        r.M1_value > 0.001
                          ? "text-accent-green"
                          : r.M1_value < -0.001
                          ? "text-accent-red"
                          : "text-muted"
                      }`}
                    >
                      {r.M1_value > 0.001
                        ? `+${r.M1_value.toFixed(2)}`
                        : r.M1_value < -0.001
                        ? r.M1_value.toFixed(2)
                        : "0.00"}
                    </td>

                    {/* Confidence — grey + italic below 40% */}
                    <td
                      className={`px-3 py-2 text-right ${
                        r.confidence_score != null && r.confidence_score < 0.4
                          ? "text-muted italic"
                          : "text-foreground"
                      }`}
                    >
                      {r.confidence_score != null
                        ? `${(r.confidence_score * 100).toFixed(0)}%`
                        : "—"}
                    </td>

                    {/* Last ΔB — colored */}
                    <td
                      className={`px-3 py-2 text-right ${
                        r.last_delta_B != null
                          ? r.last_delta_B > 0
                            ? "text-accent-green"
                            : r.last_delta_B < 0
                            ? "text-accent-red"
                            : "text-muted"
                          : "text-muted"
                      }`}
                    >
                      {r.last_delta_B != null
                        ? `${r.last_delta_B >= 0 ? "+" : ""}${r.last_delta_B.toFixed(2)}`
                        : "—"}
                    </td>

                    {/* Next match */}
                    <td className="px-3 py-2 text-left text-muted truncate max-w-[180px] hidden md:table-cell">
                      {r.next_match_label ?? "—"}
                    </td>

                    {/* Settled count */}
                    <td className="px-3 py-2 text-right text-muted">
                      {r.settled_count}
                    </td>

                    {/* B Trend sparkline */}
                    <td className="px-3 py-2 text-center hidden sm:table-cell">
                      <Sparkline values={r.b_trend} />
                    </td>

                    {/* Latest settled date */}
                    <td className="px-3 py-2 text-right text-muted hidden lg:table-cell">
                      {r.latest_settled_at
                        ? r.latest_settled_at.slice(0, 10)
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {filteredRows.length === 0 && (
        <div className="text-center text-muted text-sm py-12 border border-border rounded font-mono">
          No teams found for this filter.
        </div>
      )}
    </div>
  );
}
