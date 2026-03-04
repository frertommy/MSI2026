import { Box, Divider, Group, Text } from '@mantine/core';
import type { HeaderStats } from '../_types';
import { LEAGUE_COLOR, LEAGUE_SHORT } from '../_types';
import styles from './HeaderBar.module.css';
import cx from 'clsx';

interface StatCellProps {
  label: string;
  value: string;
  colorClass?: string;
}

function StatCell({ label, value, colorClass }: StatCellProps) {
  return (
    <Box className={styles.statCell}>
      <Text className={styles.statLabel}>{label}</Text>
      <Text className={cx(styles.statValue, colorClass)}>{value}</Text>
    </Box>
  );
}

function returnColorClass(v: number | null): string {
  if (v === null) { return ''; }
  return v >= 0 ? styles.green : styles.red;
}

interface HeaderBarProps {
  teamName: string;
  league: string;
  stats: HeaderStats;
}

export function HeaderBar({ teamName, league, stats }: HeaderBarProps) {
  const leagueColor = LEAGUE_COLOR[league] ?? '#888';
  const leagueShort = LEAGUE_SHORT[league] ?? league;

  return (
    <Box className={styles.root}>
      <Group wrap="wrap" gap="lg" align="center">
        <Group gap="sm" align="center">
          <Box className={styles.leagueDot} style={{ background: leagueColor }} />
          <Text className={styles.teamName}>{teamName}</Text>
          <Box className={styles.leagueBadge} style={{ color: leagueColor, borderColor: leagueColor }}>
            <Text className={styles.leagueBadgeText}>{leagueShort}</Text>
          </Box>
        </Group>

        <Divider orientation="vertical" className={styles.divider} />

        <StatCell label="Price" value={`$${stats.currentPrice.toFixed(2)}`} colorClass={styles.green} />

        <Divider orientation="vertical" className={styles.divider} />

        <StatCell label="Elo" value={String(Math.round(stats.currentElo))} />

        <Divider orientation="vertical" className={styles.divider} />

        <Box className={styles.statCell}>
          <Text className={styles.statLabel}>Record</Text>
          <Group gap={4}>
            <Text className={cx(styles.statValue, styles.green)}>{stats.record.w}W</Text>
            <Text className={cx(styles.statValue, styles.amber)}>{stats.record.d}D</Text>
            <Text className={cx(styles.statValue, styles.red)}>{stats.record.l}L</Text>
          </Group>
        </Box>

        <Divider orientation="vertical" className={styles.divider} />

        <StatCell
          label="Season"
          value={stats.seasonReturn !== null ? `${stats.seasonReturn >= 0 ? '+' : ''}${stats.seasonReturn.toFixed(1)}%` : '—'}
          colorClass={returnColorClass(stats.seasonReturn)}
        />

        {stats.return7d !== null && (
          <>
            <Divider orientation="vertical" className={styles.divider} />
            <StatCell label="7d" value={`${stats.return7d >= 0 ? '+' : ''}${stats.return7d.toFixed(1)}%`} colorClass={returnColorClass(stats.return7d)} />
          </>
        )}

        {stats.return30d !== null && (
          <>
            <Divider orientation="vertical" className={styles.divider} />
            <StatCell label="30d" value={`${stats.return30d >= 0 ? '+' : ''}${stats.return30d.toFixed(1)}%`} colorClass={returnColorClass(stats.return30d)} />
          </>
        )}
      </Group>
    </Box>
  );
}
