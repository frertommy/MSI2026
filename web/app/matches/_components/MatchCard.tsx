import { Box, Text } from '@mantine/core';
import type { EnrichedMatch } from '../_types';
import { ImpactRow } from './ImpactRow';
import { ProbBar } from './ProbBar';
import styles from './MatchCard.module.css';

const LEAGUE_SHORT: Record<string, string> = {
  'Premier League': 'EPL',
  'La Liga': 'ESP',
  Bundesliga: 'BUN',
  'Serie A': 'ITA',
  'Ligue 1': 'FRA',
};

interface MatchCardProps {
  match: EnrichedMatch;
}

export function MatchCard({ match }: MatchCardProps) {
  const { homeImpacts, awayImpacts, probs } = match;
  const homeShort = match.home_team.split(' ').pop() ?? match.home_team;
  const awayShort = match.away_team.split(' ').pop() ?? match.away_team;
  const leagueShort = LEAGUE_SHORT[match.league] ?? match.league;

  return (
    <Box className={styles.root}>
      <Box className={styles.header}>
        <Box className={styles[`league_${leagueShort}`] ?? styles.leagueDefault}>
          <Text className={styles.leagueLabel}>{leagueShort}</Text>
        </Box>
        <Text className={styles.date}>{match.date}</Text>
      </Box>

      <Box className={styles.body}>
        <Box className={styles.teamsGrid}>
          <Box className={styles.homeTeam}>
            <Text className={styles.teamName}>{match.home_team}</Text>
            <Text className={styles.teamMeta}>${match.home_price.toFixed(2)} · Elo {Math.round(match.home_elo)}</Text>
            <Box className={styles.impacts}>
              <ImpactRow label={`${homeShort} Win`} delta={homeImpacts.win.delta} pctDelta={homeImpacts.win.pctDelta} />
              <ImpactRow label="Draw" delta={homeImpacts.draw.delta} pctDelta={homeImpacts.draw.pctDelta} />
              <ImpactRow label={`${homeShort} Loss`} delta={homeImpacts.loss.delta} pctDelta={homeImpacts.loss.pctDelta} />
            </Box>
          </Box>

          <Box className={styles.vs}>
            <Text className={styles.vsLabel}>VS</Text>
          </Box>

          <Box className={styles.awayTeam}>
            <Text className={styles.teamName}>{match.away_team}</Text>
            <Text className={styles.teamMeta}>${match.away_price.toFixed(2)} · Elo {Math.round(match.away_elo)}</Text>
            <Box className={styles.impacts}>
              <ImpactRow label={`${awayShort} Win`} delta={awayImpacts.win.delta} pctDelta={awayImpacts.win.pctDelta} align="right" />
              <ImpactRow label="Draw" delta={awayImpacts.draw.delta} pctDelta={awayImpacts.draw.pctDelta} align="right" />
              <ImpactRow label={`${awayShort} Loss`} delta={awayImpacts.loss.delta} pctDelta={awayImpacts.loss.pctDelta} align="right" />
            </Box>
          </Box>
        </Box>

        <ProbBar home={probs.home} draw={probs.draw} away={probs.away} source={probs.source} />
      </Box>
    </Box>
  );
}
