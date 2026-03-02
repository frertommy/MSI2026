"use client";

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { MatchRow, OddsConsensus, PriceHistoryRow } from "./page";

// ─── Constants ───────────────────────────────────────────────
const LEAGUE_SHORT: Record<string, string> = {
  "Premier League": "EPL",
  "La Liga": "ESP",
  Bundesliga: "BUN",
  "Serie A": "ITA",
  "Ligue 1": "FRA",
};

const LEAGUE_COLOR: Record<string, string> = {
  "Premier League": "#a855f7",
  "La Liga": "#fb923c",
  Bundesliga: "#f87171",
  "Serie A": "#60a5fa",
  "Ligue 1": "#22d3ee",
};

const tooltipStyle = {
  backgroundColor: "#111",
  border: "1px solid #333",
  borderRadius: "4px",
  fontFamily: "monospace",
  fontSize: "11px",
};

// ─── Parameter Types ─────────────────────────────────────────
interface SimParams {
  priorPull: number;
  carryDecay: number;
  shockK: number;
  shockHalfLife: number;
  priceMapping: "logistic" | "linear" | "exponential";
  linearSlope: number;
  linearOffset: number;
  linearFloor: number;
  linearCeiling: number;
  expScale: number;
  logisticSpread: number;
  calendarAwareDecay: boolean;
  anchorMode: "fixed" | "30d" | "45d" | "60d";
  propVol: number;
}

// ─── Presets ─────────────────────────────────────────────────
interface Preset {
  name: string;
  desc: string;
  params: SimParams;
}

const BASE_PARAMS: SimParams = {
  priorPull: 0.15,
  carryDecay: 0.005,
  shockK: 20,
  shockHalfLife: 10,
  priceMapping: "logistic",
  linearSlope: 10,
  linearOffset: 1000,
  linearFloor: 10,
  linearCeiling: 150,
  expScale: 600,
  logisticSpread: 220,
  calendarAwareDecay: false,
  anchorMode: "fixed",
  propVol: 0,
};

const PRESETS: Preset[] = [
  {
    name: "Current (broken)",
    desc: "Pure Elo, fixed anchor. Arsenal flat, Lecce wild.",
    params: { ...BASE_PARAMS },
  },
  {
    name: "Balanced",
    desc: "Less mean reversion, bigger shocks. Fixes structural drift.",
    params: {
      ...BASE_PARAMS,
      priorPull: 0.06,
      carryDecay: 0.001,
      shockK: 28,
      shockHalfLife: 7,
      calendarAwareDecay: true,
    },
  },
  {
    name: "Tradeable",
    desc: "Balanced mix. All teams 20-30% annual vol. No sure bets.",
    params: {
      ...BASE_PARAMS,
      priorPull: 0.06,
      carryDecay: 0.001,
      shockK: 30,
      shockHalfLife: 7,
      calendarAwareDecay: true,
      priceMapping: "linear",
      linearFloor: 10,
      linearCeiling: 150,
    },
  },
  {
    name: "High Volatility",
    desc: "Big swings. For leverage lovers.",
    params: {
      ...BASE_PARAMS,
      priorPull: 0.03,
      carryDecay: 0.0005,
      shockK: 40,
      shockHalfLife: 5,
      calendarAwareDecay: true,
      priceMapping: "linear",
      linearFloor: 10,
      linearCeiling: 150,
    },
  },
  {
    name: "Degen",
    desc: "Maximum chaos. 40%+ annual vol.",
    params: {
      ...BASE_PARAMS,
      priorPull: 0.01,
      carryDecay: 0,
      shockK: 50,
      shockHalfLife: 4,
      calendarAwareDecay: true,
      priceMapping: "linear",
      linearFloor: 5,
      linearCeiling: 200,
    },
  },
];

// ─── Seeded RNG (xorshift32) ─────────────────────────────────
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function xorshift32(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

// Box-Muller for seeded gaussian
function seededGaussian(rng: () => number): number {
  const u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
}

// ─── Price Mapping Functions ─────────────────────────────────
function mapPrice(elo: number, params: SimParams): number {
  switch (params.priceMapping) {
    case "logistic":
      return 100 / (1 + Math.exp(-(elo - 1500) / params.logisticSpread));
    case "linear": {
      const raw = (elo - params.linearOffset) / params.linearSlope;
      return Math.max(params.linearFloor, Math.min(params.linearCeiling, raw));
    }
    case "exponential":
      return 50 * Math.exp((elo - 1500) / params.expScale);
  }
}

// ─── Helpers ─────────────────────────────────────────────────
function parseScore(score: string): [number, number] | null {
  const parts = score.split("-");
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0].trim());
  const a = parseInt(parts[1].trim());
  if (isNaN(h) || isNaN(a)) return null;
  return [h, a];
}

