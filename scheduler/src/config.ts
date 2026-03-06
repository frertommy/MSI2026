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

// ─── Credit limits (Mega plan: 5M credits/month) ────────────
export const CREDITS_DAILY_SOFT_LIMIT = 25_000;              // 1-min full markets ≈ 21,600/day + headroom
export const CREDITS_PER_LEAGUE_CALL = 3;                    // h2h + totals + spreads = 3 credits
export const CREDITS_FALLBACK_INTERVAL = 5 * 60 * 1000;     // 5 min fallback when credits low

// ─── Legacy pricing constants (removed — see git history) ────
// pricing-engine.ts retired in favor of Oracle V1 pipeline.
// Old constants: INITIAL_ELO, WINDOW_DAYS, PRICE_SLOPE, PRICE_ZERO,
// PRICE_FLOOR, SHOCK_K, CARRY_DECAY_RATE, MA_WINDOW, LIVE_SHOCK_DISCOUNT
export const BATCH_SIZE = 500;

// ─── Outright futures mapping (DISABLED — all API endpoints return 404) ──
// Table dropped. Will be replaced by Polymarket futures integration.
export const OUTRIGHT_SPORT_KEYS: Record<string, string> = {
  "Premier League": "soccer_epl_winner",
  "La Liga": "soccer_spain_la_liga_winner",
  Bundesliga: "soccer_germany_bundesliga_winner",
  "Serie A": "soccer_italy_serie_a_winner",
  "Ligue 1": "soccer_france_ligue_one_winner",
};
export const OUTRIGHT_POLL_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

// ─── Primary polling interval ────────────────────────────────
export const PRIMARY_POLL_INTERVAL = 60 * 1000;      // 1 minute — all leagues, all markets, 24/7
export const HOURLY_POLL_INTERVAL = 60 * 60 * 1000;  // legacy — only used by sub-pollers (Polymarket etc.)
export const DAILY_CREDIT_SAFETY = 22_000;            // fallback to 5-min if exceeded

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

// ─── xG integration (removed — spec §17 rejects xG in settlement) ──
// understat-poller.ts retired. See git history for XG_ENABLED, XG_POLL_INTERVAL, XG_FLOOR, XG_CEILING.

// ─── Oracle V1 constants ─────────────────────────────────────
export const ORACLE_V1_K = 30;         // Fixed K-factor for B-layer settlement: ΔB = 30 × (S − E_KR)
export const ORACLE_V1_BASELINE_ELO = 1500;  // Bootstrap B_value for new teams (league-neutral in v1)
export const ORACLE_V1_SETTLEMENT_START_DATE = "2025-08-01"; // Only settle matches from current odds-covered season

// ─── Oracle V1 feature flags ──────────────────────────────────
export const ORACLE_V1_ENABLED = true;                 // Oracle V1 always on
export const ORACLE_V1_LIVE_ENABLED = true;            // Live layer during matches
export const ORACLE_V1_FEEDBACK_ENABLED = false;       // Stub — no perp mark price yet
export const ORACLE_V1_OFFSEASON_ENABLED = false;      // Outright sport keys broken (all 404)

// ─── Legacy odds blend weights (removed — pricing-engine retired) ──
// See git history for PREMATCH_WEIGHT, LIVE_WEIGHT.
