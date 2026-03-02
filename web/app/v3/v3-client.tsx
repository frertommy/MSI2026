"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type {
  StartingElo,
  PriceHistoryRow,
  MatchRow,
  OddsConsensus,
} from "./page";

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
export interface SimParams {
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
  calendarAwareDecay: boolean;
}

const CURRENT_PARAMS: SimParams = {
  priorPull: 0.15,
  carryDecay: 0.005,
  shockK: 20,
  shockHalfLife: 10,
  priceMapping: "logistic",
  linearSlope: 10,
  linearOffset: 1000,
  linearFloor: 10,
  linearCeiling: 120,
  expScale: 600,
  calendarAwareDecay: false,
};

const RECOMMENDED_PARAMS: SimParams = {
  priorPull: 0.03,
  carryDecay: 0.001,
  shockK: 32,
  shockHalfLife: 7,
  priceMapping: "linear",
  linearSlope: 10,
  linearOffset: 1000,
  linearFloor: 10,
  linearCeiling: 120,
  expScale: 600,
  calendarAwareDecay: true,
};

const HIGH_VOL_PARAMS: SimParams = {
  ...CURRENT_PARAMS,
  priorPull: 0.01,
  carryDecay: 0,
  shockK: 45,
  shockHalfLife: 5,
};

const CONSERVATIVE_PARAMS: SimParams = {
  ...CURRENT_PARAMS,
  priorPull: 0.10,
  carryDecay: 0.003,
  shockK: 25,
  shockHalfLife: 10,
};

