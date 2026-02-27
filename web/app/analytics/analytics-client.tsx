"use client";

import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
} from "recharts";
import type {
  ModelVolatility,
  BrierResult,
  ArbFrequency,
  LeagueCorrelation,
  PriceHistBucket,
  RollingVolPoint,
} from "./page";

const MODELS = ["smooth", "reactive", "sharp", "oracle"];

const MODEL_COLORS: Record<string, string> = {
  smooth: "#00e676",
  reactive: "#ffc107",
  sharp: "#ff1744",
  oracle: "#ffffff",
};

const MODEL_LABELS: Record<string, string> = {
  smooth: "Smooth",
  reactive: "Reactive",
  sharp: "Sharp",
  oracle: "Oracle",
};

const LEAGUE_SHORT: Record<string, string> = {
  "Premier League": "EPL",
  "La Liga": "ESP",
  Bundesliga: "BUN",
  "Serie A": "ITA",
  "Ligue 1": "FRA",
};

const tooltipStyle = {
  backgroundColor: "#111",
  border: "1px solid #333",
  borderRadius: "4px",
  fontFamily: "monospace",
  fontSize: "12px",
};

// ─── Stat card component ──────────────────────────────────
function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="border border-border rounded-lg p-4 bg-surface">
      <div className="text-xs text-muted uppercase tracking-wider mb-1">
        {label}
      </div>
      <div
        className="text-xl font-bold font-mono"
        style={{ color: color ?? "#c8c8c8" }}
      >
        {value}
      </div>
      {sub && (
        <div className="text-xs text-muted font-mono mt-1">{sub}</div>
      )}
    </div>
  );
}

// ─── Section header ───────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <h2 className="text-xs font-bold uppercase tracking-wider text-muted border-b border-border pb-2">
        {title}
      </h2>
      {children}
    </div>
  );
}

