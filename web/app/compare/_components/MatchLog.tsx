import { Box, Table, Text } from '@mantine/core';
import type { EnrichedMatch } from '../_types';
import { RESULT_COLOR } from '../_types';
import styles from './MatchLog.module.css';
import cx from 'clsx';

interface MatchLogProps {
  matches: EnrichedMatch[];
}

export function MatchLog({ matches }: MatchLogProps) {
  if (matches.length === 0) { return null; }

  return (
    <Box className={styles.root}>
      <Box className={styles.header}>
        <Text className={styles.title}>Match Log — {matches.length} matches</Text>
      </Box>

      <Box className={styles.tableWrapper}>
        <Table className={styles.table}>
          <Table.Thead className={styles.thead}>
            <Table.Tr>
              {['Date', 'Opponent', 'H/A', 'Score', 'xG', 'Surprise', 'xG Mult', 'Impact', 'Post $'].map((h) => (
                <Table.Th key={h} className={styles.th}>{h}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {matches.map((m) => (
              <Table.Tr key={m.fixture_id} className={styles.row}>
                <Table.Td className={cx(styles.td, styles.muted)}>{m.date}</Table.Td>
                <Table.Td className={styles.td}>{m.isHome ? 'vs ' : '@ '}{m.opponent}</Table.Td>
                <Table.Td className={cx(styles.td, styles.center, styles.muted)}>{m.isHome ? 'H' : 'A'}</Table.Td>
                <Table.Td className={cx(styles.td, styles.center)}>
                  <Text component="span" style={{ color: RESULT_COLOR[m.result] }}>{m.score}</Text>
                </Table.Td>
                <Table.Td className={cx(styles.td, styles.right, styles.muted)}>
                  {m.teamXg !== null && m.opponentXg !== null ? `${m.teamXg.toFixed(1)}–${m.opponentXg.toFixed(1)}` : '—'}
                </Table.Td>
                <Table.Td className={cx(styles.td, styles.right, m.surprise !== null ? (m.surprise >= 0 ? styles.green : styles.red) : styles.muted)}>
                  {m.surprise !== null ? `${m.surprise >= 0 ? '+' : ''}${m.surprise.toFixed(3)}` : '—'}
                </Table.Td>
                <Table.Td className={cx(styles.td, styles.right, m.xgMult !== null ? (m.xgMult >= 1 ? styles.green : styles.red) : styles.muted)}>
                  {m.xgMult !== null ? `${m.xgMult.toFixed(2)}×` : '—'}
                </Table.Td>
                <Table.Td className={cx(styles.td, styles.right, m.priceImpact !== null ? (m.priceImpact >= 0 ? styles.green : styles.red) : styles.muted)}>
                  {m.priceImpact !== null ? `${m.priceImpact >= 0 ? '+' : ''}$${m.priceImpact.toFixed(2)}` : '—'}
                </Table.Td>
                <Table.Td className={cx(styles.td, styles.right)}>
                  {m.postPrice !== null ? `$${m.postPrice.toFixed(2)}` : '—'}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
    </Box>
  );
}
