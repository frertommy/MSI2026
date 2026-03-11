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

export interface V3SettlementRow {
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

export interface KRSnapshotRow {
  fixture_id: number;
  bookmaker_count: number;
  freeze_timestamp: string;
  home_prob: number;
  draw_prob: number;
  away_prob: number;
  home_expected_score: number;
  away_expected_score: number;
  kr_degraded: boolean;
  method: string;
}

export interface TeamStateRow {
  team_id: string;
  B_value: number;
  M1_value: number;
  published_index: number;
  confidence_score: number | null;
  last_market_refresh_ts: string | null;
  updated_at: string;
}

export interface PriceHistoryRow {
  team: string;
  league: string;
  timestamp: string;
  B_value: number;
  M1_value: number;
  published_index: number;
  publish_reason: string;
}

export interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
}

export interface BTSnapshotRow {
  id: number;
  league: string;
  solve_timestamp: string;
  fixtures_used: number;
  teams_count: number;
  iterations: number;
  max_step: number;
  converged: boolean;
  sigma_prior: number;
  home_adv: number;
  window_days: number;
  ratings: Record<string, number>;
  std_errors: Record<string, number>;
}

// ─── Constants ──────────────────────────────────────────────

const LEAGUE_COLOR: Record<string, string> = {
  "Premier League": "#a855f7",
  "La Liga": "#fb923c",
  Bundesliga: "#f87171",
  "Serie A": "#60a5fa",
  "Ligue 1": "#22d3ee",
};

const TOOLTIP_STYLE = {
  contentStyle: {
    backgroundColor: "#111",
    border: "1px solid #333",
    borderRadius: "4px",
    fontFamily: "monospace",
    fontSize: "11px",
  },
};

// ─── Helpers ────────────────────────────────────────────────

function fmt(n: number, d = 2): string {
  return n.toFixed(d);
}

function pct(n: number, d = 1): string {
  return (n * 100).toFixed(d) + "%";
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2) * Math.sqrt(dy2);
  return denom === 0 ? 0 : num / denom;
}

// ─── Stat Card ──────────────────────────────────────────────

function Stat({ label, value, sub, warn }: {
  label: string;
  value: string;
  sub?: string;
  warn?: boolean;
}) {
  return (
    <div className="border border-border rounded px-3 py-2">
      <div className="text-[10px] text-muted font-mono uppercase tracking-wider">{label}</div>
      <div className={`text-lg font-bold font-mono ${warn ? "text-accent-amber" : "text-foreground"}`}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-muted/60 font-mono">{sub}</div>}
    </div>
  );
}

function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="h-1 w-1 rounded-full bg-cyan-400" />
      <h3 className="text-xs font-mono text-cyan-400 uppercase tracking-wider">{title}</h3>
      {sub && <span className="text-[10px] text-muted/50 font-mono">{sub}</span>}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────

