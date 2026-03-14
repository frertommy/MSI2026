"use client";

import { useState, useMemo } from "react";
import type { CLMatchData } from "./page";

// ─── Constants ───────────────────────────────────────────────
const ORACLE_K = 30;

function deltaColor(delta: number): string {
  if (Math.abs(delta) < 0.10) return "text-muted";
  return delta > 0 ? "text-accent-green" : "text-accent-red";
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

interface OutcomeImpact {
  label: string;
  deltaPrice: number;
}

/**
 * CL settlement: ΔB = K × (S - E_KR), NO gravity
 * E_KR = teamWinProb + 0.5 × drawProb (draw-corrected at freeze time)
 */
function computeImpacts(
  teamIndex: number,
  teamWinProb: number,
  drawProb: number,
): { win: OutcomeImpact; draw: OutcomeImpact; loss: OutcomeImpact } {
  const E_KR_raw = teamWinProb + 0.5 * drawProb;
  // Draw-corrected E_KR (matches what freezeKR now stores)
  const E_KR = E_KR_raw + drawProb * (0.5 - E_KR_raw);

  const indexToPrice = (idx: number) => Math.round(((idx - 800) / 5) * 100) / 100;
  const currentPrice = indexToPrice(teamIndex);

  const results: Record<string, OutcomeImpact> = {};
  for (const { label, S } of [
    { label: "Win", S: 1.0 },
    { label: "Draw", S: 0.5 },
    { label: "Loss", S: 0.0 },
  ]) {
    const delta_B = ORACLE_K * (S - E_KR);
    const newPrice = indexToPrice(teamIndex + delta_B);
    results[label.toLowerCase()] = {
      label,
      deltaPrice: Math.round((newPrice - currentPrice) * 100) / 100,
    };
  }

  return results as { win: OutcomeImpact; draw: OutcomeImpact; loss: OutcomeImpact };
}

// ─── Component ──────────────────────────────────────────────

interface Props {
  matches: CLMatchData[];
}

export function VGlobalMatchesClient({ matches }: Props) {
  const [filter, setFilter] = useState<"all" | "upcoming" | "finished">("all");

  const filtered = useMemo(() => {
    if (filter === "all") return matches;
    return matches.filter(m => m.status === filter);
  }, [matches, filter]);

  // Group by date
  const groupedByDate = useMemo(() => {
    const groups = new Map<string, CLMatchData[]>();
    for (const m of filtered) {
      if (!groups.has(m.date)) groups.set(m.date, []);
      groups.get(m.date)!.push(m);
    }
    return [...groups.entries()].sort((a, b) => {
      // Upcoming first (ascending), then finished (descending)
      if (filter === "finished") return b[0].localeCompare(a[0]);
      return a[0].localeCompare(b[0]);
    });
  }, [filtered, filter]);

  const upcoming = matches.filter(m => m.status === "upcoming").length;
  const finished = matches.filter(m => m.status === "finished").length;

  return (
    <div className="space-y-6">
      {/* Filter tabs */}
      <div className="flex gap-2">
        {(["all", "upcoming", "finished"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 text-xs font-mono uppercase rounded-md transition-colors ${
              filter === f
                ? "bg-amber-400/20 text-amber-400 border border-amber-400/30"
                : "bg-surface text-muted border border-border hover:text-foreground"
            }`}
          >
            {f} {f === "upcoming" ? `(${upcoming})` : f === "finished" ? `(${finished})` : `(${matches.length})`}
          </button>
        ))}
      </div>

      {/* Match cards by date */}
      {groupedByDate.map(([date, dateMatches]) => (
        <div key={date}>
          <div className="text-xs font-mono text-muted uppercase mb-2">
            {formatDate(date)}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {dateMatches.map((m) => (
              <MatchCard key={m.fixture_id} match={m} />
            ))}
          </div>
        </div>
      ))}

      {filtered.length === 0 && (
        <div className="text-center text-muted text-sm font-mono py-12">
          No CL matches found
        </div>
      )}
    </div>
  );
}

// ─── Match Card ─────────────────────────────────────────────

function MatchCard({ match: m }: { match: CLMatchData }) {
  const [expanded, setExpanded] = useState(false);
  const isFinished = m.status === "finished";
  const hasOdds = m.bookmaker_home_prob != null && m.bookmaker_draw_prob != null;
  const hasOracleState = m.home_index > 0 || m.away_index > 0;

  const homeImpacts = hasOdds && hasOracleState
    ? computeImpacts(m.home_index, m.bookmaker_home_prob!, m.bookmaker_draw_prob!)
    : null;
  const awayImpacts = hasOdds && hasOracleState
    ? computeImpacts(m.away_index, m.bookmaker_away_prob!, m.bookmaker_draw_prob!)
    : null;

  return (
    <div
      className={`border rounded-lg p-3 bg-surface transition-colors cursor-pointer ${
        isFinished ? "border-border/50" : "border-amber-400/20"
      }`}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Teams & Score */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex-1">
          <div className="text-sm font-medium text-foreground">{m.home_team}</div>
          <div className="text-sm font-medium text-foreground">{m.away_team}</div>
        </div>
        <div className="text-center min-w-[60px]">
          {isFinished ? (
            <div className="text-lg font-bold text-foreground font-mono">{m.score}</div>
          ) : (
            <div className="text-xs text-muted font-mono">
              {m.commence_time
                ? new Date(m.commence_time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
                : "TBD"}
            </div>
          )}
        </div>
      </div>

      {/* Prices */}
      {hasOracleState && (
        <div className="flex items-center justify-between text-xs font-mono mb-2">
          <span className="text-muted">
            ${m.home_price.toFixed(2)}
          </span>
          <span className="text-muted/40">price</span>
          <span className="text-muted">
            ${m.away_price.toFixed(2)}
          </span>
        </div>
      )}

      {/* Settlement deltas (finished) */}
      {isFinished && (m.home_delta_B != null || m.away_delta_B != null) && (
        <div className="flex items-center justify-between text-xs font-mono">
          <span className={deltaColor(m.home_delta_B ?? 0)}>
            {m.home_delta_B != null
              ? `ΔB ${m.home_delta_B > 0 ? "+" : ""}${m.home_delta_B.toFixed(1)}`
              : "—"}
          </span>
          <span className="text-amber-400/40">settled</span>
          <span className={deltaColor(m.away_delta_B ?? 0)}>
            {m.away_delta_B != null
              ? `ΔB ${m.away_delta_B > 0 ? "+" : ""}${m.away_delta_B.toFixed(1)}`
              : "—"}
          </span>
        </div>
      )}

      {/* Odds & Impact predictions (upcoming, expanded) */}
      {!isFinished && hasOdds && expanded && (
        <div className="mt-3 pt-3 border-t border-border/30 space-y-2">
          <div className="text-[10px] text-muted uppercase mb-1">
            Price Impact Prediction (γ=0, {m.bookmaker_count} books)
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono text-muted">
            <span>Odds: H {(m.bookmaker_home_prob! * 100).toFixed(0)}%</span>
            <span>D {(m.bookmaker_draw_prob! * 100).toFixed(0)}%</span>
            <span>A {((m.bookmaker_away_prob ?? 0) * 100).toFixed(0)}%</span>
          </div>

          {homeImpacts && (
            <div className="text-xs font-mono">
              <span className="text-muted mr-2">{m.home_team}:</span>
              <span className="text-accent-green">W {homeImpacts.win.deltaPrice > 0 ? "+" : ""}{homeImpacts.win.deltaPrice.toFixed(2)}</span>
              <span className="text-muted mx-1">·</span>
              <span className="text-amber-400">D {homeImpacts.draw.deltaPrice > 0 ? "+" : ""}{homeImpacts.draw.deltaPrice.toFixed(2)}</span>
              <span className="text-muted mx-1">·</span>
              <span className="text-accent-red">L {homeImpacts.loss.deltaPrice > 0 ? "+" : ""}{homeImpacts.loss.deltaPrice.toFixed(2)}</span>
            </div>
          )}
          {awayImpacts && (
            <div className="text-xs font-mono">
              <span className="text-muted mr-2">{m.away_team}:</span>
              <span className="text-accent-green">W {awayImpacts.win.deltaPrice > 0 ? "+" : ""}{awayImpacts.win.deltaPrice.toFixed(2)}</span>
              <span className="text-muted mx-1">·</span>
              <span className="text-amber-400">D {awayImpacts.draw.deltaPrice > 0 ? "+" : ""}{awayImpacts.draw.deltaPrice.toFixed(2)}</span>
              <span className="text-muted mx-1">·</span>
              <span className="text-accent-red">L {awayImpacts.loss.deltaPrice > 0 ? "+" : ""}{awayImpacts.loss.deltaPrice.toFixed(2)}</span>
            </div>
          )}
        </div>
      )}

      {/* Expand hint */}
      {!isFinished && hasOdds && !expanded && (
        <div className="text-[10px] text-muted/40 font-mono mt-1 text-center">
          click to expand impact predictions
        </div>
      )}
    </div>
  );
}
