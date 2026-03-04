import type { MatchRow, OddsConsensus, V2Point, XgRow, StartingElo } from '../_types';

const V2_K = 20;
const V2_DECAY_RATE = 0.001;
const V2_MA_WINDOW = 45;
const V2_XG_FLOOR = 0.4;
const V2_XG_CEILING = 1.8;

function parseScore(score: string): [number, number] | null {
  const parts = score.split('-');
  if (parts.length !== 2) { return null; }
  const h = parseInt(parts[0].trim());
  const a = parseInt(parts[1].trim());
  if (isNaN(h) || isNaN(a)) { return null; }
  return [h, a];
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function computeV2Prices(
  startingElosArr: StartingElo[],
  matches: MatchRow[],
  oddsMap: Map<number, OddsConsensus>,
  xgByFixtureId: Map<number, XgRow>,
  xgByKey: Map<string, XgRow>,
): Record<string, V2Point[]> {
  const teamElo = new Map<string, number>();
  const teamLeague = new Map<string, string>();
  const teamSeries = new Map<string, V2Point[]>();
  const teamEloHistory = new Map<string, number[]>();
  const teamLastMatch = new Map<string, string>();

  for (const t of startingElosArr) {
    teamElo.set(t.team, t.startingElo);
    teamLeague.set(t.team, t.league);
    teamSeries.set(t.team, []);
    teamEloHistory.set(t.team, [t.startingElo]);
  }

  const playedMatches = matches
    .filter((m) => parseScore(m.score) !== null)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (playedMatches.length === 0) {
    const result: Record<string, V2Point[]> = {};
    for (const [team, pts] of teamSeries) { result[team] = pts; }
    return result;
  }

  const startDate = playedMatches[0].date;
  const lastMatchDate = playedMatches[playedMatches.length - 1].date;

  const matchesByDate = new Map<string, MatchRow[]>();
  for (const m of playedMatches) {
    if (!matchesByDate.has(m.date)) { matchesByDate.set(m.date, []); }
    matchesByDate.get(m.date)!.push(m);
  }

  let currentDate = startDate;
  while (currentDate <= lastMatchDate) {
    const todaysMatches = matchesByDate.get(currentDate) ?? [];
    const playingToday = new Set<string>();
    for (const m of todaysMatches) { playingToday.add(m.home_team); playingToday.add(m.away_team); }

    const leagueMeans = new Map<string, number>();
    const leagueTeams = new Map<string, number[]>();
    for (const [team, elo] of teamElo) {
      const league = teamLeague.get(team) ?? '';
      if (!leagueTeams.has(league)) { leagueTeams.set(league, []); }
      leagueTeams.get(league)!.push(elo);
    }
    for (const [league, elos] of leagueTeams) {
      leagueMeans.set(league, elos.reduce((a, b) => a + b, 0) / elos.length);
    }

    for (const [team, elo] of teamElo) {
      if (playingToday.has(team)) { continue; }
      const lastMatch = teamLastMatch.get(team);
      if (!lastMatch) { continue; }
      const daysSince = Math.round(
        (new Date(currentDate).getTime() - new Date(lastMatch).getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysSince <= 0) { continue; }
      const history = teamEloHistory.get(team) ?? [elo];
      const maSlice = history.slice(-V2_MA_WINDOW);
      const ma45 = maSlice.reduce((a, b) => a + b, 0) / maSlice.length;
      const decayFactor = Math.max(0.5, 1 - V2_DECAY_RATE * daysSince);
      teamElo.set(team, ma45 + (elo - ma45) * decayFactor);
    }

    for (const m of todaysMatches) {
      const sc = parseScore(m.score);
      if (!sc) { continue; }
      const [hg, ag] = sc;
      const homeElo = teamElo.get(m.home_team) ?? 1500;
      const awayElo = teamElo.get(m.away_team) ?? 1500;
      const leagueMean = leagueMeans.get(m.league) ?? 1500;

      const odds = oddsMap.get(m.fixture_id);
      const homeProb = odds?.homeProb ?? 0.45;
      const drawProb = odds?.drawProb ?? 0.27;
      const awayProb = odds?.awayProb ?? 0.28;

      const homeActual = hg > ag ? 3 : hg === ag ? 1 : 0;
      const awayActual = ag > hg ? 3 : hg === ag ? 1 : 0;
      const homeExpected = 3 * homeProb + 1 * drawProb;
      const awayExpected = 3 * awayProb + 1 * drawProb;
      const homeEffK = V2_K * (1 + (awayElo - leagueMean) / 400);
      const awayEffK = V2_K * (1 + (homeElo - leagueMean) / 400);

      let homeShock = homeEffK * (homeActual - homeExpected);
      let awayShock = awayEffK * (awayActual - awayExpected);

      const xg = xgByFixtureId.get(m.fixture_id) ?? xgByKey.get(`${m.date}|${m.home_team}|${m.away_team}`);
      if (xg) {
        const homeXgDiff = xg.home_xg - xg.away_xg;
        const homeSign = hg > ag ? 1 : hg < ag ? -1 : 0;
        homeShock *= Math.max(V2_XG_FLOOR, Math.min(V2_XG_CEILING, 1.0 + 0.3 * homeXgDiff * homeSign));

        const awayXgDiff = xg.away_xg - xg.home_xg;
        const awaySign = ag > hg ? 1 : ag < hg ? -1 : 0;
        awayShock *= Math.max(V2_XG_FLOOR, Math.min(V2_XG_CEILING, 1.0 + 0.3 * awayXgDiff * awaySign));
      }

      teamElo.set(m.home_team, homeElo + homeShock);
      teamElo.set(m.away_team, awayElo + awayShock);
      teamLastMatch.set(m.home_team, currentDate);
      teamLastMatch.set(m.away_team, currentDate);
    }

    const allElos = [...teamElo.values()];
    const globalMean = allElos.reduce((a, b) => a + b, 0) / allElos.length;
    const shift = 1500 - globalMean;
    for (const [team, elo] of teamElo) { teamElo.set(team, elo + shift); }

    for (const [team, elo] of teamElo) {
      const price = Math.max(10, (elo - 800) / 5);
      teamSeries.get(team)?.push({ date: currentDate, elo, price });
      const history = teamEloHistory.get(team)!;
      history.push(elo);
      if (history.length > V2_MA_WINDOW + 30) { history.splice(0, history.length - V2_MA_WINDOW - 10); }
    }

    currentDate = addDays(currentDate, 1);
  }

  const result: Record<string, V2Point[]> = {};
  for (const [team, pts] of teamSeries) { result[team] = pts; }
  return result;
}
