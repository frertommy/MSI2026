"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  ReferenceLine,
  Cell,
  CartesianGrid,
} from "recharts";

// ─── Types ──────────────────────────────────────────────────

export interface CLSettlementRow {
  settlement_id: number;
  fixture_id: number;
  team_id: string;
  E_KR: number;
  actual_score_S: number;
  delta_B: number;
  B_before: number;
  B_after: number;
  settled_at: string;
  gravity_component: number;
}

export interface CLKRSnapshotRow {
  fixture_id: number;
  bookmaker_count: number;
  freeze_timestamp: string;
  home_prob: number;
  draw_prob: number;
  away_prob: number;
  home_expected_score: number;
  away_expected_score: number;
  home_expected_score_raw: number | null;
  away_expected_score_raw: number | null;
  kr_degraded: boolean;
  method: string;
}

export interface CLPriceHistoryRow {
  team: string;
  league: string;
  timestamp: string;
  B_value: number;
  M1_value: number;
  published_index: number;
  publish_reason: string;
}

export interface CLMatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
}

// ─── Constants ──────────────────────────────────────────────

const tooltipStyle = {
  backgroundColor: "#111",
  border: "1px solid #333",
  borderRadius: "4px",
  fontFamily: "monospace",
  fontSize: "11px",
};

// ─── Component ──────────────────────────────────────────────

interface Props {
  settlements: CLSettlementRow[];
  krSnapshots: CLKRSnapshotRow[];
  priceHistory: CLPriceHistoryRow[];
  matches: CLMatchRow[];
}

