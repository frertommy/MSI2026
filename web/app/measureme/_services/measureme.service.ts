import { supabase } from '@/lib/supabase';
import type { MeasureMeRow, TeamEloRow } from '../_types';

export async function fetchMeasureMeData(): Promise<{
  rows: MeasureMeRow[];
  runId: string | null;
  teamElos: TeamEloRow[];
}> {
  const { data: latestRun } = await supabase
    .from('measureme_results')
    .select('run_id')
    .order('created_at', { ascending: false })
    .limit(1);

  const runId = latestRun?.[0]?.run_id ?? null;
  if (!runId) { return { rows: [], runId: null, teamElos: [] }; }

  const allRows: MeasureMeRow[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('measureme_results')
      .select('*')
      .eq('run_id', runId)
      .order('composite_score', { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) { console.error('measureme fetch error:', error.message); break; }
    if (!data || data.length === 0) { break; }
    allRows.push(...(data as MeasureMeRow[]));
    if (data.length < pageSize) { break; }
    from += pageSize;
  }

  let teamElos: TeamEloRow[] = [];
  const { data: latestDate } = await supabase
    .from('team_prices')
    .select('date')
    .eq('model', 'oracle')
    .order('date', { ascending: false })
    .limit(1);

  if (latestDate?.[0]?.date) {
    const { data: eloData } = await supabase
      .from('team_prices')
      .select('team, implied_elo')
      .eq('model', 'oracle')
      .eq('date', latestDate[0].date)
      .order('implied_elo', { ascending: false });
    teamElos = (eloData ?? []) as TeamEloRow[];
  }

  return { rows: allRows, runId, teamElos };
}
