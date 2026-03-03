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

// ─── Pricing engine constants (MeasureMe-validated) ──────────
export const INITIAL_ELO = 1500;
export const WINDOW_DAYS = 60;
export const PRICE_SLOPE = 5;                    // price = max(FLOOR, (elo-ZERO)/SLOPE)
export const PRICE_ZERO = 800;                   // elo zero point for pricing
export const PRICE_FLOOR = 10;                   // minimum dollar price
export const SHOCK_K = 20;                       // flat K-factor for match shocks (xG amplifies)
export const CARRY_DECAY_RATE = 0.001;           // daily decay rate toward 45d MA
export const MA_WINDOW = 45;                     // moving average window for carry anchor
export const LIVE_SHOCK_DISCOUNT = 0.5;           // discount factor for in-play shocks
export const BATCH_SIZE = 500;

// ─── Outright futures mapping (disabled but kept for odds-client) ──
export const OUTRIGHT_SPORT_KEYS: Record<string, string> = {
  "Premier League": "soccer_epl_winner",
  "La Liga": "soccer_spain_la_liga_winner",
  Bundesliga: "soccer_germany_bundesliga_winner",
  "Serie A": "soccer_italy_serie_a_winner",
  "Ligue 1": "soccer_france_ligue_one_winner",
};
export const OUTRIGHT_POLL_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

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
export const POLYMARKET_FUTURES_SLUGS: Record<string, string> = {
  "Premier League": "english-premier-league-winner",
  "La Liga": "la-liga-winner-114",
  Bundesliga: "bundesliga-winner-527",
  "Serie A": "serie-a-league-winner",
  "Ligue 1": "french-ligue-1-winner",
};

// ─── Understat xG integration ────────────────────────────────
export const XG_ENABLED = true;
export const XG_POLL_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
export const XG_FLOOR = 0.4;                         // min shock multiplier (lucky win)
export const XG_CEILING = 1.8;                       // max shock multiplier (dominant win)

// ─── Odds blend constants (Phase 2) ─────────────────────────
// Drift signal removed — replaced by direct odds-implied Elo blend
export const PREMATCH_WEIGHT = 0.35;   // Blend weight: (1-w)*matchElo + w*oddsImplied