// ─── Price Mapping Functions ─────────────────────────────────
function mapPrice(elo: number, params: SimParams): number {
  switch (params.priceMapping) {
    case "logistic":
      return 100 / (1 + Math.exp(-(elo - 1500) / 220));
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
  startingElos: StartingElo[],
  matches: MatchRow[],
  oddsMap: Map<number, { homeProb: number; drawProb: number; awayProb: number }>,
  params: SimParams
): Map<string, SimPoint[]> {
  // Initialize team state
  const teamElo = new Map<string, number>();
  const teamLeague = new Map<string, string>();
  const teamStartElo = new Map<string, number>();
  const teamLastMatch = new Map<string, string>();
  const teamSeries = new Map<string, SimPoint[]>();

  for (const t of startingElos) {
    teamElo.set(t.team, t.implied_elo);
    teamLeague.set(t.team, t.league);
    teamStartElo.set(t.team, t.implied_elo);
    teamSeries.set(t.team, []);
  }

  // Filter to played matches with valid scores, sorted by date
  const playedMatches = matches
    .filter((m) => {
      const parsed = parseScore(m.score);
      return parsed !== null;
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  if (playedMatches.length === 0) return teamSeries;

  // Determine date range
  const startDate = startingElos[0]?.date ?? playedMatches[0].date;
  const lastMatchDate = playedMatches[playedMatches.length - 1].date;

  // Build match schedule by date
  const matchesByDate = new Map<string, MatchRow[]>();
  for (const m of playedMatches) {
    if (!matchesByDate.has(m.date)) matchesByDate.set(m.date, []);
    matchesByDate.get(m.date)!.push(m);
  }

  // Build set of all match dates per team (for calendar-aware decay lookahead)
  const teamMatchDates = new Map<string, string[]>();
  for (const m of playedMatches) {
    if (!teamMatchDates.has(m.home_team)) teamMatchDates.set(m.home_team, []);
    if (!teamMatchDates.has(m.away_team)) teamMatchDates.set(m.away_team, []);
    teamMatchDates.get(m.home_team)!.push(m.date);
    teamMatchDates.get(m.away_team)!.push(m.date);
  }

  // Active shocks: team → [{date, amount}]
  const shockLog = new Map<string, { date: string; amount: number }[]>();
  for (const t of startingElos) {
    shockLog.set(t.team, []);
  }

  // Iterate day by day
  let currentDate = startDate;
  while (currentDate <= lastMatchDate) {
    const todayMatches = matchesByDate.get(currentDate) ?? [];
    const teamsPlayingToday = new Set<string>();

    // ─── Step 1: Compute league means ───────────────────
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

    // ─── Step 2: Mark teams playing today ───────────────
    for (const m of todayMatches) {
      teamsPlayingToday.add(m.home_team);
      teamsPlayingToday.add(m.away_team);
    }

    // ─── Step 3: Carry-forward decay (non-match day) ────
    for (const [team, elo] of teamElo) {
      if (teamsPlayingToday.has(team)) {
        teamLastMatch.set(team, currentDate);
        continue;
      }

      const lastMatch = teamLastMatch.get(team);
      if (!lastMatch) continue; // no match played yet

      // Calendar-aware decay: skip if no match within 7 days ahead
      if (params.calendarAwareDecay) {
        const futureDates = teamMatchDates.get(team) ?? [];
        const nextMatch = futureDates.find((d) => d > currentDate);
        if (!nextMatch || daysBetween(currentDate, nextMatch) > 7) {
          continue; // international break — skip decay
        }
      }

      const daysSince = daysBetween(lastMatch, currentDate);
      const decayFactor = Math.max(0.5, 1 - params.carryDecay * daysSince);
      const mean = leagueMean.get(teamLeague.get(team) ?? "") ?? 1500;
      teamElo.set(team, mean + (elo - mean) * decayFactor);
    }

    // ─── Step 4: Compute match shocks ───────────────────
    for (const m of todayMatches) {
      const odds = oddsMap.get(m.fixture_id);
      if (!odds) continue;

      const parsed = parseScore(m.score);
      if (!parsed) continue;
      const [hg, ag] = parsed;

      // Opponent strength K scaling
      const homeElo = teamElo.get(m.home_team) ?? 1500;
      const awayElo = teamElo.get(m.away_team) ?? 1500;
      const mean = leagueMean.get(m.league) ?? 1500;

      const homeEffK = params.shockK * (1 + (awayElo - mean) / 400);
      const awayEffK = params.shockK * (1 + (homeElo - mean) / 400);

      // Home team shock
      const homeActual = hg > ag ? 3 : hg === ag ? 1 : 0;
      const homeExpected = 3 * odds.homeProb + 1 * odds.drawProb + 0 * odds.awayProb;
      const homeShock = (homeActual - homeExpected) * homeEffK;

      // Away team shock
      const awayActual = ag > hg ? 3 : ag === hg ? 1 : 0;
      const awayExpected = 3 * odds.awayProb + 1 * odds.drawProb + 0 * odds.homeProb;
      const awayShock = (awayActual - awayExpected) * awayEffK;

      if (shockLog.has(m.home_team)) {
        shockLog.get(m.home_team)!.push({ date: currentDate, amount: homeShock });
      }
      if (shockLog.has(m.away_team)) {
        shockLog.get(m.away_team)!.push({ date: currentDate, amount: awayShock });
      }
    }

    // ─── Step 5: Apply decaying shock boost ─────────────
    for (const [team, elo] of teamElo) {
      const shocks = shockLog.get(team) ?? [];
      let boost = 0;
      for (const s of shocks) {
        if (s.date > currentDate) continue;
        const daysSince = daysBetween(s.date, currentDate);
        boost += s.amount * Math.pow(0.5, daysSince / params.shockHalfLife);
      }
      // Store boost separately — don't compound into base elo
      // We'll add boost when computing final elo for price mapping
      // Actually, for the simulation we need to apply shocks to base elo
      // Let's use a different approach: base elo tracks decay+pull, final = base + boost
    }

    // ─── Step 6: Apply prior pull ───────────────────────
    const dailyPull = params.priorPull / 50;
    for (const [team, elo] of teamElo) {
      const startElo = teamStartElo.get(team) ?? 1500;
      teamElo.set(team, elo * (1 - dailyPull) + startElo * dailyPull);
    }

    // ─── Step 7: Re-center global average to 1500 ───────
    const allElos = [...teamElo.values()];
    const globalMean = allElos.reduce((a, b) => a + b, 0) / allElos.length;
    const recentering = 1500 - globalMean;
    for (const [team, elo] of teamElo) {
      teamElo.set(team, elo + recentering);
    }

    // ─── Step 8: Compute final elo (base + shock boost) and price ──
    for (const [team, baseElo] of teamElo) {
      const shocks = shockLog.get(team) ?? [];
      let boost = 0;
      for (const s of shocks) {
        if (s.date > currentDate) continue;
        const daysSince = daysBetween(s.date, currentDate);
        boost += s.amount * Math.pow(0.5, daysSince / params.shockHalfLife);
      }
      const finalElo = baseElo + boost;
      const price = mapPrice(finalElo, params);
      teamSeries.get(team)!.push({
        date: currentDate,
        elo: Math.round(finalElo * 10) / 10,
        price: Math.round(price * 100) / 100,
      });
    }

    // Next day
    currentDate = addDays(currentDate, 1);
  }

  return teamSeries;
}

// ─── Index Card Component ────────────────────────────────────
function IndexCard({
  title,
  current,
  proposed,
  lowerBetter,
  unit,
}: {
  title: string;
  current: number;
  proposed: number;
  lowerBetter: boolean;
  unit?: string;
}) {
  const curBetter = lowerBetter ? current < proposed : current > proposed;
  const proBetter = lowerBetter ? proposed < current : proposed > current;
  const fmt = (n: number) => {
    if (unit === "%") return `${n.toFixed(2)}%`;
    if (unit === "x") return `${n.toFixed(2)}x`;
    return n.toFixed(2);
  };

  return (
    <div className="border border-border rounded-lg p-3 bg-surface">
      <div className="text-[10px] text-muted uppercase tracking-wider mb-2 font-bold">
        {title}
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted font-mono">current</span>
          <span
            className={`text-sm font-mono font-bold tabular-nums ${
              curBetter ? "text-accent-green" : "text-foreground"
            }`}
          >
            {fmt(current)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted font-mono">proposed</span>
          <span
            className={`text-sm font-mono font-bold tabular-nums ${
              proBetter ? "text-accent-green" : "text-foreground"
            }`}
          >
            {fmt(proposed)}
          </span>
        </div>
      </div>
      <div className="mt-2 text-[9px] text-muted font-mono opacity-60">
        {lowerBetter ? "lower is better" : "higher is better"}
      </div>
    </div>
  );
}

// ─── Slider Component ────────────────────────────────────────
function ParamSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  formatValue?: (v: number) => string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted uppercase tracking-wider font-bold">
          {label}
        </span>
        <span className="text-xs font-mono text-foreground font-bold tabular-nums">
          {formatValue ? formatValue(value) : value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[#00e676] h-1.5"
      />
    </div>
  );
}

// ─── Team Chart Card ─────────────────────────────────────────
function TeamChart({
  team,
  league,
  currentSeries,
  proposedSeries,
  actualSeries,
}: {
  team: string;
  league: string;
  currentSeries: SimPoint[];
  proposedSeries: SimPoint[];
  actualSeries: { date: string; price: number }[];
}) {
  // Merge all series into one dataset by date
  const merged = useMemo(() => {
    const byDate = new Map<
      string,
      { date: string; current?: number; proposed?: number; actual?: number }
    >();

    // Sample if > 200 points
    const sampleRate = currentSeries.length > 200 ? 2 : 1;

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

  const curStart = currentSeries[0]?.price ?? 0;
  const curEnd = currentSeries[currentSeries.length - 1]?.price ?? 0;
  const curMin = Math.min(...currentSeries.map((p) => p.price));
  const curMax = Math.max(...currentSeries.map((p) => p.price));
  const curDelta = curEnd - curStart;
  const curPct = curStart > 0 ? (curDelta / curStart) * 100 : 0;

  const proStart = proposedSeries[0]?.price ?? 0;
  const proEnd = proposedSeries[proposedSeries.length - 1]?.price ?? 0;
  const proMin = Math.min(...proposedSeries.map((p) => p.price));
  const proMax = Math.max(...proposedSeries.map((p) => p.price));
  const proDelta = proEnd - proStart;
  const proPct = proStart > 0 ? (proDelta / proStart) * 100 : 0;

  const startElo = currentSeries[0]?.elo ?? 0;
  const endElo = currentSeries[currentSeries.length - 1]?.elo ?? 0;

  return (
    <div className="border border-border rounded-lg bg-surface p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: LEAGUE_COLOR[league] ?? "#666" }}
          />
          <span className="text-xs font-bold text-foreground font-mono uppercase tracking-wider truncate max-w-[200px]">
            {team}
          </span>
        </div>
        <span className="text-[10px] text-muted font-mono">
          {Math.round(startElo)} &rarr; {Math.round(endElo)} Elo
        </span>
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={merged} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          <XAxis
            dataKey="date"
            stroke="#333"
            tick={{ fill: "#666", fontSize: 9, fontFamily: "monospace" }}
            interval={Math.max(1, Math.floor(merged.length / 5))}
            tickFormatter={(d: string) => d.slice(5)}
          />
          <YAxis
            stroke="#333"
            tick={{ fill: "#666", fontSize: 9, fontFamily: "monospace" }}
            domain={["auto", "auto"]}
            width={35}
          />
          <Tooltip contentStyle={tooltipStyle} />
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
            strokeWidth={1.5}
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

      <div className="grid grid-cols-2 gap-3 mt-2 text-[10px] font-mono">
        <div className="space-y-0.5">
          <span className="text-[#ff6b6b] font-bold">CURRENT</span>
          <div className="text-muted">
            range ${curMin.toFixed(2)}&ndash;${curMax.toFixed(2)}
          </div>
          <div className={curDelta >= 0 ? "text-accent-green" : "text-accent-red"}>
            &Delta; {curDelta >= 0 ? "+" : ""}${curDelta.toFixed(2)} ({curPct >= 0 ? "+" : ""}
            {curPct.toFixed(1)}%)
          </div>
        </div>
        <div className="space-y-0.5">
          <span className="text-accent-green font-bold">PROPOSED</span>
          <div className="text-muted">
            range ${proMin.toFixed(2)}&ndash;${proMax.toFixed(2)}
          </div>
          <div className={proDelta >= 0 ? "text-accent-green" : "text-accent-red"}>
            &Delta; {proDelta >= 0 ? "+" : ""}${proDelta.toFixed(2)} ({proPct >= 0 ? "+" : ""}
            {proPct.toFixed(1)}%)
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Compute Indexes ─────────────────────────────────────────
function computeIndexes(
  simResult: Map<string, SimPoint[]>,
  matchesByDate: Map<string, Set<string>>
) {
  const teams = [...simResult.keys()];
  if (teams.length === 0) {
    return {
      annualRange: 0,
      driftScore: 0,
      matchDayImpact: 0,
      nonMatchDrift: 0,
      volRatio: 0,
    };
  }

  let rangeSum = 0;
  let rangeCount = 0;
  let matchDayMoves: number[] = [];
  let nonMatchDayMoves: number[] = [];
  let driftCorrs: number[] = [];

  for (const team of teams) {
    const series = simResult.get(team)!;
    if (series.length < 2) continue;

    const startPrice = series[0].price;
    const prices = series.map((p) => p.price);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);

    // Index 1: Annual Price Range
    if (startPrice > 0) {
      rangeSum += (maxP - minP) / startPrice;
      rangeCount++;
    }

    // Index 2: Directional drift — correlation between elo distance and price trend
    const eloDistFromCenter = series.map((p) => p.elo - 1500);
    const priceTrend: number[] = [];
    for (let i = 1; i < series.length; i++) {
      priceTrend.push(series[i].price - series[i - 1].price);
    }
    if (priceTrend.length > 5) {
      // Just use sign of avg trend vs sign of avg elo distance
      const avgDist =
        eloDistFromCenter.reduce((a, b) => a + b, 0) / eloDistFromCenter.length;
      const avgTrend = priceTrend.reduce((a, b) => a + b, 0) / priceTrend.length;
      // Positive correlation = teams far from 1500 tend to revert
      driftCorrs.push(avgDist * avgTrend);
    }

    // Index 3 & 4: Match day vs non-match day moves
    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1];
      const cur = series[i];
      if (prev.price <= 0) continue;
      const pctMove = Math.abs((cur.price - prev.price) / prev.price) * 100;

      const playingTeams = matchesByDate.get(cur.date);
      if (playingTeams && playingTeams.has(team)) {
        matchDayMoves.push(pctMove);
      } else {
        nonMatchDayMoves.push(pctMove);
      }
    }
  }

  const avg = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const annualRange = rangeCount > 0 ? (rangeSum / rangeCount) * 100 : 0;
  const driftScore =
    driftCorrs.length > 0
      ? Math.abs(avg(driftCorrs))
      : 0;
  const matchDayImpact = avg(matchDayMoves);
  const nonMatchDrift = avg(nonMatchDayMoves);
  const volRatio = nonMatchDrift > 0 ? matchDayImpact / nonMatchDrift : 0;

  return { annualRange, driftScore, matchDayImpact, nonMatchDrift, volRatio };
}

// ─── Main Client Component ──────────────────────────────────
export function V3Client({
  startingElos,
  priceHistory,
  matches,
  oddsConsensus,
}: {
  startingElos: StartingElo[];
  priceHistory: PriceHistoryRow[];
  matches: MatchRow[];
  oddsConsensus: OddsConsensus[];
}) {
  const [proposed, setProposed] = useState<SimParams>({ ...RECOMMENDED_PARAMS });
  const [activeLeague, setActiveLeague] = useState("All");
  const [showAll, setShowAll] = useState(false);
  const [computing, setComputing] = useState(false);

  // Debounce timer
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedParams, setDebouncedParams] = useState<SimParams>({ ...RECOMMENDED_PARAMS });

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
      map.set(o.fixture_id, {
        homeProb: o.homeProb,
        drawProb: o.drawProb,
        awayProb: o.awayProb,
      });
    }
    return map;
  }, [oddsConsensus]);

  // Build matches-by-date for index computation (team → played on date)
  const matchesByDateTeams = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const m of matches) {
      if (!parseScore(m.score)) continue;
      if (!map.has(m.date)) map.set(m.date, new Set());
      map.get(m.date)!.add(m.home_team);
      map.get(m.date)!.add(m.away_team);
    }
    return map;
  }, [matches]);

  // Build actual production price series per team
  const actualPriceByTeam = useMemo(() => {
    const map = new Map<string, { date: string; price: number }[]>();
    for (const r of priceHistory) {
      if (!map.has(r.team)) map.set(r.team, []);
      map.get(r.team)!.push({ date: r.date, price: r.dollar_price });
    }
    for (const rows of map.values()) {
      rows.sort((a, b) => a.date.localeCompare(b.date));
    }
    return map;
  }, [priceHistory]);

  // Run simulation with CURRENT params (memoized, never changes)
  const currentSimulation = useMemo(
    () => runSimulation(startingElos, matches, oddsMap, CURRENT_PARAMS),
    [startingElos, matches, oddsMap]
  );

  // Run simulation with PROPOSED (debounced) params
  const proposedSimulation = useMemo(
    () => runSimulation(startingElos, matches, oddsMap, debouncedParams),
    [startingElos, matches, oddsMap, debouncedParams]
  );

  // Compute indexes
  const currentIndexes = useMemo(
    () => computeIndexes(currentSimulation, matchesByDateTeams),
    [currentSimulation, matchesByDateTeams]
  );
  const proposedIndexes = useMemo(
    () => computeIndexes(proposedSimulation, matchesByDateTeams),
    [proposedSimulation, matchesByDateTeams]
  );

  // Team list sorted by starting Elo
  const sortedTeams = useMemo(() => {
    return [...startingElos].sort((a, b) => b.implied_elo - a.implied_elo);
  }, [startingElos]);

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

  // Param update helper
  const updateParam = useCallback(
    <K extends keyof SimParams>(key: K, value: SimParams[K]) => {
      setProposed((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  return (
    <div className="space-y-6">
      {/* ─── Preset Buttons ─────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        {[
          { label: "Current Production", params: CURRENT_PARAMS },
          { label: "Recommended Fix", params: RECOMMENDED_PARAMS },
          { label: "High Volatility", params: HIGH_VOL_PARAMS },
          { label: "Conservative", params: CONSERVATIVE_PARAMS },
        ].map((preset) => (
          <button
            key={preset.label}
            onClick={() => setProposed({ ...preset.params })}
            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded border border-border bg-surface text-muted hover:border-accent-green hover:text-accent-green transition-all"
          >
            {preset.label}
          </button>
        ))}
        {computing && (
          <span className="px-3 py-1.5 text-xs font-mono text-amber-400 animate-pulse">
            Computing...
          </span>
        )}
      </div>

      {/* ─── Control Panel ──────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Current (read-only) */}
        <div className="border border-border rounded-lg p-4 bg-surface">
          <h3 className="text-xs font-bold uppercase tracking-wider text-[#ff6b6b] mb-4">
            Current Production
          </h3>
          <div className="space-y-3 text-xs font-mono">
            <div className="flex justify-between">
              <span className="text-muted">PRIOR_PULL</span>
              <span className="text-foreground">{CURRENT_PARAMS.priorPull}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">CARRY_DECAY</span>
              <span className="text-foreground">{CURRENT_PARAMS.carryDecay}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">ORACLE_SHOCK_K</span>
              <span className="text-foreground">{CURRENT_PARAMS.shockK}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">SHOCK_HALF_LIFE</span>
              <span className="text-foreground">{CURRENT_PARAMS.shockHalfLife}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">PRICE MAPPING</span>
              <span className="text-foreground">{CURRENT_PARAMS.priceMapping}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">CALENDAR DECAY</span>
              <span className="text-foreground">OFF</span>
            </div>
          </div>
        </div>

        {/* Proposed (sliders) */}
        <div className="border border-border rounded-lg p-4 bg-surface">
          <h3 className="text-xs font-bold uppercase tracking-wider text-accent-green mb-4">
            Proposed Parameters
          </h3>
          <div className="space-y-3">
            <ParamSlider
              label="PRIOR_PULL"
              value={proposed.priorPull}
              min={0}
              max={0.3}
              step={0.01}
              onChange={(v) => updateParam("priorPull", v)}
            />
            <ParamSlider
              label="CARRY_DECAY"
              value={proposed.carryDecay}
              min={0}
              max={0.02}
              step={0.001}
              onChange={(v) => updateParam("carryDecay", v)}
              formatValue={(v) => v.toFixed(3)}
            />
            <ParamSlider
              label="ORACLE_SHOCK_K"
              value={proposed.shockK}
              min={5}
              max={60}
              step={1}
              onChange={(v) => updateParam("shockK", v)}
            />
            <ParamSlider
              label="SHOCK_HALF_LIFE"
              value={proposed.shockHalfLife}
              min={2}
              max={20}
              step={1}
              onChange={(v) => updateParam("shockHalfLife", v)}
            />

            {/* Price mapping toggle */}
            <div className="space-y-1">
              <span className="text-[10px] text-muted uppercase tracking-wider font-bold">
                PRICE MAPPING
              </span>
              <div className="flex gap-1">
                {(["logistic", "linear", "exponential"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => updateParam("priceMapping", m)}
                    className={`px-2 py-1 text-[10px] font-mono uppercase rounded border transition-all ${
                      proposed.priceMapping === m
                        ? "bg-accent-green text-background border-accent-green font-bold"
                        : "bg-transparent text-muted border-border hover:text-foreground"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {/* Conditional sliders for linear/exponential */}
            {proposed.priceMapping === "linear" && (
              <div className="space-y-2 pl-2 border-l border-border ml-1">
                <ParamSlider
                  label="Slope"
                  value={proposed.linearSlope}
                  min={5}
                  max={20}
                  step={0.5}
                  onChange={(v) => updateParam("linearSlope", v)}
                />
                <ParamSlider
                  label="Offset"
                  value={proposed.linearOffset}
                  min={800}
                  max={1200}
                  step={10}
                  onChange={(v) => updateParam("linearOffset", v)}
                />
                <ParamSlider
                  label="Floor"
                  value={proposed.linearFloor}
                  min={0}
                  max={30}
                  step={1}
                  onChange={(v) => updateParam("linearFloor", v)}
                />
                <ParamSlider
                  label="Ceiling"
                  value={proposed.linearCeiling}
                  min={80}
                  max={200}
                  step={5}
                  onChange={(v) => updateParam("linearCeiling", v)}
                />
              </div>
            )}
            {proposed.priceMapping === "exponential" && (
              <div className="pl-2 border-l border-border ml-1">
                <ParamSlider
                  label="Exp Scale"
                  value={proposed.expScale}
                  min={300}
                  max={1000}
                  step={50}
                  onChange={(v) => updateParam("expScale", v)}
                />
              </div>
            )}

            {/* Calendar-aware decay toggle */}
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted uppercase tracking-wider font-bold">
                CALENDAR-AWARE DECAY
              </span>
              <button
                onClick={() =>
                  updateParam("calendarAwareDecay", !proposed.calendarAwareDecay)
                }
                className={`px-2 py-1 text-[10px] font-mono uppercase rounded border transition-all ${
                  proposed.calendarAwareDecay
                    ? "bg-accent-green text-background border-accent-green font-bold"
                    : "bg-transparent text-muted border-border hover:text-foreground"
                }`}
              >
                {proposed.calendarAwareDecay ? "ON" : "OFF"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Summary Index Cards ────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <IndexCard
          title="Annual Price Range"
          current={currentIndexes.annualRange}
          proposed={proposedIndexes.annualRange}
          lowerBetter={false}
          unit="%"
        />
        <IndexCard
          title="Directional Drift"
          current={currentIndexes.driftScore}
          proposed={proposedIndexes.driftScore}
          lowerBetter={true}
        />
        <IndexCard
          title="Match Day Impact"
          current={currentIndexes.matchDayImpact}
          proposed={proposedIndexes.matchDayImpact}
          lowerBetter={false}
          unit="%"
        />
        <IndexCard
          title="Non-Match Drift"
          current={currentIndexes.nonMatchDrift}
          proposed={proposedIndexes.nonMatchDrift}
          lowerBetter={true}
          unit="%"
        />
        <IndexCard
          title="Volatility Ratio"
          current={currentIndexes.volRatio}
          proposed={proposedIndexes.volRatio}
          lowerBetter={false}
          unit="x"
        />
      </div>

      {/* ─── League Filter ──────────────────────────────── */}
      <div className="space-y-4">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted border-b border-border pb-2">
          Per-Team Price Trajectories
        </h2>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setActiveLeague("All")}
            className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded border transition-all ${
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
              className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded border transition-all ${
                activeLeague === league
                  ? "bg-foreground text-background border-foreground"
                  : "bg-transparent text-muted border-border hover:border-muted hover:text-foreground"
              }`}
            >
              {LEAGUE_SHORT[league] || league}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Team Charts Grid ───────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filteredTeams.map((t) => (
          <TeamChart
            key={t.team}
            team={t.team}
            league={t.league}
            currentSeries={currentSimulation.get(t.team) ?? []}
            proposedSeries={proposedSimulation.get(t.team) ?? []}
            actualSeries={actualPriceByTeam.get(t.team) ?? []}
          />
        ))}
      </div>

      {/* ─── Show All Toggle ────────────────────────────── */}
      {!showAll && sortedTeams.length > 50 && (
        <div className="text-center">
          <button
            onClick={() => setShowAll(true)}
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded border border-border bg-surface text-muted hover:border-accent-green hover:text-accent-green transition-all"
          >
            Show all {sortedTeams.length} teams
          </button>
        </div>
      )}

      {/* ─── Legend ─────────────────────────────────────── */}
      <div className="flex items-center gap-6 text-[10px] font-mono text-muted border-t border-border pt-4">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-0.5 bg-[#ff6b6b]" />
          <span>Current params</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-0.5 bg-[#00e676]" />
          <span>Proposed params</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-0.5 bg-[#666] border-dashed" style={{ borderTop: "1px dashed #666", height: 0 }} />
          <span>Actual production (reference)</span>
        </div>
        <span className="ml-auto opacity-60">
          Simulation is an approximation &mdash; shocks from real match results, simplified decay model
        </span>
      </div>
    </div>
  );
}
