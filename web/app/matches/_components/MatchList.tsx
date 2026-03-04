'use client';

import { useState } from 'react';
import { Box, Button, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import cx from 'clsx';
import type { EnrichedMatch } from '../_types';
import { MatchCard } from './MatchCard';
import { formatDate } from '../_utils/format';
import styles from './MatchList.module.css';

const LEAGUE_SHORT: Record<string, string> = {
  'Premier League': 'EPL',
  'La Liga': 'ESP',
  Bundesliga: 'BUN',
  'Serie A': 'ITA',
  'Ligue 1': 'FRA',
};

interface MatchListProps {
  matches: EnrichedMatch[];
}

export function MatchList({ matches }: MatchListProps) {
  const leagues = [...new Set(matches.map((m) => m.league))].sort();
  const [activeLeague, setActiveLeague] = useState('All');

  const filtered = activeLeague === 'All'
    ? matches
    : matches.filter((m) => m.league === activeLeague);

  const grouped = new Map<string, EnrichedMatch[]>();
  for (const m of filtered) {
    if (!grouped.has(m.date)) { grouped.set(m.date, []); }
    grouped.get(m.date)!.push(m);
  }
  const sortedDates = [...grouped.keys()].sort();

  if (matches.length === 0) {
    return (
      <Box className={styles.empty}>
        <Text className={styles.emptyIcon}>⚽</Text>
        <Text className={styles.emptyTitle}>No upcoming matches</Text>
        <Text className={styles.emptyHint}>Check back on match day</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Group gap="xs" mb="md" wrap="wrap">
        <Button
          size="xs"
          onClick={() => setActiveLeague('All')}
          className={cx(styles.filterBtn, { [styles.filterBtnActive]: activeLeague === 'All' })}
        >
          All ({matches.length})
        </Button>
        {leagues.map((league) => {
          const count = matches.filter((m) => m.league === league).length;
          const isActive = activeLeague === league;
          return (
            <Button
              key={league}
              size="xs"
              onClick={() => setActiveLeague(league)}
              className={cx(styles.filterBtn, { [styles.filterBtnActive]: isActive })}
            >
              {LEAGUE_SHORT[league] ?? league} ({count})
            </Button>
          );
        })}
      </Group>

      <Box className={styles.formulaHint}>
        Price impact = logistic(Elo ± K<sub>eff</sub> × surprise) where K<sub>eff</sub> = 20 × (1 + (opp_elo − league_mean) / 400)
      </Box>

      <Stack gap="xl">
        {sortedDates.map((date) => {
          const dateMatches = grouped.get(date)!;
          return (
            <Box key={date}>
              <Group gap="xs" mb="sm" className={styles.dateHeader}>
                <Box className={styles.dateDot} />
                <Text className={styles.dateLabel}>{formatDate(date)}</Text>
                <Text className={styles.dateCount}>· {dateMatches.length} {dateMatches.length === 1 ? 'match' : 'matches'}</Text>
              </Group>
              <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="sm">
                {dateMatches.map((match) => (
                  <MatchCard key={`${match.fixture_id}-${match.home_team}`} match={match} />
                ))}
              </SimpleGrid>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}
