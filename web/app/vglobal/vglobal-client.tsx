"use client";

import { useState, useMemo } from "react";
import type { TeamOracleRow, CLSettlementRow, CLMatchRow } from "./page";

// ─── Constants ───────────────────────────────────────────────

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

/** price = (published_index - 800) / 5 */
function indexToPrice(index: number): number {
  return Math.round(((index - 800) / 5) * 100) / 100;
}

function deltaColor(delta: number): string {
  if (Math.abs(delta) < 0.01) return "text-muted";
  return delta > 0 ? "text-accent-green" : "text-accent-red";
}

// ─── Types ──────────────────────────────────────────────────

interface CLTeamRow {
  rank: number;
  team_id: string;
  league: string;
  published_index: number;
  B_value: number;
  M1_value: number;
  confidence_score: number | null;
  cl_delta_sum: number;
  cl_settled_count: number;
  cl_last_delta: number | null;
  cl_last_match: string | null;
}

type SortKey = "published_index" | "B_value" | "cl_delta_sum" | "cl_settled_count";

// ─── Component ──────────────────────────────────────────────

interface Props {
  teamStates: TeamOracleRow[];
  settlements: CLSettlementRow[];
  matches: CLMatchRow[];
  teamLeagueMap: Record<string, string>;
}

export function VGlobalClient({ teamStates, settlements, matches, teamLeagueMap }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("published_index");
  const [sortAsc, setSortAsc] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);

  // Build match fixture lookup
  const matchByFixture = useMemo(() => {
    const map = new Map<number, CLMatchRow>();
    for (const m of matches) map.set(m.fixture_id, m);
    return map;
  }, [matches]);

  // Team → domestic league lookup (provided by server from non-CL matches)
  // No useMemo needed — it's a plain object from props

  // Build CL settlement stats per team
  const clStatsByTeam = useMemo(() => {
    const map = new Map<string, {
      deltaSum: number;
      count: number;
      lastDelta: number | null;
      lastMatch: string | null;
      settlements: CLSettlementRow[];
    }>();

    // Sort by settled_at to find latest
    const sorted = [...settlements].sort(
      (a, b) => new Date(a.settled_at).getTime() - new Date(b.settled_at).getTime()
    );

    for (const s of sorted) {
      if (!map.has(s.team_id)) {
        map.set(s.team_id, { deltaSum: 0, count: 0, lastDelta: null, lastMatch: null, settlements: [] });
      }
      const entry = map.get(s.team_id)!;
      entry.deltaSum += Number(s.delta_B);
      entry.count++;
      entry.lastDelta = Number(s.delta_B);
      const m = matchByFixture.get(s.fixture_id);
      entry.lastMatch = m ? `${m.home_team} vs ${m.away_team}` : null;
      entry.settlements.push(s);
    }

    return map;
  }, [settlements, matchByFixture]);

  // Build table rows
  const tableRows = useMemo(() => {
    const rows: CLTeamRow[] = teamStates.map((t) => {
      const clStats = clStatsByTeam.get(t.team_id);

      // Domestic league from server-provided map
      const league = teamLeagueMap[t.team_id] ?? "Unknown";

      return {
        rank: 0,
        team_id: t.team_id,
        league,
        published_index: Number(t.published_index),
        B_value: Number(t.B_value),
        M1_value: Number(t.M1_value),
        confidence_score: t.confidence_score ? Number(t.confidence_score) : null,
        cl_delta_sum: clStats?.deltaSum ?? 0,
        cl_settled_count: clStats?.count ?? 0,
        cl_last_delta: clStats?.lastDelta ?? null,
        cl_last_match: clStats?.lastMatch ?? null,
      };
    });

    // Sort
    rows.sort((a, b) => {
      const va = a[sortKey] ?? 0;
      const vb = b[sortKey] ?? 0;
      return sortAsc ? (va as number) - (vb as number) : (vb as number) - (va as number);
    });

    rows.forEach((r, i) => (r.rank = i + 1));
    return rows;
  }, [teamStates, clStatsByTeam, teamLeagueMap, sortKey, sortAsc]);

  // Summary stats
  const totalCLDelta = useMemo(
    () => settlements.reduce((sum, s) => sum + Number(s.delta_B), 0),
    [settlements]
  );

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  };

  const sortIcon = (key: SortKey) =>
    sortKey === key ? (sortAsc ? " ▲" : " ▼") : "";

  // Selected team detail
  const selectedSettlements = useMemo(() => {
    if (!selectedTeam) return [];
    return (clStatsByTeam.get(selectedTeam)?.settlements ?? [])
      .sort((a, b) => new Date(b.settled_at).getTime() - new Date(a.settled_at).getTime());
  }, [selectedTeam, clStatsByTeam]);

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="border border-border rounded-lg p-3 bg-surface">
          <div className="text-[10px] font-mono text-muted uppercase">CL Teams</div>
          <div className="text-lg font-bold text-foreground">{tableRows.length}</div>
        </div>
        <div className="border border-border rounded-lg p-3 bg-surface">
          <div className="text-[10px] font-mono text-muted uppercase">CL Settlements</div>
          <div className="text-lg font-bold text-foreground">{settlements.length}</div>
        </div>
        <div className="border border-border rounded-lg p-3 bg-surface">
          <div className="text-[10px] font-mono text-muted uppercase">CL Matches</div>
          <div className="text-lg font-bold text-foreground">{matches.length}</div>
        </div>
        <div className="border border-border rounded-lg p-3 bg-surface">
          <div className="text-[10px] font-mono text-muted uppercase">Net CL ΔB</div>
          <div className={`text-lg font-bold ${deltaColor(totalCLDelta)}`}>
            {totalCLDelta > 0 ? "+" : ""}{totalCLDelta.toFixed(1)}
          </div>
        </div>
      </div>

      {/* Main table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="bg-surface border-b border-border text-muted uppercase">
              <th className="px-3 py-2 text-left w-8">#</th>
              <th className="px-3 py-2 text-left">Team</th>
              <th className="px-3 py-2 text-left">League</th>
              <th
                className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                onClick={() => handleSort("published_index")}
              >
                Price{sortIcon("published_index")}
              </th>
              <th
                className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                onClick={() => handleSort("B_value")}
              >
                B{sortIcon("B_value")}
              </th>
              <th className="px-3 py-2 text-right">M1</th>
              <th
                className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                onClick={() => handleSort("cl_delta_sum")}
              >
                CL ΔB{sortIcon("cl_delta_sum")}
              </th>
              <th
                className="px-3 py-2 text-right cursor-pointer hover:text-foreground"
                onClick={() => handleSort("cl_settled_count")}
              >
                CL Settled{sortIcon("cl_settled_count")}
              </th>
              <th className="px-3 py-2 text-right">Last CL ΔB</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((row) => (
              <tr
                key={row.team_id}
                className={`border-b border-border/50 hover:bg-surface-hover cursor-pointer transition-colors ${
                  selectedTeam === row.team_id ? "bg-amber-400/5" : ""
                }`}
                onClick={() =>
                  setSelectedTeam(selectedTeam === row.team_id ? null : row.team_id)
                }
              >
                <td className="px-3 py-2 text-muted">{row.rank}</td>
                <td className="px-3 py-2 text-foreground font-medium">{row.team_id}</td>
                <td className={`px-3 py-2 ${LEAGUE_COLOR[row.league] ?? "text-muted"}`}>
                  {LEAGUE_SHORT[row.league] ?? row.league}
                </td>
                <td className="px-3 py-2 text-right text-foreground">
                  ${indexToPrice(row.published_index).toFixed(2)}
                </td>
                <td className="px-3 py-2 text-right text-muted">
                  {row.B_value.toFixed(0)}
                </td>
                <td className="px-3 py-2 text-right text-muted">
                  {row.M1_value > 0 ? "+" : ""}{row.M1_value.toFixed(0)}
                </td>
                <td className={`px-3 py-2 text-right font-medium ${deltaColor(row.cl_delta_sum)}`}>
                  {row.cl_settled_count > 0
                    ? `${row.cl_delta_sum > 0 ? "+" : ""}${row.cl_delta_sum.toFixed(1)}`
                    : "—"}
                </td>
                <td className="px-3 py-2 text-right text-muted">
                  {row.cl_settled_count || "—"}
                </td>
                <td className={`px-3 py-2 text-right ${deltaColor(row.cl_last_delta ?? 0)}`}>
                  {row.cl_last_delta != null
                    ? `${row.cl_last_delta > 0 ? "+" : ""}${row.cl_last_delta.toFixed(1)}`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Settlement detail panel */}
      {selectedTeam && (
        <div className="border border-amber-400/20 rounded-lg p-4 bg-surface">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-2 w-2 rounded-full bg-amber-400" />
            <span className="font-bold text-sm text-foreground">{selectedTeam}</span>
            <span className="text-xs text-amber-400 font-mono">
              CL Settlement History
            </span>
            <button
              onClick={() => setSelectedTeam(null)}
              className="ml-auto text-muted hover:text-foreground text-sm"
            >
              ✕
            </button>
          </div>

          {selectedSettlements.length === 0 ? (
            <div className="text-xs text-muted font-mono py-4 text-center">
              No CL settlements yet for this team
            </div>
          ) : (
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-muted uppercase border-b border-border">
                  <th className="px-2 py-1 text-left">Date</th>
                  <th className="px-2 py-1 text-left">Opponent</th>
                  <th className="px-2 py-1 text-center">Score</th>
                  <th className="px-2 py-1 text-right">E_KR</th>
                  <th className="px-2 py-1 text-right">S</th>
                  <th className="px-2 py-1 text-right">ΔB</th>
                  <th className="px-2 py-1 text-right">B_after</th>
                  <th className="px-2 py-1 text-right">Gravity</th>
                </tr>
              </thead>
              <tbody>
                {selectedSettlements.map((s) => {
                  const m = matchByFixture.get(s.fixture_id);
                  const isHome = m?.home_team === selectedTeam;
                  const opponent = m
                    ? isHome
                      ? m.away_team
                      : m.home_team
                    : `fixture #${s.fixture_id}`;

                  return (
                    <tr key={s.settlement_id} className="border-b border-border/30">
                      <td className="px-2 py-1 text-muted">
                        {m?.date ?? new Date(s.settled_at).toISOString().slice(0, 10)}
                      </td>
                      <td className="px-2 py-1 text-foreground">
                        {isHome ? "vs " : "@ "}{opponent}
                      </td>
                      <td className="px-2 py-1 text-center text-muted">
                        {m?.score ?? "—"}
                      </td>
                      <td className="px-2 py-1 text-right text-muted">
                        {Number(s.E_KR).toFixed(3)}
                      </td>
                      <td className="px-2 py-1 text-right">
                        <span className={
                          Number(s.actual_score_S) === 1 ? "text-accent-green" :
                          Number(s.actual_score_S) === 0 ? "text-accent-red" :
                          "text-amber-400"
                        }>
                          {Number(s.actual_score_S).toFixed(1)}
                        </span>
                      </td>
                      <td className={`px-2 py-1 text-right font-medium ${deltaColor(Number(s.delta_B))}`}>
                        {Number(s.delta_B) > 0 ? "+" : ""}{Number(s.delta_B).toFixed(2)}
                      </td>
                      <td className="px-2 py-1 text-right text-muted">
                        {Number(s.B_after).toFixed(0)}
                      </td>
                      <td className="px-2 py-1 text-right text-muted">
                        {Number(s.gravity_component).toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
