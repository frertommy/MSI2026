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
  CartesianGrid,
} from "recharts";
import type {
  MatchInfo,
  TeamPricePoint,
  LatestPrice,
  OddsData,
} from "./page";

// ─── Constants ───────────────────────────────────────────────
const HOME_COLOR = "#22c55e";
const AWAY_COLOR = "#ef4444";

const INITIAL_ELO = 1500;
const DOLLAR_SPREAD = 220;
const HOME_ADVANTAGE = 70;
const K_BASE = 20;

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

const tooltipStyle: React.CSSProperties = {
  backgroundColor: "#111",
  border: "1px solid #333",
  borderRadius: "4px",
  fontFamily: "monospace",
  fontSize: "11px",
  padding: "8px 10px",
};

// ─── Impact helpers (same as matches list) ───────────────────
function logistic(elo: number): number {
  return 100 / (1 + Math.exp(-(elo - INITIAL_ELO) / DOLLAR_SPREAD));
}

interface OutcomeImpact {
  label: string;
  delta: number;
  pctDelta: number;
}

function computeImpacts(
  teamElo: number,
  opponentElo: number,
  teamPrice: number,
  leagueMean: number,
  teamWinProb: number,
  drawProb: number,
  teamLossProb: number
): { win: OutcomeImpact; draw: OutcomeImpact; loss: OutcomeImpact } {
  const expected = 3 * teamWinProb + 1 * drawProb + 0 * teamLossProb;
  const effectiveK = K_BASE * (1 + (opponentElo - leagueMean) / 400);

  const outcomes = [
    { label: "Win", actual: 3 },
    { label: "Draw", actual: 1 },
    { label: "Loss", actual: 0 },
  ] as const;

  const results: Record<string, OutcomeImpact> = {};
  for (const o of outcomes) {
    const surprise = o.actual - expected;
    const newElo = teamElo + effectiveK * surprise;
    const newPrice = logistic(newElo);
    const delta = Math.round((newPrice - teamPrice) * 100) / 100;
    const pctDelta =
      teamPrice > 0 ? Math.round((delta / teamPrice) * 10000) / 100 : 0;
    results[o.label.toLowerCase()] = { label: o.label, delta, pctDelta };
  }

  return results as {
    win: OutcomeImpact;
    draw: OutcomeImpact;
    loss: OutcomeImpact;
  };
}

function computeModelProbs(
  homeElo: number,
  awayElo: number
): { home: number; draw: number; away: number } {
  const homeExpected =
    1 / (1 + Math.pow(10, (awayElo - homeElo - HOME_ADVANTAGE) / 400));
  const eloDiff = Math.abs(homeElo - awayElo);
  const drawBase = 0.26 - eloDiff / 3000;
  const drawProb = Math.max(0.1, Math.min(0.32, drawBase));

  const homeProb = homeExpected * (1 - drawProb);
  const awayProb = (1 - homeExpected) * (1 - drawProb);

  return { home: homeProb, draw: drawProb, away: awayProb };
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
  date: string;
  dateLabel: string;
  homePrice: number | null;
  awayPrice: number | null;
}

// ─── Props ───────────────────────────────────────────────────
interface Props {
  match: MatchInfo;
  priceHistory: TeamPricePoint[];
  latestPrices: Record<string, LatestPrice>;
  leagueMean: number;
  odds: OddsData | null;
}