function daysBetween(a: string, b: string): number {
  return Math.abs(
    (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24)
  );
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Simulation Engine ──────────────────────────────────────
interface SimPoint {
  date: string;
  elo: number;
  price: number;
}

function runSimulation(
  startingElos: { team: string; league: string; startingElo: number }[],
  matches: MatchRow[],
  oddsMap: Map<number, { homeProb: number; drawProb: number; awayProb: number }>,
  params: SimParams
): Map<string, SimPoint[]> {
  const teamElo = new Map<string, number>();
  const teamLeague = new Map<string, string>();
  const teamStartElo = new Map<string, number>();
  const teamLastMatch = new Map<string, string>();
  const teamSeries = new Map<string, SimPoint[]>();
  // Per-team recent elo history for MA anchor
  const teamEloHistory = new Map<string, number[]>();

  for (const t of startingElos) {
    teamElo.set(t.team, t.startingElo);
    teamLeague.set(t.team, t.league);
    teamStartElo.set(t.team, t.startingElo);
    teamSeries.set(t.team, []);
    teamEloHistory.set(t.team, [t.startingElo]);
  }

  const playedMatches = matches
    .filter((m) => parseScore(m.score) !== null)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (playedMatches.length === 0) return teamSeries;

  const startDate = playedMatches[0].date;
  const lastMatchDate = playedMatches[playedMatches.length - 1].date;

  const matchesByDate = new Map<string, MatchRow[]>();
  for (const m of playedMatches) {
    if (!matchesByDate.has(m.date)) matchesByDate.set(m.date, []);
    matchesByDate.get(m.date)!.push(m);
  }

  // Future match dates per team for calendar-aware decay
  const teamMatchDates = new Map<string, string[]>();
  for (const m of playedMatches) {
    if (!teamMatchDates.has(m.home_team)) teamMatchDates.set(m.home_team, []);
    if (!teamMatchDates.has(m.away_team)) teamMatchDates.set(m.away_team, []);
    teamMatchDates.get(m.home_team)!.push(m.date);
    teamMatchDates.get(m.away_team)!.push(m.date);
  }

  // Shock log
  const shockLog = new Map<string, { date: string; amount: number }[]>();
  for (const t of startingElos) shockLog.set(t.team, []);

  let currentDate = startDate;
  while (currentDate <= lastMatchDate) {
    const todayMatches = matchesByDate.get(currentDate) ?? [];
    const teamsPlayingToday = new Set<string>();

    // League means
    const leagueElos = new Map<string, number[]>();
    for (const [team, elo] of teamElo) {
      const league = teamLeague.get(team) ?? "";
      if (!leagueElos.has(league)) leagueElos.set(league, []);
      leagueElos.get(league)!.push(elo);
    }
    const leagueMean = new Map<string, number>();
    for (const [league, elos] of leagueElos) {
      leagueMean.set(league, elos.reduce((a, b) => a + b, 0) / elos.length);
    }

    for (const m of todayMatches) {
      teamsPlayingToday.add(m.home_team);
      teamsPlayingToday.add(m.away_team);
    }

    // Carry decay
    for (const [team, elo] of teamElo) {
      if (teamsPlayingToday.has(team)) {
        teamLastMatch.set(team, currentDate);
        continue;
      }
      const lastMatch = teamLastMatch.get(team);
      if (!lastMatch) continue;

      if (params.calendarAwareDecay) {
        const futureDates = teamMatchDates.get(team) ?? [];
        const nextMatch = futureDates.find((d) => d > currentDate);
        if (!nextMatch || daysBetween(currentDate, nextMatch) > 7) continue;
      }

      const daysSince = daysBetween(lastMatch, currentDate);
      const decayFactor = Math.max(0.5, 1 - params.carryDecay * daysSince);

      // Anchor selection
      let anchor: number;
      if (params.anchorMode === "fixed") {
        anchor = leagueMean.get(teamLeague.get(team) ?? "") ?? 1500;
      } else {
        const maDays = params.anchorMode === "30d" ? 30 : params.anchorMode === "45d" ? 45 : 60;
        const history = teamEloHistory.get(team) ?? [];
        const window = history.slice(-maDays);
        anchor = window.length > 0
          ? window.reduce((a, b) => a + b, 0) / window.length
          : elo;
      }

      teamElo.set(team, anchor + (elo - anchor) * decayFactor);
    }

    // Match shocks
    for (const m of todayMatches) {
      const odds = oddsMap.get(m.fixture_id);
      if (!odds) continue;
      const parsed = parseScore(m.score);
      if (!parsed) continue;
      const [hg, ag] = parsed;

      const homeElo = teamElo.get(m.home_team) ?? 1500;
      const awayElo = teamElo.get(m.away_team) ?? 1500;
      const mean = leagueMean.get(m.league) ?? 1500;

      const homeEffK = params.shockK * (1 + (awayElo - mean) / 400);
      const awayEffK = params.shockK * (1 + (homeElo - mean) / 400);

      const homeActual = hg > ag ? 3 : hg === ag ? 1 : 0;
      const homeExpected = 3 * odds.homeProb + 1 * odds.drawProb;
      const homeShock = (homeActual - homeExpected) * homeEffK;

      const awayActual = ag > hg ? 3 : ag === hg ? 1 : 0;
      const awayExpected = 3 * odds.awayProb + 1 * odds.drawProb;
      const awayShock = (awayActual - awayExpected) * awayEffK;

      if (shockLog.has(m.home_team)) {
        shockLog.get(m.home_team)!.push({ date: currentDate, amount: homeShock });
      }
      if (shockLog.has(m.away_team)) {
        shockLog.get(m.away_team)!.push({ date: currentDate, amount: awayShock });
      }
    }

    // Prior pull
    const dailyPull = params.priorPull / 50;
    for (const [team, elo] of teamElo) {
      const startElo = teamStartElo.get(team) ?? 1500;
      teamElo.set(team, elo * (1 - dailyPull) + startElo * dailyPull);
    }

    // Re-center
    const allElos = [...teamElo.values()];
    const globalMean = allElos.reduce((a, b) => a + b, 0) / allElos.length;
    const recentering = 1500 - globalMean;
    for (const [team, elo] of teamElo) {
      teamElo.set(team, elo + recentering);
    }

    // Compute final elo (base + shock boost) and price
    for (const [team, baseElo] of teamElo) {
      const shocks = shockLog.get(team) ?? [];
      let boost = 0;
      for (const s of shocks) {
        if (s.date > currentDate) continue;
        const age = daysBetween(s.date, currentDate);
        boost += s.amount * Math.pow(0.5, age / params.shockHalfLife);
      }
      let finalElo = baseElo + boost;

      // Proportional volatility noise
      if (params.propVol > 0) {
        const price = mapPrice(finalElo, params);
        const rng = xorshift32(hashStr(team + currentDate));
        const noise = params.propVol * price * 0.01 * seededGaussian(rng);
        // Convert price noise back to elo delta (approximate via sensitivity)
        const p1 = mapPrice(finalElo + 1, params);
        const p0 = mapPrice(finalElo, params);
        const sensitivity = Math.abs(p1 - p0);
        if (sensitivity > 0.0001) {
          finalElo += noise / sensitivity;
        }
      }

      const price = mapPrice(finalElo, params);
      teamSeries.get(team)!.push({
        date: currentDate,
        elo: Math.round(finalElo * 10) / 10,
        price: Math.round(price * 100) / 100,
      });

      // Track elo history for MA anchor
      const hist = teamEloHistory.get(team);
      if (hist) hist.push(finalElo);
    }

    currentDate = addDays(currentDate, 1);
  }

  return teamSeries;
}

// ─── Index Computation ──────────────────────────────────────
interface SimIndexes {
  noSureBets: number;      // % teams with drift < 15%
  topDelta: number;
  botDelta: number;
  gapDelta: number;
  annualVol: number;       // avg annualized vol
  topVol: number;
  midVol: number;
  botVol: number;
  volUniformity: number;   // ratio top/bot tier vol
  volRatio: number;
  bigMoveDays: number;     // days/yr with >1.5% move
  noDeadPct: number;       // % days non-flat
  longestFlat: number;     // longest <0.3% streak
}

function computeIndexes(
  simResult: Map<string, SimPoint[]>,
  startingElos: { team: string; startingElo: number }[]
): SimIndexes {
  const teams = [...simResult.keys()];
  if (teams.length === 0) {
    return {
      noSureBets: 0, topDelta: 0, botDelta: 0, gapDelta: 0,
      annualVol: 0, topVol: 0, midVol: 0, botVol: 0,
      volUniformity: 0, volRatio: 0,
      bigMoveDays: 0, noDeadPct: 0, longestFlat: 0,
    };
  }

  const startEloMap = new Map(startingElos.map((t) => [t.team, t.startingElo]));

  // Per-team metrics
  const teamDeltas: number[] = [];
  const teamVols: { team: string; elo: number; vol: number }[] = [];
  let totalBigDays = 0;
  let totalDays = 0;
  let worstFlat = 0;
  let totalNonFlat = 0;
  let totalDayCount = 0;

  for (const team of teams) {
    const series = simResult.get(team)!;
    if (series.length < 2) continue;

    const startP = series[0].price;
    const endP = series[series.length - 1].price;
    const delta = startP > 0 ? ((endP - startP) / startP) * 100 : 0;
    teamDeltas.push(delta);

    // Daily % changes
    const dailyPcts: number[] = [];
    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1].price;
      if (prev > 0) {
        dailyPcts.push(((series[i].price - prev) / prev) * 100);
      }
    }

    // Annualized vol
    if (dailyPcts.length > 5) {
      const mean = dailyPcts.reduce((a, b) => a + b, 0) / dailyPcts.length;
      const variance =
        dailyPcts.reduce((s, v) => s + (v - mean) ** 2, 0) / dailyPcts.length;
      const dailyStd = Math.sqrt(variance);
      const annVol = dailyStd * Math.sqrt(252);
      const startElo = startEloMap.get(team) ?? 1500;
      teamVols.push({ team, elo: startElo, vol: annVol });
    }

    // Big move days
    let bigDays = 0;
    let flatStreak = 0;
    let maxFlat = 0;
    let nonFlatDays = 0;

    for (const pct of dailyPcts) {
      if (Math.abs(pct) > 1.5) bigDays++;
      if (Math.abs(pct) < 0.3) {
        flatStreak++;
        maxFlat = Math.max(maxFlat, flatStreak);
      } else {
        flatStreak = 0;
        nonFlatDays++;
      }
    }

    totalBigDays += bigDays;
    totalDays += dailyPcts.length;
    worstFlat = Math.max(worstFlat, maxFlat);
    totalNonFlat += nonFlatDays;
    totalDayCount += dailyPcts.length;
  }

  // No Sure Bets: % teams with abs(delta) < 15%
  const safeBets = teamDeltas.filter((d) => Math.abs(d) < 15).length;
  const noSureBets = teamDeltas.length > 0 ? (safeBets / teamDeltas.length) * 100 : 0;
  const sortedDeltas = [...teamDeltas].sort((a, b) => b - a);
  const topDelta = sortedDeltas[0] ?? 0;
  const botDelta = sortedDeltas[sortedDeltas.length - 1] ?? 0;
  const gapDelta = topDelta - botDelta;

  // Volatility
  const avgVol = teamVols.length > 0
    ? teamVols.reduce((s, t) => s + t.vol, 0) / teamVols.length
    : 0;

  const topTier = teamVols.filter((t) => t.elo > 1650);
  const midTier = teamVols.filter((t) => t.elo >= 1400 && t.elo <= 1650);
  const botTier = teamVols.filter((t) => t.elo < 1400);
  const avg = (arr: { vol: number }[]) =>
    arr.length > 0 ? arr.reduce((s, t) => s + t.vol, 0) / arr.length : 0;
  const topVol = avg(topTier);
  const midVol = avg(midTier);
  const botVol = avg(botTier);
  const volRatio = botVol > 0 ? topVol / botVol : 0;

  // Big moves: scale to per year (252 trading days)
  const avgDaysPerTeam = totalDays / Math.max(teams.length, 1);
  const bigMoveDays = avgDaysPerTeam > 0
    ? (totalBigDays / teams.length) * (252 / avgDaysPerTeam)
    : 0;

  // Dead zones
  const noDeadPct = totalDayCount > 0 ? (totalNonFlat / totalDayCount) * 100 : 0;

  return {
    noSureBets,
    topDelta,
    botDelta,
    gapDelta,
    annualVol: avgVol,
    topVol,
    midVol,
    botVol,
    volUniformity: volRatio > 0 ? Math.min(topVol, botVol) / Math.max(topVol, botVol) * 100 : 0,
    volRatio,
    bigMoveDays,
    noDeadPct,
    longestFlat: worstFlat,
  };
}

