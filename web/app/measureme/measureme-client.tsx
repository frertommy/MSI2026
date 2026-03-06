"use client";

import { useState, useMemo } from "react";
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
import type {
  SettlementRow,
  KRSnapshotRow,
  TeamStateRow,
  PriceHistoryRow,
  MatchRow,
} from "./page";

// ─── Constants ──────────────────────────────────────────────

const TABS = [
  "Settlement",
  "KR Quality",
  "M1 Behavior",
  "Price Stability",
  "System Health",
] as const;

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
  let num = 0,
    dx2 = 0,
    dy2 = 0;
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

function Stat({
  label,
  value,
  sub,
  warn,
}: {
  label: string;
  value: string;
  sub?: string;
  warn?: boolean;
}) {
  return (
    <div className="border border-border rounded px-3 py-2">
      <div className="text-[10px] text-muted font-mono uppercase tracking-wider">
        {label}
      </div>
      <div
        className={`text-lg font-bold font-mono ${
          warn ? "text-accent-amber" : "text-foreground"
        }`}
      >
        {value}
      </div>
      {sub && (
        <div className="text-[10px] text-muted/60 font-mono">{sub}</div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────

export function MeasureMeClient({
  settlements,
  krSnapshots,
  teamStates,
  priceHistory,
  matches,
}: {
  settlements: SettlementRow[];
  krSnapshots: KRSnapshotRow[];
  teamStates: TeamStateRow[];
  priceHistory: PriceHistoryRow[];
  matches: MatchRow[];
}) {
  const [activeTab, setActiveTab] = useState<(typeof TABS)[number]>(TABS[0]);

  // ── Fixture → league lookup ──
  const fixtureLookup = useMemo(() => {
    const map = new Map<number, MatchRow>();
    for (const m of matches) map.set(m.fixture_id, m);
    return map;
  }, [matches]);

  // ── Team → league lookup (from team_oracle_state via price history) ──
  const teamLeague = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of priceHistory) {
      if (p.league) map.set(p.team, p.league);
    }
    // fallback: derive from matches
    for (const t of teamStates) {
      if (!map.has(t.team_id)) {
        const m = matches.find(
          (m) => m.home_team === t.team_id || m.away_team === t.team_id
        );
        if (m) map.set(t.team_id, m.league);
      }
    }
    return map;
  }, [priceHistory, teamStates, matches]);

  // ── Settlement with league ──
  const settlementsWithLeague = useMemo(
    () =>
      settlements.map((s) => ({
        ...s,
        league: fixtureLookup.get(s.fixture_id)?.league ?? "Unknown",
      })),
    [settlements, fixtureLookup]
  );

  return (
    <div>
      {/* Tab bar */}
      <div className="flex flex-wrap gap-2 mb-6">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded border transition-all font-mono ${
              activeTab === tab
                ? "bg-foreground text-background border-foreground"
                : "bg-transparent text-muted border-border hover:border-muted"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Settlement" && (
        <SettlementTab settlements={settlementsWithLeague} />
      )}
      {activeTab === "KR Quality" && (
        <KRQualityTab krSnapshots={krSnapshots} fixtureLookup={fixtureLookup} />
      )}
      {activeTab === "M1 Behavior" && (
        <M1BehaviorTab teamStates={teamStates} teamLeague={teamLeague} />
      )}
      {activeTab === "Price Stability" && (
        <PriceStabilityTab
          settlements={settlementsWithLeague}
          teamStates={teamStates}
          teamLeague={teamLeague}
        />
      )}
      {activeTab === "System Health" && (
        <SystemHealthTab
          settlements={settlements}
          krSnapshots={krSnapshots}
          teamStates={teamStates}
          priceHistory={priceHistory}
          matches={matches}
          teamLeague={teamLeague}
          fixtureLookup={fixtureLookup}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 1: SETTLEMENT ACCURACY
// ═══════════════════════════════════════════════════════════════

function SettlementTab({
  settlements,
}: {
  settlements: (SettlementRow & { league: string })[];
}) {
  // ── Calibration buckets ──
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
    return buckets
      .filter((b) => b.count > 0)
      .map((b) => ({
        ...b,
        actual: b.sumActual / b.count,
      }));
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

  // ── Mean surprise by league ──
  const leagueSurprise = useMemo(() => {
    const byLeague = new Map<string, { sum: number; count: number }>();
    for (const s of settlements) {
      if (s.league === "Unknown") continue;
      const entry = byLeague.get(s.league) ?? { sum: 0, count: 0 };
      entry.sum += Number(s.actual_score_S) - Number(s.E_KR);
      entry.count++;
      byLeague.set(s.league, entry);
    }
    return Array.from(byLeague.entries())
      .map(([league, v]) => ({
        league,
        mean: v.sum / v.count,
        count: v.count,
      }))
      .sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean));
  }, [settlements]);

  // ── Biggest upsets ──
  const upsets = useMemo(() => {
    return [...settlements]
      .map((s) => ({
        ...s,
        surprise: Number(s.actual_score_S) - Number(s.E_KR),
        absSurprise: Math.abs(Number(s.actual_score_S) - Number(s.E_KR)),
      }))
      .sort((a, b) => b.absSurprise - a.absSurprise)
      .slice(0, 10);
  }, [settlements]);

  // ── Summary stats ──
  const stats = useMemo(() => {
    const n = settlements.length;
    let sumAbsSurprise = 0;
    let sumSqSurprise = 0;
    for (const s of settlements) {
      const diff = Number(s.actual_score_S) - Number(s.E_KR);
      sumAbsSurprise += Math.abs(diff);
      sumSqSurprise += diff * diff;
    }
    return {
      total: n,
      meanAbsSurprise: sumAbsSurprise / n,
      brierScore: sumSqSurprise / n,
    };
  }, [settlements]);

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Settlements" value={String(stats.total)} />
        <Stat label="Mean |Surprise|" value={fmt(stats.meanAbsSurprise, 3)} sub="lower = more accurate" />
        <Stat label="Brier Score" value={fmt(stats.brierScore, 4)} sub="lower = better calibrated" />
        <Stat
          label="Calibration"
          value={stats.brierScore < 0.2 ? "Good" : stats.brierScore < 0.25 ? "Fair" : "Poor"}
          warn={stats.brierScore >= 0.25}
        />
      </div>

      {/* Calibration chart */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          E_KR Calibration — Expected vs Actual Win Rate
        </h3>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={calibration} barGap={2}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis dataKey="range" tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
            <YAxis tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} domain={[0, 1]} />
            <Tooltip {...TOOLTIP_STYLE} />
            <Bar dataKey="expected" name="Expected" fill="#555" radius={[2, 2, 0, 0]} />
            <Bar dataKey="actual" name="Actual" fill="#00e676" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        <div className="text-[10px] text-muted/50 font-mono mt-1">
          Perfect calibration = green bars match grey bars
        </div>
      </div>

      {/* Surprise histogram */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          Surprise Distribution — (Actual − E_KR)
        </h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={surpriseHist}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis dataKey="bin" tick={{ fill: "#666", fontSize: 9, fontFamily: "monospace" }} />
            <YAxis tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
            <Tooltip {...TOOLTIP_STYLE} />
            <Bar dataKey="count" name="Count" radius={[2, 2, 0, 0]}>
              {surpriseHist.map((d, i) => (
                <Cell key={i} fill={d.mid >= 0 ? "#00e676" : "#ff1744"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Mean surprise by league */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          Mean Surprise by League — should be ≈ 0
        </h3>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={leagueSurprise} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis
              type="number"
              tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
              domain={[-0.1, 0.1]}
            />
            <YAxis
              type="category"
              dataKey="league"
              tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
              width={110}
            />
            <Tooltip {...TOOLTIP_STYLE} />
            <ReferenceLine x={0} stroke="#555" />
            <Bar dataKey="mean" name="Mean Surprise" radius={[0, 2, 2, 0]}>
              {leagueSurprise.map((d, i) => (
                <Cell
                  key={i}
                  fill={LEAGUE_COLOR[d.league] ?? "#666"}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div className="text-[10px] text-muted/50 font-mono mt-1">
          Positive = more upsets than expected. Negative = favorites overperform.
        </div>
      </div>

      {/* Biggest upsets */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          Top 10 Biggest Surprises
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-muted/60 border-b border-border">
                <th className="text-left py-1 pr-3">Team</th>
                <th className="text-left py-1 pr-3">League</th>
                <th className="text-right py-1 pr-3">E_KR</th>
                <th className="text-right py-1 pr-3">Result</th>
                <th className="text-right py-1 pr-3">Surprise</th>
                <th className="text-right py-1">Date</th>
              </tr>
            </thead>
            <tbody>
              {upsets.map((u) => (
                <tr key={u.settlement_id} className="border-b border-border/30">
                  <td className="py-1 pr-3 text-foreground">{u.team_id}</td>
                  <td className="py-1 pr-3" style={{ color: LEAGUE_COLOR[u.league] ?? "#666" }}>
                    {u.league}
                  </td>
                  <td className="py-1 pr-3 text-right text-muted">{fmt(Number(u.E_KR), 3)}</td>
                  <td className="py-1 pr-3 text-right">
                    <span
                      className={
                        Number(u.actual_score_S) === 1
                          ? "text-accent-green"
                          : Number(u.actual_score_S) === 0
                          ? "text-accent-red"
                          : "text-accent-amber"
                      }
                    >
                      {Number(u.actual_score_S) === 1 ? "W" : Number(u.actual_score_S) === 0 ? "L" : "D"}
                    </span>
                  </td>
                  <td className="py-1 pr-3 text-right font-bold">
                    <span className={u.surprise > 0 ? "text-accent-green" : "text-accent-red"}>
                      {u.surprise > 0 ? "+" : ""}
                      {fmt(u.surprise, 3)}
                    </span>
                  </td>
                  <td className="py-1 text-right text-muted/60">
                    {new Date(u.settled_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 2: KR QUALITY
// ═══════════════════════════════════════════════════════════════

function KRQualityTab({
  krSnapshots,
  fixtureLookup,
}: {
  krSnapshots: KRSnapshotRow[];
  fixtureLookup: Map<number, MatchRow>;
}) {
  // ── Bookmaker count histogram ──
  const bookCountHist = useMemo(() => {
    const counts = new Map<number, number>();
    for (const kr of krSnapshots) {
      counts.set(kr.bookmaker_count, (counts.get(kr.bookmaker_count) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([books, count]) => ({ books: String(books), count }));
  }, [krSnapshots]);

  // ── Expected score distribution ──
  const ekrHist = useMemo(() => {
    const bins = new Map<string, number>();
    for (let v = 0; v < 1; v += 0.05) {
      bins.set(v.toFixed(2), 0);
    }
    for (const kr of krSnapshots) {
      for (const es of [kr.home_expected_score, kr.away_expected_score]) {
        const key = (Math.floor(Number(es) * 20) / 20).toFixed(2);
        if (bins.has(key)) bins.set(key, (bins.get(key) ?? 0) + 1);
      }
    }
    return Array.from(bins.entries()).map(([bin, count]) => ({ bin, count }));
  }, [krSnapshots]);

  // ── Stats ──
  const stats = useMemo(() => {
    const total = krSnapshots.length;
    const degraded = krSnapshots.filter((kr) => kr.kr_degraded).length;
    const avgBooks =
      krSnapshots.reduce((s, kr) => s + kr.bookmaker_count, 0) / total;
    // consensus spread: max prob - min prob per fixture
    const spreads = krSnapshots.map((kr) => {
      const probs = [Number(kr.home_prob), Number(kr.draw_prob), Number(kr.away_prob)];
      return Math.max(...probs) - Math.min(...probs);
    });
    const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    return { total, degraded, degradedRate: degraded / total, avgBooks, avgSpread };
  }, [krSnapshots]);

  // ── KR by league ──
  const leagueStats = useMemo(() => {
    const byLeague = new Map<string, { count: number; sumBooks: number; degraded: number }>();
    for (const kr of krSnapshots) {
      const match = fixtureLookup.get(kr.fixture_id);
      const league = match?.league ?? "Unknown";
      const entry = byLeague.get(league) ?? { count: 0, sumBooks: 0, degraded: 0 };
      entry.count++;
      entry.sumBooks += kr.bookmaker_count;
      if (kr.kr_degraded) entry.degraded++;
      byLeague.set(league, entry);
    }
    return Array.from(byLeague.entries())
      .map(([league, v]) => ({
        league,
        count: v.count,
        avgBooks: v.sumBooks / v.count,
        degradedRate: v.degraded / v.count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [krSnapshots, fixtureLookup]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="KR Snapshots" value={String(stats.total)} />
        <Stat label="Avg Bookmakers" value={fmt(stats.avgBooks, 1)} />
        <Stat
          label="Degraded Rate"
          value={pct(stats.degradedRate)}
          sub={`${stats.degraded} fixtures`}
          warn={stats.degradedRate > 0.05}
        />
        <Stat label="Avg Consensus Spread" value={fmt(stats.avgSpread, 3)} />
      </div>

      {/* Bookmaker count histogram */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          Bookmaker Count per KR Freeze
        </h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={bookCountHist}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis dataKey="books" tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
            <YAxis tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
            <Tooltip {...TOOLTIP_STYLE} />
            <Bar dataKey="count" name="Fixtures" fill="#60a5fa" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Expected score distribution */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          E_KR Distribution (home + away)
        </h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={ekrHist}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis dataKey="bin" tick={{ fill: "#666", fontSize: 9, fontFamily: "monospace" }} interval={3} />
            <YAxis tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
            <Tooltip {...TOOLTIP_STYLE} />
            <Bar dataKey="count" name="Count" fill="#a855f7" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* KR by league table */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          KR Quality by League
        </h3>
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-muted/60 border-b border-border">
              <th className="text-left py-1">League</th>
              <th className="text-right py-1">Fixtures</th>
              <th className="text-right py-1">Avg Books</th>
              <th className="text-right py-1">Degraded</th>
            </tr>
          </thead>
          <tbody>
            {leagueStats.map((l) => (
              <tr key={l.league} className="border-b border-border/30">
                <td className="py-1" style={{ color: LEAGUE_COLOR[l.league] ?? "#666" }}>
                  {l.league}
                </td>
                <td className="py-1 text-right text-muted">{l.count}</td>
                <td className="py-1 text-right text-foreground">{fmt(l.avgBooks, 1)}</td>
                <td className={`py-1 text-right ${l.degradedRate > 0.05 ? "text-accent-amber" : "text-muted"}`}>
                  {pct(l.degradedRate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 3: M1 BEHAVIOR
// ═══════════════════════════════════════════════════════════════

function M1BehaviorTab({
  teamStates,
  teamLeague,
}: {
  teamStates: TeamStateRow[];
  teamLeague: Map<string, string>;
}) {
  // ── M1 histogram ──
  const m1Hist = useMemo(() => {
    const bins = new Map<string, number>();
    for (let v = -120; v < 120; v += 20) {
      bins.set(String(v), 0);
    }
    for (const t of teamStates) {
      const m1 = Number(t.M1_value);
      const key = String(Math.floor(m1 / 20) * 20);
      if (bins.has(key)) bins.set(key, (bins.get(key) ?? 0) + 1);
    }
    return Array.from(bins.entries()).map(([bin, count]) => ({
      bin,
      count,
    }));
  }, [teamStates]);

  // ── Confidence histogram ──
  const confHist = useMemo(() => {
    const bins = [
      { range: "0-0.2", min: 0, max: 0.2, count: 0 },
      { range: "0.2-0.4", min: 0.2, max: 0.4, count: 0 },
      { range: "0.4-0.6", min: 0.4, max: 0.6, count: 0 },
      { range: "0.6-0.8", min: 0.6, max: 0.8, count: 0 },
      { range: "0.8-1.0", min: 0.8, max: 1.01, count: 0 },
    ];
    for (const t of teamStates) {
      const c = Number(t.confidence_score ?? 0);
      for (const b of bins) {
        if (c >= b.min && c < b.max) {
          b.count++;
          break;
        }
      }
    }
    return bins;
  }, [teamStates]);

  // ── M1 vs B scatter data ──
  const scatterData = useMemo(
    () =>
      teamStates.map((t) => ({
        B: Number(t.B_value),
        M1: Number(t.M1_value),
        team: t.team_id,
        league: teamLeague.get(t.team_id) ?? "Unknown",
      })),
    [teamStates, teamLeague]
  );

  // ── Stats ──
  const stats = useMemo(() => {
    const m1s = teamStates.map((t) => Number(t.M1_value));
    const confs = teamStates.map((t) => Number(t.confidence_score ?? 0));
    const atClamp = m1s.filter((m) => Math.abs(m) >= 119).length;
    const meanM1 = m1s.reduce((a, b) => a + b, 0) / m1s.length;
    const medianM1 = [...m1s].sort((a, b) => a - b)[Math.floor(m1s.length / 2)];
    const corr = pearson(
      teamStates.map((t) => Number(t.B_value)),
      m1s
    );
    const meanConf = confs.reduce((a, b) => a + b, 0) / confs.length;
    return {
      meanM1,
      medianM1,
      atClamp,
      clampRate: atClamp / teamStates.length,
      corr,
      meanConf,
    };
  }, [teamStates]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Mean M1" value={fmt(stats.meanM1, 1)} />
        <Stat
          label="At Clamp (±120)"
          value={`${stats.atClamp} (${pct(stats.clampRate)})`}
          warn={stats.clampRate > 0.1}
          sub="spec recommends ±75"
        />
        <Stat label="M1-B Correlation" value={fmt(stats.corr, 3)} sub="low = good separation" />
        <Stat label="Mean Confidence" value={fmt(stats.meanConf, 3)} />
      </div>

      {/* M1 histogram */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          M1 Distribution Across Teams
        </h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={m1Hist}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis dataKey="bin" tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
            <YAxis tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
            <Tooltip {...TOOLTIP_STYLE} />
            <ReferenceLine x="-120" stroke="#ff1744" strokeDasharray="3 3" />
            <ReferenceLine x="120" stroke="#ff1744" strokeDasharray="3 3" />
            <Bar dataKey="count" name="Teams" fill="#fb923c" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* M1 vs B scatter */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          M1 vs B — Correlation: {fmt(stats.corr, 3)}
        </h3>
        <ResponsiveContainer width="100%" height={300}>
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis
              dataKey="B"
              name="B_value"
              type="number"
              tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
              label={{ value: "B_value", position: "bottom", fill: "#666", fontSize: 10 }}
            />
            <YAxis
              dataKey="M1"
              name="M1_value"
              type="number"
              tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
              label={{ value: "M1", angle: -90, position: "left", fill: "#666", fontSize: 10 }}
            />
            <Tooltip
              {...TOOLTIP_STYLE}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={(value: any, name: any) => [fmt(Number(value), 1), String(name)]}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              labelFormatter={(_: any, payload: any) =>
                payload?.[0]?.payload?.team ?? ""
              }
            />
            <ReferenceLine y={0} stroke="#555" />
            <Scatter data={scatterData}>
              {scatterData.map((d, i) => (
                <Cell
                  key={i}
                  fill={LEAGUE_COLOR[d.league] ?? "#666"}
                  fillOpacity={0.7}
                />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      {/* Confidence distribution */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          Confidence Score Distribution
        </h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={confHist}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis dataKey="range" tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
            <YAxis tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
            <Tooltip {...TOOLTIP_STYLE} />
            <Bar dataKey="count" name="Teams" fill="#22d3ee" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 4: PRICE STABILITY
// ═══════════════════════════════════════════════════════════════

function PriceStabilityTab({
  settlements,
  teamStates,
  teamLeague,
}: {
  settlements: (SettlementRow & { league: string })[];
  teamStates: TeamStateRow[];
  teamLeague: Map<string, string>;
}) {
  // ── Delta_B histogram ──
  const deltaHist = useMemo(() => {
    const bins = new Map<string, number>();
    for (let v = -30; v < 30; v += 5) {
      bins.set(String(v), 0);
    }
    for (const s of settlements) {
      const delta = Number(s.delta_B);
      const key = String(Math.floor(delta / 5) * 5);
      if (bins.has(key)) bins.set(key, (bins.get(key) ?? 0) + 1);
    }
    return Array.from(bins.entries()).map(([bin, count]) => ({
      bin,
      count,
    }));
  }, [settlements]);

  // ── Index range per league ──
  const leagueRange = useMemo(() => {
    const byLeague = new Map<
      string,
      { min: number; max: number; sum: number; count: number }
    >();
    for (const t of teamStates) {
      const league = teamLeague.get(t.team_id) ?? "Unknown";
      const idx = Number(t.published_index);
      const entry = byLeague.get(league) ?? {
        min: Infinity,
        max: -Infinity,
        sum: 0,
        count: 0,
      };
      entry.min = Math.min(entry.min, idx);
      entry.max = Math.max(entry.max, idx);
      entry.sum += idx;
      entry.count++;
      byLeague.set(league, entry);
    }
    return Array.from(byLeague.entries())
      .filter(([l]) => l !== "Unknown")
      .map(([league, v]) => ({
        league,
        min: v.min,
        max: v.max,
        mean: v.sum / v.count,
        spread: v.max - v.min,
      }))
      .sort((a, b) => b.spread - a.spread);
  }, [teamStates, teamLeague]);

  // ── M1 contribution per league ──
  const m1Contribution = useMemo(() => {
    const byLeague = new Map<string, { sumRatio: number; count: number }>();
    for (const t of teamStates) {
      const league = teamLeague.get(t.team_id) ?? "Unknown";
      const absM1 = Math.abs(Number(t.M1_value));
      const absB = Math.abs(Number(t.B_value));
      const ratio = absB + absM1 > 0 ? absM1 / (absB + absM1) : 0;
      const entry = byLeague.get(league) ?? { sumRatio: 0, count: 0 };
      entry.sumRatio += ratio;
      entry.count++;
      byLeague.set(league, entry);
    }
    return Array.from(byLeague.entries())
      .filter(([l]) => l !== "Unknown")
      .map(([league, v]) => ({
        league,
        ratio: v.sumRatio / v.count,
      }))
      .sort((a, b) => b.ratio - a.ratio);
  }, [teamStates, teamLeague]);

  // ── Stats ──
  const stats = useMemo(() => {
    const deltas = settlements.map((s) => Math.abs(Number(s.delta_B)));
    const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const maxDelta = Math.max(...deltas);
    const indices = teamStates.map((t) => Number(t.published_index));
    const minIdx = Math.min(...indices);
    const maxIdx = Math.max(...indices);
    const meanIdx = indices.reduce((a, b) => a + b, 0) / indices.length;
    return { meanDelta, maxDelta, minIdx, maxIdx, meanIdx, spread: maxIdx - minIdx };
  }, [settlements, teamStates]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Mean |ΔB|" value={fmt(stats.meanDelta, 2)} sub="avg settlement shock" />
        <Stat label="Max |ΔB|" value={fmt(stats.maxDelta, 2)} sub="biggest single shock" />
        <Stat label="Index Range" value={`${fmt(stats.minIdx, 0)}–${fmt(stats.maxIdx, 0)}`} sub={`spread: ${fmt(stats.spread, 0)}`} />
        <Stat label="Mean Index" value={fmt(stats.meanIdx, 0)} />
      </div>

      {/* Delta_B histogram */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          Settlement Shock (ΔB) Distribution
        </h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={deltaHist}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis dataKey="bin" tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
            <YAxis tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }} />
            <Tooltip {...TOOLTIP_STYLE} />
            <Bar dataKey="count" name="Settlements" radius={[2, 2, 0, 0]}>
              {deltaHist.map((d, i) => (
                <Cell key={i} fill={Number(d.bin) >= 0 ? "#00e676" : "#ff1744"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Index range per league */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          Published Index Range by League
        </h3>
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
            {leagueRange.map((l) => (
              <tr key={l.league} className="border-b border-border/30">
                <td className="py-1" style={{ color: LEAGUE_COLOR[l.league] ?? "#666" }}>
                  {l.league}
                </td>
                <td className="py-1 text-right text-muted">{fmt(l.min, 0)}</td>
                <td className="py-1 text-right text-foreground">{fmt(l.mean, 0)}</td>
                <td className="py-1 text-right text-muted">{fmt(l.max, 0)}</td>
                <td className="py-1 text-right text-accent-amber">{fmt(l.spread, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* M1 contribution */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          M1 Contribution Ratio by League — |M1| / (|B| + |M1|)
        </h3>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={m1Contribution} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis
              type="number"
              domain={[0, 0.15]}
              tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
              tickFormatter={(v: number) => pct(v, 0)}
            />
            <YAxis
              type="category"
              dataKey="league"
              tick={{ fill: "#666", fontSize: 10, fontFamily: "monospace" }}
              width={110}
            />
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: any) => pct(Number(v))} />
            <Bar dataKey="ratio" name="M1 Ratio" radius={[0, 2, 2, 0]}>
              {m1Contribution.map((d, i) => (
                <Cell key={i} fill={LEAGUE_COLOR[d.league] ?? "#666"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div className="text-[10px] text-muted/50 font-mono mt-1">
          If ratio &gt; 50%, market layer dominates base — may indicate clamp is too loose.
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 5: SYSTEM HEALTH
// ═══════════════════════════════════════════════════════════════

function SystemHealthTab({
  settlements,
  krSnapshots,
  teamStates,
  priceHistory,
  matches,
  teamLeague,
  fixtureLookup,
}: {
  settlements: SettlementRow[];
  krSnapshots: KRSnapshotRow[];
  teamStates: TeamStateRow[];
  priceHistory: PriceHistoryRow[];
  matches: MatchRow[];
  teamLeague: Map<string, string>;
  fixtureLookup: Map<number, MatchRow>;
}) {
  // ── Coverage by league ──
  const coverage = useMemo(() => {
    const byLeague = new Map<
      string,
      { teams: Set<string>; settlements: number; krSnapshots: number }
    >();

    for (const t of teamStates) {
      const league = teamLeague.get(t.team_id) ?? "Unknown";
      const entry = byLeague.get(league) ?? {
        teams: new Set<string>(),
        settlements: 0,
        krSnapshots: 0,
      };
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
      .map(([league, v]) => ({
        league,
        teams: v.teams.size,
        settlements: v.settlements,
        krSnapshots: v.krSnapshots,
      }))
      .sort((a, b) => b.teams - a.teams);
  }, [teamStates, settlements, krSnapshots, teamLeague, fixtureLookup]);

  // ── Stalest teams ──
  const stalest = useMemo(() => {
    const now = Date.now();
    return [...teamStates]
      .filter((t) => t.last_market_refresh_ts)
      .map((t) => ({
        team: t.team_id,
        league: teamLeague.get(t.team_id) ?? "Unknown",
        hoursAgo: (now - new Date(t.last_market_refresh_ts!).getTime()) / 3600000,
        lastRefresh: t.last_market_refresh_ts!,
      }))
      .sort((a, b) => b.hoursAgo - a.hoursAgo)
      .slice(0, 15);
  }, [teamStates, teamLeague]);

  const uniqueFixtures = useMemo(
    () => new Set(settlements.map((s) => s.fixture_id)).size,
    [settlements]
  );

  return (
    <div className="space-y-6">
      {/* Pipeline overview */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Stat label="Teams" value={String(teamStates.length)} />
        <Stat label="Settlements" value={String(settlements.length)} />
        <Stat label="Fixtures Settled" value={String(uniqueFixtures)} />
        <Stat label="KR Snapshots" value={String(krSnapshots.length)} />
        <Stat label="Price History" value={String(priceHistory.length)} sub="settlement+bootstrap" />
      </div>

      {/* Coverage by league */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          Coverage by League
        </h3>
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
            {coverage.map((c) => (
              <tr key={c.league} className="border-b border-border/30">
                <td className="py-1" style={{ color: LEAGUE_COLOR[c.league] ?? "#666" }}>
                  {c.league}
                </td>
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
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          Stalest Market Refreshes
        </h3>
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-muted/60 border-b border-border">
              <th className="text-left py-1">Team</th>
              <th className="text-left py-1">League</th>
              <th className="text-right py-1">Hours Ago</th>
              <th className="text-right py-1">Last Refresh</th>
            </tr>
          </thead>
          <tbody>
            {stalest.map((s) => (
              <tr key={s.team} className="border-b border-border/30">
                <td className="py-1 text-foreground">{s.team}</td>
                <td className="py-1" style={{ color: LEAGUE_COLOR[s.league] ?? "#666" }}>
                  {s.league}
                </td>
                <td
                  className={`py-1 text-right ${
                    s.hoursAgo > 48
                      ? "text-accent-red"
                      : s.hoursAgo > 24
                      ? "text-accent-amber"
                      : "text-accent-green"
                  }`}
                >
                  {fmt(s.hoursAgo, 1)}h
                </td>
                <td className="py-1 text-right text-muted/60">
                  {new Date(s.lastRefresh).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Oracle V1.4 parameters */}
      <div className="border border-border rounded p-4">
        <h3 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
          Oracle V1.4 Parameters
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="K (Settlement)" value="30" sub="ΔB = K × (S − E_KR)" />
          <Stat
            label="M1 Clamp"
            value="±120"
            sub="spec: ±75"
            warn
          />
          <Stat
            label="Horizon Days"
            value="21"
            sub="spec: 10"
            warn
          />
          <Stat label="Home Advantage" value="65 Elo" />
          <Stat label="c_books Full At" value="5 books" />
          <Stat label="c_recency Decay" value="48h" />
          <Stat label="c_dispersion" value="0.08 spread" />
          <Stat label="KR Preference" value="6h window" />
        </div>
      </div>
    </div>
  );
}
