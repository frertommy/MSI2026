'use client';

import { useState, useMemo } from 'react';
import { Box, Button, Group, NativeSelect, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import cx from 'clsx';
import type { MeasureMeRow, TeamEloRow, SortCol, NumericKey } from '../_types';
import { INITIAL_TABLE_ROWS, SLOPE_OPTIONS } from '../_types';
import { WinnerBanner } from './WinnerBanner';
import { IndexBreakdown } from './IndexBreakdown';
import styles from './MeasureMeClient.module.css';

function compositeColorClass(score: number): string {
  if (score >= 70) { return styles.green; }
  if (score >= 50) { return styles.amber; }
  return styles.red;
}

function scoreColorClass(score: number): string {
  if (score >= 70) { return styles.green; }
  if (score >= 40) { return styles.amber; }
  return styles.red;
}

const TABLE_COLS: [SortCol, string][] = [
  ['rank', '#'], ['k_factor', 'K'], ['decay', 'Decay'], ['prematch_weight', 'PW'],
  ['composite_score', 'Score'], ['surprise_r2_score', 'R²'], ['drift_score', 'Drift'],
  ['floor_hit_score', 'Floor'], ['kurtosis_score', 'Kurt'], ['vol_uni_score', 'Vol×'],
  ['mean_rev_score', 'MR'], ['info_score', 'Info'], ['odds_responsiveness_score', 'OddsR'],
  ['venue_stability_score', 'Venue'], ['between_match_vol_score', 'BtwnV'],
  ['avg_match_move_pct', 'Avg⚡%'], ['avg_annual_vol', 'σ/yr'],
];

interface MeasureMeClientProps {
  results: MeasureMeRow[];
  runId: string;
  teamElos: TeamEloRow[];
}

export function MeasureMeClient({ results, runId, teamElos }: MeasureMeClientProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [sortCol, setSortCol] = useState<SortCol>('composite_score');
  const [sortAsc, setSortAsc] = useState(false);
  const [displaySlope, setDisplaySlope] = useState(5);

  const best = results[0];
  const selected = results[selectedIdx] ?? best;

  const sorted = useMemo(() => {
    const indexed = results.map((r, i) => ({ ...r, origRank: i + 1 }));
    indexed.sort((a, b) => {
      if (sortCol === 'rank') { return sortAsc ? a.origRank - b.origRank : b.origRank - a.origRank; }
      const col: NumericKey = sortCol;
      return sortAsc ? Number(a[col]) - Number(b[col]) : Number(b[col]) - Number(a[col]);
    });
    return indexed;
  }, [results, sortCol, sortAsc]);

  const displayRows = showAll ? sorted : sorted.slice(0, INITIAL_TABLE_ROWS);

  const priceImplications = useMemo(() => {
    if (teamElos.length === 0) { return []; }
    const combined = [...teamElos.slice(0, 10), ...teamElos.slice(-5)];
    return combined.map((t) => ({
      team: t.team,
      elo: t.implied_elo,
      price: Math.max(10, (t.implied_elo - selected.zero_point) / displaySlope),
      atFloor: (t.implied_elo - selected.zero_point) / displaySlope <= 10,
    }));
  }, [teamElos, displaySlope, selected.zero_point]);

  function handleSort(col: SortCol) {
    if (col === sortCol) { setSortAsc(!sortAsc); } else { setSortCol(col); setSortAsc(false); }
  }

  function sortIndicator(col: SortCol) {
    if (col !== sortCol) { return ''; }
    return sortAsc ? ' ▲' : ' ▼';
  }

  function selectRow(row: MeasureMeRow & { origRank: number }) {
    const idx = results.findIndex(
      (r) => r.k_factor === row.k_factor && r.decay === row.decay && r.zero_point === row.zero_point && r.prematch_weight === row.prematch_weight,
    );
    if (idx >= 0) { setSelectedIdx(idx); }
  }

  if (!best) { return null; }

  return (
    <Stack gap="xl">
      <WinnerBanner best={best} total={results.length} />

      <IndexBreakdown selected={selected} />

      <Box>
        <Text className={styles.sectionTitle}>All Configs</Text>
        <Box className={styles.tableWrapper}>
          <Table className={styles.table}>
            <Table.Thead className={styles.thead}>
              <Table.Tr>
                {TABLE_COLS.map(([col, label]) => (
                  <Table.Th
                    key={col}
                    className={cx(styles.th, styles.sortable)}
                    onClick={() => handleSort(col)}
                  >
                    {label}{sortIndicator(col)}
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {displayRows.map((row) => {
                const isSelected = row.k_factor === selected.k_factor && row.decay === selected.decay && row.zero_point === selected.zero_point && row.prematch_weight === selected.prematch_weight;
                const isBest = row.origRank === 1;

                return (
                  <Table.Tr
                    key={`${row.k_factor}-${row.decay}-${row.zero_point}-${row.prematch_weight}`}
                    className={cx(styles.row, { [styles.rowBest]: isBest, [styles.rowSelected]: isSelected && !isBest })}
                    onClick={() => selectRow(row)}
                  >
                    <Table.Td className={cx(styles.td, styles.muted)}>{row.origRank}</Table.Td>
                    <Table.Td className={styles.td}>{row.k_factor}</Table.Td>
                    <Table.Td className={styles.td}>{row.decay}</Table.Td>
                    <Table.Td className={styles.td}>{row.prematch_weight === -1 ? 'DRIFT' : row.prematch_weight}</Table.Td>
                    <Table.Td className={cx(styles.td, styles.bold, compositeColorClass(row.composite_score))}>{Number(row.composite_score).toFixed(1)}</Table.Td>
                    {(['surprise_r2_score', 'drift_score', 'floor_hit_score', 'kurtosis_score', 'vol_uni_score', 'mean_rev_score', 'info_score', 'odds_responsiveness_score', 'venue_stability_score', 'between_match_vol_score'] as const).map((k) => (
                      <Table.Td key={k} className={cx(styles.td, scoreColorClass(Number(row[k] ?? 0)))}>{Math.round(Number(row[k] ?? 0))}</Table.Td>
                    ))}
                    <Table.Td className={styles.td}>{row.avg_match_move_pct.toFixed(2)}</Table.Td>
                    <Table.Td className={styles.td}>{row.avg_annual_vol.toFixed(1)}</Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Box>

        {!showAll && sorted.length > INITIAL_TABLE_ROWS && (
          <Box mt="md" style={{ textAlign: 'center' }}>
            <Button variant="outline" size="xs" onClick={() => setShowAll(true)} className={styles.showAllBtn}>
              Show all {sorted.length} configs
            </Button>
          </Box>
        )}
        {showAll && sorted.length > INITIAL_TABLE_ROWS && (
          <Box mt="md" style={{ textAlign: 'center' }}>
            <Button variant="outline" size="xs" onClick={() => setShowAll(false)} className={styles.showLessBtn}>
              Show top {INITIAL_TABLE_ROWS} only
            </Button>
          </Box>
        )}
      </Box>

      <Box>
        <Group mb="sm" wrap="wrap" align="center">
          <Text className={styles.sectionTitle}>
            Price Implications <Text component="span" className={styles.subtitle}>— zp={selected.zero_point}</Text>
          </Text>
          <Group gap="xs" align="center">
            <Text className={styles.slopeLabel}>Slope:</Text>
            <NativeSelect
              value={String(displaySlope)}
              onChange={(e) => setDisplaySlope(Number(e.target.value))}
              data={SLOPE_OPTIONS.map((s) => String(s))}
              className={styles.slopeSelect}
            />
            <Text className={styles.slopeHint}>(display only — slope cancels in % returns)</Text>
          </Group>
        </Group>

        {priceImplications.length === 0 ? (
          <Text className={styles.noData}>No team Elo data available.</Text>
        ) : (
          <Box className={styles.priceTableWrapper}>
            <Table className={styles.table}>
              <Table.Thead className={styles.thead}>
                <Table.Tr>
                  {['Team', 'Current Elo', 'Price', ''].map((h) => (
                    <Table.Th key={h} className={styles.th}>{h}</Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {priceImplications.map((t) => (
                  <Table.Tr key={t.team} className={styles.row}>
                    <Table.Td className={styles.td}>{t.team}</Table.Td>
                    <Table.Td className={cx(styles.td, styles.muted, styles.right)}>{Math.round(t.elo)}</Table.Td>
                    <Table.Td className={cx(styles.td, styles.green, styles.bold, styles.right)}>${t.price.toFixed(0)}</Table.Td>
                    <Table.Td className={cx(styles.td, styles.right)}>
                      {t.atFloor && <Text component="span" className={styles.atFloor}>⚠ AT FLOOR</Text>}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        )}

        <Text className={styles.formula}>
          Formula: price = max($10, (elo − {selected.zero_point}) / {displaySlope}) · Current Elos from latest oracle run
        </Text>
      </Box>

      <Box className={styles.footer}>
        Run {runId} · {results.length} configs · {best.total_teams} teams · {best.total_matches_evaluated} matches
      </Box>
    </Stack>
  );
}
