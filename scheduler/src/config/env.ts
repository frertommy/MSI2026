export const ODDS_API_KEY = process.env.ODDS_API_KEY ?? "";
export const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
export const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
export const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";
export const PORT = parseInt(process.env.PORT ?? "3000", 10);
export const BATCH_SIZE = 500;

export function validateEnv(): void {
  const missing: string[] = [];
  if (!ODDS_API_KEY) { missing.push("ODDS_API_KEY"); }
  if (!SUPABASE_URL) { missing.push("SUPABASE_URL"); }
  if (!SUPABASE_KEY) { missing.push("SUPABASE_KEY"); }
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}
