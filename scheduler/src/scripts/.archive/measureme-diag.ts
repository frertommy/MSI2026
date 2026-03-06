/**
 * MeasureMe diagnostic — investigate slope invariance and kurtosis outliers.
 */
import "dotenv/config";
import { getSupabase } from "../api/supabase-client.js";
import { log } from "../logger.js";
import { INITIAL_ELO } from "../config.js";

const LEGACY_NAME_MAP: Record<string, string> = {
  "1. FC Heidenheim": "1. FC Heidenheim 1846",
  "1899 Hoffenheim": "TSG 1899 Hoffenheim",
  Alaves: "Deportivo Alavés", Angers: "Angers SCO",
  Arsenal: "Arsenal FC", "Aston Villa": "Aston Villa FC",
  Atalanta: "Atalanta BC", "Atletico Madrid": "Club Atlético de Madrid",
  Auxerre: "AJ Auxerre", Barcelona: "FC Barcelona",
  "Bayer Leverkusen": "Bayer 04 Leverkusen", "Bayern München": "FC Bayern München",
  Bologna: "Bologna FC 1909", Bournemouth: "AFC Bournemouth",
  Brentford: "Brentford FC", Brighton: "Brighton & Hove Albion FC",
  Chelsea: "Chelsea FC", Como: "Como 1907",
  "Crystal Palace": "Crystal Palace FC", Everton: "Everton FC",
  Fiorentina: "ACF Fiorentina", Fulham: "Fulham FC",
  Inter: "FC Internazionale Milano", Juventus: "Juventus FC",
  Lazio: "SS Lazio", Lecce: "US Lecce",
  Liverpool: "Liverpool FC", "Manchester City": "Manchester City FC",
  "Manchester United": "Manchester United FC",
  Napoli: "SSC Napoli", Newcastle: "Newcastle United FC",
  "Nottingham Forest": "Nottingham Forest FC",
  "Real Madrid": "Real Madrid CF", Tottenham: "Tottenham Hotspur FC",
  "West Ham": "West Ham United FC", Wolves: "Wolverhampton Wanderers FC",
};

const LEGACY_URL = "https://raw.githubusercontent.com/frertommy/MSI/main/data/msi_daily.json";
const MA_WINDOW = 45;

