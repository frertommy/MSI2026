import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY, BATCH_SIZE } from "../config.js";
import { log } from "../logger.js";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return client;
}

export async function upsertBatched(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string
): Promise<{ inserted: number; failed: number }> {
  const sb = getSupabase();
  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from(table)
      .upsert(batch, { onConflict, ignoreDuplicates: false });

    if (error) {
      log.error(`${table} batch ${Math.floor(i / BATCH_SIZE) + 1} error`, error.message);
      failed += batch.length;
    } else {
      inserted += batch.length;
    }
  }

  return { inserted, failed };
}

/**
 * Paginated select from a Supabase table.
 * Returns all rows matching the query.
 */
export async function fetchAllRows<T extends Record<string, unknown>>(
  table: string,
  select: string,
  filters?: { column: string; value: unknown }[],
  orderBy?: { column: string; ascending: boolean }
): Promise<T[]> {
  const sb = getSupabase();
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    let query = sb.from(table).select(select).range(from, from + pageSize - 1);

    if (filters) {
      for (const f of filters) {
        query = query.eq(f.column, f.value);
      }
    }
    if (orderBy) {
      query = query.order(orderBy.column, { ascending: orderBy.ascending });
    }

    const { data, error } = await query;

    if (error) {
      log.error(`fetchAllRows ${table} error`, error.message);
      break;
    }
    if (!data || data.length === 0) break;

    all.push(...(data as unknown as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return all;
}
