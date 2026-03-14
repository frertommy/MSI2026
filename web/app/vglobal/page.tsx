/**
 * vGlobal Rankings — Champions League Impact on Team Prices
 *
 * Shows all teams that participate in Champions League,
 * their current Oracle V3 state, and CL-specific settlement history.
 * The oracle state is SHARED with league — vGlobal is a filtered VIEW.
 */

import { supabase } from "@/lib/supabase";
import { VGlobalClient } from "./vglobal-client";

// ─── Types (shared with client) ─────────────────────────────
export interface TeamOracleRow {
  team_id: string;
  season: string | null;
  B_value: number;
  M1_value: number;
  published_index: number;
  confidence_score: number | null;
  bt_std_error: number | null;
  updated_at: string;
}

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

export interface CLMatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
  status: string;
  commence_time: string | null;
}

export const dynamic = "force-dynamic";

// ─── Paginated fetch ────────────────────────────────────────
async function fetchAll<T>(
  table: string,
  select: string,
  filters?: { column: string; value: string }[],
  orderCol?: string,
  ascending = true
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (filters) {
      for (const f of filters) q = q.eq(f.column, f.value);
    }
    if (orderCol) q = q.order(orderCol, { ascending });
    const { data, error } = await q;
    if (error) { console.error(`${table} fetch error:`, error.message); break; }
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ─── Server component ──────────────────────────────────────
export default async function VGlobalPage() {
  // Fetch all V3 team states
  const teamStatesPromise = fetchAll<TeamOracleRow>(
    "team_oracle_v3_state",
    "team_id, season, B_value:b_value, M1_value:m1_value, published_index, confidence_score, bt_std_error, updated_at"
  );

  // Fetch CL-only settlements
  const clSettlementsPromise = fetchAll<CLSettlementRow>(
    "settlement_log",
    "settlement_id, fixture_id, team_id, E_KR:e_kr, actual_score_S:actual_score_s, delta_B:delta_b, B_before:b_before, B_after:b_after, settled_at, gravity_component",
    [{ column: "oracle_version", value: "v3" }, { column: "competition", value: "champions_league" }],
    "settled_at",
    false
  );

  // Fetch CL matches
  const clMatchesPromise = fetchAll<CLMatchRow>(
    "matches",
    "fixture_id, date, league, home_team, away_team, score, status, commence_time",
    [{ column: "league", value: "Champions League" }],
    "date",
    true
  );

  const [teamStates, clSettlements, clMatches] = await Promise.all([
    teamStatesPromise,
    clSettlementsPromise,
    clMatchesPromise,
  ]);

  // Find CL team IDs (teams appearing in any CL fixture)
  const clTeamIds = new Set<string>();
  for (const m of clMatches) {
    clTeamIds.add(m.home_team);
    clTeamIds.add(m.away_team);
  }
  // Also include teams that have CL settlements
  for (const s of clSettlements) {
    clTeamIds.add(s.team_id);
  }

  // Filter team states to only CL participants that have oracle state
  const clTeamStates = teamStates.filter(t => clTeamIds.has(t.team_id));
  const validSettlements = clSettlements.filter(s => !(Number(s.delta_B) === 0 && Number(s.B_before) === 0));

  // Build team→domestic league map by finding each team's most recent domestic match
  const teamLeagueMap: Record<string, string> = {};
  for (const teamId of clTeamIds) {
    const { data } = await supabase
      .from("matches")
      .select("league")
      .or(`home_team.eq.${teamId},away_team.eq.${teamId}`)
      .neq("league", "Champions League")
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.league) teamLeagueMap[teamId] = data.league;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto max-w-7xl flex items-center gap-4">
          <div className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
          <h1 className="text-lg font-bold tracking-wider text-foreground uppercase">
            vGlobal
          </h1>
          <span className="text-xs text-amber-400 font-mono">
            Champions League &middot; &gamma;=0
          </span>
          <span className="text-xs text-muted font-mono ml-auto">
            {clTeamStates.length} CL teams &middot; {validSettlements.length} CL settlements
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        {clTeamStates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="text-muted text-sm font-mono mb-2">
              No Champions League data yet
            </div>
            <div className="text-muted/60 text-xs font-mono max-w-md">
              CL fixtures will appear once odds polling and match tracking pick up
              Champions League events.
            </div>
          </div>
        ) : (
          <VGlobalClient
            teamStates={clTeamStates}
            settlements={validSettlements}
            matches={clMatches}
            teamLeagueMap={teamLeagueMap}
          />
        )}
      </main>
    </div>
  );
}
