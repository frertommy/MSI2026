import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string
);

const avg = (a: number[]) => a.length === 0 ? null : a.reduce((s, v) => s + v, 0) / a.length;
const median = (a: number[]) => {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/** Paginated fetch from odds_snapshots for a single fixture_id */
async function fetchAllOddsForFixture(fid: number) {
  const all: any[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data } = await sb
      .from("odds_snapshots")
      .select("fixture_id, bookmaker, snapshot_time, home_odds, draw_odds, away_odds")
      .eq("fixture_id", fid)
      .order("snapshot_time", { ascending: true })
      .range(from, from + pageSize - 1);
    if (data == null || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function main() {
  // 1. All Arsenal prices (oracle model)
  const { data: prices } = await sb
    .from("team_prices")
    .select("date, dollar_price, implied_elo")
    .eq("team", "Arsenal")
    .eq("model", "oracle")
    .order("date", { ascending: true });

  // 2. All Arsenal matches (both API-Football and synthetic IDs)
  const { data: homeM } = await sb.from("matches")
    .select("fixture_id, date, home_team, away_team, score, status")
    .eq("home_team", "Arsenal").order("date", { ascending: true });
  const { data: awayM } = await sb.from("matches")
    .select("fixture_id, date, home_team, away_team, score, status")
    .eq("away_team", "Arsenal").order("date", { ascending: true });

  const allMatches = [...(homeM ?? []), ...(awayM ?? [])];
  allMatches.sort((a, b) => a.date.localeCompare(b.date));

  // Build: for each date+home+away key, collect ALL fixture_ids AND pick the best match row
  const matchByKey = new Map<string, typeof allMatches[0]>();
  const allFixtureIdsByKey = new Map<string, number[]>();
  for (const m of allMatches) {
    const key = `${m.date}|${m.home_team}|${m.away_team}`;
    if (!allFixtureIdsByKey.has(key)) allFixtureIdsByKey.set(key, []);
    allFixtureIdsByKey.get(key)?.push(m.fixture_id);
    const existing = matchByKey.get(key);
    if (!existing) {
      matchByKey.set(key, m);
    } else if (m.status === "finished" && existing.status !== "finished") {
      matchByKey.set(key, m);
    }
  }
  const dedupMatches = [...matchByKey.values()].sort((a, b) => a.date.localeCompare(b.date));

  // 3 month cutoff
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const recentMatches = dedupMatches.filter(m => m.date >= cutoff);
  const recentPrices = (prices ?? []).filter(p => p.date >= cutoff);

  const allPrices = prices ?? [];
  const threeMonthAgo = allPrices.filter(p => p.date <= cutoff);
  const priceStart = threeMonthAgo.length > 0 ? threeMonthAgo[threeMonthAgo.length - 1] : allPrices[0];
  const priceEnd = allPrices[allPrices.length - 1];

  console.log("════════════════════════════════════════════════════════════════");
  console.log("  ARSENAL — 3-MONTH REPORT");
  console.log("════════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  SNAPSHOT COMPARISON");
  console.log("  ┌─────────────┬────────────────┬──────────────┐");
  console.log("  │             │  3 Months Ago  │    Current   │");
  console.log("  ├─────────────┼────────────────┼──────────────┤");
  console.log(`  │ Date        │  ${(priceStart?.date ?? "N/A").padEnd(12)}  │  ${(priceEnd?.date ?? "N/A").padEnd(10)}  │`);
  console.log(`  │ Price       │  $${(priceStart?.dollar_price ?? 0).toFixed(2).padEnd(11)}  │  $${(priceEnd?.dollar_price ?? 0).toFixed(2).padEnd(9)}  │`);
  console.log(`  │ Implied Elo │  ${Math.round(priceStart?.implied_elo ?? 0).toString().padEnd(12)}  │  ${Math.round(priceEnd?.implied_elo ?? 0).toString().padEnd(10)}  │`);
  console.log("  └─────────────┴────────────────┴──────────────┘");
  const priceChg = priceEnd && priceStart
    ? ((priceEnd.dollar_price - priceStart.dollar_price) / priceStart.dollar_price * 100).toFixed(1)
    : "N/A";
  const eloChg = priceEnd && priceStart
    ? (priceEnd.implied_elo - priceStart.implied_elo).toFixed(1)
    : "N/A";
  console.log(`  Price Δ: ${priceChg}%  |  Elo Δ: ${eloChg}`);
  console.log("");

  // Daily price table
  console.log("════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("  DAILY PRICE/ELO LOG (last 3 months) — matches highlighted");
  console.log("════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("  Date        │ Price    │ Elo    │ Δ$      │ ΔElo   │ Match");
  console.log("  ────────────┼──────────┼────────┼─────────┼────────┼──────────────────────────────────────────");

  const matchByDate = new Map<string, typeof dedupMatches[0]>();
  for (const m of dedupMatches) matchByDate.set(m.date, m);

  let prevPrice: number | null = null;
  let prevElo: number | null = null;
  for (const p of recentPrices) {
    const dp = prevPrice !== null ? p.dollar_price - prevPrice : 0;
    const de = prevElo !== null ? p.implied_elo - prevElo : 0;
    const dpStr = prevPrice !== null ? (dp >= 0 ? "+" : "") + dp.toFixed(2) : "  ---";
    const deStr = prevElo !== null ? (de >= 0 ? "+" : "") + de.toFixed(1) : " ---";
    const match = matchByDate.get(p.date);
    let matchStr = "";
    if (match) {
      const isHome = match.home_team === "Arsenal";
      const opp = isHome ? match.away_team : match.home_team;
      const venue = isHome ? "vs" : "@";
      const score = match.score ?? "N/A";
      let result = "";
      if (match.status === "finished" && score && score !== "N/A") {
        const parts = score.split("-");
        if (parts.length === 2) {
          const hg = parseInt(parts[0].trim()), ag = parseInt(parts[1].trim());
          if (hg === ag) result = "D";
          else if (isHome) result = hg > ag ? "W" : "L";
          else result = ag > hg ? "W" : "L";
        }
      }
      matchStr = `⚽ ${venue} ${opp} ${score} ${result}`;
    }
    console.log(`  ${p.date}  │ $${p.dollar_price.toFixed(2).padStart(6)} │ ${Math.round(p.implied_elo).toString().padStart(5)}  │ ${dpStr.padStart(7)} │ ${deStr.padStart(6)} │ ${matchStr}`);
    prevPrice = p.dollar_price;
    prevElo = p.implied_elo;
  }

  // Match results
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("  MATCH RESULTS (last 3 months)");
  console.log("════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("  Date        │ H/A │ Score │ Res │ Opponent                  │ Price Impact");
  console.log("  ────────────┼─────┼───────┼─────┼───────────────────────────┼──────────────");

  const priceByDate = new Map<string, { dollar_price: number; implied_elo: number }>();
  for (const p of (prices ?? [])) priceByDate.set(p.date, p);

  let w = 0, d = 0, l = 0;
  for (const m of recentMatches) {
    if (m.status !== "finished") continue;
    const isHome = m.home_team === "Arsenal";
    const opp = isHome ? m.away_team : m.home_team;
    const venue = isHome ? "H" : "A";
    const score = m.score ?? "N/A";
    let result = "";
    const parts = score.split("-");
    if (parts.length === 2) {
      const hg = parseInt(parts[0].trim()), ag = parseInt(parts[1].trim());
      if (hg === ag) { result = "D"; d++; }
      else if (isHome) { result = hg > ag ? "W" : "L"; if (result === "W") w++; else l++; }
      else { result = ag > hg ? "W" : "L"; if (result === "W") w++; else l++; }
    }
    const priceOn = priceByDate.get(m.date);
    const allDates = [...priceByDate.keys()].sort();
    const idx = allDates.indexOf(m.date);
    const prevP = idx > 0 ? priceByDate.get(allDates[idx - 1]) : null;
    const impact = priceOn && prevP ? priceOn.dollar_price - prevP.dollar_price : null;
    const impactStr = impact !== null ? `${impact >= 0 ? "+" : ""}$${impact.toFixed(2)}` : "---";
    console.log(`  ${m.date}  │  ${venue}  │ ${score.padEnd(5)} │  ${result}  │ ${opp.padEnd(25)} │ ${impactStr}`);
  }
  console.log("");
  console.log(`  Record: ${w}W ${d}D ${l}L  (Win%: ${((w / (w + d + l)) * 100).toFixed(0)}%)`);

  // 3. ODDS DATA — fetch ALL odds per match with pagination
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("  ODDS DATA — Arsenal fixtures (last 3 months)");
  console.log("════════════════════════════════════════════════════════════════════════════════════════════════════════");

  // Fetch odds for each match (all fixture_ids, paginated)
  const oddsByMatchKey = new Map<string, any[]>();
  let totalFetched = 0;

  for (const m of recentMatches) {
    const key = `${m.date}|${m.home_team}|${m.away_team}`;
    const fids = allFixtureIdsByKey.get(key) ?? [m.fixture_id];
    let matchOdds: any[] = [];
    for (const fid of fids) {
      const odds = await fetchAllOddsForFixture(fid);
      matchOdds.push(...odds);
    }
    oddsByMatchKey.set(key, matchOdds);
    totalFetched += matchOdds.length;
    process.stderr.write(`  Fetched ${matchOdds.length} odds for ${m.date} ${m.home_team} vs ${m.away_team} (${fids.length} fids)\n`);
  }

  console.log(`  Total odds snapshots: ${totalFetched}`);
  console.log("");

  // Per-match odds table
  console.log("  Match                                  │ Snaps  │ Arsenal Win          │ Draw                 │ Arsenal Lose");
  console.log("                                         │        │ Avg    Med    Imp%    │ Avg    Med    Imp%   │ Avg    Med    Imp%");
  console.log("  ───────────────────────────────────────┼────────┼──────────────────────┼──────────────────────┼─────────────────────");

  let totalArsenalWin: number[] = [];
  let totalDraw: number[] = [];
  let totalArsenalLose: number[] = [];

  for (const m of recentMatches) {
    const key = `${m.date}|${m.home_team}|${m.away_team}`;
    const odds = oddsByMatchKey.get(key) ?? [];
    if (odds.length === 0) continue;

    const isHome = m.home_team === "Arsenal";
    const opp = isHome ? m.away_team : m.home_team;
    const venue = isHome ? "vs" : "@";
    const score = m.status === "finished" ? m.score : "upcoming";

    const arsenalWin = odds.map((o: any) => isHome ? o.home_odds : o.away_odds).filter(Boolean);
    const drawOdds = odds.map((o: any) => o.draw_odds).filter(Boolean);
    const arsenalLose = odds.map((o: any) => isHome ? o.away_odds : o.home_odds).filter(Boolean);

    totalArsenalWin.push(...arsenalWin);
    totalDraw.push(...drawOdds);
    totalArsenalLose.push(...arsenalLose);

    const fmtCol = (arr: number[]) => {
      const a = avg(arr);
      const m = median(arr);
      const imp = a ? (1 / a * 100) : 0;
      return `${a?.toFixed(2).padStart(5) ?? "  N/A"} ${m?.toFixed(2).padStart(5) ?? "  N/A"} ${imp.toFixed(0).padStart(4)}%`;
    };

    const label = `${m.date} ${venue} ${opp} ${score}`;
    console.log(`  ${label.padEnd(39)} │ ${odds.length.toString().padStart(5)}  │ ${fmtCol(arsenalWin)}   │ ${fmtCol(drawOdds)}  │ ${fmtCol(arsenalLose)}`);
  }

  // Overall
  console.log("  ───────────────────────────────────────┼────────┼──────────────────────┼──────────────────────┼─────────────────────");
  const fmtOverall = (arr: number[]) => {
    const a = avg(arr);
    const m = median(arr);
    const imp = a ? (1 / a * 100) : 0;
    return `${a?.toFixed(2).padStart(5) ?? "  N/A"} ${m?.toFixed(2).padStart(5) ?? "  N/A"} ${imp.toFixed(0).padStart(4)}%`;
  };
  console.log(`  ${"OVERALL (all matches)".padEnd(39)} │ ${totalFetched.toString().padStart(5)}  │ ${fmtOverall(totalArsenalWin)}   │ ${fmtOverall(totalDraw)}  │ ${fmtOverall(totalArsenalLose)}`);

  // Bookmaker breakdown
  console.log("");
  console.log("  ─── BY BOOKMAKER (Arsenal Win odds — all matches combined) ───");
  console.log("  Bookmaker              │ Avg    │ Median │ Implied% │ Snapshots");
  console.log("  ───────────────────────┼────────┼────────┼──────────┼──────────");

  const byBookmaker = new Map<string, number[]>();
  for (const m of recentMatches) {
    const key = `${m.date}|${m.home_team}|${m.away_team}`;
    const odds = oddsByMatchKey.get(key) ?? [];
    const isHome = m.home_team === "Arsenal";
    for (const o of odds) {
      const winOdds = isHome ? o.home_odds : o.away_odds;
      if (winOdds == null) continue;
      if (!byBookmaker.has(o.bookmaker)) byBookmaker.set(o.bookmaker, []);
      byBookmaker.get(o.bookmaker)?.push(winOdds);
    }
  }

  const sorted = [...byBookmaker.entries()].sort((a, b) => (avg(a[1]) ?? 99) - (avg(b[1]) ?? 99));
  for (const [bk, odds] of sorted) {
    const a = avg(odds);
    const m = median(odds);
    const imp = a ? (1 / a * 100) : 0;
    console.log(`  ${bk.padEnd(23)} │ ${a?.toFixed(2).padStart(6)} │ ${m?.toFixed(2).padStart(6)} │ ${imp.toFixed(1).padStart(7)}% │ ${odds.length}`);
  }

  // Pinnacle deep-dive
  console.log("");
  console.log("  ─── PINNACLE ODDS PER MATCH ───");
  for (const m of recentMatches) {
    if (m.status !== "finished") continue;
    const key = `${m.date}|${m.home_team}|${m.away_team}`;
    const odds = oddsByMatchKey.get(key) ?? [];
    const isHome = m.home_team === "Arsenal";
    const opp = isHome ? m.away_team : m.home_team;
    const pinnacle = odds.filter((o: any) => o.bookmaker === "pinnacle");
    if (pinnacle.length === 0) continue;
    const pw = pinnacle.map((o: any) => isHome ? o.home_odds : o.away_odds).filter(Boolean);
    const pd = pinnacle.map((o: any) => o.draw_odds).filter(Boolean);
    const pl = pinnacle.map((o: any) => isHome ? o.away_odds : o.home_odds).filter(Boolean);
    console.log(`  ${m.date} ${isHome ? "vs" : "@"} ${opp.padEnd(20)} │ Win: ${avg(pw)?.toFixed(2)} (${(1/(avg(pw) ?? 1)*100).toFixed(0)}%)  Draw: ${avg(pd)?.toFixed(2)} (${(1/(avg(pd) ?? 1)*100).toFixed(0)}%)  Lose: ${avg(pl)?.toFixed(2)} (${(1/(avg(pl) ?? 1)*100).toFixed(0)}%)  n=${pinnacle.length}`);
  }
}

main().catch(console.error);
