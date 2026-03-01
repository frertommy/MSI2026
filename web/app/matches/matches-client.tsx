"use client";

import { useState } from "react";
import type { UpcomingMatch } from "./page";

// ─── Constants ───────────────────────────────────────────────
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

// ─── Price impact calculation ────────────────────────────────
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
  isHome: boolean,
  teamWinProb: number,
  drawProb: number,
  teamLossProb: number
): { win: OutcomeImpact; draw: OutcomeImpact; loss: OutcomeImpact } {
  // Server uses 0/1/3 points scale (not Elo 0/0.5/1):
  //   actual:   win=3, draw=1, loss=0
  //   expected: 3*winProb + 1*drawProb + 0*lossProb
  const expected = 3 * teamWinProb + 1 * drawProb + 0 * teamLossProb;

  // Effective K (opponent-weighted)
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
    const pctDelta = teamPrice > 0 ? Math.round((delta / teamPrice) * 10000) / 100 : 0;
    results[o.label.toLowerCase()] = { label: o.label, delta, pctDelta };
  }

  return results as { win: OutcomeImpact; draw: OutcomeImpact; loss: OutcomeImpact };
}

function computeModelProbs(homeElo: number, awayElo: number): { home: number; draw: number; away: number } {
  // Implied home win probability from Elo (with home advantage)
  const homeExpected = 1 / (1 + Math.pow(10, (awayElo - homeElo - HOME_ADVANTAGE) / 400));
  // Simple draw estimate: higher when teams are close in strength
  const eloDiff = Math.abs(homeElo - awayElo);
  const drawBase = 0.26 - (eloDiff / 3000);
  const drawProb = Math.max(0.10, Math.min(0.32, drawBase));

  const homeProb = homeExpected * (1 - drawProb);
  const awayProb = (1 - homeExpected) * (1 - drawProb);

  return { home: homeProb, draw: drawProb, away: awayProb };
}

// ─── Helpers ─────────────────────────────────────────────────
function deltaColor(delta: number): string {
  if (Math.abs(delta) < 0.10) return "text-muted";
  return delta > 0 ? "text-accent-green" : "text-accent-red";
}

function deltaArrow(delta: number): string {
  if (Math.abs(delta) < 0.10) return "·";
  return delta > 0 ? "↑" : "↓";
}

function formatDelta(delta: number): string {
  const prefix = delta > 0 ? "+" : "";
  return `${prefix}$${delta.toFixed(2)}`;
}

function formatPctDelta(pct: number): string {
  const prefix = pct > 0 ? "+" : "";
  return `${prefix}${pct.toFixed(1)}%`;
}