// ─── Component ───────────────────────────────────────────────
export function MatchDetailClient({
  match,
  priceHistory,
  latestPrices,
  leagueMean,
  odds,
}: Props) {
  const homeLatest = latestPrices[match.home_team];
  const awayLatest = latestPrices[match.away_team];

  // Build chart data: merge both teams onto shared date axis
  const chartData = useMemo((): ChartRow[] => {
    const dateMap = new Map<
      string,
      { homePrice: number | null; awayPrice: number | null }
    >();

    for (const pt of priceHistory) {
      const d = pt.date.slice(0, 10);
      if (!dateMap.has(d))
        dateMap.set(d, { homePrice: null, awayPrice: null });
      const entry = dateMap.get(d)!;
      if (pt.team === match.home_team) entry.homePrice = pt.dollar_price;
      if (pt.team === match.away_team) entry.awayPrice = pt.dollar_price;
    }

    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];

    return [...dateMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, vals]) => {
        const d = new Date(date + "T00:00:00Z");
        return {
          date,
          dateLabel: `${months[d.getUTCMonth()]} ${d.getUTCDate()}`,
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

  // Match date for reference line
  const hasResult = match.score != null && match.score !== "";
  const matchDateStr = match.date.slice(0, 10);

  // Probabilities
  const homeElo = homeLatest?.implied_elo ?? 1500;
  const awayElo = awayLatest?.implied_elo ?? 1500;
  const modelProbs = computeModelProbs(homeElo, awayElo);

  // Normalize to { home, draw, away } shape
  const probs = odds
    ? { home: odds.homeProb, draw: odds.drawProb, away: odds.awayProb }
    : modelProbs;

  const homePrice = homeLatest?.dollar_price ?? 0;
  const awayPrice = awayLatest?.dollar_price ?? 0;

  // Impacts
  const homeImpacts = computeImpacts(
    homeElo,
    awayElo,
    homePrice,
    leagueMean,
    probs.home,
    probs.draw,
    probs.away
  );
  const awayImpacts = computeImpacts(
    awayElo,
    homeElo,
    awayPrice,
    leagueMean,
    probs.away,
    probs.draw,
    probs.home
  );

  // Y-axis domain: compute nice bounds
  const allPrices = chartData.flatMap((d) =>
    [d.homePrice, d.awayPrice].filter((p): p is number => p != null)
  );
  const yMin = allPrices.length > 0 ? Math.floor(Math.min(...allPrices) - 2) : 0;
  const yMax = allPrices.length > 0 ? Math.ceil(Math.max(...allPrices) + 2) : 100;

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
              <span>Elo {Math.round(homeElo)}</span>
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
              <span>Elo {Math.round(awayElo)}</span>
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
            Price History
          </h2>
          <span className="text-[10px] text-muted font-mono">Last 3 days</span>
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
                  dataKey="dateLabel"
                  tick={{
                    fill: "#666",
                    fontSize: 10,
                    fontFamily: "monospace",
                  }}
                  axisLine={{ stroke: "#333" }}
                  tickLine={false}
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
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
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
                            {homeDelta3d != null &&
                              chartData.length > 0 &&
                              chartData[0].homePrice != null && (
                                <span style={{ opacity: 0.6, marginLeft: 6 }}>
                                  {row.homePrice - chartData[0].homePrice >= 0
                                    ? "+"
                                    : ""}
                                  $
                                  {(
                                    row.homePrice - chartData[0].homePrice
                                  ).toFixed(2)}
                                </span>
                              )}
                          </div>
                        )}
                        {row.awayPrice != null && (
                          <div style={{ color: AWAY_COLOR }}>
                            {match.away_team}: ${row.awayPrice.toFixed(2)}
                            {awayDelta3d != null &&
                              chartData.length > 0 &&
                              chartData[0].awayPrice != null && (
                                <span style={{ opacity: 0.6, marginLeft: 6 }}>
                                  {row.awayPrice - chartData[0].awayPrice >= 0
                                    ? "+"
                                    : ""}
                                  $
                                  {(
                                    row.awayPrice - chartData[0].awayPrice
                                  ).toFixed(2)}
                                </span>
                              )}
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
                {/* Match result reference line */}
                {hasResult &&
                  chartData.some((d) => d.date === matchDateStr) && (
                    <ReferenceLine
                      x={
                        chartData.find((d) => d.date === matchDateStr)
                          ?.dateLabel
                      }
                      stroke="#666"
                      strokeDasharray="4 4"
                      label={{
                        value: `FT ${match.score}`,
                        position: "top",
                        fill: "#c8c8c8",
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
            No price data available for the last 3 days
          </div>
        )}
      </div>

      {/* Outcome Impact Table */}
      <div className="border border-border rounded-lg bg-surface p-4">
        <h2 className="text-sm font-bold text-foreground uppercase tracking-wider mb-4">
          Outcome Impact
        </h2>

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
                ${homePrice.toFixed(2)} · Elo {Math.round(homeElo)}
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
                        impact.delta
                      )}`}
                    >
                      {formatDelta(impact.delta)}
                    </span>
                    <span
                      className={`text-[10px] font-mono tabular-nums ${deltaColor(
                        impact.delta
                      )} opacity-60`}
                    >
                      {formatPctDelta(impact.pctDelta)}
                    </span>
                    <span className={`text-[10px] ${deltaColor(impact.delta)}`}>
                      {deltaArrow(impact.delta)}
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
                ${awayPrice.toFixed(2)} · Elo {Math.round(awayElo)}
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
                        impact.delta
                      )}`}
                    >
                      {formatDelta(impact.delta)}
                    </span>
                    <span
                      className={`text-[10px] font-mono tabular-nums ${deltaColor(
                        impact.delta
                      )} opacity-60`}
                    >
                      {formatPctDelta(impact.pctDelta)}
                    </span>
                    <span className={`text-[10px] ${deltaColor(impact.delta)}`}>
                      {deltaArrow(impact.delta)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Formula note */}
        <div className="mt-4 pt-3 border-t border-border/30 text-[10px] text-muted font-mono">
          Price impact = logistic(Elo ± K<sub>eff</sub> × surprise) where K
          <sub>eff</sub> = 20 × (1 + (opp_elo − league_mean) / 400)
        </div>
      </div>
    </div>
  );
}
