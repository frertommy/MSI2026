import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ─── Batched .in() helper ────────────────────────────────────
// Supabase silently truncates results at 1000 rows per request.
// Use this for any .in() query where each ID may return multiple rows
// (e.g. latest_odds has ~25 rows per fixture_id).
//
// It splits IDs into small batches and collects all results.
export async function batchedIn<T>(
  table: string,
  select: string,
  inColumn: string,
  ids: (string | number)[],
  opts?: {
    filters?: { column: string; op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; value: string | number | boolean }[];
    order?: { column: string; ascending?: boolean };
    batchSize?: number; // default 10
  }
): Promise<T[]> {
  if (ids.length === 0) return [];
  const batchSize = opts?.batchSize ?? 10;
  const all: T[] = [];

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    let q = supabase.from(table).select(select).in(inColumn, batch);
    if (opts?.filters) {
      for (const f of opts.filters) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        q = (q as any)[f.op](f.column, f.value);
      }
    }
    if (opts?.order) {
      q = q.order(opts.order.column, { ascending: opts.order.ascending ?? true });
    }
    const { data, error } = await q;
    if (error) { console.error(`batchedIn ${table} error:`, error.message); continue; }
    if (data) all.push(...(data as T[]));
  }
  return all;
}