function parseScore(s: string): [number, number] | null {
  const parts = s.split("-");
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0].trim()), a = parseInt(parts[1].trim());
  if (isNaN(h) || isNaN(a)) return null;
  return [h, a];
}
function addDays(d: string, n: number): string {
  const dt = new Date(d + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function eloExp(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

async function main() {
  const sb = getSupabase();

  // Load matches
  const allMatches: { fixture_id: number; date: string; home_team: string; away_team: string; score: string; league: string }[] = [];
  let from = 0;
  while (true) {
    const { data } = await sb.from("matches").select("fixture_id, date, league, home_team, away_team, score").order("date", { ascending: true }).range(from, from + 999);
    if (!data || data.length === 0) break;
    allMatches.push(...data as any);
    if (data.length < 1000) break;
    from += 1000;
  }
  const matches = allMatches.filter(m => parseScore(m.score) !== null);

  // Load closing odds
  const fixtureIds = [...new Set(matches.map(m => m.fixture_id))];
  const oddsMap = new Map<number, { hp: number; dp: number; ap: number }>();
  for (let i = 0; i < fixtureIds.length; i += 50) {
    const batch = fixtureIds.slice(i, i + 50);
    const { data } = await sb.from("odds_snapshots").select("fixture_id, home_odds, away_odds, draw_odds").in("fixture_id", batch).eq("days_before_kickoff", 1);
    if (!data) continue;
    const accum = new Map<number, { h: number[]; d: number[]; a: number[] }>();
    for (const r of data) {
      const ho = r.home_odds as number, ao = r.away_odds as number, dw = r.draw_odds as number;
      if (!ho || !ao || !dw || ho <= 1 || ao <= 1 || dw <= 1) continue;
      if (!accum.has(r.fixture_id)) accum.set(r.fixture_id, { h: [], d: [], a: [] });
      const e = accum.get(r.fixture_id)!;
      e.h.push(1 / ho); e.d.push(1 / dw); e.a.push(1 / ao);
    }
    for (const [fid, { h, d, a }] of accum) {
      const mh = h.reduce((a, b) => a + b, 0) / h.length;
      const md = d.reduce((a, b) => a + b, 0) / d.length;
      const ma = a.reduce((a, b) => a + b, 0) / a.length;
      const t = mh + md + ma;
      if (t > 0) oddsMap.set(fid, { hp: mh / t, dp: md / t, ap: ma / t });
    }
  }

  // Load legacy Elos
  const resp = await fetch(LEGACY_URL);
  const legacyData = (await resp.json()) as Record<string, { date: string; rating: number }[]>;
  const legacyElos = new Map<string, number>();
  for (const [name, entries] of Object.entries(legacyData)) {
    if (!entries || entries.length === 0) continue;
    const pre = entries.filter(e => e.date < "2025-08-01");
    legacyElos.set(name, pre.length > 0 ? pre[pre.length - 1].rating : entries[0].rating);
  }

  // Teams
  const teamLeague = new Map<string, string>();
  for (const m of matches) {
    if (!teamLeague.has(m.home_team)) teamLeague.set(m.home_team, m.league);
    if (!teamLeague.has(m.away_team)) teamLeague.set(m.away_team, m.league);
  }
  const allTeams = [...teamLeague.keys()].sort();
  const startingElos = new Map<string, number>();
  for (const t of allTeams) {
    const ln = LEGACY_NAME_MAP[t] || t;
    startingElos.set(t, legacyElos.get(ln) ?? INITIAL_ELO);
  }

  // Group by date
  const matchesByDate = new Map<string, typeof matches>();
  for (const m of matches) {
    if (!matchesByDate.has(m.date)) matchesByDate.set(m.date, []);
    matchesByDate.get(m.date)!.push(m);
  }
  const sortedDates = [...matchesByDate.keys()].sort();
  const dates: string[] = [];
  let d = sortedDates[0];
  while (d <= sortedDates[sortedDates.length - 1]) { dates.push(d); d = addDays(d, 1); }

  // Replay Elos with K=30, decay=0.001
  const K = 30, decay = 0.001;
  const elo = new Map<string, number>();
  const eloHistory = new Map<string, number[]>();
  const lastMatchDate = new Map<string, string>();
  const dailyElos = new Map<string, number[]>();

  for (const t of allTeams) {
    const e = startingElos.get(t)!;
    elo.set(t, e);
    eloHistory.set(t, [e]);
    dailyElos.set(t, [e]);
  }

  interface MatchEvent {
    date: string; team: string; opponent: string; surprise: number;
    homeTeam: string; score: string;
  }
  const matchEvents: (MatchEvent & { dateIdx: number })[] = [];

  for (let dateIdx = 0; dateIdx < dates.length; dateIdx++) {
    const date = dates[dateIdx];
    const today = matchesByDate.get(date) ?? [];
    const playing = new Set<string>();
    for (const m of today) { playing.add(m.home_team); playing.add(m.away_team); }

    for (const t of allTeams) {
      if (playing.has(t)) continue;
      const lm = lastMatchDate.get(t);
      if (!lm) continue;
      const ds = Math.round((new Date(date + "T00:00:00Z").getTime() - new Date(lm + "T00:00:00Z").getTime()) / 86400000);
      if (ds <= 0) continue;
      const hist = eloHistory.get(t)!;
      const sl = hist.slice(-MA_WINDOW);
      const ma = sl.reduce((a, b) => a + b, 0) / sl.length;
      const f = Math.max(0.5, 1 - decay * ds);
      elo.set(t, ma + (elo.get(t)! - ma) * f);
    }

    for (const m of today) {
      const he = elo.get(m.home_team)!, ae = elo.get(m.away_team)!;
      const sc = parseScore(m.score)!;
      const ha = sc[0] > sc[1] ? 1 : sc[0] === sc[1] ? 0.5 : 0;
      const aa = 1 - ha;
      const odds = oddsMap.get(m.fixture_id);
      let hExp: number, aExp: number;
      if (odds) { hExp = odds.hp + odds.dp * 0.5; aExp = odds.ap + odds.dp * 0.5; }
      else { hExp = eloExp(he, ae); aExp = 1 - hExp; }
      elo.set(m.home_team, he + K * (ha - hExp));
      elo.set(m.away_team, ae + K * (aa - aExp));
      lastMatchDate.set(m.home_team, date);
      lastMatchDate.set(m.away_team, date);
      matchEvents.push({ dateIdx, date, team: m.home_team, opponent: m.away_team, surprise: Math.abs(ha - hExp), homeTeam: m.home_team, score: m.score });
      matchEvents.push({ dateIdx, date, team: m.away_team, opponent: m.home_team, surprise: Math.abs(aa - aExp), homeTeam: m.home_team, score: m.score });
    }

    let sum = 0;
    for (const t of allTeams) sum += elo.get(t)!;
    const shift = 1500 - sum / allTeams.length;
    for (const t of allTeams) elo.set(t, elo.get(t)! + shift);

    for (const t of allTeams) {
      const e = elo.get(t)!;
      eloHistory.get(t)!.push(e);
      if (eloHistory.get(t)!.length > MA_WINDOW + 30) eloHistory.get(t)!.splice(0, eloHistory.get(t)!.length - MA_WINDOW - 10);
      dailyElos.get(t)!.push(e);
    }
  }

  // ══════════════════════════════════════════════════════════
  // DIAGNOSTIC 1: Slope invariance proof
  // ══════════════════════════════════════════════════════════
  log.info("═══ DIAGNOSTIC 1: Slope invariance ═══");
  log.info("");

  for (const slope of [3, 5, 10]) {
    const zp = 800;
    // Arsenal prices
    const arsenalElos = dailyElos.get("Arsenal")!;
    const arsenalPrices = arsenalElos.map(e => Math.max(10, (e - zp) / slope));
    const arsenalReturns = arsenalPrices.slice(1).map((p, i) => (p - arsenalPrices[i]) / arsenalPrices[i]);

    // Wolves prices
    const wolvesElos = dailyElos.get("Wolves")!;
    const wolvesPrices = wolvesElos.map(e => Math.max(10, (e - zp) / slope));

    log.info(`slope=${slope} zp=${zp}:`);
    log.info(`  Arsenal: Elo ${arsenalElos[0].toFixed(0)}→${arsenalElos[arsenalElos.length - 1].toFixed(0)}  Price $${arsenalPrices[0].toFixed(2)}→$${arsenalPrices[arsenalPrices.length - 1].toFixed(2)}  min=$${Math.min(...arsenalPrices).toFixed(2)} max=$${Math.max(...arsenalPrices).toFixed(2)}`);
    log.info(`  Wolves:  Elo ${wolvesElos[0].toFixed(0)}→${wolvesElos[wolvesElos.length - 1].toFixed(0)}  Price $${wolvesPrices[0].toFixed(2)}→$${wolvesPrices[wolvesPrices.length - 1].toFixed(2)}  min=$${Math.min(...wolvesPrices).toFixed(2)} max=$${Math.max(...wolvesPrices).toFixed(2)}`);

    // Show a sample return to prove slope cancels
    const sampleReturn = arsenalReturns[50];
    log.info(`  Arsenal day-50 return: ${(sampleReturn * 100).toFixed(6)}%`);
    log.info(`  Math proof: return = ΔElo/(Elo-zp) = slope cancels in (ΔElo/slope) / ((Elo-zp)/slope)`);
    log.info("");
  }

  // ══════════════════════════════════════════════════════════
  // DIAGNOSTIC 2: Extreme returns causing kurtosis=80.71
  // ══════════════════════════════════════════════════════════
  log.info("═══ DIAGNOSTIC 2: Kurtosis investigation (slope=3 zp=800) ═══");
  log.info("");

  const slope = 3, zp = 800;
  interface ReturnEntry { team: string; dateIdx: number; date: string; priceBefore: number; priceAfter: number; ret: number; eloBefore: number; eloAfter: number; }
  const allReturns: ReturnEntry[] = [];

  for (const team of allTeams) {
    const elos = dailyElos.get(team)!;
    for (let i = 0; i < dates.length; i++) {
      const pBefore = Math.max(10, (elos[i] - zp) / slope);
      const pAfter = Math.max(10, (elos[i + 1] - zp) / slope);
      if (pBefore > 0) {
        allReturns.push({
          team, dateIdx: i, date: dates[i],
          priceBefore: pBefore, priceAfter: pAfter,
          ret: (pAfter - pBefore) / pBefore,
          eloBefore: elos[i], eloAfter: elos[i + 1],
        });
      }
    }
  }

  // Sort by absolute return
  const sorted = [...allReturns].sort((a, b) => Math.abs(b.ret) - Math.abs(a.ret));

  log.info("Top 20 most extreme daily returns:");
  log.info("─".repeat(130));
  for (let i = 0; i < 20; i++) {
    const r = sorted[i];
    // Find the match that caused it
    const dayMatches = matchesByDate.get(r.date) ?? [];
    const match = dayMatches.find(m => m.home_team === r.team || m.away_team === r.team);
    const matchStr = match ? `${match.home_team} ${match.score} ${match.away_team}` : "no match";
    log.info(
      `  ${(i + 1).toString().padStart(2)}. ${r.team.padEnd(22)} ${r.date}  $${r.priceBefore.toFixed(2).padStart(7)} → $${r.priceAfter.toFixed(2).padStart(7)}  ret=${(r.ret * 100).toFixed(2).padStart(7)}%  Elo ${r.eloBefore.toFixed(0)}→${r.eloAfter.toFixed(0)}  | ${matchStr}`
    );
  }

  // Teams with low prices
  log.info("");
  log.info("Teams with prices under $30 at any point (slope=3 zp=800):");
  for (const team of allTeams) {
    const elos = dailyElos.get(team)!;
    const prices = elos.map(e => Math.max(10, (e - zp) / slope));
    const minPrice = Math.min(...prices);
    if (minPrice < 30) {
      const minIdx = prices.indexOf(minPrice);
      log.info(`  ${team.padEnd(25)} min=$${minPrice.toFixed(2)} (Elo=${elos[minIdx].toFixed(0)}) on day ${minIdx}`);
    }
  }

  // Kurtosis with and without tail trimming
  const rawReturns = allReturns.map(r => r.ret);
  const n = rawReturns.length;
  const mean = rawReturns.reduce((a, b) => a + b, 0) / n;

  let m2 = 0, m4 = 0;
  for (const r of rawReturns) { const d = r - mean; m2 += d * d; m4 += d * d * d * d; }
  m2 /= n; m4 /= n;
  const fullKurt = m4 / (m2 * m2);

  // Trim top/bottom 1%
  const sortedRets = [...rawReturns].sort((a, b) => a - b);
  const trim = Math.floor(n * 0.01);
  const trimmed = sortedRets.slice(trim, -trim);
  const tn = trimmed.length;
  const tmean = trimmed.reduce((a, b) => a + b, 0) / tn;
  let tm2 = 0, tm4 = 0;
  for (const r of trimmed) { const d = r - tmean; tm2 += d * d; tm4 += d * d * d * d; }
  tm2 /= tn; tm4 /= tn;
  const trimKurt = tm2 > 0 ? tm4 / (tm2 * tm2) : 3;

  // Trim top/bottom 0.1%
  const trim01 = Math.floor(n * 0.001);
  const trimmed01 = sortedRets.slice(trim01, -trim01);
  const tn01 = trimmed01.length;
  const tmean01 = trimmed01.reduce((a, b) => a + b, 0) / tn01;
  let tm2_01 = 0, tm4_01 = 0;
  for (const r of trimmed01) { const d = r - tmean01; tm2_01 += d * d; tm4_01 += d * d * d * d; }
  tm2_01 /= tn01; tm4_01 /= tn01;
  const trimKurt01 = tm2_01 > 0 ? tm4_01 / (tm2_01 * tm2_01) : 3;

  log.info("");
  log.info(`Return distribution stats (${n} returns):`);
  log.info(`  Full kurtosis:                  ${fullKurt.toFixed(2)}`);
  log.info(`  Kurtosis excl top/bottom 0.1%:  ${trimKurt01.toFixed(2)} (${trim01} removed each side)`);
  log.info(`  Kurtosis excl top/bottom 1%:    ${trimKurt.toFixed(2)} (${trim} removed each side)`);
  log.info(`  Min return: ${(sortedRets[0] * 100).toFixed(4)}%`);
  log.info(`  Max return: ${(sortedRets[n - 1] * 100).toFixed(4)}%`);
  log.info(`  P1:  ${(sortedRets[trim] * 100).toFixed(4)}%`);
  log.info(`  P99: ${(sortedRets[n - 1 - trim] * 100).toFixed(4)}%`);
  log.info(`  Std dev: ${(Math.sqrt(m2) * 100).toFixed(4)}%`);

  // Count returns > 5 std devs
  const stdDev = Math.sqrt(m2);
  const extreme5 = rawReturns.filter(r => Math.abs(r - mean) > 5 * stdDev).length;
  const extreme3 = rawReturns.filter(r => Math.abs(r - mean) > 3 * stdDev).length;
  log.info(`  Returns > 3σ: ${extreme3} (${(extreme3 / n * 100).toFixed(2)}%)`);
  log.info(`  Returns > 5σ: ${extreme5} (${(extreme5 / n * 100).toFixed(2)}%)`);

  // ══════════════════════════════════════════════════════════
  // DIAGNOSTIC 3: Show WHY slope cancels mathematically
  // ══════════════════════════════════════════════════════════
  log.info("");
  log.info("═══ DIAGNOSTIC 3: WHY slope cancels ═══");
  log.info("");
  log.info("  price = (elo - zp) / slope");
  log.info("  return = (price_after - price_before) / price_before");
  log.info("         = ((eloAfter - zp)/slope - (eloBefore - zp)/slope) / ((eloBefore - zp)/slope)");
  log.info("         = (eloAfter - eloBefore) / (eloBefore - zp)");
  log.info("         → slope cancels completely in percentage returns!");
  log.info("");
  log.info("  Slope ONLY matters when teams hit the $10 floor (price truncation).");
  log.info("  With zp=800, weakest Elo ~1200 → price = (1200-800)/10 = $40, no floor hit.");
  log.info("");
  log.info("  To make slope matter, either:");
  log.info("  1. Use higher zeroPoints (e.g. 1100-1300) so weak teams hit floor with high slopes");
  log.info("  2. Use log/non-linear pricing so slope doesn't cancel");
  log.info("  3. Mix dollar + percentage metrics");
}

main().catch(err => { log.error("FATAL", err); process.exit(1); });
