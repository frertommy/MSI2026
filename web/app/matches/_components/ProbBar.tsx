import { Box, Group, Text } from '@mantine/core';
import { formatPct } from '../_utils/format';
import styles from './ProbBar.module.css';

interface ProbBarProps {
  home: number;
  draw: number;
  away: number;
  source: 'odds' | 'elo';
}

export function ProbBar({ home, draw, away, source }: ProbBarProps) {
  return (
    <Box className={styles.root}>
      <Group gap={4} className={styles.header}>
        <Text className={styles.label}>Match Probabilities</Text>
        <Text className={styles.source}>({source})</Text>
      </Group>

      <Box className={styles.track}>
        <Box className={styles.segGreen} style={{ width: `${home * 100}%` }} title={`Home: ${formatPct(home)}`} />
        <Box className={styles.segAmber} style={{ width: `${draw * 100}%` }} title={`Draw: ${formatPct(draw)}`} />
        <Box className={styles.segRed}   style={{ width: `${away * 100}%` }} title={`Away: ${formatPct(away)}`} />
      </Box>

      <Group justify="space-between" className={styles.labels}>
        <Text className={styles.pctGreen}>{formatPct(home)}</Text>
        <Text className={styles.pctAmber}>{formatPct(draw)}</Text>
        <Text className={styles.pctRed}>{formatPct(away)}</Text>
      </Group>
    </Box>
  );
}