export function VGlobalDiagnosticsClient({
  settlements,
  krSnapshots,
  priceHistory,
  matches,
}: Props) {
  // ── Settlement distribution ──
  const settlementDistribution = useMemo(() => {
    const buckets = new Map<string, number>();
    const step = 2;
    for (const s of settlements) {
      const delta = Number(s.delta_B);
      const bucketVal = Math.round(delta / step) * step;
      const key = `${bucketVal}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return [...buckets.entries()]
      .map(([bucket, count]) => ({ bucket: Number(bucket), count }))
      .sort((a, b) => a.bucket - b.bucket);
  }, [settlements]);

  // ── Settlement scatter: E_KR vs delta_B ──
  const scatterData = useMemo(() => {
    return settlements.map((s) => ({
      E_KR: Number(s.E_KR),
      delta_B: Number(s.delta_B),
      team: s.team_id,
      S: Number(s.actual_score_S),
    }));
  }, [settlements]);

  // ── Drift monitoring: net ΔB per team from CL ──
  const driftByTeam = useMemo(() => {
    const map = new Map<string, { team: string; netDelta: number; count: number }>();
    for (const s of settlements) {
      if (!map.has(s.team_id)) map.set(s.team_id, { team: s.team_id, netDelta: 0, count: 0 });
      const entry = map.get(s.team_id)!;
      entry.netDelta += Number(s.delta_B);
      entry.count++;
    }
    return [...map.values()].sort((a, b) => b.netDelta - a.netDelta);
  }, [settlements]);

  // ── Gravity verification (should all be 0 for CL) ──
  const nonZeroGravity = useMemo(() => {
    return settlements.filter(s => Math.abs(Number(s.gravity_component)) > 0.001);
  }, [settlements]);

  // ── KR quality stats ──
  const krStats = useMemo(() => {
    const degradedCount = krSnapshots.filter(k => k.kr_degraded).length;
    const avgBooks = krSnapshots.length > 0
      ? krSnapshots.reduce((sum, k) => sum + k.bookmaker_count, 0) / krSnapshots.length
      : 0;
    const drawCorrectedCount = krSnapshots.filter(k =>
      k.method?.includes("draw_corrected")
    ).length;
    const rawVsCorrected = krSnapshots.filter(k =>
      k.home_expected_score_raw != null &&
      Math.abs(Number(k.home_expected_score) - Number(k.home_expected_score_raw)) > 0.0001
    ).length;
    return { degradedCount, avgBooks, total: krSnapshots.length, drawCorrectedCount, rawVsCorrected };
  }, [krSnapshots]);

  // ── Summary stats ──
  const totalDelta = settlements.reduce((sum, s) => sum + Number(s.delta_B), 0);
  const avgDelta = settlements.length > 0 ? totalDelta / settlements.length : 0;
  const winsCount = settlements.filter(s => Number(s.actual_score_S) === 1).length;
  const drawsCount = settlements.filter(s => Number(s.actual_score_S) === 0.5).length;
  const lossesCount = settlements.filter(s => Number(s.actual_score_S) === 0).length;

  return (
    <div className="space-y-8">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        <StatCard label="CL Settlements" value={settlements.length.toString()} />
        <StatCard label="Net ΔB" value={`${totalDelta > 0 ? "+" : ""}${totalDelta.toFixed(1)}`}
          color={Math.abs(totalDelta) < 1 ? "text-foreground" : totalDelta > 0 ? "text-accent-green" : "text-accent-red"} />
        <StatCard label="Avg ΔB" value={avgDelta.toFixed(2)} />
        <StatCard label="W / D / L" value={`${winsCount} / ${drawsCount} / ${lossesCount}`} />
        <StatCard label="KR Snapshots" value={krStats.total.toString()} />
        <StatCard label="KR Degraded" value={krStats.degradedCount.toString()}
          color={krStats.degradedCount > 0 ? "text-amber-400" : "text-foreground"} />
      </div>

      {/* Gravity check */}
      {nonZeroGravity.length > 0 && (
        <div className="border border-red-500/30 rounded-lg p-4 bg-red-500/5">
          <div className="text-xs font-mono text-red-400 uppercase mb-1">
            ⚠ Non-zero gravity detected in CL settlements
          </div>
          <div className="text-xs font-mono text-muted">
            {nonZeroGravity.length} settlement(s) have gravity ≠ 0. CL should always use γ=0.
          </div>
        </div>
      )}

      {/* Draw correction info */}
      {krStats.drawCorrectedCount > 0 && (
        <div className="border border-amber-400/20 rounded-lg p-3 bg-amber-400/5">
          <div className="text-xs font-mono text-amber-400">
            {krStats.drawCorrectedCount}/{krStats.total} KR snapshots use draw-corrected E_KR
            {krStats.rawVsCorrected > 0 && ` (${krStats.rawVsCorrected} show raw ≠ corrected)`}
          </div>
        </div>
      )}

      {/* Settlement Distribution */}
      {settlementDistribution.length > 0 && (
        <Section title="Settlement Distribution" subtitle="ΔB histogram (CL only)">
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={settlementDistribution} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <XAxis
                  dataKey="bucket"
                  tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                  tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v}`}
                />
                <YAxis tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
                <Tooltip contentStyle={tooltipStyle} />
                <ReferenceLine x={0} stroke="#666" strokeDasharray="3 3" />
                <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                  {settlementDistribution.map((entry, i) => (
                    <Cell
                      key={i}
                      fill={entry.bucket > 0 ? "#22c55e" : entry.bucket < 0 ? "#ef4444" : "#666"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      {/* E_KR vs delta_B scatter */}
      {scatterData.length > 0 && (
        <Section title="E_KR vs ΔB" subtitle="Each point is one CL settlement">
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis
                  dataKey="E_KR"
                  type="number"
                  domain={[0, 1]}
                  tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                  name="E_KR"
                />
                <YAxis
                  dataKey="delta_B"
                  type="number"
                  tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                  name="ΔB"
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(value: any, name: any) => [Number(value).toFixed(2), String(name)]}
                  labelFormatter={(label) => `E_KR: ${Number(label).toFixed(3)}`}
                />
                <ReferenceLine y={0} stroke="#666" strokeDasharray="3 3" />
                <Scatter data={scatterData} name="Settlements">
                  {scatterData.map((entry, i) => (
                    <Cell
                      key={i}
                      fill={
                        entry.S === 1 ? "#22c55e" :
                        entry.S === 0.5 ? "#f59e0b" :
                        "#ef4444"
                      }
                      opacity={0.7}
                    />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      {/* CL Drift by Team */}
      {driftByTeam.length > 0 && (
        <Section title="CL Drift by Team" subtitle="Net ΔB from CL settlements per team">
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="bg-surface border-b border-border text-muted uppercase">
                  <th className="px-3 py-2 text-left">Team</th>
                  <th className="px-3 py-2 text-right">CL Matches</th>
                  <th className="px-3 py-2 text-right">Net ΔB</th>
                  <th className="px-3 py-2 text-right">Avg ΔB</th>
                </tr>
              </thead>
              <tbody>
                {driftByTeam.map((row) => (
                  <tr key={row.team} className="border-b border-border/50">
                    <td className="px-3 py-2 text-foreground">{row.team}</td>
                    <td className="px-3 py-2 text-right text-muted">{row.count}</td>
                    <td className={`px-3 py-2 text-right ${
                      row.netDelta > 1 ? "text-accent-green" :
                      row.netDelta < -1 ? "text-accent-red" :
                      "text-muted"
                    }`}>
                      {row.netDelta > 0 ? "+" : ""}{row.netDelta.toFixed(1)}
                    </td>
                    <td className="px-3 py-2 text-right text-muted">
                      {(row.netDelta / row.count).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* KR Quality */}
      <Section title="KR Quality" subtitle="Frozen odds consensus for CL fixtures">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total KR" value={krStats.total.toString()} />
          <StatCard label="Avg Books" value={krStats.avgBooks.toFixed(1)} />
          <StatCard label="Degraded" value={krStats.degradedCount.toString()}
            color={krStats.degradedCount > 0 ? "text-amber-400" : "text-foreground"} />
          <StatCard label="Draw Corrected" value={krStats.drawCorrectedCount.toString()} />
        </div>
      </Section>

      {/* Empty state */}
      {settlements.length === 0 && (
        <div className="text-center text-muted text-sm font-mono py-12">
          No CL settlements yet. Data will appear after the first CL match is settled.
        </div>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        <h2 className="text-sm font-bold tracking-wider uppercase text-foreground">{title}</h2>
        {subtitle && (
          <span className="text-[10px] text-muted font-mono ml-1">{subtitle}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function StatCard({
  label,
  value,
  color = "text-foreground",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="border border-border rounded-lg p-3 bg-surface">
      <div className="text-[10px] font-mono text-muted uppercase">{label}</div>
      <div className={`text-lg font-bold ${color}`}>{value}</div>
    </div>
  );
}
