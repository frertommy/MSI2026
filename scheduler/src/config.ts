// ─── Environment ─────────────────────────────────────────────
export const ODDS_API_KEY = process.env.ODDS_API_KEY ?? "";
export const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
export const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
export const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";
export const PORT = parseInt(process.env.PORT ?? "3000", 10);

export function validateEnv(): void {
  const missing: string[] = [];
  if (!ODDS_API_KEY) missing.push("ODDS_API_KEY");
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_KEY) missing.push("SUPABASE_KEY");
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  // API_FOOTBALL_KEY is optional (match tracker degrades gracefully)
}

// ─── League → Odds API sport key mapping ─────────────────────
export const LEAGUE_SPORT_KEYS: Record<string, string> = {
  "Premier League": "soccer_epl",
  "La Liga": "soccer_spain_la_liga",
  Bundesliga: "soccer_germany_bundesliga",
  "Serie A": "soccer_italy_serie_a",
  "Ligue 1": "soccer_france_ligue_one",
};

// ─── League → API-Football league IDs ────────────────────────
export const LEAGUE_IDS: Record<string, number> = {
  "Premier League": 39,
  "La Liga": 140,
  Bundesliga: 78,
  "Serie A": 135,
  "Ligue 1": 61,
};

// ─── Dynamic polling intervals (ms) ─────────────────────────
export const POLL_INTERVALS = {
  NO_MATCHES_TODAY: 120 * 60 * 1000, // 120 min
  FAR_FROM_KICKOFF: 60 * 60 * 1000, //  60 min  (> 3h)
  APPROACHING: 5 * 60 * 1000, //   5 min  (1-3h)
  CLOSE: 2 * 60 * 1000, //   2 min  (15m-1h)
  IMMINENT: 30 * 1000, //  30 sec  (< 15m)
  POST_KICKOFF: 10 * 60 * 1000, //  10 min  (0-2h after)
} as const;

// ─── Credit limits ───────────────────────────────────────────
export const CREDITS_DAILY_SOFT_LIMIT = 450; // reserve 50 for manual
export const CREDITS_PER_LEAGUE_CALL = 3; // h2h + totals + spreads = 3 credits
export const CREDITS_FALLBACK_INTERVAL = 60 * 60 * 1000; // hourly when low

// ─── Pricing engine constants (mirrored from src/compute-prices.ts) ───
export const INITIAL_ELO = 1500;
export const BT_ITERATIONS = 50;
export const WINDOW_DAYS = 60;
export const DECAY_HALF_LIFE = 14;
export const SHOCK_HALF_LIFE = 7;
export const SHOCK_K = 32;
export const ORACLE_SHOCK_K = 20;
export const ORACLE_SHOCK_HALF_LIFE = 10;
export const PRIOR_PULL = 0.15;
export const CARRY_DECAY = 0.005;
export const DOLLAR_SPREAD = 220;
export const ORACLE_WEIGHT = 0.7;
export const BATCH_SIZE = 500;

// ─── Outright futures mapping ─────────────────────────────────
export const OUTRIGHT_SPORT_KEYS: Record<string, string> = {
  "Premier League": "soccer_epl_winner",
  "La Liga": "soccer_spain_la_liga_winner",
  Bundesliga: "soccer_germany_bundesliga_winner",
  "Serie A": "soccer_italy_serie_a_winner",
  "Ligue 1": "soccer_france_ligue_one_winner",
};

// Outright blending disabled — league winner probability creates
// season-end discontinuity incompatible with continuous perp
export const OUTRIGHT_WEIGHT = 0;
export const OUTRIGHT_POLL_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

// ─── EMA fast-response layer ────────────────────────────────
export const EMA_SPAN = 5;                         // 5-day EMA
export const EMA_ALPHA = 2 / (EMA_SPAN + 1);      // ≈ 0.333

// ─── Hourly baseline polling ─────────────────────────────────
export const HOURLY_POLL_INTERVAL = 60 * 60 * 1000; // 1 hour
export const DAILY_CREDIT_SAFETY = 400;              // switch to hourly-only above this

// ─── Polymarket data collection (analytics only, no pricing) ─
export const POLYMARKET_SERIES_IDS: Record<string, string> = {
  "Premier League": "10188",
  "La Liga": "10193",
  Bundesliga: "10194",
  "Serie A": "10203",
  "Ligue 1": "10195",
};
export const POLYMARKET_POLL_INTERVAL = 10 * 60 * 1000; // 10 minutes

// ─── Odds drift signal constants ────────────────────────────
export const DRIFT_SCALE = 400;        // Elo points per 1.0 probability drift
export const DRIFT_MIN_HOURS = 12;     // Min gap between earliest/latest snapshot
export const DRIFT_FADE_DAYS = 7;      // Days-before-kickoff at which drift reaches full weight
