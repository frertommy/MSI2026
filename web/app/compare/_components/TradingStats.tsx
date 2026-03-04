import { Box, SimpleGrid, Text } from '@mantine/core';
import cx from 'clsx';
import type { TradingStats as TradingStatsType } from '../_types';
import styles from './TradingStats.module.css';

interface StatCardProps {
  title: string;
  value: string;
  sub?: string;
  valueClass?: string;
}

function StatCard({ title, value, sub, valueClass }: StatCardProps) {
  return (
    <Box className={styles.card}>
      <Text className={styles.cardTitle}>{title}</Text>
      <Text className={cx(styles.cardValue, valueClass)}>{value}</Text>
      {sub && <Text className={styles.cardSub}>{sub}</Text>}
    </Box>
  );
}

interface TradingStatsProps {
  stats: TradingStatsType;
}

export function TradingStats({ stats }: TradingStatsProps) {
  const streakClass = stats.currentStreak.endsWith('W') ? styles.green
    : stats.currentStreak.endsWith('L') ? styles.red
    : stats.currentStreak.endsWith('D') ? styles.amber
    : '';

  const mrClass = stats.meanReversion !== null
    ? (stats.meanReversion < 0 ? styles.green : styles.amber)
    : '';

  const mrLabel = stats.meanReversion !== null
    ? (stats.meanReversion < -0.1 ? 'Mean-reverting' : stats.meanReversion > 0.1 ? 'Trending' : 'Neutral')
    : '';

  const xgClass = stats.xgLuck !== null ? (stats.xgLuck >= 0 ? styles.green : styles.red) : '';
  const xgLabel = stats.xgLuck !== null
    ? (stats.xgLuck > 0.15 ? 'Running lucky' : stats.xgLuck < -0.15 ? 'Running unlucky' : 'Neutral')
    : '';

  return (
    <Box>
      <Text className={styles.sectionTitle}>Trading Statistics</Text>
      <SimpleGrid cols={{ base: 2, md: 3 }} spacing="md" mt="sm">
        <StatCard
          title="Ann. Volatility"
          value={stats.annVol !== null ? `${stats.annVol.toFixed(1)}%` : '—'}
        />
        <StatCard
          title="Streaks"
          value={stats.currentStreak}
          valueClass={streakClass}
          sub={`Max W: ${stats.maxWinStreak} · Max L: ${stats.maxLossStreak}`}
        />
        <StatCard
          title="Mean Reversion"
          value={stats.meanReversion !== null ? `ρ = ${stats.meanReversion.toFixed(3)}` : '—'}
          valueClass={mrClass}
          sub={mrLabel}
        />
        <StatCard
          title="Avg Edge vs Books"
          value={stats.oddsAccuracy !== null ? `${(stats.oddsAccuracy * 100).toFixed(1)}%` : '—'}
        />
        <StatCard
          title="xG Luck Index"
          value={stats.xgLuck !== null ? `${stats.xgLuck >= 0 ? '+' : ''}${stats.xgLuck.toFixed(2)}` : '—'}
          valueClass={xgClass}
          sub={xgLabel}
        />
        <StatCard
          title="Surprise Magnitude"
          value={stats.avgSurprise.toFixed(3)}
          sub={`${stats.upsetPct.toFixed(0)}% upsets (>0.2)`}
        />
      </SimpleGrid>
    </Box>
  );
}
