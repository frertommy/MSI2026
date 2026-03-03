"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { TeamRow } from "@/lib/types";

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

function priceColor(price: number | null): string {
  if (price === null) return "text-muted";
  if (price >= 65) return "text-accent-green";
  if (price >= 45) return "text-accent-amber";
  return "text-accent-red";
}

function eloColor(elo: number | null): string {
  if (elo === null) return "text-muted";
  if (elo >= 1600) return "text-accent-green";
  if (elo >= 1450) return "text-accent-amber";
  return "text-accent-red";
}

function wdlBar(w: number, d: number, l: number) {
  const total = w + d + l;
  if (total === 0) return null;
  const wPct = (w / total) * 100;
  const dPct = (d / total) * 100;
  return (
    <div className="flex h-1.5 w-16 overflow-hidden rounded-full bg-border">
      <div className="bg-accent-green" style={{ width: `${wPct}%` }} />
      <div className="bg-accent-amber" style={{ width: `${dPct}%` }} />
      <div className="bg-accent-red flex-1" />
    </div>
  );
}

export function TeamTable({
  teams,
  leagues,
}: {
  teams: TeamRow[];
  leagues: string[];
}) {
  const router = useRouter();
  const [activeLeague, setActiveLeague] = useState<string>("All");

  const filtered =
    activeLeague === "All"
      ? teams
      : teams.filter((t) => t.league === activeLeague);

  // Re-rank filtered list
  const ranked = filtered.map((t, i) => ({ ...t, rank: i + 1 }));

  return (
    <div>
      {/* League filter bar */}
      <div className="mb-6 flex flex-wrap gap-2">
        <button
          onClick={() => setActiveLeague("All")}
          className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded border transition-all ${
            activeLeague === "All"
              ? "bg-foreground text-background border-foreground"
              : "bg-transparent text-muted border-border hover:border-muted hover:text-foreground"
          }`}
        >
          All ({teams.length})
        </button>
        {leagues.map((league) => {
          const count = teams.filter((t) => t.league === league).length;
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

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted uppercase tracking-wider">
              <th className="py-2 pr-3 text-right w-10">#</th>
              <th className="py-2 px-3 text-left">Team</th>
              <th className="py-2 px-3 text-left w-16">League</th>
              <th className="py-2 px-3 text-right w-16">Elo</th>
              <th className="py-2 px-3 text-right w-20">Price</th>
              <th className="py-2 px-3 text-right w-10">P</th>
              <th className="py-2 px-3 text-center w-24">W-D-L</th>
              <th className="py-2 px-3 text-center w-16">Form</th>
              <th className="py-2 px-3 text-right w-24">Latest</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((t) => (
              <tr
                key={t.team}
                onClick={() => router.push(`/compare?team=${encodeURIComponent(t.team)}`)}
                className="border-b border-border/50 hover:bg-surface-hover cursor-pointer transition-colors group"
              >
                <td className="py-2 pr-3 text-right font-mono text-muted">
                  {t.rank}
                </td>
                <td className="py-2 px-3 text-left font-semibold text-foreground group-hover:text-accent-green transition-colors">
                  {t.team}
                </td>
                <td
                  className={`py-2 px-3 text-left text-xs font-bold ${
                    LEAGUE_COLOR[t.league] || "text-muted"
                  }`}
                >
                  {LEAGUE_SHORT[t.league] || t.league}
                </td>
                <td
                  className={`py-2 px-3 text-right font-mono font-bold ${eloColor(
                    t.impliedElo
                  )}`}
                >
                  {t.impliedElo !== null
                    ? Math.round(t.impliedElo)
                    : "---"}
                </td>
                <td
                  className={`py-2 px-3 text-right font-mono font-bold ${priceColor(
                    t.dollarPrice
                  )}`}
                >
                  {t.dollarPrice !== null
                    ? `$${t.dollarPrice.toFixed(2)}`
                    : "---"}
                </td>
                <td className="py-2 px-3 text-right font-mono text-muted">
                  {t.played}
                </td>
                <td className="py-2 px-3 text-center font-mono">
                  <span className="text-accent-green">{t.wins}</span>
                  <span className="text-muted">-</span>
                  <span className="text-accent-amber">{t.draws}</span>
                  <span className="text-muted">-</span>
                  <span className="text-accent-red">{t.losses}</span>
                </td>
                <td className="py-2 px-3 flex items-center justify-center">
                  {wdlBar(t.wins, t.draws, t.losses)}
                </td>
                <td className="py-2 px-3 text-right font-mono text-xs text-muted">
                  {t.latestDate}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {ranked.length === 0 && (
        <div className="mt-8 text-center text-muted text-sm py-12 border border-border rounded">
          No teams found for this filter.
        </div>
      )}
    </div>
  );
}
