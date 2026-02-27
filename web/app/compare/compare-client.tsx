"use client";

import { useState, useEffect, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import { supabase } from "@/lib/supabase";

interface PriceRow {
  date: string;
  model: string;
  implied_elo: number;
  dollar_price: number;
  confidence: number;
  matches_in_window: number;
}

interface MatchProbRow {
  fixture_id: number;
  model: string;
  date: string;
  home_team: string;
  away_team: string;
  edge_home: number;
  edge_draw: number;
  edge_away: number;
}

interface MatchDate {
  date: string;
  opponent: string;
  isHome: boolean;
}

const MODEL_COLORS: Record<string, string> = {
  smooth: "#00e676",
  reactive: "#ffc107",
  sharp: "#ff1744",
};

const MODEL_LABELS: Record<string, string> = {
  smooth: "Smooth",
  reactive: "Reactive",
  sharp: "Sharp",
};

const TIME_RANGES = [
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "All", days: 999 },
];

export function CompareClient({ teams }: { teams: string[] }) {
  const [selectedTeam, setSelectedTeam] = useState(teams[0] ?? "");
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [matchProbs, setMatchProbs] = useState<MatchProbRow[]>([]);
  const [matchDates, setMatchDates] = useState<MatchDate[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeModels, setActiveModels] = useState<Record<string, boolean>>({
    smooth: true,
    reactive: true,
    sharp: true,
  });
  const [timeRange, setTimeRange] = useState(999);

  const fetchData = useCallback(async (team: string) => {
    if (!team) return;
    setLoading(true);

    // Fetch prices
    const { data: priceData } = await supabase
      .from("team_prices")
      .select("date, model, implied_elo, dollar_price, confidence, matches_in_window")
      .eq("team", team)
      .order("date", { ascending: true });

    // Fetch match probabilities (as home or away)
    const { data: homeProbs } = await supabase
      .from("match_probabilities")
      .select("fixture_id, model, date, home_team, away_team, edge_home, edge_draw, edge_away")
      .eq("home_team", team);

    const { data: awayProbs } = await supabase
      .from("match_probabilities")
      .select("fixture_id, model, date, home_team, away_team, edge_home, edge_draw, edge_away")
      .eq("away_team", team);

    // Fetch matches for this team to get match days
    const { data: homeMatches } = await supabase
      .from("matches")
      .select("date, away_team")
      .eq("home_team", team);

    const { data: awayMatches } = await supabase
      .from("matches")
      .select("date, home_team")
      .eq("away_team", team);

    setPrices(priceData ?? []);
    setMatchProbs([...(homeProbs ?? []), ...(awayProbs ?? [])]);
    setMatchDates([
      ...(homeMatches ?? []).map((m: { date: string; away_team: string }) => ({
        date: m.date,
        opponent: m.away_team,
        isHome: true,
      })),
      ...(awayMatches ?? []).map((m: { date: string; home_team: string }) => ({
        date: m.date,
        opponent: m.home_team,
        isHome: false,
      })),
    ]);

    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData(selectedTeam);
  }, [selectedTeam, fetchData]);

  // Filter by time range
  const endDate = "2026-02-26";
  const startDate =
    timeRange >= 999
      ? "2026-01-01"
      : new Date(
          new Date(endDate).getTime() - timeRange * 86400000
        )
          .toISOString()
          .slice(0, 10);

  const filteredPrices = prices.filter((p) => p.date >= startDate);
  const filteredMatchDates = matchDates.filter((m) => m.date >= startDate);

  // Build chart data: one row per date with smooth/reactive/sharp columns
  const dateMap = new Map<
    string,
    { date: string; smooth?: number; reactive?: number; sharp?: number }
  >();
  for (const p of filteredPrices) {
    if (!dateMap.has(p.date)) dateMap.set(p.date, { date: p.date });
    const entry = dateMap.get(p.date)!;
    if (p.model === "smooth") entry.smooth = p.dollar_price;
    if (p.model === "reactive") entry.reactive = p.dollar_price;
    if (p.model === "sharp") entry.sharp = p.dollar_price;
  }
  const chartData = [...dateMap.values()].sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  // Volatility stats per model
  const volStats = (model: string) => {
    const modelPrices = filteredPrices
      .filter((p) => p.model === model)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (modelPrices.length < 2) return { stdev: 0, max: 0, current: 0, change: 0 };

    const changes: number[] = [];
    for (let i = 1; i < modelPrices.length; i++) {
      changes.push(modelPrices[i].dollar_price - modelPrices[i - 1].dollar_price);
    }
    const absChanges = changes.map(Math.abs);
    const avg = absChanges.reduce((a, b) => a + b, 0) / absChanges.length;
    const stdev = Math.sqrt(
      absChanges.reduce((s, c) => s + (c - avg) ** 2, 0) / absChanges.length
    );
    const max = Math.max(...absChanges);
    const current = modelPrices[modelPrices.length - 1]?.dollar_price ?? 0;
    const first = modelPrices[0]?.dollar_price ?? 0;
    const change = current - first;

    return { stdev, max, current, change };
  };

  // Arb edge chart data
  const arbData = filteredMatchDates
    .map((m) => {
      const probs = matchProbs.filter(
        (p) => p.date === m.date && p.model === "sharp"
      );
      if (probs.length === 0) return null;
      const prob = probs[0];
      const edge = m.isHome
        ? prob.edge_home
        : prob.edge_away;
      return {
        date: m.date,
        label: `${m.isHome ? "vs" : "@"} ${m.opponent}`,
        edge: Math.round(edge * 1000) / 10,
      };
    })
    .filter(Boolean) as { date: string; label: string; edge: number }[];

  return (
    <div className="space-y-8">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        {/* Team selector */}
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

        {/* Time range */}
        <div className="flex gap-1">
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

        {/* Model toggles */}
        <div className="flex gap-2 ml-auto">
          {(["smooth", "reactive", "sharp"] as const).map((model) => (
            <button
              key={model}
              onClick={() =>
                setActiveModels((prev) => ({
                  ...prev,
                  [model]: !prev[model],
                }))
              }
              className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded border transition-all ${
                activeModels[model]
                  ? "border-current"
                  : "opacity-30 border-border"
              }`}
              style={{
                color: activeModels[model]
                  ? MODEL_COLORS[model]
                  : undefined,
              }}
            >
              {MODEL_LABELS[model]}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="text-center text-muted py-12 text-sm font-mono">
          Loading data...
        </div>
      )}

      {!loading && chartData.length > 0 && (
        <>
          {/* Price chart */}
          <div className="border border-border rounded-lg p-4 bg-surface">
            <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-4">
              Dollar Price — {selectedTeam}
            </h2>
            <ResponsiveContainer width="100%" height={350}>
              <LineChart data={chartData}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#1e1e1e"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                  tickFormatter={(d: string) => d.slice(5)}
                  axisLine={{ stroke: "#1e1e1e" }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={{ stroke: "#1e1e1e" }}
                  tickLine={false}
                  domain={["auto", "auto"]}
                  tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#111",
                    border: "1px solid #333",
                    borderRadius: "4px",
                    fontFamily: "monospace",
                    fontSize: "12px",
                  }}
                  labelStyle={{ color: "#888" }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={((value: any, name: any) => [
                    `$${(Number(value) || 0).toFixed(2)}`,
                    MODEL_LABELS[name] ?? name,
                  ]) as never}
                />
                {/* Match day markers */}
                {filteredMatchDates.map((m, i) => (
                  <ReferenceLine
                    key={`match-${i}`}
                    x={m.date}
                    stroke="#333"
                    strokeDasharray="2 4"
                  />
                ))}
                {activeModels.smooth && (
                  <Line
                    type="monotone"
                    dataKey="smooth"
                    stroke={MODEL_COLORS.smooth}
                    dot={false}
                    strokeWidth={2}
                    name="smooth"
                  />
                )}
                {activeModels.reactive && (
                  <Line
                    type="monotone"
                    dataKey="reactive"
                    stroke={MODEL_COLORS.reactive}
                    dot={false}
                    strokeWidth={2}
                    name="reactive"
                    strokeDasharray="5 3"
                  />
                )}
                {activeModels.sharp && (
                  <Line
                    type="monotone"
                    dataKey="sharp"
                    stroke={MODEL_COLORS.sharp}
                    dot={false}
                    strokeWidth={2}
                    name="sharp"
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Volatility stats */}
          <div className="grid grid-cols-3 gap-4">
            {(["smooth", "reactive", "sharp"] as const).map((model) => {
              const stats = volStats(model);
              return (
                <div
                  key={model}
                  className="border border-border rounded-lg p-4 bg-surface"
                >
                  <div className="flex items-center gap-2 mb-3">
                    <div
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: MODEL_COLORS[model] }}
                    />
                    <span
                      className="text-xs font-bold uppercase tracking-wider"
                      style={{ color: MODEL_COLORS[model] }}
                    >
                      {MODEL_LABELS[model]}
                    </span>
                  </div>
                  <div className="space-y-2 font-mono text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted">Current</span>
                      <span className="text-foreground font-bold">
                        ${stats.current.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Change</span>
                      <span
                        className={
                          stats.change >= 0
                            ? "text-accent-green"
                            : "text-accent-red"
                        }
                      >
                        {stats.change >= 0 ? "+" : ""}
                        ${stats.change.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Volatility</span>
                      <span className="text-foreground">
                        ${stats.stdev.toFixed(3)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Max Move</span>
                      <span className="text-foreground">
                        ${stats.max.toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Arb edge chart */}
          {arbData.length > 0 && (
            <div className="border border-border rounded-lg p-4 bg-surface">
              <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-4">
                Sharp Edge vs Bookmakers — {selectedTeam}
              </h2>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={arbData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#1e1e1e"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    tick={{
                      fill: "#666",
                      fontSize: 9,
                      fontFamily: "monospace",
                    }}
                    axisLine={{ stroke: "#1e1e1e" }}
                    tickLine={false}
                    angle={-30}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis
                    tick={{
                      fill: "#666",
                      fontSize: 10,
                      fontFamily: "monospace",
                    }}
                    axisLine={{ stroke: "#1e1e1e" }}
                    tickLine={false}
                    tickFormatter={(v: number) => `${v}%`}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#111",
                      border: "1px solid #333",
                      borderRadius: "4px",
                      fontFamily: "monospace",
                      fontSize: "12px",
                    }}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    formatter={((value: any) => [`${(Number(value) || 0).toFixed(1)}%`, "Edge"]) as never}
                  />
                  <ReferenceLine y={0} stroke="#333" />
                  <ReferenceLine
                    y={3}
                    stroke="#00e676"
                    strokeDasharray="3 3"
                    label={{
                      value: "3% threshold",
                      fill: "#00e676",
                      fontSize: 9,
                      position: "right",
                    }}
                  />
                  <ReferenceLine
                    y={-3}
                    stroke="#ff1744"
                    strokeDasharray="3 3"
                    label={{
                      value: "-3% threshold",
                      fill: "#ff1744",
                      fontSize: 9,
                      position: "right",
                    }}
                  />
                  <Bar dataKey="edge" radius={[2, 2, 0, 0]}>
                    {arbData.map((entry, i) => (
                      <Cell
                        key={i}
                        fill={
                          Math.abs(entry.edge) > 3
                            ? entry.edge > 0
                              ? "#00e676"
                              : "#ff1744"
                            : "#444"
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}

      {!loading && chartData.length === 0 && (
        <div className="text-center text-muted py-12 text-sm font-mono border border-border rounded">
          Select a team to view oracle prices.
        </div>
      )}
    </div>
  );
}
