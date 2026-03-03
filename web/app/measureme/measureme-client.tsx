"use client";

import { useState, useMemo } from "react";
import type { MeasureMeRow, TeamEloRow } from "./page";

// ─── Index Definitions ───────────────────────────────────────
const INDEX_DEFS = [
  {
    key: "surprise_r2_score" as const,
    rawKey: "surprise_r2" as const,
    name: "Surprise R\u00B2",
    weight: "25%",
    description:
      "How well price moves correlate with match surprise magnitude",
    target: "Higher is better (R\u00B2 \u00D7 150, cap 100)",
    rawFmt: (v: number) => v.toFixed(4),
  },
  {
    key: "drift_score" as const,
    rawKey: "drift_neutrality" as const,
    name: "Drift Neutrality",
    weight: "15%",
    description: "Mean daily price return across all teams should be ~0%",
    target: "Closer to 0 is better",
    rawFmt: (v: number) => (v * 100).toFixed(4) + "%",
  },
  {
    key: "floor_hit_score" as const,
    rawKey: "floor_hit_pct" as const,
    name: "Floor Hit %",
    weight: "15%",
    description:
      "% of team-day prices at $10 floor \u2014 price discovery stops",
    target: "0% ideal (lower is better)",
    rawFmt: (v: number) => v.toFixed(2) + "%",
  },
  {
    key: "kurtosis_score" as const,
    rawKey: "kurtosis" as const,
    name: "Return Kurtosis",
    weight: "10%",
    description: "Tail thickness of return distribution (m4/m2\u00B2)",
    target: "4\u201310 ideal",
    rawFmt: (v: number) => v.toFixed(2),
  },
  {
    key: "vol_uni_score" as const,
    rawKey: "vol_uniformity_ratio" as const,
    name: "Vol Uniformity",
    weight: "10%",
    description: "Max/min annualized vol across Elo tiers (top/mid/bot 25%)",
    target: "< 1.5\u00D7 ideal",
    rawFmt: (v: number) => v.toFixed(2) + "\u00D7",
  },
  {
    key: "mean_rev_score" as const,
    rawKey: "mean_rev_sharpe" as const,
    name: "MR Sharpe",
    weight: "15%",
    description: "Mean-reversion strategy Sharpe (long loss, short win, 3d)",
    target: "|SR| < 0.3 ideal (no free lunch)",
    rawFmt: (v: number) => v.toFixed(3),
  },
  {
    key: "info_score" as const,
    rawKey: "info_ratio" as const,
    name: "Information Ratio",
    weight: "10%",
    description: "Spearman: final price rank vs actual league points",
    target: "Higher is better (\u00D7110, cap 100)",
    rawFmt: (v: number) => v.toFixed(3),
  },
] as const;

const INITIAL_TABLE_ROWS = 50;

// ─── Helpers ─────────────────────────────────────────────────
function scoreColor(score: number): string {
  if (score >= 70) return "text-accent-green";
  if (score >= 40) return "text-amber-400";
  return "text-red-400";
}

function compositeColor(score: number): string {
  if (score >= 70) return "text-accent-green";
  if (score >= 50) return "text-amber-400";
  return "text-red-400";
}

function scoreBg(score: number): string {
  if (score >= 70) return "bg-accent-green";
  if (score >= 40) return "bg-amber-400";
  return "bg-red-400";
}

// ─── Sort types ──────────────────────────────────────────────
type NumericKey =
  | "slope"
  | "k_factor"
  | "decay"
  | "zero_point"
  | "composite_score"
  | "surprise_r2_score"
  | "drift_score"
  | "floor_hit_score"
  | "kurtosis_score"
  | "vol_uni_score"
  | "mean_rev_score"
  | "info_score"
  | "avg_match_move_pct"
  | "avg_annual_vol";

type SortCol = "rank" | NumericKey;

// ─── Props ──────────────────────────────────────────────────
interface Props {
  results: MeasureMeRow[];
  runId: string;
  teamElos: TeamEloRow[];
}

