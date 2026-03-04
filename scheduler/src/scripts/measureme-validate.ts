/**
 * MeasureMe Validation Script
 * Walks through Q1 (Arsenal match) and Q5 (index deep dive) computations
 */
import "dotenv/config";
import { getSupabase } from "../core/supabase.js";
import { log } from "../core/logger.js";
import { INITIAL_ELO } from "../config/index.js";

const LEGACY_NAME_MAP: Record<string, string> = {
  Arsenal: "Arsenal FC",
  Chelsea: "Chelsea FC",
  "Bayern München": "FC Bayern München",
  Barcelona: "FC Barcelona",
  Inter: "FC Internazionale Milano",
  Wolves: "Wolverhampton Wanderers FC",
  Burnley: "Burnley FC",
  Sunderland: "Sunderland AFC",
  Como: "Como 1907",
};

const LEGACY_URL =
  "https://raw.githubusercontent.com/frertommy/MSI/main/data/msi_daily.json";

function eloExpected(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function linearPrice(elo: number, slope: number, zeroPoint: number): number {
  return Math.max(10, (elo - zeroPoint) / slope);
}

function parseScore(s: string): [number, number] | null {
  const parts = s.split("-");
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0].trim());
  const a = parseInt(parts[1].trim());
  if (isNaN(h) || isNaN(a)) return null;
  return [h, a];
}

interface MatchRow {
  fixture_id: number;
  date: string;
  league: string;
  home_team: string;
  away_team: string;
  score: string;
}

interface NormOdds {
  homeProb: number;
  drawProb: number;
  awayProb: number;
}

