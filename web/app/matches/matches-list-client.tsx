"use client";

import { useState } from "react";
import type { UpcomingMatch, BookmakerOdds, PolymarketOdds } from "./page";

// ─── Oracle V1.4 Constants ───────────────────────────────────
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

// ─── Oracle V1.4 Price Impact ────────────────────────────────
/** price = (published_index - 800) / 5 */
function indexToPrice(index: number): number {
  return Math.round(((index - 800) / 5) * 100) / 100;
}

interface OutcomeImpact {
  label: string;
  deltaPrice: number;
  pctDelta: number;
}

/**
 * Oracle V1.4 settlement: delta_B = K × (S - E_KR)
 * E_KR = teamWinProb + 0.5 × drawProb
 * S = 1.0 (win), 0.5 (draw), 0.0 (loss)
 */
function computeImpacts(
  teamIndex: number,
  teamPrice: number,
  teamWinProb: number,
  drawProb: number,
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
    const pctDelta = teamPrice > 0 ? Math.round((deltaPrice / teamPrice) * 10000) / 100 : 0;
    results[o.label.toLowerCase()] = { label: o.label, deltaPrice, pctDelta };
  }

  return results as { win: OutcomeImpact; draw: OutcomeImpact; loss: OutcomeImpact };
}

// ─── Helpers ─────────────────────────────────────────────────
function deltaColor(delta: number): string {
  if (Math.abs(delta) < 0.10) return "text-muted";
  return delta > 0 ? "text-accent-green" : "text-accent-red";
}