// ─── Component ──────────────────────────────────────────────
export function MeasureMeClient({ results, runId, teamElos }: Props) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [sortCol, setSortCol] = useState<SortCol>("composite_score");
  const [sortAsc, setSortAsc] = useState(false);

  const best = results[0];
  const selected = results[selectedIdx] ?? best;

  const sorted = useMemo(() => {
    const indexed = results.map((r, i) => ({ ...r, origRank: i + 1 }));
    indexed.sort((a, b) => {
      if (sortCol === "rank") {
        return sortAsc
          ? a.origRank - b.origRank
          : b.origRank - a.origRank;
      }
      const col: NumericKey = sortCol;
      return sortAsc ? a[col] - b[col] : b[col] - a[col];
    });
    return indexed;
  }, [results, sortCol, sortAsc]);

  const displayRows = showAll ? sorted : sorted.slice(0, INITIAL_TABLE_ROWS);

  function handleSort(col: SortCol) {
    if (col === sortCol) setSortAsc(!sortAsc);
    else {
      setSortCol(col);
      setSortAsc(false);
    }
  }

  function sortIndicator(col: SortCol) {
    if (col !== sortCol) return "";
    return sortAsc ? " \u25B2" : " \u25BC";
  }

  function selectRow(row: MeasureMeRow) {
    const idx = results.findIndex(
      (r) =>
        r.slope === row.slope &&
        r.k_factor === row.k_factor &&
        r.decay === row.decay &&
        r.zero_point === row.zero_point
    );
    if (idx >= 0) setSelectedIdx(idx);
  }

  // Price implications: show top teams + bottom teams with real Elos
  const priceImplications = useMemo(() => {
    if (teamElos.length === 0) return [];
    const top = teamElos.slice(0, 10);
    const bottom = teamElos.slice(-5);
    const combined = [...top, ...bottom];
    return combined.map((t) => ({
      team: t.team,
      elo: t.implied_elo,
      price: Math.max(10, (t.implied_elo - selected.zero_point) / selected.slope),
      atFloor: (t.implied_elo - selected.zero_point) / selected.slope <= 10,
    }));
  }, [teamElos, selected.slope, selected.zero_point]);

  if (!best) return null;

  return (
    <div className="space-y-8">
      {/* ── Section 1: Winner Banner ──────────────────────── */}
      <div className="border-2 border-accent-green rounded-lg p-6 bg-surface">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <span className="text-accent-green text-xl font-bold">#1</span>
              <span className="text-foreground font-bold text-lg uppercase tracking-wider">
                Best Config
              </span>
              <span className="text-xs text-muted font-mono">
                of {results.length} tested
              </span>
            </div>

            <div className="grid grid-cols-4 gap-x-6 gap-y-2 text-sm font-mono">
              <div>
                <span className="text-muted">Slope</span>{" "}
                <span className="text-foreground font-bold">{best.slope}</span>
              </div>
              <div>
                <span className="text-muted">K</span>{" "}
                <span className="text-foreground font-bold">
                  {best.k_factor}
                </span>
              </div>
              <div>
                <span className="text-muted">Decay</span>{" "}
                <span className="text-foreground font-bold">{best.decay}</span>
              </div>
              <div>
                <span className="text-muted">ZeroPoint</span>{" "}
                <span className="text-foreground font-bold">
                  {best.zero_point}
                </span>
              </div>
              <div>
                <span className="text-muted">Avg Move</span>{" "}
                <span className="text-foreground">
                  {best.avg_match_move_pct.toFixed(2)}%
                </span>
              </div>
              <div>
                <span className="text-muted">Ann Vol</span>{" "}
                <span className="text-foreground">
                  {best.avg_annual_vol.toFixed(1)}%
                </span>
              </div>
              <div>
                <span className="text-muted">R&sup2;</span>{" "}
                <span className="text-foreground">
                  {best.surprise_r2.toFixed(4)}
                </span>
              </div>
              <div>
                <span className="text-muted">Floor</span>{" "}
                <span className="text-foreground">
                  {best.teams_at_floor} teams
                </span>
              </div>
            </div>
          </div>

          <div className="text-right">
            <div className="text-5xl font-bold text-accent-green font-mono">
              {best.composite_score}
            </div>
            <div className="text-xs text-muted font-mono mt-1">
              composite /100
            </div>
          </div>
        </div>

        {/* Config snippet */}
        <div className="mt-4 bg-background rounded-md p-3 text-xs font-mono text-muted border border-border">
          <span className="text-foreground/50">// config.ts</span>
          <br />
          <span className="text-accent-green">export const</span> PRICE_SLOPE ={" "}
          {best.slope};
          <br />
          <span className="text-accent-green">export const</span> PRICE_ZERO ={" "}
          {best.zero_point};
          <br />
          <span className="text-accent-green">export const</span> PRICE_FLOOR =
          10;
          <br />
          <span className="text-accent-green">export const</span>{" "}
          ORACLE_SHOCK_K = {best.k_factor};
          <br />
          <span className="text-accent-green">export const</span> CARRY_DECAY ={" "}
          {best.decay};
        </div>
      </div>

      {/* ── Section 2: Index Cards ────────────────────────── */}
      <div>
        <h2 className="text-sm font-bold text-foreground uppercase tracking-wider mb-3">
          Index Breakdown{" "}
          <span className="text-muted font-normal">
            &mdash; slope={selected.slope} K={selected.k_factor} decay=
            {selected.decay} zp={selected.zero_point}
          </span>
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {INDEX_DEFS.map((def) => {
            const score = selected[def.key];
            const raw = selected[def.rawKey];

            return (
              <div
                key={def.key}
                className="border border-border rounded-lg p-3 bg-surface"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-foreground uppercase">
                    {def.name}
                  </span>
                  <span className="text-[10px] text-muted font-mono">
                    w={def.weight}
                  </span>
                </div>

                <div className="flex items-center gap-2 mb-2">
                  <div className="flex-1 h-2 bg-background rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${scoreBg(score)}`}
                      style={{ width: `${Math.min(100, score)}%` }}
                    />
                  </div>
                  <span
                    className={`text-sm font-bold font-mono ${scoreColor(score)}`}
                  >
                    {score}
                  </span>
                </div>

                <div className="text-[10px] font-mono text-muted space-y-0.5">
                  <div>Raw: {def.rawFmt(raw)}</div>
                  <div>{def.description}</div>
                  <div className="text-foreground/40">
                    Target: {def.target}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Section 3: Results Table ──────────────────────── */}
      <div>
        <h2 className="text-sm font-bold text-foreground uppercase tracking-wider mb-3">
          All Configs
        </h2>

        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="bg-surface border-b border-border text-muted">
                {(
                  [
                    ["rank", "#"],
                    ["slope", "Slope"],
                    ["k_factor", "K"],
                    ["decay", "Decay"],
                    ["zero_point", "ZP"],
                    ["composite_score", "Score"],
                    ["surprise_r2_score", "R\u00B2"],
                    ["drift_score", "Drift"],
                    ["floor_hit_score", "Floor"],
                    ["kurtosis_score", "Kurt"],
                    ["vol_uni_score", "Vol\u00D7"],
                    ["mean_rev_score", "MR"],
                    ["info_score", "Info"],
                    ["avg_match_move_pct", "Avg\u26A1%"],
                    ["avg_annual_vol", "\u03C3/yr"],
                  ] as [SortCol, string][]
                ).map(([col, label]) => (
                  <th
                    key={col}
                    className="px-2 py-2 text-left cursor-pointer hover:text-foreground transition-colors whitespace-nowrap"
                    onClick={() => handleSort(col)}
                  >
                    {label}
                    {sortIndicator(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row) => {
                const isSelected =
                  row.slope === selected.slope &&
                  row.k_factor === selected.k_factor &&
                  row.decay === selected.decay &&
                  row.zero_point === selected.zero_point;
                const isBest = row.origRank === 1;

                return (
                  <tr
                    key={`${row.slope}-${row.k_factor}-${row.decay}-${row.zero_point}`}
                    className={`border-b border-border/50 cursor-pointer transition-colors ${
                      isBest
                        ? "bg-accent-green/10 hover:bg-accent-green/20"
                        : isSelected
                          ? "bg-surface hover:bg-surface"
                          : "hover:bg-surface/50"
                    }`}
                    onClick={() => selectRow(row)}
                  >
                    <td className="px-2 py-1.5 text-muted">
                      {row.origRank}
                    </td>
                    <td className="px-2 py-1.5 text-foreground">
                      {row.slope}
                    </td>
                    <td className="px-2 py-1.5 text-foreground">
                      {row.k_factor}
                    </td>
                    <td className="px-2 py-1.5 text-foreground">
                      {row.decay}
                    </td>
                    <td className="px-2 py-1.5 text-foreground">
                      {row.zero_point}
                    </td>
                    <td
                      className={`px-2 py-1.5 font-bold ${compositeColor(row.composite_score)}`}
                    >
                      {row.composite_score}
                    </td>
                    <td
                      className={`px-2 py-1.5 ${scoreColor(row.surprise_r2_score)}`}
                    >
                      {row.surprise_r2_score}
                    </td>
                    <td
                      className={`px-2 py-1.5 ${scoreColor(row.drift_score)}`}
                    >
                      {row.drift_score}
                    </td>
                    <td
                      className={`px-2 py-1.5 ${scoreColor(row.floor_hit_score)}`}
                    >
                      {row.floor_hit_score}
                    </td>
                    <td
                      className={`px-2 py-1.5 ${scoreColor(row.kurtosis_score)}`}
                    >
                      {row.kurtosis_score}
                    </td>
                    <td
                      className={`px-2 py-1.5 ${scoreColor(row.vol_uni_score)}`}
                    >
                      {row.vol_uni_score}
                    </td>
                    <td
                      className={`px-2 py-1.5 ${scoreColor(row.mean_rev_score)}`}
                    >
                      {row.mean_rev_score}
                    </td>
                    <td
                      className={`px-2 py-1.5 ${scoreColor(row.info_score)}`}
                    >
                      {row.info_score}
                    </td>
                    <td className="px-2 py-1.5 text-foreground">
                      {row.avg_match_move_pct.toFixed(2)}
                    </td>
                    <td className="px-2 py-1.5 text-foreground">
                      {row.avg_annual_vol.toFixed(1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!showAll && sorted.length > INITIAL_TABLE_ROWS && (
          <div className="text-center mt-4">
            <button
              onClick={() => setShowAll(true)}
              className="px-6 py-2 text-xs font-mono text-accent-green border border-accent-green/30 rounded-lg hover:bg-accent-green/10 transition-colors"
            >
              Show all {sorted.length} configs
            </button>
          </div>
        )}
        {showAll && sorted.length > INITIAL_TABLE_ROWS && (
          <div className="text-center mt-4">
            <button
              onClick={() => setShowAll(false)}
              className="px-6 py-2 text-xs font-mono text-muted border border-border rounded-lg hover:text-foreground transition-colors"
            >
              Show top {INITIAL_TABLE_ROWS} only
            </button>
          </div>
        )}
      </div>

      {/* ── Section 4: Price Implications ─────────────────── */}
      <div>
        <h2 className="text-sm font-bold text-foreground uppercase tracking-wider mb-3">
          Price Implications{" "}
          <span className="text-muted font-normal">
            &mdash; slope={selected.slope} zeroPoint={selected.zero_point}
          </span>
        </h2>

        {priceImplications.length === 0 ? (
          <p className="text-xs text-muted font-mono">
            No team Elo data available. Run the pricing engine first.
          </p>
        ) : (
          <div className="border border-border rounded-lg bg-surface overflow-hidden">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="px-3 py-2 text-left">Team</th>
                  <th className="px-3 py-2 text-right">Current Elo</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2 text-right"></th>
                </tr>
              </thead>
              <tbody>
                {priceImplications.map((t) => (
                  <tr
                    key={t.team}
                    className="border-b border-border/50"
                  >
                    <td className="px-3 py-1.5 text-foreground">{t.team}</td>
                    <td className="px-3 py-1.5 text-right text-muted">
                      {Math.round(t.elo)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-accent-green font-bold">
                      ${t.price.toFixed(0)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {t.atFloor && (
                        <span className="text-accent-red text-[10px]">
                          \u26A0\uFE0F AT FLOOR
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[10px] text-muted font-mono mt-2">
          Formula: price = max($10, (elo &minus; {selected.zero_point}) /{" "}
          {selected.slope})
          &middot; Current Elos from latest oracle run
        </p>
      </div>

      {/* ── Footer ────────────────────────────────────────── */}
      <div className="text-center text-[10px] text-muted font-mono py-4 border-t border-border">
        Run {runId} &middot; {results.length} configs &middot;{" "}
        {best.total_teams} teams &middot; {best.total_matches_evaluated}{" "}
        matches
      </div>
    </div>
  );
}
