'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Box, Button, Group, Table, Text } from '@mantine/core';
import cx from 'clsx';
import type { TeamRow } from '@/lib/types';
import { WdlBar } from './WdlBar';
import styles from './TeamTable.module.css';

const LEAGUE_SHORT: Record<string, string> = {
  'Premier League': 'EPL',
  'La Liga': 'ESP',
  Bundesliga: 'BUN',
  'Serie A': 'ITA',
  'Ligue 1': 'FRA',
};

interface TeamTableProps {
  teams: TeamRow[];
  leagues: string[];
}

export function TeamTable({ teams, leagues }: TeamTableProps) {
  const router = useRouter();
  const [activeLeague, setActiveLeague] = useState<string>('All');

  const filtered = activeLeague === 'All'
    ? teams
    : teams.filter((t) => t.league === activeLeague);

  const ranked = filtered.map((t, i) => ({ ...t, rank: i + 1 }));

  return (
    <Box>
      <Group gap="xs" mb="md" wrap="wrap">
        <Button
          size="xs"
          variant={activeLeague === 'All' ? 'filled' : 'outline'}
          onClick={() => setActiveLeague('All')}
          className={cx(styles.filterBtn, { [styles.filterBtnActive]: activeLeague === 'All' })}
        >
          All ({teams.length})
        </Button>

        {leagues.map((league) => {
          const count = teams.filter((t) => t.league === league).length;
          const isActive = activeLeague === league;
          return (
            <Button
              key={league}
              size="xs"
              variant={isActive ? 'filled' : 'outline'}
              onClick={() => setActiveLeague(league)}
              className={cx(styles.filterBtn, { [styles.filterBtnActive]: isActive })}
            >
              {LEAGUE_SHORT[league] ?? league} ({count})
            </Button>
          );
        })}
      </Group>

      <Box className={styles.tableWrapper}>
        <Table className={styles.table}>
          <Table.Thead>
            <Table.Tr className={styles.headerRow}>
              <Table.Th className={cx(styles.th, styles.colRank)}>#</Table.Th>
              <Table.Th className={styles.th}>Team</Table.Th>
              <Table.Th className={styles.th}>League</Table.Th>
              <Table.Th className={cx(styles.th, styles.right)}>Elo</Table.Th>
              <Table.Th className={cx(styles.th, styles.right)}>Price</Table.Th>
              <Table.Th className={cx(styles.th, styles.right)}>P</Table.Th>
              <Table.Th className={cx(styles.th, styles.center)}>W-D-L</Table.Th>
              <Table.Th className={cx(styles.th, styles.center)}>Form</Table.Th>
              <Table.Th className={cx(styles.th, styles.right)}>Latest</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {ranked.map((t) => (
              <Table.Tr
                key={t.team}
                onClick={() => router.push(`/compare?team=${encodeURIComponent(t.team)}`)}
                className={styles.row}
              >
                <Table.Td className={cx(styles.td, styles.colRank, styles.muted)}>
                  {t.rank}
                </Table.Td>
                <Table.Td className={cx(styles.td, styles.teamName)}>
                  {t.team}
                </Table.Td>
                <Table.Td className={cx(styles.td, styles[`league_${LEAGUE_SHORT[t.league] ?? 'other'}`])}>
                  {LEAGUE_SHORT[t.league] ?? t.league}
                </Table.Td>
                <Table.Td className={cx(styles.td, styles.right, styles.mono, styles.bold, eloClass(t.impliedElo))}>
                  {t.impliedElo !== null ? Math.round(t.impliedElo) : '---'}
                </Table.Td>
                <Table.Td className={cx(styles.td, styles.right, styles.mono, styles.bold, priceClass(t.dollarPrice))}>
                  {t.dollarPrice !== null ? `$${t.dollarPrice.toFixed(2)}` : '---'}
                </Table.Td>
                <Table.Td className={cx(styles.td, styles.right, styles.mono, styles.muted)}>
                  {t.played}
                </Table.Td>
                <Table.Td className={cx(styles.td, styles.center, styles.mono)}>
                  <Text component="span" className={styles.win}>{t.wins}</Text>
                  <Text component="span" className={styles.muted}>-</Text>
                  <Text component="span" className={styles.draw}>{t.draws}</Text>
                  <Text component="span" className={styles.muted}>-</Text>
                  <Text component="span" className={styles.loss}>{t.losses}</Text>
                </Table.Td>
                <Table.Td className={cx(styles.td, styles.center)}>
                  <WdlBar w={t.wins} d={t.draws} l={t.losses} />
                </Table.Td>
                <Table.Td className={cx(styles.td, styles.right, styles.mono, styles.xs, styles.muted)}>
                  {t.latestDate}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>

      {ranked.length === 0 && (
        <Box className={styles.empty}>
          No teams found for this filter.
        </Box>
      )}
    </Box>
  );
}

function priceClass(price: number | null): string {
  if (price === null) { return styles.muted; }
  if (price >= 65) { return styles.win; }
  if (price >= 45) { return styles.draw; }
  return styles.loss;
}

function eloClass(elo: number | null): string {
  if (elo === null) { return styles.muted; }
  if (elo >= 1600) { return styles.win; }
  if (elo >= 1450) { return styles.draw; }
  return styles.loss;
}
