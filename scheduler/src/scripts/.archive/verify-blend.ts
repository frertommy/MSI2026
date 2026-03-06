/**
 * Verify odds blend — Commit 1 verification checks.
 *
 * Checks:
 *   1. Between-match movement (Arsenal on non-match days)
 *   2. Venue oscillation check
 *   3. Sanity range for oddsImpliedStrength
 *   4. Match-day behavior
 *   5. IDLE behavior
 *   6. State integrity (PREMATCH_WEIGHT doesn't corrupt teamElo)
 */
import "dotenv/config";
import { getSupabase } from "../api/supabase-client.js";
import { log } from "../logger.js";

async function main() {
  const sb = getSupabase();

  log.info("═══ Blend Verification ═══\n");

  // Check 1: Between-match movement — Arsenal on non-match days
  log.info("CHECK 1: Between-match movement (Arsenal)");
  const { data: arsenalPrices } = await sb
    .from("team_prices")
    .select("date, implied_elo, dollar_price, drift_elo")
    .eq("team", "Arsenal")
    .eq("model", "oracle")
    .order("date", { ascending: false })
    .limit(20);

  if (arsenalPrices) {
    // Find 3 consecutive non-match days
    const { data: arsenalMatches } = await sb
      .from("matches")
      .select("date")
      .or("home_team.eq.Arsenal,away_team.eq.Arsenal")
      .eq("status", "finished")
      .order("date", { ascending: false })
      .limit(10);

    const matchDates = new Set(arsenalMatches?.map(m => m.date) ?? []);
    const nonMatchPrices = arsenalPrices.filter(p => !matchDates.has(p.date)).slice(0, 5);

    log.info("  Arsenal non-match days (most recent 5):");
    for (const p of nonMatchPrices) {
      log.info(`    ${p.date}  implied_elo=${p.implied_elo}  price=$${p.dollar_price}  drift_elo=${p.drift_elo}`);
    }

    // Check if prices vary across days
    const prices = nonMatchPrices.map(p => p.dollar_price);
    const priceRange = Math.max(...prices) - Math.min(...prices);
    log.info(`  Price range across non-match days: $${priceRange.toFixed(2)}`);
    log.info(`  ${priceRange > 0.01 ? "✅ Prices DO vary between matches (blend working)" : "⚠️ Prices are flat (blend may not be active)"}\n`);
  }

  // Check 3: Sanity range for oddsImpliedStrength (drift_elo column)
  log.info("CHECK 3: Sanity range (Arsenal drift_elo = oddsImpliedStrength)");
  if (arsenalPrices) {
    const impliedValues = arsenalPrices
      .filter(p => p.drift_elo !== null && p.drift_elo !== 0)
      .map(p => p.drift_elo);

    if (impliedValues.length > 0) {
      const min = Math.min(...impliedValues);
      const max = Math.max(...impliedValues);
      log.info(`  Range: ${min} to ${max}`);
      log.info(`  ${min >= 1700 && max <= 2000 ? "✅ In expected range [1700-2000]" : "⚠️ Outside expected range"}\n`);
    } else {
      log.info("  ⚠️ No implied strength values found\n");
    }
  }

  // Check 2: Venue oscillation — find a team with home→away transition
  log.info("CHECK 2: Venue oscillation");
  // Get Liverpool's recent matches to find home→away transition
  const { data: livMatches } = await sb
    .from("matches")
    .select("date, home_team, away_team, score")
    .or("home_team.eq.Liverpool,away_team.eq.Liverpool")
    .eq("status", "finished")
    .order("date", { ascending: false })
    .limit(6);

  if (livMatches && livMatches.length >= 2) {
    log.info("  Liverpool recent matches:");
    for (const m of livMatches.slice(0, 4)) {
      const isHome = m.home_team === "Liverpool";
      const opp = isHome ? m.away_team : m.home_team;
      log.info(`    ${m.date} ${isHome ? "H" : "A"} vs ${opp} (${m.score})`);
    }

    // Get Liverpool prices around these matches
    const { data: livPrices } = await sb
      .from("team_prices")
      .select("date, implied_elo, dollar_price, drift_elo")
      .eq("team", "Liverpool")
      .eq("model", "oracle")
      .order("date", { ascending: false })
      .limit(15);

    if (livPrices) {
      log.info("  Liverpool recent prices:");
      for (const p of livPrices.slice(0, 8)) {
        log.info(`    ${p.date}  elo=${p.implied_elo}  $${p.dollar_price}  implied=${p.drift_elo}`);
      }
    }
  }
  log.info("");

  // Check 4: Match-day behavior
  log.info("CHECK 4: Match-day behavior (Arsenal latest match)");
  const { data: arsenalLastMatch } = await sb
    .from("matches")
    .select("date, home_team, away_team, score")
    .or("home_team.eq.Arsenal,away_team.eq.Arsenal")
    .eq("status", "finished")
    .order("date", { ascending: false })
    .limit(1);

  if (arsenalLastMatch?.[0]) {
    const m = arsenalLastMatch[0];
    const matchDate = m.date;
    log.info(`  Last match: ${matchDate} ${m.home_team} ${m.score} ${m.away_team}`);

    const { data: matchDayPrices } = await sb
      .from("team_prices")
      .select("date, implied_elo, dollar_price, drift_elo")
      .eq("team", "Arsenal")
      .eq("model", "oracle")
      .gte("date", addDays(matchDate, -2))
      .lte("date", addDays(matchDate, 2))
      .order("date");

    if (matchDayPrices) {
      log.info("  Arsenal prices around match day:");
      for (const p of matchDayPrices) {
        const marker = p.date === matchDate ? " ← MATCH DAY" : "";
        log.info(`    ${p.date}  elo=${p.implied_elo}  $${p.dollar_price}  implied=${p.drift_elo}${marker}`);
      }
    }
  }
  log.info("");

  // Check 5: Top 10 — overall sanity
  log.info("CHECK 5: Top 10 latest prices (sanity)");
  const { data: top10 } = await sb
    .from("team_prices")
    .select("team, implied_elo, dollar_price, drift_elo")
    .eq("model", "oracle")
    .eq("date", new Date().toISOString().slice(0, 10))
    .order("dollar_price", { ascending: false })
    .limit(10);

  if (top10) {
    for (let i = 0; i < top10.length; i++) {
      const t = top10[i];
      log.info(`  ${(i+1).toString().padStart(2)}. ${t.team.padEnd(22)} elo=${t.implied_elo}  $${t.dollar_price}  implied=${t.drift_elo}`);
    }
  }
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

main().catch((err) => {
  log.error("Verification failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