// ─── Index Card ─────────────────────────────────────────────
function IndexCard({
  title,
  value,
  sub,
  color,
}: {
  title: string;
  value: string;
  sub: string;
  color: "green" | "amber" | "red";
}) {
  const colorClass =
    color === "green"
      ? "text-[#00e676]"
      : color === "amber"
      ? "text-[#ffc107]"
      : "text-[#ff1744]";

  return (
    <div className="border border-border rounded-lg p-3 bg-surface min-w-0">
      <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5 font-bold truncate">
        {title}
      </div>
      <div className={`text-lg font-mono font-bold tabular-nums ${colorClass}`}>
        {value}
      </div>
      <div className="text-[9px] text-muted font-mono mt-1 truncate">{sub}</div>
    </div>
  );
}

// ─── Param Slider ───────────────────────────────────────────
function ParamSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  fmt,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted uppercase tracking-wider font-bold">
          {label}
        </span>
        <span className="text-[11px] font-mono text-foreground font-bold tabular-nums">
          {fmt ? fmt(value) : value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[#00e676] h-1"
      />
    </div>
  );
}

// ─── Team Chart ─────────────────────────────────────────────
function TeamChart({
  team,
  league,
  startingElo,
  currentSeries,
  proposedSeries,
  actualSeries,
}: {
  team: string;
  league: string;
  startingElo: number;
  currentSeries: SimPoint[];
  proposedSeries: SimPoint[];
  actualSeries: { date: string; price: number }[];
}) {
  const merged = useMemo(() => {
    const byDate = new Map<
      string,
      { date: string; current?: number; proposed?: number; actual?: number }
    >();
    const sampleRate = proposedSeries.length > 250 ? 2 : 1;

    for (let i = 0; i < currentSeries.length; i += sampleRate) {
      const p = currentSeries[i];
      if (!byDate.has(p.date)) byDate.set(p.date, { date: p.date });
      byDate.get(p.date)!.current = p.price;
    }
    for (let i = 0; i < proposedSeries.length; i += sampleRate) {
      const p = proposedSeries[i];
      if (!byDate.has(p.date)) byDate.set(p.date, { date: p.date });
      byDate.get(p.date)!.proposed = p.price;
    }
    for (let i = 0; i < actualSeries.length; i += sampleRate) {
      const p = actualSeries[i];
      if (!byDate.has(p.date)) byDate.set(p.date, { date: p.date });
      byDate.get(p.date)!.actual = p.price;
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [currentSeries, proposedSeries, actualSeries]);

  // Stats from proposed series
  const proSeries = proposedSeries;
  const proStart = proSeries[0]?.price ?? 0;
  const proEnd = proSeries[proSeries.length - 1]?.price ?? 0;
  const proMin = proSeries.length > 0 ? Math.min(...proSeries.map((p) => p.price)) : 0;
  const proMax = proSeries.length > 0 ? Math.max(...proSeries.map((p) => p.price)) : 0;
  const proDelta = proStart > 0 ? ((proEnd - proStart) / proStart) * 100 : 0;

  // Annualized vol
  let annVol = 0;
  const dailyPcts: number[] = [];
  for (let i = 1; i < proSeries.length; i++) {
    const prev = proSeries[i - 1].price;
    if (prev > 0) dailyPcts.push(((proSeries[i].price - prev) / prev) * 100);
  }
  if (dailyPcts.length > 5) {
    const mean = dailyPcts.reduce((a, b) => a + b, 0) / dailyPcts.length;
    const variance = dailyPcts.reduce((s, v) => s + (v - mean) ** 2, 0) / dailyPcts.length;
    annVol = Math.sqrt(variance) * Math.sqrt(252);
  }

  // Big move count and flat streak
  let bigMoves = 0;
  let flatStreak = 0;
  let maxFlat = 0;
  for (const p of dailyPcts) {
    if (Math.abs(p) > 1.5) bigMoves++;
    if (Math.abs(p) < 0.3) {
      flatStreak++;
      maxFlat = Math.max(maxFlat, flatStreak);
    } else {
      flatStreak = 0;
    }
  }

  const deltaColor = proDelta >= 0 ? "text-[#00e676]" : "text-[#ff1744]";

  // Month tick formatter
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  return (
    <div className="border border-border rounded-lg bg-surface p-3">
      {/* Header row */}
      <div className="flex items-center gap-2 mb-1 text-[11px] font-mono flex-wrap">
        <span
          className="inline-block w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: LEAGUE_COLOR[league] ?? "#666" }}
        />
        <span className="font-bold text-foreground uppercase tracking-wider truncate max-w-[160px]">
          {team}
        </span>
        <span className="text-muted">{Math.round(startingElo)}</span>
        <span className={`font-bold ${deltaColor}`}>
          {proDelta >= 0 ? "+" : ""}{proDelta.toFixed(1)}%
        </span>
        <span className="text-muted">&sigma;{annVol.toFixed(1)}%</span>
        <span className="text-muted">
          ${proMin.toFixed(0)}&ndash;${proMax.toFixed(0)}
        </span>
        <span className="text-muted">{bigMoves} big</span>
        <span className="text-muted">flat {maxFlat}d</span>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={165}>
        <LineChart data={merged} margin={{ top: 2, right: 4, bottom: 2, left: 0 }}>
          <XAxis
            dataKey="date"
            stroke="#333"
            tick={{ fill: "#555", fontSize: 9, fontFamily: "monospace" }}
            interval={Math.max(1, Math.floor(merged.length / 7))}
            tickFormatter={(d: string) => {
              const m = parseInt(d.slice(5, 7));
              return monthNames[m - 1] ?? d.slice(5, 7);
            }}
          />
          <YAxis
            stroke="#333"
            tick={{ fill: "#555", fontSize: 9, fontFamily: "monospace" }}
            domain={["auto", "auto"]}
            width={32}
            tickFormatter={(v: number) => `$${v.toFixed(0)}`}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={(v: any, name: any) => [v != null ? `$${Number(v).toFixed(2)}` : "", String(name ?? "")]}
          />
          <Line
            type="monotone"
            dataKey="actual"
            stroke="#666666"
            strokeDasharray="4 3"
            dot={false}
            strokeWidth={1}
            name="Actual"
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="current"
            stroke="#ff6b6b"
            dot={false}
            strokeWidth={1}
            name="Current"
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="proposed"
            stroke="#00e676"
            dot={false}
            strokeWidth={1.5}
            name="Proposed"
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Verdict Bar ────────────────────────────────────────────
function VerdictBar({ idx }: { idx: SimIndexes }) {
  const isTradeable =
    idx.noSureBets > 80 &&
    idx.annualVol >= 15 &&
    idx.annualVol <= 45 &&
    idx.volRatio >= 0.6 &&
    idx.volRatio <= 1.4 &&
    idx.bigMoveDays > 30;

  const isBroken =
    idx.noSureBets < 60 ||
    idx.annualVol < 10 ||
    idx.annualVol > 60 ||
    idx.volRatio > 2.0;

  const verdict = isTradeable
    ? { icon: "\u2726", label: "TRADEABLE", color: "border-[#00e676] bg-[#00e676]/5", textColor: "text-[#00e676]" }
    : isBroken
    ? { icon: "\u2717", label: "BROKEN", color: "border-[#ff1744] bg-[#ff1744]/5", textColor: "text-[#ff1744]" }
    : { icon: "\u26A0", label: "MARGINAL", color: "border-[#ffc107] bg-[#ffc107]/5", textColor: "text-[#ffc107]" };

  const bullets = [
    `Direction gap ${idx.gapDelta.toFixed(0)}% \u2014 ${idx.noSureBets > 80 ? "good" : idx.noSureBets > 60 ? "needs work" : "broken"}`,
    `Vol ratio ${idx.volRatio.toFixed(2)}x \u2014 ${idx.volRatio >= 0.7 && idx.volRatio <= 1.3 ? "all tiers similar" : "still skewed"}`,
    `${idx.annualVol.toFixed(1)}% annual vol \u2014 ${idx.annualVol >= 15 && idx.annualVol <= 45 ? "enough to trade" : idx.annualVol < 15 ? "too sleepy" : "too wild"}`,
    `${idx.bigMoveDays.toFixed(0)} big-move days/year \u2014 ${idx.bigMoveDays > 40 ? "regular trading" : idx.bigMoveDays > 20 ? "moderate" : "dead market"}`,
  ];

  return (
    <div className={`border rounded-lg p-4 ${verdict.color}`}>
      <div className={`text-sm font-bold font-mono uppercase tracking-wider ${verdict.textColor} mb-2`}>
        {verdict.icon} {verdict.label} &mdash; these parameters{" "}
        {isTradeable
          ? "produce instrument-grade pricing"
          : isBroken
          ? "have structural problems"
          : "are close but need tuning"}
      </div>
      <div className="grid grid-cols-2 gap-1">
        {bullets.map((b, i) => (
          <div key={i} className="text-[10px] font-mono text-muted">
            &bull; {b}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Client Component ──────────────────────────────────
export function V3Client({
  startingElos,
  matches,
  oddsConsensus,
  priceHistory,
}: {
  startingElos: { team: string; league: string; startingElo: number }[];
  matches: MatchRow[];
  oddsConsensus: OddsConsensus[];
  priceHistory: PriceHistoryRow[];
}) {
  const [proposed, setProposed] = useState<SimParams>({ ...PRESETS[2].params }); // Tradeable default
  const [activePreset, setActivePreset] = useState(2);
  const [activeLeague, setActiveLeague] = useState("All");
  const [showAll, setShowAll] = useState(false);
  const [computing, setComputing] = useState(false);

  // Debounce
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedParams, setDebouncedParams] = useState<SimParams>({ ...PRESETS[2].params });

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setComputing(true);
    debounceRef.current = setTimeout(() => {
      setDebouncedParams({ ...proposed });
      setComputing(false);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [proposed]);

  // Build odds map
  const oddsMap = useMemo(() => {
    const map = new Map<number, { homeProb: number; drawProb: number; awayProb: number }>();
    for (const o of oddsConsensus) {
      map.set(o.fixture_id, { homeProb: o.homeProb, drawProb: o.drawProb, awayProb: o.awayProb });
    }
    return map;
  }, [oddsConsensus]);

  // Actual production prices per team
  const actualPriceByTeam = useMemo(() => {
    const map = new Map<string, { date: string; price: number }[]>();
    for (const r of priceHistory) {
      if (!map.has(r.team)) map.set(r.team, []);
      map.get(r.team)!.push({ date: r.date, price: r.dollar_price });
    }
    for (const rows of map.values()) rows.sort((a, b) => a.date.localeCompare(b.date));
    return map;
  }, [priceHistory]);

  // Current (broken) simulation — memoized, never changes
  const currentSimulation = useMemo(
    () => runSimulation(startingElos, matches, oddsMap, PRESETS[0].params),
    [startingElos, matches, oddsMap]
  );

  // Proposed simulation (debounced)
  const proposedSimulation = useMemo(
    () => runSimulation(startingElos, matches, oddsMap, debouncedParams),
    [startingElos, matches, oddsMap, debouncedParams]
  );

  // Indexes
  const proposedIndexes = useMemo(
    () => computeIndexes(proposedSimulation, startingElos),
    [proposedSimulation, startingElos]
  );

  // Sorted teams by starting Elo
  const sortedTeams = useMemo(
    () => [...startingElos].sort((a, b) => b.startingElo - a.startingElo),
    [startingElos]
  );

  // Filtered teams
  const filteredTeams = useMemo(() => {
    let teams = sortedTeams;
    if (activeLeague !== "All") {
      teams = teams.filter((t) => t.league === activeLeague);
    }
    if (!showAll) {
      teams = teams.slice(0, 50);
    }
    return teams;
  }, [sortedTeams, activeLeague, showAll]);

  const leagues = useMemo(
    () => [...new Set(startingElos.map((t) => t.league))].sort(),
    [startingElos]
  );

  // Param update
  const updateParam = useCallback(
    <K extends keyof SimParams>(key: K, value: SimParams[K]) => {
      setActivePreset(-1);
      setProposed((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  // Preset click
  const selectPreset = useCallback((idx: number) => {
    setActivePreset(idx);
    setProposed({ ...PRESETS[idx].params });
  }, []);

  // Live info for carry decay
  const arsenalElo = useMemo(() => {
    const ars = proposedSimulation.get("Arsenal FC");
    if (ars && ars.length > 0) return ars[ars.length - 1].elo;
    return 1838;
  }, [proposedSimulation]);

  const decayInfo = useMemo(() => {
    const anchor = proposed.anchorMode === "fixed" ? 1500 : arsenalElo - 20; // approximate MA
    const rate = proposed.carryDecay;
    const eloDelta = rate * Math.abs(arsenalElo - anchor);
    const priceBefore = mapPrice(arsenalElo, proposed);
    const priceAfter = mapPrice(arsenalElo - eloDelta, proposed);
    return {
      anchor: proposed.anchorMode === "fixed" ? "1500" : `~${Math.round(anchor)}`,
      eloDelta: eloDelta.toFixed(2),
      priceDelta: Math.abs(priceAfter - priceBefore).toFixed(3),
    };
  }, [proposed, arsenalElo]);

  // Index card colors
  const nsColor = proposedIndexes.noSureBets > 85 ? "green" : proposedIndexes.noSureBets > 70 ? "amber" : "red";
  const volColor = proposedIndexes.annualVol >= 18 && proposedIndexes.annualVol <= 45 ? "green" : proposedIndexes.annualVol >= 12 && proposedIndexes.annualVol <= 55 ? "amber" : "red";
  const vuColor = proposedIndexes.volRatio >= 0.7 && proposedIndexes.volRatio <= 1.3 ? "green" : proposedIndexes.volRatio >= 0.5 && proposedIndexes.volRatio <= 1.5 ? "amber" : "red";
  const bmColor = proposedIndexes.bigMoveDays > 40 ? "green" : proposedIndexes.bigMoveDays > 20 ? "amber" : "red";
  const ndColor = proposedIndexes.longestFlat < 7 ? "green" : proposedIndexes.longestFlat < 14 ? "amber" : "red";

  return (
    <div className="flex" style={{ height: "calc(100vh - 57px)" }}>
      {/* ─── LEFT SIDEBAR ─────────────────────────────── */}
      <aside className="w-[280px] flex-shrink-0 border-r border-border bg-surface overflow-y-auto p-4 space-y-4">
        {/* Presets */}
        <div className="space-y-2">
          <div className="text-[10px] text-muted uppercase tracking-wider font-bold">
            Presets
          </div>
          {PRESETS.map((preset, i) => (
            <button
              key={i}
              onClick={() => selectPreset(i)}
              className={`w-full text-left px-3 py-2 rounded border transition-all ${
                activePreset === i
                  ? "border-[#00e676] bg-[#00e676]/5"
                  : "border-border bg-background hover:border-muted"
              }`}
            >
              <div className={`text-[11px] font-mono font-bold uppercase tracking-wider ${
                activePreset === i ? "text-[#00e676]" : "text-foreground"
              }`}>
                {preset.name}
              </div>
              <div className="text-[9px] text-muted font-mono mt-0.5 leading-tight">
                {preset.desc}
              </div>
            </button>
          ))}
        </div>

        <div className="border-t border-border" />

        {/* Carry Decay */}
        <div className="space-y-2">
          <div className="text-[10px] text-muted uppercase tracking-wider font-bold">
            Carry Decay
          </div>
          <ParamSlider
            label="Rate"
            value={proposed.carryDecay}
            min={0}
            max={0.02}
            step={0.001}
            onChange={(v) => updateParam("carryDecay", v)}
            fmt={(v) => `${v.toFixed(3)}/d`}
          />
          <div className="space-y-1">
            <span className="text-[10px] text-muted uppercase tracking-wider font-bold">
              Anchor
            </span>
            <div className="flex gap-1 flex-wrap">
              {(["fixed", "30d", "45d", "60d"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => updateParam("anchorMode", m)}
                  className={`px-2 py-0.5 text-[9px] font-mono uppercase rounded border transition-all ${
                    proposed.anchorMode === m
                      ? "bg-[#00e676] text-background border-[#00e676] font-bold"
                      : "bg-transparent text-muted border-border hover:text-foreground"
                  }`}
                >
                  {m === "fixed" ? "Fixed 1500" : `${m} MA`}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted uppercase tracking-wider font-bold">
              Calendar-Aware
            </span>
            <button
              onClick={() => updateParam("calendarAwareDecay", !proposed.calendarAwareDecay)}
              className={`px-2 py-0.5 text-[9px] font-mono uppercase rounded border transition-all ${
                proposed.calendarAwareDecay
                  ? "bg-[#00e676] text-background border-[#00e676] font-bold"
                  : "bg-transparent text-muted border-border hover:text-foreground"
              }`}
            >
              {proposed.calendarAwareDecay ? "ON" : "OFF"}
            </button>
          </div>
          <div className="bg-background rounded p-2 text-[9px] font-mono text-muted leading-relaxed">
            Arsenal: {proposed.carryDecay.toFixed(3)} &times; |{Math.round(arsenalElo)} &minus; {decayInfo.anchor}|
            = {decayInfo.eloDelta} Elo = ${decayInfo.priceDelta}/day
          </div>
        </div>

        <div className="border-t border-border" />

        {/* Match Shocks */}
        <div className="space-y-2">
          <div className="text-[10px] text-muted uppercase tracking-wider font-bold">
            Match Shocks
          </div>
          <ParamSlider
            label="K Factor"
            value={proposed.shockK}
            min={5}
            max={60}
            step={1}
            onChange={(v) => updateParam("shockK", v)}
          />
          <ParamSlider
            label="Half-Life"
            value={proposed.shockHalfLife}
            min={2}
            max={20}
            step={1}
            onChange={(v) => updateParam("shockHalfLife", v)}
            fmt={(v) => `${v}d`}
          />
          <ParamSlider
            label="Prior Pull"
            value={proposed.priorPull}
            min={0}
            max={0.3}
            step={0.01}
            onChange={(v) => updateParam("priorPull", v)}
          />
          <div className="bg-background rounded p-2 text-[9px] font-mono text-muted leading-relaxed">
            Elo points per match surprise. Higher = bigger match-day moves.
          </div>
        </div>

        <div className="border-t border-border" />

        {/* Proportional Volatility */}
        <div className="space-y-2">
          <div className="text-[10px] text-muted uppercase tracking-wider font-bold">
            Proportional Volatility
          </div>
          <ParamSlider
            label="PropVol"
            value={proposed.propVol}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => updateParam("propVol", v)}
          />
          <div className="bg-background rounded p-2 text-[9px] font-mono text-muted leading-relaxed">
            Daily noise proportional to price. Equalizes % volatility across tiers. Seeded RNG = deterministic.
          </div>
        </div>

        <div className="border-t border-border" />

        {/* Price Mapping */}
        <div className="space-y-2">
          <div className="text-[10px] text-muted uppercase tracking-wider font-bold">
            Price Mapping
          </div>
          <div className="flex gap-1">
            {(["logistic", "linear", "exponential"] as const).map((m) => (
              <button
                key={m}
                onClick={() => updateParam("priceMapping", m)}
                className={`px-2 py-0.5 text-[9px] font-mono uppercase rounded border transition-all ${
                  proposed.priceMapping === m
                    ? "bg-[#00e676] text-background border-[#00e676] font-bold"
                    : "bg-transparent text-muted border-border hover:text-foreground"
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          {proposed.priceMapping === "logistic" && (
            <div className="space-y-1.5 pl-2 border-l border-border ml-1">
              <ParamSlider
                label="Spread"
                value={proposed.logisticSpread}
                min={100}
                max={400}
                step={10}
                onChange={(v) => updateParam("logisticSpread", v)}
              />
              <div className="text-[8px] font-mono text-muted">
                100 / (1 + exp(-(elo-1500) / {proposed.logisticSpread}))
              </div>
            </div>
          )}
          {proposed.priceMapping === "linear" && (
            <div className="space-y-1.5 pl-2 border-l border-border ml-1">
              <ParamSlider
                label="Ceiling"
                value={proposed.linearCeiling}
                min={100}
                max={200}
                step={5}
                onChange={(v) => updateParam("linearCeiling", v)}
                fmt={(v) => `$${v}`}
              />
              <ParamSlider
                label="Floor"
                value={proposed.linearFloor}
                min={5}
                max={20}
                step={1}
                onChange={(v) => updateParam("linearFloor", v)}
                fmt={(v) => `$${v}`}
              />
              <div className="text-[8px] font-mono text-muted">
                clamp((elo-{proposed.linearOffset}) / {proposed.linearSlope}, ${proposed.linearFloor}, ${proposed.linearCeiling})
              </div>
            </div>
          )}
          {proposed.priceMapping === "exponential" && (
            <div className="space-y-1.5 pl-2 border-l border-border ml-1">
              <ParamSlider
                label="Scale"
                value={proposed.expScale}
                min={300}
                max={1000}
                step={50}
                onChange={(v) => updateParam("expScale", v)}
              />
              <div className="text-[8px] font-mono text-muted">
                50 &times; exp((elo-1500) / {proposed.expScale})
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* ─── RIGHT CONTENT ────────────────────────────── */}
      <main className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Computing indicator */}
        {computing && (
          <div className="text-xs font-mono text-[#ffc107] animate-pulse">
            Recomputing simulation...
          </div>
        )}

        {/* Index Cards */}
        <div className="grid grid-cols-5 gap-3">
          <IndexCard
            title="No Sure Bets"
            value={`${proposedIndexes.noSureBets.toFixed(0)}%`}
            sub={`Top: +${proposedIndexes.topDelta.toFixed(0)}% | Bot: ${proposedIndexes.botDelta.toFixed(0)}% | Gap: ${proposedIndexes.gapDelta.toFixed(0)}%`}
            color={nsColor as "green" | "amber" | "red"}
          />
          <IndexCard
            title="Volatility"
            value={`${proposedIndexes.annualVol.toFixed(1)}%`}
            sub={`Top: ${proposedIndexes.topVol.toFixed(1)}% | Mid: ${proposedIndexes.midVol.toFixed(1)}% | Bot: ${proposedIndexes.botVol.toFixed(1)}%`}
            color={volColor as "green" | "amber" | "red"}
          />
          <IndexCard
            title="Vol Uniformity"
            value={`${proposedIndexes.volUniformity.toFixed(0)}%`}
            sub={`Ratio: ${proposedIndexes.volRatio.toFixed(2)}x`}
            color={vuColor as "green" | "amber" | "red"}
          />
          <IndexCard
            title="Big Moves"
            value={`${proposedIndexes.bigMoveDays.toFixed(0)} days/yr`}
            sub=">1.5% move"
            color={bmColor as "green" | "amber" | "red"}
          />
          <IndexCard
            title="No Dead Zones"
            value={`${proposedIndexes.noDeadPct.toFixed(0)}%`}
            sub={`Longest flat: ${proposedIndexes.longestFlat}d`}
            color={ndColor as "green" | "amber" | "red"}
          />
        </div>

        {/* League filter */}
        <div className="flex flex-wrap gap-2 items-center">
          <button
            onClick={() => setActiveLeague("All")}
            className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded border transition-all ${
              activeLeague === "All"
                ? "bg-foreground text-background border-foreground"
                : "bg-transparent text-muted border-border hover:border-muted hover:text-foreground"
            }`}
          >
            All
          </button>
          {leagues.map((league) => (
            <button
              key={league}
              onClick={() => setActiveLeague(league)}
              className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded border transition-all ${
                activeLeague === league
                  ? "bg-foreground text-background border-foreground"
                  : "bg-transparent text-muted border-border hover:border-muted hover:text-foreground"
              }`}
            >
              {LEAGUE_SHORT[league] || league}
            </button>
          ))}

          {/* Legend */}
          <div className="flex items-center gap-4 ml-auto text-[9px] font-mono text-muted">
            <div className="flex items-center gap-1">
              <div className="w-3 h-[1.5px] bg-[#ff6b6b]" />
              <span>Current</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-[2px] bg-[#00e676]" />
              <span>Proposed</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-0 border-t border-dashed border-[#666]" />
              <span>Actual</span>
            </div>
          </div>
        </div>

        {/* Team Charts */}
        <div className="space-y-3">
          {filteredTeams.map((t) => (
            <TeamChart
              key={t.team}
              team={t.team}
              league={t.league}
              startingElo={t.startingElo}
              currentSeries={currentSimulation.get(t.team) ?? []}
              proposedSeries={proposedSimulation.get(t.team) ?? []}
              actualSeries={actualPriceByTeam.get(t.team) ?? []}
            />
          ))}
        </div>

        {/* Show all toggle */}
        {!showAll && sortedTeams.length > 50 && (
          <div className="text-center py-2">
            <button
              onClick={() => setShowAll(true)}
              className="px-4 py-2 text-[10px] font-bold uppercase tracking-wider rounded border border-border bg-surface text-muted hover:border-[#00e676] hover:text-[#00e676] transition-all"
            >
              Show all {sortedTeams.length} teams
            </button>
          </div>
        )}

        {/* Verdict Bar */}
        <VerdictBar idx={proposedIndexes} />
      </main>
    </div>
  );
}