function formatPct(prob: number): string {
  return `${(prob * 100).toFixed(0)}%`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ─── Components ──────────────────────────────────────────────
function ImpactRow({ label, delta, pctDelta }: { label: string; delta: number; pctDelta: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-muted">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className={`text-xs font-mono font-bold tabular-nums ${deltaColor(delta)}`}>
          {formatDelta(delta)}
        </span>
        <span className={`text-[10px] font-mono tabular-nums ${deltaColor(delta)} opacity-60`}>
          {formatPctDelta(pctDelta)}
        </span>
        <span className={`text-[10px] ${deltaColor(delta)}`}>{deltaArrow(delta)}</span>
      </div>
    </div>
  );
}

function MatchCard({ match }: { match: UpcomingMatch }) {
  const modelProbs = computeModelProbs(match.home_elo, match.away_elo);

  // Use bookmaker probabilities if available, else Elo-derived model probs
  const probs = match.bookmaker_home_prob !== null
    ? {
        home: match.bookmaker_home_prob!,
        draw: match.bookmaker_draw_prob!,
        away: match.bookmaker_away_prob!,
      }
    : modelProbs;

  const homeImpacts = computeImpacts(
    match.home_elo,
    match.away_elo,
    match.home_price,
    match.league_mean_elo,
    true,
    probs.home,
    probs.draw,
    probs.away
  );
  const awayImpacts = computeImpacts(
    match.away_elo,
    match.home_elo,
    match.away_price,
    match.league_mean_elo,
    false,
    probs.away,
    probs.draw,
    probs.home
  );

  const probSource = match.bookmaker_home_prob !== null ? "odds" : "elo";

  return (
    <div className="border border-border rounded-lg bg-surface hover:bg-surface-hover transition-colors">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/50">
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${
              LEAGUE_COLOR[match.league] || "text-muted"
            } ${LEAGUE_BG[match.league] || "bg-muted/10 border-muted/20"}`}
          >
            {LEAGUE_SHORT[match.league] || match.league}
          </span>
        </div>
        <span className="text-[10px] text-muted font-mono">{match.date}</span>
      </div>

      {/* Teams + Price impacts */}
      <div className="px-4 py-3">
        <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-start">
          {/* Home team */}
          <div className="space-y-2">
            <div>
              <div className="text-sm font-bold text-foreground truncate">{match.home_team}</div>
              <div className="text-[11px] text-muted font-mono">
                ${match.home_price.toFixed(2)} · Elo {Math.round(match.home_elo)}
              </div>
            </div>
            <div className="space-y-1 border-t border-border/30 pt-2">
              <ImpactRow label={`${match.home_team.split(" ").pop()} Win`} delta={homeImpacts.win.delta} pctDelta={homeImpacts.win.pctDelta} />
              <ImpactRow label="Draw" delta={homeImpacts.draw.delta} pctDelta={homeImpacts.draw.pctDelta} />
              <ImpactRow label={`${match.home_team.split(" ").pop()} Loss`} delta={homeImpacts.loss.delta} pctDelta={homeImpacts.loss.pctDelta} />
            </div>
          </div>

          {/* VS divider */}
          <div className="flex flex-col items-center justify-center pt-1 gap-2">
            <span className="text-xs font-bold text-muted tracking-wider">VS</span>
          </div>

          {/* Away team */}
          <div className="space-y-2 text-right">
            <div>
              <div className="text-sm font-bold text-foreground truncate">{match.away_team}</div>
              <div className="text-[11px] text-muted font-mono">
                ${match.away_price.toFixed(2)} · Elo {Math.round(match.away_elo)}
              </div>
            </div>
            <div className="space-y-1 border-t border-border/30 pt-2">
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[10px] ${deltaColor(awayImpacts.win.delta)}`}>{deltaArrow(awayImpacts.win.delta)}</span>
                <span className={`text-[10px] font-mono tabular-nums ${deltaColor(awayImpacts.win.delta)} opacity-60`}>
                  {formatPctDelta(awayImpacts.win.pctDelta)}
                </span>
                <span className={`text-xs font-mono font-bold tabular-nums ${deltaColor(awayImpacts.win.delta)}`}>
                  {formatDelta(awayImpacts.win.delta)}
                </span>
                <span className="text-[11px] text-muted">{match.away_team.split(" ").pop()} Win</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[10px] ${deltaColor(awayImpacts.draw.delta)}`}>{deltaArrow(awayImpacts.draw.delta)}</span>
                <span className={`text-[10px] font-mono tabular-nums ${deltaColor(awayImpacts.draw.delta)} opacity-60`}>
                  {formatPctDelta(awayImpacts.draw.pctDelta)}
                </span>
                <span className={`text-xs font-mono font-bold tabular-nums ${deltaColor(awayImpacts.draw.delta)}`}>
                  {formatDelta(awayImpacts.draw.delta)}
                </span>
                <span className="text-[11px] text-muted">Draw</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[10px] ${deltaColor(awayImpacts.loss.delta)}`}>{deltaArrow(awayImpacts.loss.delta)}</span>
                <span className={`text-[10px] font-mono tabular-nums ${deltaColor(awayImpacts.loss.delta)} opacity-60`}>
                  {formatPctDelta(awayImpacts.loss.pctDelta)}
                </span>
                <span className={`text-xs font-mono font-bold tabular-nums ${deltaColor(awayImpacts.loss.delta)}`}>
                  {formatDelta(awayImpacts.loss.delta)}
                </span>
                <span className="text-[11px] text-muted">{match.away_team.split(" ").pop()} Loss</span>
              </div>
            </div>
          </div>
        </div>

        {/* Probability bar */}
        <div className="mt-3 pt-2 border-t border-border/30">
          <div className="flex items-center gap-2 text-[10px] text-muted font-mono mb-1.5">
            <span>Match Probabilities</span>
            <span className="text-[9px] opacity-60">({probSource})</span>
          </div>
          <div className="flex h-2 w-full overflow-hidden rounded-full">
            <div
              className="bg-accent-green transition-all"
              style={{ width: `${probs.home * 100}%` }}
              title={`Home: ${formatPct(probs.home)}`}
            />
            <div
              className="bg-accent-amber transition-all"
              style={{ width: `${probs.draw * 100}%` }}
              title={`Draw: ${formatPct(probs.draw)}`}
            />
            <div
              className="bg-accent-red transition-all"
              style={{ width: `${probs.away * 100}%` }}
              title={`Away: ${formatPct(probs.away)}`}
            />
          </div>
          <div className="flex justify-between mt-1 text-[10px] font-mono">
            <span className="text-accent-green">{formatPct(probs.home)}</span>
            <span className="text-accent-amber">{formatPct(probs.draw)}</span>
            <span className="text-accent-red">{formatPct(probs.away)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main client component ───────────────────────────────────
export function MatchesClient({ matches }: { matches: UpcomingMatch[] }) {
  const leagues = [...new Set(matches.map(m => m.league))].sort();
  const [activeLeague, setActiveLeague] = useState<string>("All");

  const filtered = activeLeague === "All"
    ? matches
    : matches.filter(m => m.league === activeLeague);

  // Group by date
  const grouped = new Map<string, UpcomingMatch[]>();
  for (const m of filtered) {
    if (!grouped.has(m.date)) grouped.set(m.date, []);
    grouped.get(m.date)!.push(m);
  }

  const sortedDates = [...grouped.keys()].sort();

  if (matches.length === 0) {
    return (
      <div className="mt-12 text-center text-muted text-sm py-16 border border-border rounded-lg">
        <div className="text-2xl mb-3">⚽</div>
        <div className="font-bold uppercase tracking-wider mb-1">No upcoming matches</div>
        <div className="text-xs">Check back on match day</div>
      </div>
    );
  }

  return (
    <div>
      {/* League filter */}
      <div className="mb-6 flex flex-wrap gap-2">
        <button
          onClick={() => setActiveLeague("All")}
          className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded border transition-all ${
            activeLeague === "All"
              ? "bg-foreground text-background border-foreground"
              : "bg-transparent text-muted border-border hover:border-muted hover:text-foreground"
          }`}
        >
          All ({matches.length})
        </button>
        {leagues.map(league => {
          const count = matches.filter(m => m.league === league).length;
          return (
            <button
              key={league}
              onClick={() => setActiveLeague(league)}
              className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded border transition-all ${
                activeLeague === league
                  ? "bg-foreground text-background border-foreground"
                  : "bg-transparent text-muted border-border hover:border-muted hover:text-foreground"
              }`}
            >
              {LEAGUE_SHORT[league] || league} ({count})
            </button>
          );
        })}
      </div>

      {/* Formula info */}
      <div className="mb-6 px-3 py-2 border border-border/50 rounded text-[10px] text-muted font-mono">
        Price impact = logistic(Elo ± K<sub>eff</sub> × surprise) where K<sub>eff</sub> = 20 × (1 + (opp_elo − league_mean) / 400)
      </div>

      {/* Match groups */}
      <div className="space-y-8">
        {sortedDates.map(date => {
          const dateMatches = grouped.get(date)!;
          return (
            <div key={date}>
              <h2 className="text-sm font-bold text-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                <div className="h-1.5 w-1.5 rounded-full bg-accent-green" />
                {formatDate(date)}
                <span className="text-muted font-normal text-xs">
                  · {dateMatches.length} {dateMatches.length === 1 ? "match" : "matches"}
                </span>
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {dateMatches.map(match => (
                  <MatchCard key={`${match.fixture_id}-${match.home_team}`} match={match} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
