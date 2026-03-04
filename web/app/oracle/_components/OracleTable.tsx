import { Box, Table, Text } from '@mantine/core';
import cx from 'clsx';
import type { TeamStats, SortKey } from '../_types';
import { LEAGUE_COLOR, LEAGUE_SHORT } from '../_types';
import styles from './OracleTable.module.css';

interface OracleTableProps {
  teams: TeamStats[];
  featured: string | null;
  sortKey: SortKey;
  sortAsc: boolean;
  onSort: (key: SortKey) => void;
  onSelect: (team: string) => void;
}

export function OracleTable({ teams, featured, sortKey, sortAsc, onSort, onSelect }: OracleTableProps) {
  const sortArrow = (key: SortKey) => sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : '';

  const cols: { key: SortKey; label: string }[] = [
    { key: 'currentPrice', label: 'Price' },
    { key: 'currentElo', label: 'Elo' },
    { key: 'pmImpliedPrice', label: 'PM Implied' },
    { key: 'divergence', label: 'Divergence' },
    { key: 'seasonDelta', label: 'Season Δ' },
    { key: 'annualizedVol', label: 'Ann. Vol' },
  ];

  return (
    <Box className={styles.root}>
      <Box className={styles.tableWrapper}>
        <Table className={styles.table}>
          <Table.Thead className={styles.thead}>
            <Table.Tr>
              <Table.Th className={styles.th}>#</Table.Th>
              <Table.Th className={styles.th}>Team</Table.Th>
              <Table.Th className={styles.th}>League</Table.Th>
              {cols.map((c) => (
                <Table.Th
                  key={c.key}
                  className={cx(styles.th, styles.sortable)}
                  onClick={() => onSort(c.key)}
                >
                  {c.label}{sortArrow(c.key)}
                </Table.Th>
              ))}
              <Table.Th className={styles.th}>Range</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {teams.map((t, i) => {
              const isSelected = t.team === featured;
              return (
                <Table.Tr
                  key={t.team}
                  className={cx(styles.row, { [styles.rowSelected]: isSelected })}
                  onClick={() => onSelect(t.team)}
                >
                  <Table.Td className={cx(styles.td, styles.muted)}>{i + 1}</Table.Td>
                  <Table.Td className={styles.td}>
                    <Box className={styles.teamCell}>
                      <Box className={styles.teamDot} style={{ background: LEAGUE_COLOR[t.league] ?? '#888' }} />
                      <Text className={styles.teamName}>{t.team}</Text>
                    </Box>
                  </Table.Td>
                  <Table.Td className={cx(styles.td, styles.muted)}>{LEAGUE_SHORT[t.league] ?? t.league}</Table.Td>
                  <Table.Td className={cx(styles.td, styles.right, styles.green)}>${t.currentPrice.toFixed(2)}</Table.Td>
                  <Table.Td className={cx(styles.td, styles.right)}>{Math.round(t.currentElo)}</Table.Td>
                  <Table.Td className={cx(styles.td, styles.right, styles.cyan)}>{t.pmImpliedPrice !== null ? `$${t.pmImpliedPrice.toFixed(2)}` : '—'}</Table.Td>
                  <Table.Td className={cx(styles.td, styles.right, t.divergence !== null ? (t.divergence >= 0 ? styles.green : styles.red) : styles.muted)}>
                    {t.divergence !== null ? `${t.divergence >= 0 ? '+' : ''}${t.divergence.toFixed(2)}` : '—'}
                  </Table.Td>
                  <Table.Td className={cx(styles.td, styles.right, t.seasonDelta !== null ? (t.seasonDelta >= 0 ? styles.green : styles.red) : styles.muted)}>
                    {t.seasonDelta !== null ? `${t.seasonDelta >= 0 ? '+' : ''}${t.seasonDelta.toFixed(1)}%` : '—'}
                  </Table.Td>
                  <Table.Td className={cx(styles.td, styles.right, styles.muted)}>
                    {t.annualizedVol !== null ? `${t.annualizedVol.toFixed(0)}%` : '—'}
                  </Table.Td>
                  <Table.Td className={cx(styles.td, styles.right, styles.muted)}>
                    {t.priceRange ? `$${t.priceRange[0].toFixed(0)}–$${t.priceRange[1].toFixed(0)}` : '—'}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Box>
    </Box>
  );
}