async function main() {
  const sb = getSupabase();
  const K = 40;
  const decay = 0.001;
  const zp = 800;
  const slope = 5;
  const MA_WINDOW = 45;

  // Load all matches
  log.info("Loading matches...");
  const allMatches: MatchRow[] = [];
  let from = 0;
  while (true) {
    const { data } = await sb
      .from("matches")
      .select("fixture_id, date, league, home_team, away_team, score")
      .order("date", { ascending: true })
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    allMatches.push(...(data as MatchRow[]));
    if (data.length < 1000) break;
    from += 1000;
  }
  const matches = allMatches.filter((r) => parseScore(r.score) !== null);
  log.info(`Loaded ${matches.length} matches`);

  // Load closing odds (same logic as measureme.ts)
  log.info("Loading closing odds...");
  const fixtureIds = [...new Set(matches.map((m) => m.fixture_id))];
  const oddsMap = new Map<number, NormOdds>();
  const rawSnaps = new Map<number, { hp: number; dp: number; ap: number }[]>();
  const foundFixtures = new Set<number>();

  for (const dbk of [0, 1, 2, 3]) {
    const remaining = fixtureIds.filter((id) => !foundFixtures.has(id));
    if (remaining.length === 0) break;
    const BATCH = 20;
    for (let i = 0; i < remaining.length; i += BATCH) {
      const batch = remaining.slice(i, i + BATCH);
      let from2 = 0;
      while (true) {
        const { data } = await sb
          .from("odds_snapshots")
          .select("fixture_id, home_odds, away_odds, draw_odds")
          .in("fixture_id", batch)
          .eq("days_before_kickoff", dbk)
          .range(from2, from2 + 999);
        if (!data || data.length === 0) break;
        for (const row of data) {
          const ho = row.home_odds as number | null;
          const ao = row.away_odds as number | null;
          const dw = row.draw_odds as number | null;
          if (!ho || !ao || !dw || ho <= 1 || ao <= 1 || dw <= 1) continue;
          if (!rawSnaps.has(row.fixture_id)) rawSnaps.set(row.fixture_id, []);
          rawSnaps.get(row.fixture_id)!.push({
            hp: 1 / ho,
            dp: 1 / dw,
            ap: 1 / ao,
          });
          foundFixtures.add(row.fixture_id);
        }
        if (data.length < 1000) break;
        from2 += 1000;
      }
    }
  }

  for (const [fid, snaps] of rawSnaps) {
    const meanH = snaps.reduce((a, s) => a + s.hp, 0) / snaps.length;
    const meanD = snaps.reduce((a, s) => a + s.dp, 0) / snaps.length;
    const meanA = snaps.reduce((a, s) => a + s.ap, 0) / snaps.length;
    const total = meanH + meanD + meanA;
    if (total <= 0) continue;
    oddsMap.set(fid, {
      homeProb: meanH / total,
      drawProb: meanD / total,
      awayProb: meanA / total,
    });
  }
  log.info(`Odds loaded: ${oddsMap.size} fixtures`);

  // Load legacy Elos
  const resp = await fetch(LEGACY_URL);
  const legacyData = (await resp.json()) as Record<string, { date: string; rating: number }[]>;
  const legacyElos = new Map<string, number>();
  for (const [name, entries] of Object.entries(legacyData)) {
    if (!entries || entries.length === 0) continue;
    const preSeason = entries.filter((e) => e.date < "2025-08-01");
    legacyElos.set(name, preSeason.length > 0 ? preSeason[preSeason.length - 1].rating : entries[0].rating);
  }

  // Get all teams and starting Elos
  const teamLeague = new Map<string, string>();
  for (const m of matches) {
    if (!teamLeague.has(m.home_team)) teamLeague.set(m.home_team, m.league);
    if (!teamLeague.has(m.away_team)) teamLeague.set(m.away_team, m.league);
  }
  const allTeams = [...teamLeague.keys()].sort();
  const startingElos = new Map<string, number>();
  for (const t of allTeams) {
    const legacyName = LEGACY_NAME_MAP[t] || t;
    startingElos.set(t, legacyElos.get(legacyName) ?? INITIAL_ELO);
  }

  // Group matches by date
  const matchesByDate = new Map<string, typeof matches>();
  const teamPoints = new Map<string, number>();
  for (const t of allTeams) teamPoints.set(t, 0);

  for (const m of matches) {
    const sc = parseScore(m.score)!;
    if (!matchesByDate.has(m.date)) matchesByDate.set(m.date, []);
    matchesByDate.get(m.date)!.push(m);
    const hp = sc[0] > sc[1] ? 3 : sc[0] === sc[1] ? 1 : 0;
    const ap = sc[1] > sc[0] ? 3 : sc[0] === sc[1] ? 1 : 0;
    teamPoints.set(m.home_team, (teamPoints.get(m.home_team) ?? 0) + hp);
    teamPoints.set(m.away_team, (teamPoints.get(m.away_team) ?? 0) + ap);
  }

  const sortedDates = [...matchesByDate.keys()].sort();
  const startDate = sortedDates[0];
  const endDate = sortedDates[sortedDates.length - 1];

  function addDays(ds: string, n: number): string {
    const d = new Date(ds + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  const dates: string[] = [];
  let d = startDate;
  while (d <= endDate) {
    dates.push(d);
    d = addDays(d, 1);
  }

  // ─── Full Elo Replay with K=40, decay=0.001 ───
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

  // Track match events for Q5
  interface MatchEvent {
    dateIdx: number;
    date: string;
    team: string;
    opponent: string;
    surprise: number;
    actualScore: number;
    expectedScore: number;
    shock: number;
    eloBefore: number;
    eloAfter: number;
    priceBefore: number;
    priceAfter: number;
    priceChangePct: number;
    fixtureId: number;
    matchScore: string;
    usedOdds: boolean;
  }
  const allEvents: MatchEvent[] = [];

  // Track daily returns for Q5 kurtosis
  const teamDailyPrices = new Map<string, number[]>();

  for (let dateIdx = 0; dateIdx < dates.length; dateIdx++) {
    const date = dates[dateIdx];
    const todaysMatches = matchesByDate.get(date) ?? [];
    const playingToday = new Set<string>();
    for (const m of todaysMatches) {
      playingToday.add(m.home_team);
      playingToday.add(m.away_team);
    }

    // Carry decay
    for (const t of allTeams) {
      if (playingToday.has(t)) continue;
      const lm = lastMatchDate.get(t);
      if (!lm) continue;
      const daysSince = Math.round(
        (new Date(date + "T00:00:00Z").getTime() - new Date(lm + "T00:00:00Z").getTime()) / 86400000
      );
      if (daysSince <= 0) continue;
      const hist = eloHistory.get(t)!;
      const maSlice = hist.slice(-MA_WINDOW);
      const ma = maSlice.reduce((a, b) => a + b, 0) / maSlice.length;
      const factor = Math.max(0.5, 1 - decay * daysSince);
      elo.set(t, ma + (elo.get(t)! - ma) * factor);
    }

    // Match shocks
    for (const m of todaysMatches) {
      const homeElo = elo.get(m.home_team)!;
      const awayElo = elo.get(m.away_team)!;
      const sc = parseScore(m.score)!;
      const homeActual = sc[0] > sc[1] ? 1 : sc[0] === sc[1] ? 0.5 : 0;
      const awayActual = 1 - homeActual;

      const odds = oddsMap.get(m.fixture_id) ?? null;
      let homeExpected: number;
      let awayExpected: number;
      if (odds) {
        homeExpected = odds.homeProb * 1 + odds.drawProb * 0.5;
        awayExpected = odds.awayProb * 1 + odds.drawProb * 0.5;
      } else {
        homeExpected = eloExpected(homeElo, awayElo);
        awayExpected = 1 - homeExpected;
      }

      const homeShock = K * (homeActual - homeExpected);
      const awayShock = K * (awayActual - awayExpected);

      elo.set(m.home_team, homeElo + homeShock);
      elo.set(m.away_team, awayElo + awayShock);
      lastMatchDate.set(m.home_team, date);
      lastMatchDate.set(m.away_team, date);

      // Record events (for Q1 and Q5)
      allEvents.push({
        dateIdx, date, team: m.home_team, opponent: m.away_team,
        surprise: Math.abs(homeActual - homeExpected),
        actualScore: homeActual, expectedScore: homeExpected,
        shock: homeShock, eloBefore: homeElo, eloAfter: homeElo + homeShock,
        priceBefore: 0, priceAfter: 0, priceChangePct: 0,
        fixtureId: m.fixture_id, matchScore: m.score, usedOdds: !!odds,
      });
      allEvents.push({
        dateIdx, date, team: m.away_team, opponent: m.home_team,
        surprise: Math.abs(awayActual - awayExpected),
        actualScore: awayActual, expectedScore: awayExpected,
        shock: awayShock, eloBefore: awayElo, eloAfter: awayElo + awayShock,
        priceBefore: 0, priceAfter: 0, priceChangePct: 0,
        fixtureId: m.fixture_id, matchScore: m.score, usedOdds: !!odds,
      });
    }

    // Recenter
    let sum = 0;
    for (const t of allTeams) sum += elo.get(t)!;
    const shift = 1500 - sum / allTeams.length;
    for (const t of allTeams) elo.set(t, elo.get(t)! + shift);

    // Update history
    for (const t of allTeams) {
      const e = elo.get(t)!;
      const hist = eloHistory.get(t)!;
      hist.push(e);
      if (hist.length > MA_WINDOW + 30) hist.splice(0, hist.length - MA_WINDOW - 10);
      dailyElos.get(t)!.push(e);
    }
  }

  // Compute prices and fill in events
  for (const t of allTeams) {
    const elos = dailyElos.get(t)!;
    const prices = elos.map((e) => linearPrice(e, slope, zp));
    teamDailyPrices.set(t, prices);
  }

  for (const ev of allEvents) {
    const prices = teamDailyPrices.get(ev.team)!;
    ev.priceBefore = prices[ev.dateIdx];
    ev.priceAfter = prices[ev.dateIdx + 1];
    ev.priceChangePct = ev.priceBefore > 0 ? (ev.priceAfter - ev.priceBefore) / ev.priceBefore * 100 : 0;
  }

  // ═══════════════════════════════════════════════
  // Q1: Arsenal vs Chelsea walk-through
  // ═══════════════════════════════════════════════
  console.log("\n═══ Q1: Arsenal vs Chelsea 2026-03-01 (fixture 1379239) ═══\n");

  const arsenalEvent = allEvents.find(
    (e) => e.fixtureId === 1379239 && e.team === "Arsenal"
  )!;
  const chelseaEvent = allEvents.find(
    (e) => e.fixtureId === 1379239 && e.team === "Chelsea"
  )!;

  const odds = oddsMap.get(1379239)!;
  console.log("1. Fixture: 1379239 | Date: 2026-03-01 | Arsenal vs Chelsea | Score: 2-1");
  console.log(`2. Bookmakers at dbk=0: 25 bookmakers, 869 snapshot rows`);
  console.log(`3. Normalized probs: home=${odds.homeProb.toFixed(4)}, draw=${odds.drawProb.toFixed(4)}, away=${odds.awayProb.toFixed(4)}`);
  console.log(`4. Arsenal expected = ${odds.homeProb.toFixed(4)}*1 + ${odds.drawProb.toFixed(4)}*0.5 = ${arsenalEvent.expectedScore.toFixed(4)}`);
  console.log(`5. Actual score: W=1 (2-1 home win)`);
  console.log(`6. Surprise = |1 - ${arsenalEvent.expectedScore.toFixed(4)}| = ${arsenalEvent.surprise.toFixed(4)}`);
  console.log(`7. Arsenal Elo BEFORE: ${arsenalEvent.eloBefore.toFixed(2)}`);
  console.log(`8. Shock = ${K} * (1 - ${arsenalEvent.expectedScore.toFixed(4)}) = ${arsenalEvent.shock.toFixed(4)}`);
  console.log(`9. Arsenal Elo AFTER (pre-recenter): ${arsenalEvent.eloAfter.toFixed(2)}`);
  console.log(`10. Price before: $${arsenalEvent.priceBefore.toFixed(2)} | Price after: $${arsenalEvent.priceAfter.toFixed(2)} (slope=${slope}, zp=${zp})`);
  console.log(`11. Price change: ${arsenalEvent.priceChangePct.toFixed(4)}%`);

  console.log("\n--- Chelsea (opponent) ---");
  console.log(`Expected: ${chelseaEvent.expectedScore.toFixed(4)}, Actual: ${chelseaEvent.actualScore} (loss)`);
  console.log(`Shock: ${chelseaEvent.shock.toFixed(4)}`);
  console.log(`Arsenal shock + Chelsea shock = ${(arsenalEvent.shock + chelseaEvent.shock).toFixed(6)}`);
  console.log(`(Should be 0 — zero-sum system)`);
  console.log(`Chelsea Elo before: ${chelseaEvent.eloBefore.toFixed(2)}, after: ${chelseaEvent.eloAfter.toFixed(2)}`);
  console.log(`Chelsea price: $${chelseaEvent.priceBefore.toFixed(2)} → $${chelseaEvent.priceAfter.toFixed(2)} (${chelseaEvent.priceChangePct.toFixed(4)}%)`);

  // ═══════════════════════════════════════════════
  // Q5: Index deep dive
  // ═══════════════════════════════════════════════
  console.log("\n\n═══ Q5: Index Deep Dive (K=40, decay=0.001, zp=800) ═══\n");

  // Skip day 1 events
  const matchEventsSkip1 = allEvents.filter((e) => e.dateIdx > 0);

  // SURPRISE R²
  console.log("── SURPRISE R² = 0.857 ──");
  console.log(`Total match events in regression: ${matchEventsSkip1.length}`);

  // Top 5 biggest surprises
  const sorted = [...matchEventsSkip1].sort((a, b) => b.surprise - a.surprise);
  console.log("\nTop 5 HIGHEST surprise (biggest upsets):");
  for (let i = 0; i < 5; i++) {
    const e = sorted[i];
    console.log(
      `  ${e.date} ${e.team} vs ${e.opponent} (${e.matchScore}) | surprise=${e.surprise.toFixed(4)} | |priceMove|=${Math.abs(e.priceChangePct).toFixed(4)}% | expected=${e.expectedScore.toFixed(3)} actual=${e.actualScore}`
    );
  }

  // Bottom 5 lowest surprises
  const sortedAsc = [...matchEventsSkip1]
    .filter((e) => e.surprise > 0)
    .sort((a, b) => a.surprise - b.surprise);
  console.log("\nTop 5 LOWEST surprise (routine results):");
  for (let i = 0; i < 5; i++) {
    const e = sortedAsc[i];
    console.log(
      `  ${e.date} ${e.team} vs ${e.opponent} (${e.matchScore}) | surprise=${e.surprise.toFixed(4)} | |priceMove|=${Math.abs(e.priceChangePct).toFixed(4)}% | expected=${e.expectedScore.toFixed(3)} actual=${e.actualScore}`
    );
  }

  // Regression line slope/intercept
  const surprises: number[] = [];
  const absMoves: number[] = [];
  for (const e of matchEventsSkip1) {
    if (e.priceBefore <= 0) continue;
    surprises.push(e.surprise);
    absMoves.push(Math.abs(e.priceChangePct));
  }
  const n = surprises.length;
  const meanX = surprises.reduce((a, b) => a + b, 0) / n;
  const meanY = absMoves.reduce((a, b) => a + b, 0) / n;
  let ssXY = 0, ssXX = 0;
  for (let i = 0; i < n; i++) {
    ssXY += (surprises[i] - meanX) * (absMoves[i] - meanY);
    ssXX += (surprises[i] - meanX) ** 2;
  }
  const regSlope = ssXX > 0 ? ssXY / ssXX : 0;
  const regIntercept = meanY - regSlope * meanX;
  console.log(`\nRegression: |priceMove| = ${regSlope.toFixed(4)} * surprise + ${regIntercept.toFixed(4)}`);
  console.log(`n = ${n} match events`);

  // MR SHARPE
  console.log("\n── MR SHARPE = 0.310 ──");
  const teamMatchDays = new Map<string, Map<number, number>>();
  for (const e of matchEventsSkip1) {
    if (!teamMatchDays.has(e.team)) teamMatchDays.set(e.team, new Map());
    teamMatchDays.get(e.team)!.set(e.dateIdx, e.actualScore);
  }

  interface Trade {
    team: string;
    direction: string;
    dateIdx: number;
    returns: number[];
    totalReturn: number;
  }
  const trades: Trade[] = [];
  let totalPnlDays = 0;
  let totalPnlSum = 0;
  const dailyPnls: number[] = [];

  for (const team of allTeams) {
    const prices = teamDailyPrices.get(team)!;
    const returns: number[] = [];
    for (let i = 0; i < prices.length - 1; i++) {
      returns.push(prices[i] > 0 ? (prices[i + 1] - prices[i]) / prices[i] : 0);
    }
    const matchDays = teamMatchDays.get(team) ?? new Map();
    let position = 0;
    let holdDays = 0;
    let currentTrade: Trade | null = null;

    for (let i = 1; i < returns.length; i++) {
      if (position !== 0) {
        const pnl = position * returns[i];
        dailyPnls.push(pnl);
        totalPnlDays++;
        totalPnlSum += pnl;
        if (currentTrade) currentTrade.returns.push(pnl);
        holdDays--;
        if (holdDays <= 0) {
          if (currentTrade) {
            currentTrade.totalReturn = currentTrade.returns.reduce((a, b) => a + b, 0);
            trades.push(currentTrade);
          }
          position = 0;
          currentTrade = null;
        }
      }
      const actual = matchDays.get(i);
      if (actual !== undefined) {
        if (actual === 0) {
          position = 1;
          holdDays = 3;
          currentTrade = { team, direction: "LONG (after loss)", dateIdx: i, returns: [], totalReturn: 0 };
        } else if (actual === 1) {
          position = -1;
          holdDays = 3;
          currentTrade = { team, direction: "SHORT (after win)", dateIdx: i, returns: [], totalReturn: 0 };
        }
      }
    }
  }

  console.log(`Total trades: ${trades.length}`);
  const winTrades = trades.filter((t) => t.totalReturn > 0);
  console.log(`Win rate: ${winTrades.length}/${trades.length} = ${((winTrades.length / trades.length) * 100).toFixed(1)}%`);
  console.log(`Avg return per trade: ${(trades.reduce((a, t) => a + t.totalReturn, 0) / trades.length * 100).toFixed(4)}%`);
  console.log(`Total daily PnL entries: ${dailyPnls.length}`);
  const meanPnl = dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length;
  const stdPnl = Math.sqrt(dailyPnls.reduce((a, r) => a + (r - meanPnl) ** 2, 0) / dailyPnls.length);
  console.log(`Sharpe = (${(meanPnl * 100).toFixed(6)}% / ${(stdPnl * 100).toFixed(6)}%) * sqrt(365) = ${((meanPnl / stdPnl) * Math.sqrt(365)).toFixed(4)}`);

  const sortedTrades = [...trades].sort((a, b) => b.totalReturn - a.totalReturn);
  console.log("\n3 most profitable trades:");
  for (let i = 0; i < 3 && i < sortedTrades.length; i++) {
    const t = sortedTrades[i];
    console.log(`  ${t.team} ${t.direction} dateIdx=${t.dateIdx} → ${(t.totalReturn * 100).toFixed(4)}%`);
  }
  console.log("3 most losing trades:");
  for (let i = sortedTrades.length - 1; i >= sortedTrades.length - 3 && i >= 0; i--) {
    const t = sortedTrades[i];
    console.log(`  ${t.team} ${t.direction} dateIdx=${t.dateIdx} → ${(t.totalReturn * 100).toFixed(4)}%`);
  }

  // INFO RATIO
  console.log("\n── INFO RATIO = 0.887 ──");
  const leagues = new Set(teamLeague.values());
  for (const league of leagues) {
    const teams = allTeams.filter((t) => teamLeague.get(t) === league);
    if (teams.length < 5) continue;
    const teamFinalPrice = new Map<string, number>();
    for (const t of teams) {
      const prices = teamDailyPrices.get(t)!;
      teamFinalPrice.set(t, prices[prices.length - 1]);
    }
    const byPrice = [...teams].sort((a, b) => (teamFinalPrice.get(b) ?? 0) - (teamFinalPrice.get(a) ?? 0));
    const priceRank = new Map<string, number>();
    byPrice.forEach((t, i) => priceRank.set(t, i + 1));
    const byPoints = [...teams].sort((a, b) => (teamPoints.get(b) ?? 0) - (teamPoints.get(a) ?? 0));
    const ptsRank = new Map<string, number>();
    byPoints.forEach((t, i) => ptsRank.set(t, i + 1));
    let dSq = 0;
    for (const t of teams) {
      const d2 = (priceRank.get(t) ?? 0) - (ptsRank.get(t) ?? 0);
      dSq += d2 * d2;
    }
    const rho = 1 - (6 * dSq) / (teams.length * (teams.length ** 2 - 1));
    console.log(`  ${league}: ρ = ${rho.toFixed(4)} (${teams.length} teams)`);

    // Show biggest mispricings for worst league
    if (rho < 0.85) {
      console.log(`    ↳ Biggest mispricings:`);
      const mispriced = teams
        .map((t) => ({
          team: t,
          priceRank: priceRank.get(t)!,
          ptsRank: ptsRank.get(t)!,
          gap: Math.abs((priceRank.get(t) ?? 0) - (ptsRank.get(t) ?? 0)),
        }))
        .sort((a, b) => b.gap - a.gap);
      for (let i = 0; i < 3; i++) {
        const m2 = mispriced[i];
        console.log(
          `      ${m2.team}: price rank #${m2.priceRank} vs pts rank #${m2.ptsRank} (gap ${m2.gap})`
        );
      }
    }
  }

  // KURTOSIS — top 5 extreme returns after day 1 skip
  console.log("\n── KURTOSIS = 17.3 (after day-1 skip) ──");
  console.log("Top 5 most extreme daily returns (post day 1):");
  const extremeReturns: { team: string; dateIdx: number; date: string; ret: number }[] = [];
  for (const t of allTeams) {
    const prices = teamDailyPrices.get(t)!;
    for (let i = 2; i < prices.length; i++) {
      // returns[i-1] = (prices[i] - prices[i-1]) / prices[i-1]
      if (prices[i - 1] <= 0) continue;
      const ret = (prices[i] - prices[i - 1]) / prices[i - 1];
      extremeReturns.push({ team: t, dateIdx: i - 1, date: dates[i - 1] ?? "?", ret });
    }
  }
  extremeReturns.sort((a, b) => Math.abs(b.ret) - Math.abs(a.ret));
  for (let i = 0; i < 5; i++) {
    const e = extremeReturns[i];
    // Find what match happened
    const matchesOnDate = matchesByDate.get(e.date) ?? [];
    const relevantMatch = matchesOnDate.find(
      (m) => m.home_team === e.team || m.away_team === e.team
    );
    const matchInfo = relevantMatch
      ? `${relevantMatch.home_team} ${relevantMatch.score} ${relevantMatch.away_team}`
      : "(no match — carry/recenter only)";
    console.log(
      `  ${e.team} ${e.date} return=${(e.ret * 100).toFixed(4)}% | ${matchInfo}`
    );
  }

  // Match count using odds vs fallback
  const withOdds = allEvents.filter((e) => e.usedOdds).length / 2;
  const withoutOdds = allEvents.filter((e) => !e.usedOdds).length / 2;
  console.log(`\n── Odds vs Fallback ──`);
  console.log(`Matches with bookmaker odds: ${withOdds}`);
  console.log(`Matches with Elo fallback: ${withoutOdds}`);
  console.log(`Total: ${withOdds + withoutOdds}`);

  // Show 5 examples of fallback matches
  const fallbacks = allEvents.filter((e) => !e.usedOdds && e.team === e.opponent ? false : true);
  const seenFixtures = new Set<number>();
  console.log("\n5 fallback match examples:");
  let count = 0;
  for (const e of fallbacks) {
    if (seenFixtures.has(e.fixtureId)) continue;
    seenFixtures.add(e.fixtureId);
    console.log(`  fixture=${e.fixtureId} ${e.date} ${e.team} vs ${e.opponent}`);
    count++;
    if (count >= 5) break;
  }
}

main().catch(console.error);
