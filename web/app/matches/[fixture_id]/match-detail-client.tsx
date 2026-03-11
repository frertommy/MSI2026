"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
  CartesianGrid,
} from "recharts";
import type {
  MatchInfo,
  OracleState,
  PriceHistoryPoint,
  OddsData,
} from "./page";
import { indexToPrice } from "./page";

// ─── Constants ───────────────────────────────────────────────
const HOME_COLOR = "#22c55e";
const AWAY_COLOR = "#ef4444";
const ORACLE_K = 30;

const LEAGUE_SHORT: Record<string, string> = {
  "Premier League": "EPL",
  "La Liga": "ESP",
  Bundesliga: "BUN",
  "Serie A": "ITA",
  "Ligue 1": "FRA",
};

const LEAGUE_COLOR: Record<string, string> = {
  "Premier League": "text-purple-400",
  "La Liga": "text-orange-400",
  Bundesliga: "text-red-400",
  "Serie A": "text-blue-400",
  "Ligue 1": "text-cyan-400",
};

const LEAGUE_BG: Record<string, string> = {
  "Premier League": "bg-purple-400/10 border-purple-400/20",
  "La Liga": "bg-orange-400/10 border-orange-400/20",
  Bundesliga: "bg-red-400/10 border-red-400/20",
  "Serie A": "bg-blue-400/10 border-blue-400/20",
  "Ligue 1": "bg-cyan-400/10 border-cyan-400/20",
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const tooltipStyle: React.CSSProperties = {
  backgroundColor: "#111",
  border: "1px solid #333",
  borderRadius: "4px",
  fontFamily: "monospace",
  fontSize: "11px",
  padding: "8px 10px",
};

// ─── Oracle V1.4 Impact ─────────────────────────────────────
interface OutcomeImpact {
  label: string;
  deltaPrice: number;
  pctDelta: number;
}

function computeImpacts(
  teamIndex: number,
  teamPrice: number,
  teamWinProb: number,
  drawProb: number
): { win: OutcomeImpact; draw: OutcomeImpact; loss: OutcomeImpact } {
  const E_KR = teamWinProb + 0.5 * drawProb;

  const outcomes = [
    { label: "Win", S: 1.0 },
    { label: "Draw", S: 0.5 },
    { label: "Loss", S: 0.0 },
  ] as const;

  const results: Record<string, OutcomeImpact> = {};
  for (const o of outcomes) {
    const delta_B = ORACLE_K * (o.S - E_KR);
    const newIndex = teamIndex + delta_B;
    const newPrice = indexToPrice(newIndex);
    const deltaPrice = Math.round((newPrice - teamPrice) * 100) / 100;
    const pctDelta =
      teamPrice > 0 ? Math.round((deltaPrice / teamPrice) * 10000) / 100 : 0;
    results[o.label.toLowerCase()] = { label: o.label, deltaPrice, pctDelta };
  }

  return results as {
    win: OutcomeImpact;
    draw: OutcomeImpact;
    loss: OutcomeImpact;
  };
}

function deltaColor(delta: number): string {
  if (Math.abs(delta) < 0.1) return "text-muted";
  return delta > 0 ? "text-accent-green" : "text-accent-red";
}

function deltaArrow(delta: number): string {
  if (Math.abs(delta) < 0.1) return "\u00b7";
  return delta > 0 ? "\u2191" : "\u2193";
}

function formatDelta(delta: number): string {
  const prefix = delta > 0 ? "+" : "";
  return `${prefix}$${delta.toFixed(2)}`;
}

function formatPctDelta(pct: number): string {
  const prefix = pct > 0 ? "+" : "";
  return `${prefix}${pct.toFixed(1)}%`;
}

// ─── Chart types ─────────────────────────────────────────────
interface ChartRow {
  ts: string;
  tsMs: number;
  dateLabel: string;
  homePrice: number | null;
  awayPrice: number | null;
}

// ─── Props ───────────────────────────────────────────────────
interface Props {
  match: MatchInfo;
  homeState: OracleState | null;
  awayState: OracleState | null;
  priceHistory: PriceHistoryPoint[];
  odds: OddsData | null;
}

// ─── Component ───────────────────────────────────────────────
export function MatchDetailClient({
  match,
  homeState,
  awayState,
  priceHistory,
  odds,
}: Props) {
  const homeIndex = homeState ? Number(homeState.published_index) : 1500;
  const awayIndex = awayState ? Number(awayState.published_index) : 1500;
  const homePrice = indexToPrice(homeIndex);
  const awayPrice = indexToPrice(awayIndex);

  // Build chart data from oracle_price_history
  const chartData = useMemo((): ChartRow[] => {
    // Group by hour for cleaner chart
    const bucketMap = new Map<
      string,
      { homePrice: number | null; awayPrice: number | null }
    >();

    for (const pt of priceHistory) {
      // Bucket by hour
      const d = new Date(pt.timestamp);
      const bucket = `${d.toISOString().slice(0, 13)}:00`;

      if (!bucketMap.has(bucket))
        bucketMap.set(bucket, { homePrice: null, awayPrice: null });
      const entry = bucketMap.get(bucket)!;
      const price = indexToPrice(pt.published_index);
      if (pt.team === match.home_team) entry.homePrice = price;
      if (pt.team === match.away_team) entry.awayPrice = price;
    }

    return [...bucketMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ts, vals]) => {
        const d = new Date(ts);
        return {
          ts,
          tsMs: d.getTime(),
          dateLabel: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCHours().toString().padStart(2, "0")}:00`,
          homePrice: vals.homePrice,
          awayPrice: vals.awayPrice,
        };
      });
  }, [priceHistory, match.home_team, match.away_team]);

  // Compute 3-day deltas
  const homeDelta3d = useMemo(() => {
    if (chartData.length < 2) return null;
    const first = chartData[0].homePrice;
    const last = chartData[chartData.length - 1].homePrice;
    if (first == null || last == null) return null;
    return Math.round((last - first) * 100) / 100;
  }, [chartData]);

  const awayDelta3d = useMemo(() => {
    if (chartData.length < 2) return null;
    const first = chartData[0].awayPrice;
    const last = chartData[chartData.length - 1].awayPrice;
    if (first == null || last == null) return null;
    return Math.round((last - first) * 100) / 100;
  }, [chartData]);

  const hasResult = match.score != null && match.score !== "";

  // Impacts (only if we have odds)
  const homeImpacts = odds
    ? computeImpacts(homeIndex, homePrice, odds.homeProb, odds.drawProb)
    : null;
  const awayImpacts = odds
    ? computeImpacts(awayIndex, awayPrice, odds.awayProb, odds.drawProb)
    : null;

  // Y-axis domain
  // Compute KO / FT timestamps for reference lines (epoch ms)
  const { kickoffMs, matchEndMs } = useMemo(() => {
    if (!match.commence_time) return { kickoffMs: null, matchEndMs: null };
    const ko = new Date(match.commence_time);
    return {
      kickoffMs: ko.getTime(),
      matchEndMs: ko.getTime() + 2 * 60 * 60 * 1000, // KO + 2h estimate
    };
  }, [match.commence_time]);

  const allPrices = chartData.flatMap((d) =>
    [d.homePrice, d.awayPrice].filter((p): p is number => p != null)
  );
  const yMin = allPrices.length > 0 ? Math.floor(Math.min(...allPrices) - 2) : 0;
  const yMax = allPrices.length > 0 ? Math.ceil(Math.max(...allPrices) + 2) : 250;

  return (
    <div className="space-y-6">
      {/* Back link + header */}
      <div className="flex items-center gap-3">
        <a
          href="/matches"
          className="text-muted hover:text-foreground transition-colors text-sm"
        >
          &larr; Matches
        </a>
        <span
          className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${
            LEAGUE_COLOR[match.league] || "text-muted"
          } ${LEAGUE_BG[match.league] || "bg-muted/10 border-muted/20"}`}
        >
          {LEAGUE_SHORT[match.league] || match.league}
        </span>
        <span className="text-xs text-muted font-mono">{match.date}</span>
        {hasResult && (
          <span className="text-xs font-bold text-foreground font-mono ml-auto">
            FT {match.score}
          </span>
        )}
      </div>

      {/* Teams header */}
      <div className="border border-border rounded-lg bg-surface p-4">
        <div className="grid grid-cols-[1fr_auto_1fr] gap-6 items-center">
          {/* Home */}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: HOME_COLOR }}
              />
              <span className="text-lg font-bold text-foreground truncate">
                {match.home_team}
              </span>
            </div>
            <div className="text-sm text-muted font-mono flex items-center gap-3">
              <span className="text-foreground font-bold">
                ${homePrice.toFixed(2)}
              </span>
              <span>Idx {Math.round(homeIndex)}</span>
              {homeDelta3d != null && (
                <span
                  className={
                    homeDelta3d > 0
                      ? "text-accent-green"
                      : homeDelta3d < 0
                      ? "text-accent-red"
                      : "text-muted"
                  }
                >
                  {homeDelta3d > 0 ? "+" : ""}
                  {homeDelta3d.toFixed(2)} 3d
                </span>
              )}
            </div>
          </div>

          {/* VS */}
          <div className="text-center">
            <span className="text-sm font-bold text-muted tracking-wider">
              VS
            </span>
          </div>

          {/* Away */}
          <div className="text-right">
            <div className="flex items-center gap-2 mb-1 justify-end">
              <span className="text-lg font-bold text-foreground truncate">
                {match.away_team}
              </span>
              <div
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: AWAY_COLOR }}
              />
            </div>
            <div className="text-sm text-muted font-mono flex items-center gap-3 justify-end">
              {awayDelta3d != null && (
                <span
                  className={
                    awayDelta3d > 0
                      ? "text-accent-green"
                      : awayDelta3d < 0
                      ? "text-accent-red"
                      : "text-muted"
                  }
                >
                  {awayDelta3d > 0 ? "+" : ""}
                  {awayDelta3d.toFixed(2)} 3d
                </span>
              )}
              <span>Idx {Math.round(awayIndex)}</span>
              <span className="text-foreground font-bold">
                ${awayPrice.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Price chart */}
      <div className="border border-border rounded-lg bg-surface p-4">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">
            Index History
          </h2>
          <span className="text-[10px] text-muted font-mono">±24h from kickoff</span>
          <div className="flex items-center gap-4 ml-auto text-xs font-mono text-muted">
            <span className="flex items-center gap-1.5">
              <span
                className="w-2.5 h-0.5 rounded inline-block"
                style={{ backgroundColor: HOME_COLOR }}
              />
              {match.home_team.split(" ").pop()}
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="w-2.5 h-0.5 rounded inline-block"
                style={{ backgroundColor: AWAY_COLOR }}
              />
              {match.away_team.split(" ").pop()}
            </span>
          </div>
        </div>

        {chartData.length > 0 ? (
          <div style={{ width: "100%", height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#1e1e1e"
                  vertical={false}
                />
                <XAxis
                  dataKey="tsMs"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tick={{
                    fill: "#666",
                    fontSize: 10,
                    fontFamily: "monospace",
                  }}
                  axisLine={{ stroke: "#333" }}
                  tickLine={false}
                  tickFormatter={(v: number) => {
                    const d = new Date(v);
                    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCHours().toString().padStart(2, "0")}:00`;
                  }}
                />
                <YAxis
                  domain={[yMin, yMax]}
                  tick={{
                    fill: "#666",
                    fontSize: 10,
                    fontFamily: "monospace",
                  }}
                  axisLine={false}
                  tickLine={false}
                  width={60}
                  tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0)
                      return null;
                    const row = payload[0]?.payload as ChartRow;
                    if (!row) return null;

                    return (
                      <div style={tooltipStyle}>
                        <div
                          className="font-bold text-foreground"
                          style={{ marginBottom: 4 }}
                        >
                          {row.dateLabel}
                        </div>
                        {row.homePrice != null && (
                          <div style={{ color: HOME_COLOR, marginBottom: 2 }}>
                            {match.home_team}: ${row.homePrice.toFixed(2)}
                          </div>
                        )}
                        {row.awayPrice != null && (
                          <div style={{ color: AWAY_COLOR }}>
                            {match.away_team}: ${row.awayPrice.toFixed(2)}
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
                {/* Match period shading */}
                {kickoffMs != null && matchEndMs != null && (
                  <ReferenceArea
                    x1={kickoffMs}
                    x2={matchEndMs}
                    fill="rgba(255,255,255,0.04)"
                    fillOpacity={1}
                    stroke="none"
                  />
                )}
                {/* Kickoff line */}
                {kickoffMs != null && (
                  <ReferenceLine
                    x={kickoffMs}
                    stroke="#666"
                    strokeDasharray="4 4"
                    label={{
                      value: "KO",
                      position: "top",
                      fill: "#888",
                      fontSize: 10,
                      fontFamily: "monospace",
                    }}
                  />
                )}
                {/* Full-time line */}
                {matchEndMs != null && (
                  <ReferenceLine
                    x={matchEndMs}
                    stroke="#666"
                    strokeDasharray="4 4"
                    label={{
                      value: hasResult ? `FT ${match.score}` : "FT",
                      position: "top",
                      fill: "#888",
                      fontSize: 10,
                      fontFamily: "monospace",
                    }}
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="homePrice"
                  stroke={HOME_COLOR}
                  strokeWidth={2}
                  dot={{ r: 3, fill: HOME_COLOR, stroke: "none" }}
                  activeDot={{ r: 5, stroke: HOME_COLOR, strokeWidth: 2, fill: "#0f0f0f" }}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="awayPrice"
                  stroke={AWAY_COLOR}
                  strokeWidth={2}
                  dot={{ r: 3, fill: AWAY_COLOR, stroke: "none" }}
                  activeDot={{ r: 5, stroke: AWAY_COLOR, strokeWidth: 2, fill: "#0f0f0f" }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="text-center text-muted text-sm py-12 font-mono">
            No price history available for the last 3 days
          </div>
        )}
      </div>

      {/* Outcome Impact Table */}
      <div className="border border-border rounded-lg bg-surface p-4">
        <h2 className="text-sm font-bold text-foreground uppercase tracking-wider mb-4">
          Outcome Impact
        </h2>

        {homeImpacts && awayImpacts ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Home team impacts */}
            <div className="space-y-1">
              <div className="flex items-center gap-2 mb-2">
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: HOME_COLOR }}
                />
                <span className="text-xs font-bold text-foreground uppercase tracking-wider">
                  {match.home_team}
                </span>
                <span className="text-[10px] text-muted font-mono ml-auto">
                  ${homePrice.toFixed(2)} · Idx {Math.round(homeIndex)}
                </span>
              </div>
              {(["win", "draw", "loss"] as const).map((outcome) => {
                const impact = homeImpacts[outcome];
                return (
                  <div
                    key={outcome}
                    className="flex items-center justify-between gap-2 py-1"
                  >
                    <span className="text-[11px] text-muted">{impact.label}</span>
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`text-xs font-mono font-bold tabular-nums ${deltaColor(
                          impact.deltaPrice
                        )}`}
                      >
                        {formatDelta(impact.deltaPrice)}
                      </span>
                      <span
                        className={`text-[10px] font-mono tabular-nums ${deltaColor(
                          impact.deltaPrice
                        )} opacity-60`}
                      >
                        {formatPctDelta(impact.pctDelta)}
                      </span>
                      <span className={`text-[10px] ${deltaColor(impact.deltaPrice)}`}>
                        {deltaArrow(impact.deltaPrice)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Away team impacts */}
            <div className="space-y-1">
              <div className="flex items-center gap-2 mb-2">
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: AWAY_COLOR }}
                />
                <span className="text-xs font-bold text-foreground uppercase tracking-wider">
                  {match.away_team}
                </span>
                <span className="text-[10px] text-muted font-mono ml-auto">
                  ${awayPrice.toFixed(2)} · Idx {Math.round(awayIndex)}
                </span>
              </div>
              {(["win", "draw", "loss"] as const).map((outcome) => {
                const impact = awayImpacts[outcome];
                return (
                  <div
                    key={outcome}
                    className="flex items-center justify-between gap-2 py-1"
                  >
                    <span className="text-[11px] text-muted">{impact.label}</span>
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`text-xs font-mono font-bold tabular-nums ${deltaColor(
                          impact.deltaPrice
                        )}`}
                      >
                        {formatDelta(impact.deltaPrice)}
                      </span>
                      <span
                        className={`text-[10px] font-mono tabular-nums ${deltaColor(
                          impact.deltaPrice
                        )} opacity-60`}
                      >
                        {formatPctDelta(impact.pctDelta)}
                      </span>
                      <span className={`text-[10px] ${deltaColor(impact.deltaPrice)}`}>
                        {deltaArrow(impact.deltaPrice)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="text-center text-muted text-sm py-8 font-mono">
            Awaiting bookmaker odds for impact calculation
          </div>
        )}

        {/* Formula note */}
        <div className="mt-4 pt-3 border-t border-border/30 text-[10px] text-muted font-mono">
          Oracle V1.4: delta_B = K &times; (S &minus; E_KR) where K=30, E_KR = P(win) + 0.5&times;P(draw), price = (index &minus; 800) / 5
        </div>
      </div>
    </div>
  );
}
