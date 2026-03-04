import { Box, Group, SimpleGrid, Text } from '@mantine/core';
import cx from 'clsx';
import type { MeasureMeRow } from '../_types';
import { INDEX_DEFS } from '../_types';
import styles from './IndexBreakdown.module.css';

function scoreColorClass(score: number): string {
  if (score >= 70) { return styles.green; }
  if (score >= 40) { return styles.amber; }
  return styles.red;
}

function scoreBgClass(score: number): string {
  if (score >= 70) { return styles.barGreen; }
  if (score >= 40) { return styles.barAmber; }
  return styles.barRed;
}

interface IndexBreakdownProps {
  selected: MeasureMeRow;
}

export function IndexBreakdown({ selected }: IndexBreakdownProps) {
  return (
    <Box>
      <Group mb="sm">
        <Text className={styles.title}>
          Index Breakdown{' '}
          <Text component="span" className={styles.subtitle}>
            — K={selected.k_factor} decay={selected.decay} zp={selected.zero_point} pw={selected.prematch_weight === -1 ? 'DRIFT' : selected.prematch_weight}
          </Text>
        </Text>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="sm">
        {INDEX_DEFS.map((def) => {
          const score = Number(selected[def.key]);
          const raw = Number(selected[def.rawKey]);

          return (
            <Box key={def.key} className={styles.card}>
              <Group justify="space-between" mb="xs">
                <Text className={styles.cardTitle}>{def.name}</Text>
                <Text className={styles.cardWeight}>w={def.weight}</Text>
              </Group>

              <Group gap="xs" mb="xs" align="center">
                <Box className={styles.barTrack}>
                  <Box
                    className={cx(styles.barFill, scoreBgClass(score))}
                    style={{ width: `${Math.min(100, score)}%` }}
                  />
                </Box>
                <Text className={cx(styles.scoreValue, scoreColorClass(score))}>
                  {Math.round(score)}
                </Text>
              </Group>

              <Box className={styles.meta}>
                <Text className={styles.metaLine}>Raw: {def.rawFmt(raw)}</Text>
                <Text className={styles.metaLine}>{def.description}</Text>
                <Text className={cx(styles.metaLine, styles.metaDim)}>Target: {def.target}</Text>
              </Box>
            </Box>
          );
        })}
      </SimpleGrid>
    </Box>
  );
}