// ─── Main client component ────────────────────────────────
export function AnalyticsClient({
  volatility,
  brierResults,
  arbFreq,
  leagueCorr,
  histData,
  rollingVol,
}: {
  volatility: ModelVolatility[];
  brierResults: BrierResult[];
  arbFreq: ArbFrequency[];
  leagueCorr: LeagueCorrelation[];
  histData: PriceHistBucket[];
  rollingVol: RollingVolPoint[];
}) {
  // ─── Volatility table data ────────────────────────────
  const volBarData = volatility.map((v) => ({
    model: MODEL_LABELS[v.model],
    matchDay: Math.round(v.matchDayVol * 1000) / 1000,
    nonMatchDay: Math.round(v.nonMatchDayVol * 1000) / 1000,
    fill: MODEL_COLORS[v.model],
  }));

  // ─── Brier score data ────────────────────────────────
  const brierBarData = brierResults.map((b) => ({
    model: MODEL_LABELS[b.model],
    brier: Math.round(b.brier * 10000) / 10000,
    fill: MODEL_COLORS[b.model],
    n: b.n,
  }));

  // ─── Arb frequency data ──────────────────────────────
  const arbBarData = arbFreq.map((a) => ({
    model: MODEL_LABELS[a.model],
    pct: Math.round(a.pct * 10) / 10,
    fill: MODEL_COLORS[a.model],
    arbs: a.arbs,
    total: a.total,
  }));

  // ─── League correlation data ─────────────────────────
  // Group by league, show oracle model correlation
  const corrByLeague = new Map<string, number>();
  for (const lc of leagueCorr) {
    if (lc.model === "oracle") {
      corrByLeague.set(lc.league, lc.avgCorr);
    }
  }

  return (
    <div className="space-y-10">
      {/* ═══ Row 1: Summary stat cards ═══ */}
      <Section title="Model Performance Summary">
        <div className="grid grid-cols-4 gap-4">
          {volatility.map((v) => (
            <StatCard
              key={v.model}
              label={`${MODEL_LABELS[v.model]} Avg |ΔP|`}
              value={`$${v.avgDailyChange.toFixed(3)}`}
              sub={`Match-day ratio: ${v.volRatio.toFixed(2)}x`}
              color={MODEL_COLORS[v.model]}
            />
          ))}
        </div>
        <div className="grid grid-cols-4 gap-4">
          {brierResults.map((b) => (
            <StatCard
              key={b.model}
              label={`${MODEL_LABELS[b.model]} Brier`}
              value={b.brier.toFixed(4)}
              sub={`${b.n} matches scored`}
              color={MODEL_COLORS[b.model]}
            />
          ))}
        </div>
      </Section>

      {/* ═══ Row 2: Match-day vs Non-match-day volatility ═══ */}
      <Section title="Match-Day vs Non-Match-Day Volatility">
        <div className="border border-border rounded-lg p-4 bg-surface">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={volBarData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" vertical={false} />
              <XAxis
                dataKey="model"
                tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                axisLine={{ stroke: "#1e1e1e" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                axisLine={{ stroke: "#1e1e1e" }}
                tickLine={false}
                tickFormatter={(v: number) => `$${v.toFixed(2)}`}
              />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend
                wrapperStyle={{ fontFamily: "monospace", fontSize: "11px" }}
              />
              <Bar
                dataKey="matchDay"
                name="Match Day"
                fill="#00e676"
                radius={[2, 2, 0, 0]}
              >
                {volBarData.map((entry, i) => (
                  <Cell key={i} fill={entry.fill} opacity={1} />
                ))}
              </Bar>
              <Bar
                dataKey="nonMatchDay"
                name="Non-Match Day"
                fill="#444"
                radius={[2, 2, 0, 0]}
              >
                {volBarData.map((_, i) => (
                  <Cell key={i} fill="#444" />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Section>

      {/* ═══ Row 3: Brier Score + Arb Frequency side by side ═══ */}
      <div className="grid grid-cols-2 gap-6">
        <Section title="Brier Score (lower = better)">
          <div className="border border-border rounded-lg p-4 bg-surface">
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={brierBarData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" vertical={false} />
                <XAxis
                  dataKey="model"
                  tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                  axisLine={{ stroke: "#1e1e1e" }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={{ stroke: "#1e1e1e" }}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={((v: any) => [(Number(v) || 0).toFixed(4), "Brier"]) as never}
                />
                <Bar dataKey="brier" radius={[2, 2, 0, 0]}>
                  {brierBarData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="Arb Frequency (edges > 3%)">
          <div className="border border-border rounded-lg p-4 bg-surface">
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={arbBarData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" vertical={false} />
                <XAxis
                  dataKey="model"
                  tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                  axisLine={{ stroke: "#1e1e1e" }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={{ stroke: "#1e1e1e" }}
                  tickLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={((v: any) => [`${(Number(v) || 0).toFixed(1)}%`, "Arb Rate"]) as never}
                />
                <Bar dataKey="pct" radius={[2, 2, 0, 0]}>
                  {arbBarData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      {/* ═══ Row 4: Cross-team correlation per league ═══ */}
      <Section title="Cross-Team Price Correlation by League">
        <div className="border border-border rounded-lg p-4 bg-surface overflow-x-auto">
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="border-b border-border text-xs text-muted uppercase tracking-wider">
                <th className="py-2 px-3 text-left">League</th>
                {MODELS.map((m) => (
                  <th key={m} className="py-2 px-3 text-right" style={{ color: MODEL_COLORS[m] }}>
                    {MODEL_LABELS[m]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {["Premier League", "La Liga", "Bundesliga", "Serie A", "Ligue 1"].map((league) => (
                <tr key={league} className="border-b border-border/50">
                  <td className="py-2 px-3 text-muted">{LEAGUE_SHORT[league]}</td>
                  {MODELS.map((model) => {
                    const lc = leagueCorr.find(
                      (l) => l.league === league && l.model === model
                    );
                    const val = lc?.avgCorr ?? 0;
                    const color =
                      val > 0.1 ? "#ff1744" : val < -0.1 ? "#00e676" : "#666";
                    return (
                      <td key={model} className="py-2 px-3 text-right" style={{ color }}>
                        {val.toFixed(3)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ═══ Row 5: Price Distribution Histogram ═══ */}
      <Section title="Latest Price Distribution">
        <div className="border border-border rounded-lg p-4 bg-surface">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={histData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" vertical={false} />
              <XAxis
                dataKey="bucket"
                tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                axisLine={{ stroke: "#1e1e1e" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                axisLine={{ stroke: "#1e1e1e" }}
                tickLine={false}
                label={{
                  value: "Teams",
                  fill: "#666",
                  fontSize: 10,
                  angle: -90,
                  position: "insideLeft",
                }}
              />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontFamily: "monospace", fontSize: "11px" }} />
              <Bar dataKey="smooth" name="Smooth" fill="#00e676" opacity={0.8} radius={[2, 2, 0, 0]} />
              <Bar dataKey="reactive" name="Reactive" fill="#ffc107" opacity={0.8} radius={[2, 2, 0, 0]} />
              <Bar dataKey="sharp" name="Sharp" fill="#ff1744" opacity={0.8} radius={[2, 2, 0, 0]} />
              <Bar dataKey="oracle" name="Oracle" fill="#ffffff" opacity={0.8} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Section>

      {/* ═══ Row 6: Rolling 7-day Volatility ═══ */}
      <Section title="Rolling 7-Day Volatility">
        <div className="border border-border rounded-lg p-4 bg-surface">
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={rollingVol}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" vertical={false} />
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
                tickFormatter={(v: number) => `$${v.toFixed(2)}`}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: "#888" }}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                formatter={((value: any, name: any) => [
                  `$${(Number(value) || 0).toFixed(3)}`,
                  MODEL_LABELS[name] ?? name,
                ]) as never}
              />
              <Legend wrapperStyle={{ fontFamily: "monospace", fontSize: "11px" }} />
              <Line
                type="monotone"
                dataKey="smooth"
                name="smooth"
                stroke={MODEL_COLORS.smooth}
                dot={false}
                strokeWidth={1.5}
              />
              <Line
                type="monotone"
                dataKey="reactive"
                name="reactive"
                stroke={MODEL_COLORS.reactive}
                dot={false}
                strokeWidth={1.5}
                strokeDasharray="5 3"
              />
              <Line
                type="monotone"
                dataKey="sharp"
                name="sharp"
                stroke={MODEL_COLORS.sharp}
                dot={false}
                strokeWidth={1.5}
              />
              <Line
                type="monotone"
                dataKey="oracle"
                name="oracle"
                stroke={MODEL_COLORS.oracle}
                dot={false}
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Section>
    </div>
  );
}
