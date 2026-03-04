import { Box, Divider, Group, Text } from '@mantine/core';
import type { EnrichedMatch, ProbRow } from '../_types';
import styles from './UpcomingFixtures.module.css';

interface UpcomingFixturesProps {
  matches: EnrichedMatch[];
  probByFixture: Map<number, ProbRow>;
}

export function UpcomingFixtures({ matches, probByFixture }: UpcomingFixturesProps) {
  if (matches.length === 0) { return null; }

  return (
    <Box className={styles.root}>
      <Box className={styles.header}>
        <Text className={styles.title}>Upcoming Fixtures</Text>
      </Box>
      <Box>
        {matches.map((m, i) => {
          const prob = probByFixture.get(m.fixture_id);
          const winProb = prob ? (m.isHome ? prob.implied_home_win : prob.implied_away_win) : null;
          const lossProb = prob ? (m.isHome ? prob.implied_away_win : prob.implied_home_win) : null;

          return (
            <Box key={m.fixture_id}>
              {i > 0 && <Divider className={styles.divider} />}
              <Group justify="space-between" className={styles.row}>
                <Group gap="md">
                  <Text className={styles.date}>{m.date}</Text>
                  <Text className={styles.opponent}>
                    {m.isHome ? 'vs ' : '@ '}{m.opponent}
                  </Text>
                  <Text className={styles.venue}>({m.isHome ? 'H' : 'A'})</Text>
                </Group>
                {prob && (
                  <Group gap="md">
                    <Text className={styles.probGreen}>W {((winProb ?? 0) * 100).toFixed(0)}%</Text>
                    <Text className={styles.probAmber}>D {(prob.implied_draw * 100).toFixed(0)}%</Text>
                    <Text className={styles.probRed}>L {((lossProb ?? 0) * 100).toFixed(0)}%</Text>
                  </Group>
                )}
              </Group>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