function deltaArrow(delta: number): string {
  if (Math.abs(delta) < 0.10) return "\u00b7";
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

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

// ─── Components ──────────────────────────────────────────────
function ImpactRow({ label, deltaPrice, pctDelta }: { label: string; deltaPrice: number; pctDelta: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-muted">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className={`text-xs font-mono font-bold tabular-nums ${deltaColor(deltaPrice)}`}>
          {formatDelta(deltaPrice)}
        </span>
        <span className={`text-[10px] font-mono tabular-nums ${deltaColor(deltaPrice)} opacity-60`}>
          {formatPctDelta(pctDelta)}
        </span>
        <span className={`text-[10px] ${deltaColor(deltaPrice)}`}>{deltaArrow(deltaPrice)}</span>
      </div>
    </div>
  );
}

function MatchCard({ match }: { match: UpcomingMatch }) {
  // Oracle V1.4 requires bookmaker odds for settlement — no fallback model
  const hasOdds = match.bookmaker_home_prob !== null;

  const probs = hasOdds
    ? {
        home: match.bookmaker_home_prob!,
        draw: match.bookmaker_draw_prob!,
        away: match.bookmaker_away_prob!,
      }
    : null;

  const homeImpacts = probs
    ? computeImpacts(match.home_index, match.home_price, probs.home, probs.draw)
    : null;
  const awayImpacts = probs
    ? computeImpacts(match.away_index, match.away_price, probs.away, probs.draw)
    : null;

  return (
    <a
      href={`/matches/${match.fixture_id}`}
      className="block border border-border rounded-lg bg-surface hover:bg-surface-hover transition-colors cursor-pointer"
    >
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
                ${match.home_price.toFixed(2)} · Idx {Math.round(match.home_index)}
              </div>
            </div>
            {homeImpacts ? (
              <div className="space-y-1 border-t border-border/30 pt-2">
                <ImpactRow label={`${match.home_team.split(" ").pop()} Win`} deltaPrice={homeImpacts.win.deltaPrice} pctDelta={homeImpacts.win.pctDelta} />
                <ImpactRow label="Draw" deltaPrice={homeImpacts.draw.deltaPrice} pctDelta={homeImpacts.draw.pctDelta} />
                <ImpactRow label={`${match.home_team.split(" ").pop()} Loss`} deltaPrice={homeImpacts.loss.deltaPrice} pctDelta={homeImpacts.loss.pctDelta} />
              </div>
            ) : (
              <div className="text-[10px] text-muted border-t border-border/30 pt-2 italic">
                Awaiting odds
              </div>
            )}
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
                ${match.away_price.toFixed(2)} · Idx {Math.round(match.away_index)}
              </div>
            </div>
            {awayImpacts ? (
              <div className="space-y-1 border-t border-border/30 pt-2">
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[10px] ${deltaColor(awayImpacts.win.deltaPrice)}`}>{deltaArrow(awayImpacts.win.deltaPrice)}</span>
                  <span className={`text-[10px] font-mono tabular-nums ${deltaColor(awayImpacts.win.deltaPrice)} opacity-60`}>
                    {formatPctDelta(awayImpacts.win.pctDelta)}
                  </span>
                  <span className={`text-xs font-mono font-bold tabular-nums ${deltaColor(awayImpacts.win.deltaPrice)}`}>
                    {formatDelta(awayImpacts.win.deltaPrice)}
                  </span>
                  <span className="text-[11px] text-muted">{match.away_team.split(" ").pop()} Win</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[10px] ${deltaColor(awayImpacts.draw.deltaPrice)}`}>{deltaArrow(awayImpacts.draw.deltaPrice)}</span>
                  <span className={`text-[10px] font-mono tabular-nums ${deltaColor(awayImpacts.draw.deltaPrice)} opacity-60`}>
                    {formatPctDelta(awayImpacts.draw.pctDelta)}
                  </span>
                  <span className={`text-xs font-mono font-bold tabular-nums ${deltaColor(awayImpacts.draw.deltaPrice)}`}>
                    {formatDelta(awayImpacts.draw.deltaPrice)}
                  </span>
                  <span className="text-[11px] text-muted">Draw</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[10px] ${deltaColor(awayImpacts.loss.deltaPrice)}`}>{deltaArrow(awayImpacts.loss.deltaPrice)}</span>
                  <span className={`text-[10px] font-mono tabular-nums ${deltaColor(awayImpacts.loss.deltaPrice)} opacity-60`}>
                    {formatPctDelta(awayImpacts.loss.pctDelta)}
                  </span>
                  <span className={`text-xs font-mono font-bold tabular-nums ${deltaColor(awayImpacts.loss.deltaPrice)}`}>
                    {formatDelta(awayImpacts.loss.deltaPrice)}
                  </span>
                  <span className="text-[11px] text-muted">{match.away_team.split(" ").pop()} Loss</span>
                </div>
              </div>
            ) : (
              <div className="text-[10px] text-muted border-t border-border/30 pt-2 italic">
                Awaiting odds
              </div>
            )}
          </div>
        </div>

        {/* Market Data: Bookmaker + Polymarket odds table */}
        {(match.bookmaker_odds || match.polymarket) && (
          <div className="mt-3 pt-2 border-t border-border/30">
            <table className="w-full text-[10px] font-mono">
              <thead>
                <tr className="text-muted">
                  <th className="text-left font-normal pb-1">Source</th>
                  <th className="text-center font-normal pb-1">Home</th>
                  <th className="text-center font-normal pb-1">Draw</th>
                  <th className="text-center font-normal pb-1">Away</th>
                  <th className="text-right font-normal pb-1"></th>
                </tr>
              </thead>
              <tbody>
                {match.bookmaker_odds && (
                  <tr className="text-foreground">
                    <td className="text-left py-0.5">
                      <span className="text-muted">Books</span>
                    </td>
                    <td className="text-center py-0.5 text-accent-green">{match.bookmaker_odds.home.toFixed(2)}</td>
                    <td className="text-center py-0.5 text-accent-amber">{match.bookmaker_odds.draw.toFixed(2)}</td>
                    <td className="text-center py-0.5 text-accent-red">{match.bookmaker_odds.away.toFixed(2)}</td>
                    <td className="text-right py-0.5 text-muted opacity-60">{match.bookmaker_odds.count} books</td>
                  </tr>
                )}
                {match.polymarket && (
                  <tr className="text-foreground">
                    <td className="text-left py-0.5">
                      <span className="text-purple-400">Poly</span>
                    </td>
                    <td className="text-center py-0.5 text-accent-green">{(match.polymarket.homeYes * 100).toFixed(0)}¢</td>
                    <td className="text-center py-0.5 text-accent-amber">{(match.polymarket.drawYes * 100).toFixed(0)}¢</td>
                    <td className="text-center py-0.5 text-accent-red">{(match.polymarket.awayYes * 100).toFixed(0)}¢</td>
                    <td className="text-right py-0.5 text-muted opacity-60">{formatVolume(match.polymarket.volume)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Probability bar */}
        {probs && (
          <div className="mt-2 pt-2 border-t border-border/30">
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
        )}
      </div>
    </a>
  );
}

// ─── Main client component ───────────────────────────────────
export function MatchesListClient({ matches }: { matches: UpcomingMatch[] }) {
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
        <div className="text-2xl mb-3">&#9917;</div>
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