export function DiagnosticsV3Client({
  settlements,
  krSnapshots,
  teamStates,
  priceHistory,
  matches,
  btSnapshots,
}: {
  settlements: V3SettlementRow[];
  krSnapshots: KRSnapshotRow[];
  teamStates: TeamStateRow[];
  priceHistory: PriceHistoryRow[];
  matches: MatchRow[];
  btSnapshots: BTSnapshotRow[];
}) {
  // ── Lookups ──
  const fixtureLookup = useMemo(() => {
    const map = new Map<number, MatchRow>();
    for (const m of matches) map.set(m.fixture_id, m);
    return map;
  }, [matches]);

  const teamLeague = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of priceHistory) { if (p.league) map.set(p.team, p.league); }
    for (const t of teamStates) {
      if (!map.has(t.team_id)) {
        const m = matches.find(m => m.home_team === t.team_id || m.away_team === t.team_id);
        if (m) map.set(t.team_id, m.league);
      }
    }
    return map;
  }, [priceHistory, teamStates, matches]);

  const settlementsWithLeague = useMemo(
    () => settlements.map(s => ({ ...s, league: fixtureLookup.get(s.fixture_id)?.league ?? "Unknown" })),
    [settlements, fixtureLookup]
  );

  // ════════════════════════════════════════════════════════════
  // SYSTEM OVERVIEW
  // ════════════════════════════════════════════════════════════

  const systemStats = useMemo(() => {
    const uniqueFixtures = new Set(settlements.map(s => s.fixture_id)).size;
    const degraded = krSnapshots.filter(kr => kr.kr_degraded).length;
    const avgBooks = krSnapshots.length > 0
      ? krSnapshots.reduce((s, kr) => s + kr.bookmaker_count, 0) / krSnapshots.length : 0;
    return { uniqueFixtures, degraded, avgBooks };
  }, [settlements, krSnapshots]);

  // ════════════════════════════════════════════════════════════
  // SETTLEMENT METRICS
  // ════════════════════════════════════════════════════════════

  const settlementStats = useMemo(() => {
    const n = settlements.length;
    if (n === 0) return { total: 0, meanAbsSurprise: 0, brierScore: 0, meanDelta: 0, maxDelta: 0, meanGravity: 0, maxGravity: 0, gravityPctOfDelta: 0 };
    let sumAbsSurprise = 0, sumSqSurprise = 0, sumAbsDelta = 0, maxDelta = 0;
    let sumAbsGravity = 0, maxGravity = 0, gravityDeltaPairs = 0;
    for (const s of settlements) {
      const diff = Number(s.actual_score_S) - Number(s.E_KR);
      sumAbsSurprise += Math.abs(diff);
      sumSqSurprise += diff * diff;
      const ad = Math.abs(Number(s.delta_B));
      sumAbsDelta += ad;
      if (ad > maxDelta) maxDelta = ad;
      const ag = Math.abs(Number(s.gravity_component));
      sumAbsGravity += ag;
      if (ag > maxGravity) maxGravity = ag;
      if (ad > 0) gravityDeltaPairs++;
    }
    return {
      total: n,
      meanAbsSurprise: sumAbsSurprise / n,
      brierScore: sumSqSurprise / n,
      meanDelta: sumAbsDelta / n,
      maxDelta,
      meanGravity: sumAbsGravity / n,
      maxGravity,
      gravityPctOfDelta: sumAbsDelta > 0 ? (sumAbsGravity / sumAbsDelta) * 100 : 0,
    };
  }, [settlements]);

  // ── Calibration ──
  const calibration = useMemo(() => {
    const buckets = Array.from({ length: 10 }, (_, i) => ({
      range: `${(i * 0.1).toFixed(1)}`,
      expected: i * 0.1 + 0.05,
      count: 0,
      sumActual: 0,
    }));
    for (const s of settlements) {
      const idx = Math.min(9, Math.floor(Number(s.E_KR) * 10));
      buckets[idx].count++;
      buckets[idx].sumActual += Number(s.actual_score_S);
    }
    return buckets.filter(b => b.count > 0).map(b => ({ ...b, actual: b.sumActual / b.count }));
  }, [settlements]);

  // ── Surprise histogram ──
  const surpriseHist = useMemo(() => {
    const bins = new Map<string, { bin: string; mid: number; count: number }>();
    for (let v = -1; v < 1; v += 0.1) {
      const key = v.toFixed(1);
      bins.set(key, { bin: key, mid: v + 0.05, count: 0 });
    }
    for (const s of settlements) {
      const surprise = Number(s.actual_score_S) - Number(s.E_KR);
      const key = (Math.floor(surprise * 10) / 10).toFixed(1);
      const entry = bins.get(key);
      if (entry) entry.count++;
    }
    return Array.from(bins.values());
  }, [settlements]);

  // ── Gravity histogram ──
  const gravityHist = useMemo(() => {
    const bins = new Map<string, number>();
    for (let v = -10; v <= 10; v += 1) bins.set(String(v), 0);
    for (const s of settlements) {
      const g = Number(s.gravity_component);
      const key = String(Math.round(g));
      if (bins.has(key)) bins.set(key, (bins.get(key) ?? 0) + 1);
    }
    return Array.from(bins.entries()).map(([bin, count]) => ({ bin, count }));
  }, [settlements]);

  // ── Delta_B histogram ──
  const deltaHist = useMemo(() => {
    const bins = new Map<string, number>();
    for (let v = -30; v < 30; v += 5) bins.set(String(v), 0);
    for (const s of settlements) {
      const delta = Number(s.delta_B);
      const key = String(Math.floor(delta / 5) * 5);
      if (bins.has(key)) bins.set(key, (bins.get(key) ?? 0) + 1);
    }
    return Array.from(bins.entries()).map(([bin, count]) => ({ bin, count }));
  }, [settlements]);

  // ── Mean surprise by league ──
  const leagueSurprise = useMemo(() => {
    const byLeague = new Map<string, { sum: number; count: number }>();
    for (const s of settlementsWithLeague) {
      if (s.league === "Unknown") continue;
      const entry = byLeague.get(s.league) ?? { sum: 0, count: 0 };
      entry.sum += Number(s.actual_score_S) - Number(s.E_KR);
      entry.count++;
      byLeague.set(s.league, entry);
    }
    return Array.from(byLeague.entries())
      .map(([league, v]) => ({ league, mean: v.sum / v.count, count: v.count }))
      .sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean));
  }, [settlementsWithLeague]);

  // ── Biggest upsets ──
  const upsets = useMemo(() => {
    return [...settlementsWithLeague]
      .map(s => ({
        ...s,
        surprise: Number(s.actual_score_S) - Number(s.E_KR),
        absSurprise: Math.abs(Number(s.actual_score_S) - Number(s.E_KR)),
      }))
      .sort((a, b) => b.absSurprise - a.absSurprise)
      .slice(0, 10);
  }, [settlementsWithLeague]);

  // ── Biggest gravity corrections ──
  const topGravity = useMemo(() => {
    return [...settlementsWithLeague]
      .map(s => ({ ...s, absGravity: Math.abs(Number(s.gravity_component)) }))
      .sort((a, b) => b.absGravity - a.absGravity)
      .slice(0, 10);
  }, [settlementsWithLeague]);

  // ════════════════════════════════════════════════════════════
  // M1 & TEAM STATE METRICS
  // ════════════════════════════════════════════════════════════

  const m1Stats = useMemo(() => {
    const m1s = teamStates.map(t => Number(t.M1_value));
    const confs = teamStates.map(t => Number(t.confidence_score ?? 0));
    const atClamp = m1s.filter(m => Math.abs(m) >= 119).length;
    const meanM1 = m1s.length > 0 ? m1s.reduce((a, b) => a + b, 0) / m1s.length : 0;
    const corr = pearson(teamStates.map(t => Number(t.B_value)), m1s);
    const meanConf = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
    const indices = teamStates.map(t => Number(t.published_index));
    const minIdx = indices.length > 0 ? Math.min(...indices) : 0;
    const maxIdx = indices.length > 0 ? Math.max(...indices) : 0;
    const meanIdx = indices.length > 0 ? indices.reduce((a, b) => a + b, 0) / indices.length : 0;
    return { meanM1, atClamp, clampRate: teamStates.length > 0 ? atClamp / teamStates.length : 0, corr, meanConf, minIdx, maxIdx, meanIdx, spread: maxIdx - minIdx };
  }, [teamStates]);

  // ── M1 histogram ──
  const m1Hist = useMemo(() => {
    const bins = new Map<string, number>();
    for (let v = -120; v < 120; v += 20) bins.set(String(v), 0);
    for (const t of teamStates) {
      const m1 = Number(t.M1_value);
      const key = String(Math.floor(m1 / 20) * 20);
      if (bins.has(key)) bins.set(key, (bins.get(key) ?? 0) + 1);
    }
    return Array.from(bins.entries()).map(([bin, count]) => ({ bin, count }));
  }, [teamStates]);

  // ── M1 vs B scatter ──
  const scatterData = useMemo(
    () => teamStates.map(t => ({
      B: Number(t.B_value),
      M1: Number(t.M1_value),
      team: t.team_id,
      league: teamLeague.get(t.team_id) ?? "Unknown",
    })),
    [teamStates, teamLeague]
  );

  // ── Index range per league ──
  const leagueRange = useMemo(() => {
    const byLeague = new Map<string, { min: number; max: number; sum: number; count: number }>();
    for (const t of teamStates) {
      const league = teamLeague.get(t.team_id) ?? "Unknown";
      const idx = Number(t.published_index);
      const entry = byLeague.get(league) ?? { min: Infinity, max: -Infinity, sum: 0, count: 0 };
      entry.min = Math.min(entry.min, idx);
      entry.max = Math.max(entry.max, idx);
      entry.sum += idx;
      entry.count++;
      byLeague.set(league, entry);
    }
    return Array.from(byLeague.entries())
      .filter(([l]) => l !== "Unknown")
      .map(([league, v]) => ({ league, min: v.min, max: v.max, mean: v.sum / v.count, spread: v.max - v.min }))
      .sort((a, b) => b.spread - a.spread);
  }, [teamStates, teamLeague]);

  // ── Coverage by league ──
  const coverage = useMemo(() => {
    const byLeague = new Map<string, { teams: Set<string>; settlements: number; krSnapshots: number }>();
    for (const t of teamStates) {
      const league = teamLeague.get(t.team_id) ?? "Unknown";
      const entry = byLeague.get(league) ?? { teams: new Set<string>(), settlements: 0, krSnapshots: 0 };
      entry.teams.add(t.team_id);
      byLeague.set(league, entry);
    }
    for (const s of settlements) {
      const match = fixtureLookup.get(s.fixture_id);
      const league = match?.league ?? "Unknown";
      const entry = byLeague.get(league);
      if (entry) entry.settlements++;
    }
    for (const kr of krSnapshots) {
      const match = fixtureLookup.get(kr.fixture_id);
      const league = match?.league ?? "Unknown";
      const entry = byLeague.get(league);
      if (entry) entry.krSnapshots++;
    }
    return Array.from(byLeague.entries())
      .filter(([l]) => l !== "Unknown")
      .map(([league, v]) => ({ league, teams: v.teams.size, settlements: v.settlements, krSnapshots: v.krSnapshots }))
      .sort((a, b) => b.teams - a.teams);
  }, [teamStates, settlements, krSnapshots, teamLeague, fixtureLookup]);

  // ── Stalest teams ──
  const stalest = useMemo(() => {
    const now = Date.now();
    return [...teamStates]
      .filter(t => t.last_market_refresh_ts)
      .map(t => ({
        team: t.team_id,
        league: teamLeague.get(t.team_id) ?? "Unknown",
        hoursAgo: (now - new Date(t.last_market_refresh_ts!).getTime()) / 3600000,
        lastRefresh: t.last_market_refresh_ts!,
      }))
      .sort((a, b) => b.hoursAgo - a.hoursAgo)
      .slice(0, 10);
  }, [teamStates, teamLeague]);

  // ════════════════════════════════════════════════════════════
  // BT SOLVE HISTORY METRICS
  // ════════════════════════════════════════════════════════════

  const btStats = useMemo(() => {
    const n = btSnapshots.length;
    if (n === 0) return { total: 0, latestTime: "–", avgIterations: 0, nonConverged: 0 };
    const sorted = [...btSnapshots].sort((a, b) =>
      new Date(b.solve_timestamp).getTime() - new Date(a.solve_timestamp).getTime()
    );
    const latestTime = sorted[0].solve_timestamp;
    const avgIterations = btSnapshots.reduce((s, bt) => s + bt.iterations, 0) / n;
    const nonConverged = btSnapshots.filter(bt => !bt.converged).length;
    return { total: n, latestTime, avgIterations, nonConverged };
  }, [btSnapshots]);

  const btSolvesTable = useMemo(() => {
    return [...btSnapshots]
      .sort((a, b) => new Date(b.solve_timestamp).getTime() - new Date(a.solve_timestamp).getTime())
      .slice(0, 20);
  }, [btSnapshots]);

  // ════════════════════════════════════════════════════════════
  // SIGMA_BT DISTRIBUTION
  // ════════════════════════════════════════════════════════════

  const sigmaHistogram = useMemo(() => {
    // Get latest BT snapshot per league
    const latestPerLeague = new Map<string, BTSnapshotRow>();
    for (const bt of btSnapshots) {
      const existing = latestPerLeague.get(bt.league);
      if (!existing || new Date(bt.solve_timestamp).getTime() > new Date(existing.solve_timestamp).getTime()) {
        latestPerLeague.set(bt.league, bt);
      }
    }

    // Collect all std_errors from latest snapshots
    const allStdErrors: number[] = [];
    for (const bt of latestPerLeague.values()) {
      for (const se of Object.values(bt.std_errors)) {
        allStdErrors.push(se);
      }
    }

    // Build histogram bins: 0-10, 10-20, ..., 140-150
    const bins: { bin: string; count: number }[] = [];
    for (let lo = 0; lo < 150; lo += 10) {
      const hi = lo + 10;
      const count = allStdErrors.filter(v => v >= lo && v < hi).length;
      bins.push({ bin: `${lo}-${hi}`, count });
    }

    return bins;
  }, [btSnapshots]);

  // ── No data state ──
  const hasSettlements = settlements.length > 0;
  const hasBTSnapshots = btSnapshots.length > 0;

  // ════════════════════════════════════════════════════════════
  // RENDER — Single scrollable page, no tabs
  // ════════════════════════════════════════════════════════════

  return (
    <div className="space-y-8">

      {/* ── SYSTEM OVERVIEW ─────────────────────────────────── */}
      <section>
        <SectionHeader title="System Overview" />
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          <Stat label="Teams" value={String(teamStates.length)} />
          <Stat label="V3 Settlements" value={String(settlements.length)} />
          <Stat label="Fixtures Settled" value={String(systemStats.uniqueFixtures)} />
          <Stat label="KR Snapshots" value={String(krSnapshots.length)} />
          <Stat
            label="KR Degraded"
            value={krSnapshots.length > 0 ? pct(systemStats.degraded / krSnapshots.length) : "–"}
            sub={`${systemStats.degraded} fixtures`}
            warn={krSnapshots.length > 0 && systemStats.degraded / krSnapshots.length > 0.05}
          />
          <Stat label="Avg Bookmakers" value={systemStats.avgBooks > 0 ? fmt(systemStats.avgBooks, 1) : "–"} />
        </div>
      </section>

      {/* ── V3 PARAMETERS ──────────────────────────────────── */}
      <section>
        <SectionHeader title="Oracle V3 Parameters" />
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          <Stat label="K (Settlement)" value="30" sub="ΔB = K(S-E_KR) + γ(R_v3_frozen - B)" />
          <Stat label="Gravity γ" value="0.08" />
          <Stat label="M1 Clamp" value="±120" />
          <Stat label="BT Window" value="30d" sub="expand to 45d if sparse" />
          <Stat label="BT Home Adv" value="65 Elo" />
          <Stat label="BT σ Prior" value="300" />
        </div>
      </section>

      {/* ── GRAVITY ANALYSIS (V3-specific) ─────────────────── */}
      <section>
        <SectionHeader title="Gravity Analysis" sub="V3-specific · γ × (R_v3_frozen − B)" />
        {!hasSettlements ? (
          <div className="border border-border rounded-lg p-8 text-center">
            <div className="text-2xl mb-2">&#9881;</div>
            <div className="text-sm text-muted font-mono">No V3 settlements yet</div>
            <div className="text-[10px] text-muted/50 font-mono mt-1">Gravity data will appear after the first V3 settlement</div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <Stat label="Mean |Gravity|" value={fmt(settlementStats.meanGravity, 3)} sub="avg correction per settlement" />
              <Stat label="Max |Gravity|" value={fmt(settlementStats.maxGravity, 2)} />
              <Stat label="Gravity % of ΔB" value={fmt(settlementStats.gravityPctOfDelta, 1) + "%"} sub="how much gravity matters" />
              <Stat label="Mean |ΔB|" value={fmt(settlementStats.meanDelta, 2)} sub="total settlement shock" />
            </div>

            {/* Gravity histogram */}
            <div className="border border-border rounded p-4 mb-4">
              <h4 className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
                Gravity Component Distribution
              </h4>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={gravityHist}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                  <XAxis dataKey="bin" tick={{ fill: "#666", fontSize: 9, fontFamily: "monospace" }} />
                  <YAxis tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
                  <Tooltip {...TOOLTIP_STYLE} />
                  <ReferenceLine x="0" stroke="#555" />
                  <Bar dataKey="count" name="Settlements" fill="#22d3ee" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Top gravity corrections */}
            <div className="border border-border rounded p-4">
              <h4 className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
                Top 10 Gravity Corrections
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-muted/60 border-b border-border">
                      <th className="text-left py-1 pr-3">Team</th>
                      <th className="text-left py-1 pr-3">League</th>
                      <th className="text-right py-1 pr-3">Gravity</th>
                      <th className="text-right py-1 pr-3">ΔB Total</th>
                      <th className="text-right py-1 pr-3">B Before</th>
                      <th className="text-right py-1">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topGravity.map(u => (
                      <tr key={u.settlement_id} className="border-b border-border/30">
                        <td className="py-1 pr-3 text-foreground">{u.team_id}</td>
                        <td className="py-1 pr-3" style={{ color: LEAGUE_COLOR[u.league] ?? "#666" }}>{u.league}</td>
                        <td className="py-1 pr-3 text-right">
                          <span className={Number(u.gravity_component) > 0 ? "text-accent-green" : "text-accent-red"}>
                            {Number(u.gravity_component) > 0 ? "+" : ""}{fmt(Number(u.gravity_component), 3)}
                          </span>
                        </td>
                        <td className="py-1 pr-3 text-right">
                          <span className={Number(u.delta_B) > 0 ? "text-accent-green" : "text-accent-red"}>
                            {Number(u.delta_B) > 0 ? "+" : ""}{fmt(Number(u.delta_B), 2)}
                          </span>
                        </td>
                        <td className="py-1 pr-3 text-right text-muted">{fmt(Number(u.B_before), 1)}</td>
                        <td className="py-1 text-right text-muted/60">{new Date(u.settled_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── SETTLEMENT ACCURACY ─────────────────────────────── */}
      <section>
        <SectionHeader title="Settlement Accuracy" />
        {!hasSettlements ? (
          <div className="border border-border rounded-lg p-6 text-center text-sm text-muted font-mono">
            No V3 settlements yet — check back after matches are settled
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <Stat label="Total" value={String(settlementStats.total)} />
              <Stat label="Mean |Surprise|" value={fmt(settlementStats.meanAbsSurprise, 3)} sub="lower = more accurate" />
              <Stat label="Brier Score" value={fmt(settlementStats.brierScore, 4)} sub="lower = better calibrated" />
              <Stat label="Max |ΔB|" value={fmt(settlementStats.maxDelta, 2)} sub="biggest single shock" />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
              {/* Calibration */}
              <div className="border border-border rounded p-4">
                <h4 className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
                  E_KR Calibration
                </h4>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={calibration} barGap={2}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                    <XAxis dataKey="range" tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
                    <YAxis tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} domain={[0, 1]} />
                    <Tooltip {...TOOLTIP_STYLE} />
                    <Bar dataKey="expected" name="Expected" fill="#555" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="actual" name="Actual" fill="#22d3ee" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Surprise distribution */}
              <div className="border border-border rounded p-4">
                <h4 className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
                  Surprise Distribution (Actual - E_KR)
                </h4>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={surpriseHist}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                    <XAxis dataKey="bin" tick={{ fill: "#666", fontSize: 9, fontFamily: "monospace" }} />
                    <YAxis tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
                    <Tooltip {...TOOLTIP_STYLE} />
                    <Bar dataKey="count" name="Count" radius={[2, 2, 0, 0]}>
                      {surpriseHist.map((d, i) => (
                        <Cell key={i} fill={d.mid >= 0 ? "#22d3ee" : "#ff1744"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* ΔB distribution */}
              <div className="border border-border rounded p-4">
                <h4 className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
                  Settlement Shock (ΔB) Distribution
                </h4>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={deltaHist}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                    <XAxis dataKey="bin" tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
                    <YAxis tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
                    <Tooltip {...TOOLTIP_STYLE} />
                    <Bar dataKey="count" name="Settlements" radius={[2, 2, 0, 0]}>
                      {deltaHist.map((d, i) => (
                        <Cell key={i} fill={Number(d.bin) >= 0 ? "#22d3ee" : "#ff1744"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Mean surprise by league */}
              <div className="border border-border rounded p-4">
                <h4 className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
                  Mean Surprise by League
                </h4>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={leagueSurprise} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                    <XAxis type="number" tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} domain={[-0.1, 0.1]} />
                    <YAxis type="category" dataKey="league" tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} width={110} />
                    <Tooltip {...TOOLTIP_STYLE} />
                    <ReferenceLine x={0} stroke="#555" />
                    <Bar dataKey="mean" name="Mean Surprise" radius={[0, 2, 2, 0]}>
                      {leagueSurprise.map((d, i) => (
                        <Cell key={i} fill={LEAGUE_COLOR[d.league] ?? "#666"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Biggest upsets table */}
            <div className="border border-border rounded p-4 mt-4">
              <h4 className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
                Top 10 Biggest Surprises
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-muted/60 border-b border-border">
                      <th className="text-left py-1 pr-3">Team</th>
                      <th className="text-left py-1 pr-3">League</th>
                      <th className="text-right py-1 pr-3">E_KR</th>
                      <th className="text-right py-1 pr-3">Result</th>
                      <th className="text-right py-1 pr-3">Surprise</th>
                      <th className="text-right py-1 pr-3">Gravity</th>
                      <th className="text-right py-1">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {upsets.map(u => (
                      <tr key={u.settlement_id} className="border-b border-border/30">
                        <td className="py-1 pr-3 text-foreground">{u.team_id}</td>
                        <td className="py-1 pr-3" style={{ color: LEAGUE_COLOR[u.league] ?? "#666" }}>{u.league}</td>
                        <td className="py-1 pr-3 text-right text-muted">{fmt(Number(u.E_KR), 3)}</td>
                        <td className="py-1 pr-3 text-right">
                          <span className={Number(u.actual_score_S) === 1 ? "text-accent-green" : Number(u.actual_score_S) === 0 ? "text-accent-red" : "text-accent-amber"}>
                            {Number(u.actual_score_S) === 1 ? "W" : Number(u.actual_score_S) === 0 ? "L" : "D"}
                          </span>
                        </td>
                        <td className="py-1 pr-3 text-right font-bold">
                          <span className={u.surprise > 0 ? "text-accent-green" : "text-accent-red"}>
                            {u.surprise > 0 ? "+" : ""}{fmt(u.surprise, 3)}
                          </span>
                        </td>
                        <td className="py-1 pr-3 text-right text-cyan-400">{fmt(Number(u.gravity_component), 3)}</td>
                        <td className="py-1 text-right text-muted/60">{new Date(u.settled_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── M1 & MARKET LAYER ──────────────────────────────── */}
      <section>
        <SectionHeader title="M1 & Market Layer" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <Stat label="Mean M1" value={fmt(m1Stats.meanM1, 1)} />
          <Stat label="At Clamp (±120)" value={`${m1Stats.atClamp} (${pct(m1Stats.clampRate)})`} warn={m1Stats.clampRate > 0.1} />
          <Stat label="M1-B Correlation" value={fmt(m1Stats.corr, 3)} sub="low = good separation" />
          <Stat label="Mean Confidence" value={fmt(m1Stats.meanConf, 3)} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* M1 histogram */}
          <div className="border border-border rounded p-4">
            <h4 className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
              M1 Distribution
            </h4>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={m1Hist}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis dataKey="bin" tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
                <YAxis tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Bar dataKey="count" name="Teams" fill="#fb923c" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* M1 vs B scatter */}
          <div className="border border-border rounded p-4">
            <h4 className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
              M1 vs B — r={fmt(m1Stats.corr, 3)}
            </h4>
            <ResponsiveContainer width="100%" height={200}>
              <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis dataKey="B" name="B" type="number" tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
                <YAxis dataKey="M1" name="M1" type="number" tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
                <Tooltip
                  {...TOOLTIP_STYLE}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(value: any, name: any) => [fmt(Number(value), 1), String(name)]}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  labelFormatter={(_: any, payload: any) => payload?.[0]?.payload?.team ?? ""}
                />
                <ReferenceLine y={0} stroke="#555" />
                <Scatter data={scatterData}>
                  {scatterData.map((d, i) => (
                    <Cell key={i} fill={LEAGUE_COLOR[d.league] ?? "#666"} fillOpacity={0.7} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* ── INDEX & PRICE ──────────────────────────────────── */}
      <section>
        <SectionHeader title="Index & Price" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <Stat label="Index Range" value={`${fmt(m1Stats.minIdx, 0)}–${fmt(m1Stats.maxIdx, 0)}`} sub={`spread: ${fmt(m1Stats.spread, 0)}`} />
          <Stat label="Mean Index" value={fmt(m1Stats.meanIdx, 0)} />
          <Stat label="Price Range" value={`$${fmt((m1Stats.minIdx - 800) / 5, 0)}–$${fmt((m1Stats.maxIdx - 800) / 5, 0)}`} />
          <Stat label="Price History" value={String(priceHistory.length)} sub="settlement+bootstrap" />
        </div>

        {/* League range table */}
        <div className="border border-border rounded p-4">
          <h4 className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
            Index Range by League
          </h4>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-muted/60 border-b border-border">
                <th className="text-left py-1">League</th>
                <th className="text-right py-1">Min</th>
                <th className="text-right py-1">Mean</th>
                <th className="text-right py-1">Max</th>
                <th className="text-right py-1">Spread</th>
              </tr>
            </thead>
            <tbody>
              {leagueRange.map(l => (
                <tr key={l.league} className="border-b border-border/30">
                  <td className="py-1" style={{ color: LEAGUE_COLOR[l.league] ?? "#666" }}>{l.league}</td>
                  <td className="py-1 text-right text-muted">{fmt(l.min, 0)}</td>
                  <td className="py-1 text-right text-foreground">{fmt(l.mean, 0)}</td>
                  <td className="py-1 text-right text-muted">{fmt(l.max, 0)}</td>
                  <td className="py-1 text-right text-accent-amber">{fmt(l.spread, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── COVERAGE & HEALTH ──────────────────────────────── */}
      <section>
        <SectionHeader title="Coverage & Health" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Coverage table */}
          <div className="border border-border rounded p-4">
            <h4 className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
              Coverage by League
            </h4>
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-muted/60 border-b border-border">
                  <th className="text-left py-1">League</th>
                  <th className="text-right py-1">Teams</th>
                  <th className="text-right py-1">Settlements</th>
                  <th className="text-right py-1">KR Snaps</th>
                </tr>
              </thead>
              <tbody>
                {coverage.map(c => (
                  <tr key={c.league} className="border-b border-border/30">
                    <td className="py-1" style={{ color: LEAGUE_COLOR[c.league] ?? "#666" }}>{c.league}</td>
                    <td className="py-1 text-right text-foreground">{c.teams}</td>
                    <td className="py-1 text-right text-muted">{c.settlements}</td>
                    <td className="py-1 text-right text-muted">{c.krSnapshots}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Stalest teams */}
          <div className="border border-border rounded p-4">
            <h4 className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
              Stalest Market Refreshes
            </h4>
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-muted/60 border-b border-border">
                  <th className="text-left py-1">Team</th>
                  <th className="text-left py-1">League</th>
                  <th className="text-right py-1">Hours Ago</th>
                </tr>
              </thead>
              <tbody>
                {stalest.map(s => (
                  <tr key={s.team} className="border-b border-border/30">
                    <td className="py-1 text-foreground">{s.team}</td>
                    <td className="py-1" style={{ color: LEAGUE_COLOR[s.league] ?? "#666" }}>{s.league}</td>
                    <td className={`py-1 text-right ${s.hoursAgo > 48 ? "text-accent-red" : s.hoursAgo > 24 ? "text-accent-amber" : "text-accent-green"}`}>
                      {fmt(s.hoursAgo, 1)}h
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── BT SOLVE HISTORY ───────────────────────────────── */}
      <section>
        <SectionHeader title="BT Solve History" sub="Bradley-Terry model solve snapshots" />
        {!hasBTSnapshots ? (
          <div className="border border-border rounded-lg p-8 text-center">
            <div className="text-2xl mb-2">&#9881;</div>
            <div className="text-sm text-muted font-mono">No BT snapshots yet</div>
            <div className="text-[10px] text-muted/50 font-mono mt-1">BT solve data will appear after the first BT model run</div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <Stat label="Total Solves" value={String(btStats.total)} />
              <Stat
                label="Latest Solve"
                value={new Date(btStats.latestTime).toLocaleString()}
                sub="most recent BT solve"
              />
              <Stat label="Avg Iterations" value={fmt(btStats.avgIterations, 1)} />
              <Stat
                label="Non-Converged"
                value={String(btStats.nonConverged)}
                warn={btStats.nonConverged > 0}
                sub={btStats.nonConverged > 0 ? "solves that did not converge" : "all solves converged"}
              />
            </div>

            {/* BT Solves table */}
            <div className="border border-border rounded p-4">
              <h4 className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
                Recent BT Solves
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-muted/60 border-b border-border">
                      <th className="text-left py-1 pr-3">League</th>
                      <th className="text-left py-1 pr-3">Timestamp</th>
                      <th className="text-right py-1 pr-3">Fixtures</th>
                      <th className="text-right py-1 pr-3">Teams</th>
                      <th className="text-right py-1 pr-3">Iterations</th>
                      <th className="text-right py-1 pr-3">Max Step</th>
                      <th className="text-center py-1 pr-3">Converged</th>
                      <th className="text-right py-1">Window</th>
                    </tr>
                  </thead>
                  <tbody>
                    {btSolvesTable.map(bt => (
                      <tr key={bt.id} className="border-b border-border/30">
                        <td className="py-1 pr-3" style={{ color: LEAGUE_COLOR[bt.league] ?? "#666" }}>
                          {bt.league}
                        </td>
                        <td className="py-1 pr-3 text-muted">
                          {new Date(bt.solve_timestamp).toLocaleString()}
                        </td>
                        <td className="py-1 pr-3 text-right text-foreground">{bt.fixtures_used}</td>
                        <td className="py-1 pr-3 text-right text-foreground">{bt.teams_count}</td>
                        <td className="py-1 pr-3 text-right text-foreground">{bt.iterations}</td>
                        <td className="py-1 pr-3 text-right text-muted">{fmt(bt.max_step, 4)}</td>
                        <td className={`py-1 pr-3 text-center font-bold ${bt.converged ? "text-accent-green" : "text-accent-red"}`}>
                          {bt.converged ? "\u2713" : "\u2717"}
                        </td>
                        <td className="py-1 text-right text-muted">{bt.window_days}d</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── σ_BT DISTRIBUTION ──────────────────────────────── */}
      <section>
        <SectionHeader title="σ_BT Distribution" sub="std error from latest BT solve per league" />
        {!hasBTSnapshots ? (
          <div className="border border-border rounded-lg p-6 text-center text-sm text-muted font-mono">
            No BT snapshots yet — σ distribution will appear after the first BT solve
          </div>
        ) : (
          <div className="border border-border rounded p-4">
            <h4 className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
              BT Standard Error Histogram (latest solve per league)
            </h4>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={sigmaHistogram}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis
                  dataKey="bin"
                  tick={{ fill: "#666", fontSize: 9, fontFamily: "monospace" }}
                  label={{ value: "σ_BT range", position: "insideBottom", offset: -2, fill: "#555", fontSize: 10, fontFamily: "monospace" }}
                />
                <YAxis
                  tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
                  label={{ value: "Teams", angle: -90, position: "insideLeft", fill: "#555", fontSize: 10, fontFamily: "monospace" }}
                />
                <Tooltip {...TOOLTIP_STYLE} />
                <Bar dataKey="count" name="Teams" fill="#a855f7" radius={[2, 2, 0, 0]}>
                  {sigmaHistogram.map((d, i) => {
                    // Color gradient: low uncertainty = green, high = red
                    const ratio = i / Math.max(sigmaHistogram.length - 1, 1);
                    const fill = ratio < 0.33 ? "#22c55e" : ratio < 0.66 ? "#fb923c" : "#ef4444";
                    return <Cell key={i} fill={fill} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="text-[10px] text-muted/50 font-mono mt-2">
              Lower σ = more certain BT rating. High σ teams may need more match data.
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
