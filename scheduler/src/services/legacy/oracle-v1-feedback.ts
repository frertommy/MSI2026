/**
 * oracle-v1-feedback.ts — Mark-price feedback term (F) for the V1 Oracle.
 *
 * F(t) = w(regime) × (MarkTWAP_elo − NaiveIndex)
 *
 * Where:
 *   MarkTWAP_elo = 5-minute TWAP of perp mark price, converted to Elo
 *   NaiveIndex   = B + M + L (oracle without feedback)
 *   w(regime)    = feedback weight (0.05–0.15 depending on regime)
 *
 * F is clamped to ±MAX_F_ABS Elo.
 *
 * When no mark price is available (perp not yet trading), F = 0.
 *
 * Constraints:
 *   - No imports from pricing-engine.ts, oracle-v1-market.ts, or oracle-v1-live.ts
 *   - Stub mark price feed returns null until the perp is live
 *   - Feature-flagged: only called when ORACLE_V1_FEEDBACK_ENABLED=true
 */

// ─── Constants ──────────────────────────────────────────────

const MAX_F_ABS = 20; // Hard cap: ±20 Elo (±$4 in price)

const REGIME_WEIGHTS: Record<string, number> = {
  live: 0.15,
  prematch: 0.10,
  between: 0.05,
  offseason: 0.05,
};

// ─── Mark price feed (stub) ─────────────────────────────────

/**
 * Get the 5-minute TWAP of the perp mark price for a team, in Elo units.
 *
 * STUB: Returns null until the perp is live with a mark price feed.
 * When ready, replace this with the real implementation:
 *   - Query mark_price_snapshots for the last 5 minutes
 *   - Time-weighted average of dollar prices
 *   - Convert to Elo: twapElo = twapPrice * 5 + 800
 *   - If < 3 datapoints in window: return null (stale)
 */
async function getMarkPriceTWAP(
  teamId: string
): Promise<{ twapElo: number; stale: boolean } | null> {
  // STUB — no perp trading yet. Return null so F = 0.
  // When the perp is live, replace this with real mark price ingestion.
  //
  // Future implementation sketch:
  //   const sb = getSupabase();
  //   const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  //   const { data } = await sb
  //     .from("mark_price_snapshots")
  //     .select("price, timestamp")
  //     .eq("team_id", teamId)
  //     .gte("timestamp", fiveMinAgo)
  //     .order("timestamp", { ascending: true });
  //
  //   if (!data || data.length < 3) return null;
  //
  //   // Time-weighted average
  //   let weightedSum = 0, totalWeight = 0;
  //   for (let i = 1; i < data.length; i++) {
  //     const dt = new Date(data[i].timestamp).getTime() - new Date(data[i-1].timestamp).getTime();
  //     weightedSum += data[i-1].price * dt;
  //     totalWeight += dt;
  //   }
  //   const twapPrice = totalWeight > 0 ? weightedSum / totalWeight : data[0].price;
  //   const twapElo = twapPrice * 5 + 800;
  //   return { twapElo, stale: false };

  return null;
}

// ─── Main exported function ─────────────────────────────────

/**
 * Compute the mark-price feedback term F for a single team.
 *
 * @param teamId     - The team identifier
 * @param naiveIndex - B + M + L (oracle without feedback)
 * @param regime     - Current oracle regime for this team
 * @returns F value, weight used, mark TWAP in Elo (if available), and staleness flag
 */
export async function computeFeedback(
  teamId: string,
  naiveIndex: number,
  regime: "live" | "prematch" | "between" | "offseason"
): Promise<{
  F: number;
  w: number;
  markTwapElo: number | null;
  stale: boolean;
}> {
  // 1. Get mark price TWAP
  const twapResult = await getMarkPriceTWAP(teamId);

  // If no mark price available or stale, F = 0
  if (!twapResult || twapResult.stale) {
    return { F: 0, w: 0, markTwapElo: null, stale: true };
  }

  // 2. Determine regime weight
  const w = REGIME_WEIGHTS[regime] ?? 0.05;

  // 3. Compute raw F
  const F_raw = w * (twapResult.twapElo - naiveIndex);

  // 4. Clamp to ±MAX_F_ABS
  const F = Math.max(-MAX_F_ABS, Math.min(MAX_F_ABS, F_raw));

  // 5. Return
  return {
    F,
    w,
    markTwapElo: twapResult.twapElo,
    stale: false,
  };
}
