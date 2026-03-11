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
export const CREDITS_DAILY_SOFT_LIMIT = 250_000;             // 10x headroom — Mega plan allows ~166K/day
export const CREDITS_PER_LEAGUE_CALL = 3;                    // h2h + totals + spreads = 3 credits
export const CREDITS_FALLBACK_INTERVAL = 5 * 60 * 1000;     // 5 min fallback when credits low

// ─── Legacy pricing constants (removed — see git history) ────
// pricing-engine.ts retired in favor of Oracle V1 pipeline.
// Old constants: INITIAL_ELO, WINDOW_DAYS, PRICE_SLOPE, PRICE_ZERO,
// PRICE_FLOOR, SHOCK_K, CARRY_DECAY_RATE, MA_WINDOW, LIVE_SHOCK_DISCOUNT
export const BATCH_SIZE = 500;

// ─── Outright futures mapping (DEAD — Odds API returns UNKNOWN_SPORT) ──
// Confirmed 2026-03: these sport keys don't exist in The Odds API.
// Replaced by Polymarket futures integration (see oracle-v1-futures.ts).
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
export const DAILY_CREDIT_SAFETY = 220_000;           // fallback to 5-min if exceeded

// ─── Polymarket data collection (feeds oracle-v1-futures.ts for offseason R_futures) ─
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
export const ORACLE_V1_OFFSEASON_ENABLED = true;       // Polymarket futures → R_futures → M1 during offseason

// ─── Oracle V1 offseason B-drift constants ───────────────────
// When regime="offseason", B drifts toward Polymarket-derived R_futures:
//   ΔB_drift = λ × (R_futures − B), capped at ±MAX_DAILY ELO/day
export const ORACLE_V1_DRIFT_LAMBDA = 0.02;             // 2% daily pull toward market consensus
export const ORACLE_V1_DRIFT_MAX_DAILY = 5;             // cap at ±5 ELO per day
export const ORACLE_V1_DRIFT_MIN_VOLUME = 10_000;       // skip teams with <$10k Polymarket volume
export const ORACLE_V1_DRIFT_INTERVAL = 24 * 60 * 60 * 1000; // apply once per 24h

// ─── Friendly match settlement ───────────────────────────────
// Phase 3: settle pre-season friendlies at reduced K-factor
export const ORACLE_V1_K_FRIENDLY = 10;                 // K=10 for friendlies (vs K=30 for competitive)

// ─── Oracle V2 constants ─────────────────────────────────────
// V2 = perfect seeds + gravity-on-settlement (γ=0.05)
// ΔB = K × (S − E_KR) + γ × (R_market − B)
export const ORACLE_V2_ENABLED = true;
export const ORACLE_V2_LIVE_ENABLED = true;       // Live layer during matches (L = K × (E_live − E_KR))
export const ORACLE_V2_K = 30;
export const ORACLE_V2_GRAVITY_GAMMA = 0.05;     // gravity pull toward market consensus at settlement
export const ORACLE_V2_BASELINE_ELO = 1500;       // fallback only — V2 uses optimal_seeds.json
export const ORACLE_V2_SETTLEMENT_START_DATE = "2025-08-01";

// ─── Oracle V3 constants ─────────────────────────────────────
// V3 = simultaneous Bradley-Terry MAP solve + alpha formula + R_next
// published = B + M1 = 0.6×B + 0.4×R_market
// R_market = 0.85×R_network + 0.15×R_next
// ΔB = K×(S−E_KR) + γ×(R_market_frozen−B), cause-effect clamped
export const ORACLE_V3_ENABLED = true;                // V3 live — backfill complete 2026-03-11
export const ORACLE_V3_LIVE_ENABLED = true;            // Live layer during matches (L = K × (E_live − E_KR))
export const ORACLE_V3_K = 30;
export const ORACLE_V3_GRAVITY_GAMMA = 0.08;           // B converges ~96% over a full season (1-0.92^38)
export const ORACLE_V3_ALPHA = 0.40;                   // PT floor = 0.60. M1 = α × (R_market − B)
export const ORACLE_V3_W_NEXT = 0.15;                  // R_market = (1-w)×R_network + w×R_next. 6% of price from next fixture.
export const ORACLE_V3_M1_CLAMP = 120;                 // Safety rail ±120 ELO on M1
export const ORACLE_V3_BASELINE_ELO = 1500;            // fallback only — V3 uses V2 seeds
export const ORACLE_V3_SETTLEMENT_START_DATE = "2025-08-01";

// Bradley-Terry solver parameters
export const ORACLE_V3_BT_SIGMA_PRIOR = 300;           // Gaussian prior σ — room to disagree with B while staying stable
export const ORACLE_V3_BT_HOME_ADV = 65;               // home advantage in Elo points
export const ORACLE_V3_BT_WINDOW_DAYS = 30;            // 30-day window of past + upcoming fixtures
export const ORACLE_V3_BT_WINDOW_EXPAND = 45;          // expand to 45d if < MIN_FIXTURES in 30d
export const ORACLE_V3_BT_MIN_FIXTURES = 5;            // minimum for full BT solve
export const ORACLE_V3_BT_SPARSE_SIGMA = 200;          // tighter prior for 3-4 fixture sparse solve
export const ORACLE_V3_BT_SIGMA_MAX = 900;             // σ_BT ceiling for confidence display
export const ORACLE_V3_BT_PAST_DECAY_HL = 14;          // past fixtures: w = 1/(1 + daysAgo/14)
export const ORACLE_V3_BT_FWD_DECAY_HL = 7;            // upcoming fixtures: w = 1/(1 + daysForward/7)

// ─── Legacy odds blend weights (removed — pricing-engine retired) ──
// See git history for PREMATCH_WEIGHT, LIVE_WEIGHT.
