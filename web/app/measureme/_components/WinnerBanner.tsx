import { Box, Group, Text } from '@mantine/core';
import type { MeasureMeRow } from '../_types';
import styles from './WinnerBanner.module.css';

interface WinnerBannerProps {
  best: MeasureMeRow;
  total: number;
}

export function WinnerBanner({ best, total }: WinnerBannerProps) {
  return (
    <Box className={styles.root}>
      <Group justify="space-between" align="flex-start" gap="xl" wrap="wrap">
        <Box>
          <Group gap="md" mb="sm">
            <Text className={styles.rank}>#1</Text>
            <Text className={styles.title}>Best Config</Text>
            <Text className={styles.count}>of {total} tested</Text>
          </Group>

          <Group gap="xl" wrap="wrap">
            {[
              ['K', String(best.k_factor)],
              ['Decay', String(best.decay)],
              ['ZeroPoint', String(best.zero_point)],
              ['PW', best.prematch_weight === -1 ? 'DRIFT' : String(best.prematch_weight)],
              ['Avg Move', `${best.avg_match_move_pct.toFixed(2)}%`],
              ['Ann Vol', `${best.avg_annual_vol.toFixed(1)}%`],
              ['R²', best.surprise_r2.toFixed(4)],
            ].map(([label, val]) => (
              <Box key={label}>
                <Text component="span" className={styles.paramLabel}>{label}</Text>{' '}
                <Text component="span" className={styles.paramValue}>{val}</Text>
              </Box>
            ))}
          </Group>

          <Box className={styles.codeBlock}>
            <Text className={styles.codeComment}>{'// config.ts'}</Text>
            <Text className={styles.codeLine}><Text component="span" className={styles.keyword}>export const</Text> PRICE_SLOPE = 5; <Text component="span" className={styles.codeComment}>// display only</Text></Text>
            <Text className={styles.codeLine}><Text component="span" className={styles.keyword}>export const</Text> PRICE_ZERO = {best.zero_point};</Text>
            <Text className={styles.codeLine}><Text component="span" className={styles.keyword}>export const</Text> PRICE_FLOOR = 10;</Text>
            <Text className={styles.codeLine}><Text component="span" className={styles.keyword}>export const</Text> ORACLE_SHOCK_K = {best.k_factor};</Text>
            <Text className={styles.codeLine}><Text component="span" className={styles.keyword}>export const</Text> CARRY_DECAY = {best.decay};</Text>
            <Text className={styles.codeLine}><Text component="span" className={styles.keyword}>export const</Text> PREMATCH_WEIGHT = {best.prematch_weight === -1 ? 'N/A (drift)' : best.prematch_weight};</Text>
          </Box>
        </Box>

        <Box className={styles.scoreBox}>
          <Text className={styles.scoreValue}>{Number(best.composite_score).toFixed(1)}</Text>
          <Text className={styles.scoreLabel}>composite /100</Text>
        </Box>
      </Group>
    </Box>
  );
}
