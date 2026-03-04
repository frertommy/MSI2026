'use client';

import { useState, useMemo } from 'react';
import { Box, Button, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import cx from 'clsx';
import type { OraclePriceRow, MatchInfo, PmPrice, TeamStats, SortKey } from '../_types';
import { LEAGUE_SHORT } from '../_types';
import { computeTeamStats, buildChartData } from '../_utils/team-stats';
import { OracleTeamChart } from './OracleTeamChart';
import { OracleTable } from './OracleTable';
import styles from './OracleClient.module.css';

const INITIAL_SHOW = 20;
const LEAGUES = ['All', 'EPL', 'ESP', 'BUN', 'ITA', 'FRA'];

interface OracleClientProps {
  priceHistory: OraclePriceRow[];
  matches: MatchInfo[];
  pmPrices: PmPrice[];
}

export function OracleClient({ priceHistory, matches, pmPrices }: OracleClientProps) {
  const [activeLeague, setActiveLeague] = useState('All');
  const [showAll, setShowAll] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('currentPrice');
  const [sortAsc, setSortAsc] = useState(false);

  const teamStats = useMemo(() => computeTeamStats(priceHistory, pmPrices), [priceHistory, pmPrices]);
  const chartDataByTeam = useMemo(() => buildChartData(priceHistory, matches), [priceHistory, matches]);

  const filteredTeams = useMemo(() => {
    let teams: TeamStats[] = teamStats;
    if (activeLeague !== 'All') {
      const fullName = Object.entries(LEAGUE_SHORT).find(([, v]) => v === activeLeague)?.[0];
      if (fullName) { teams = teams.filter((t) => t.league === fullName); }
    }
    return [...teams].sort((a, b) => {
      const aVal = a[sortKey] ?? -Infinity;
      const bVal = b[sortKey] ?? -Infinity;
      return sortAsc ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
  }, [teamStats, activeLeague, sortKey, sortAsc]);

  const displayTeams = showAll ? filteredTeams : filteredTeams.slice(0, INITIAL_SHOW);
  const featured = selectedTeam ?? (filteredTeams.length > 0 ? filteredTeams[0].team : null);
  const featuredStats = teamStats.find((t) => t.team === featured);
  const featuredChart = featured ? chartDataByTeam.get(featured) : null;

  function handleSort(key: SortKey) {
    if (sortKey === key) { setSortAsc(!sortAsc); } else { setSortKey(key); setSortAsc(false); }
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" wrap="wrap">
        <Group gap={4}>
          {LEAGUES.map((l) => (
            <Button
              key={l}
              size="xs"
              onClick={() => { setActiveLeague(l); setShowAll(false); setSelectedTeam(null); }}
              className={cx(styles.filterBtn, { [styles.filterBtnActive]: activeLeague === l })}
            >
              {l}
            </Button>
          ))}
        </Group>

        <Group gap="lg">
          {(['W', 'D', 'L'] as const).map((r) => (
            <Group key={r} gap={6}>
              <Box className={styles.legendDot} style={{ background: r === 'W' ? '#00e676' : r === 'D' ? '#ffc107' : '#ff1744' }} />
              <Text className={styles.legendLabel}>{r === 'W' ? 'Win' : r === 'D' ? 'Draw' : 'Loss'}</Text>
            </Group>
          ))}
        </Group>
      </Group>

      <Box className={styles.spec}>
        <Text component="span" className={styles.specBold}>Oracle 1b:</Text>{' '}
        price = max($10, (elo − 800) / 5) · K=20 · forward-looking BT (14d) · freshness exp(−h/72) · live shocks 0.5× · carry decay 0.1%/d → 45d MA · xG [0.4, 1.8]
      </Box>

      {featured && featuredStats && featuredChart && (
        <OracleTeamChart team={featured} league={featuredStats.league} data={featuredChart.data} stats={featuredStats} matchPoints={featuredChart.matchPoints} large />
      )}

      <OracleTable
        teams={filteredTeams}
        featured={featured}
        sortKey={sortKey}
        sortAsc={sortAsc}
        onSort={handleSort}
        onSelect={setSelectedTeam}
      />

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        {displayTeams.map((t) => {
          const chart = chartDataByTeam.get(t.team);
          if (!chart) { return null; }
          return (
            <Box key={t.team} onClick={() => setSelectedTeam(t.team)} style={{ cursor: 'pointer' }}>
              <OracleTeamChart team={t.team} league={t.league} data={chart.data} stats={t} matchPoints={chart.matchPoints} />
            </Box>
          );
        })}
      </SimpleGrid>

      {!showAll && filteredTeams.length > INITIAL_SHOW && (
        <Box style={{ textAlign: 'center' }}>
          <Button variant="outline" size="xs" onClick={() => setShowAll(true)} className={styles.showAllBtn}>
            Show all {filteredTeams.length} teams
          </Button>
        </Box>
      )}

      {showAll && filteredTeams.length > INITIAL_SHOW && (
        <Box style={{ textAlign: 'center' }}>
          <Button variant="outline" size="xs" onClick={() => setShowAll(false)} className={styles.showLessBtn}>
            Show top {INITIAL_SHOW} only
          </Button>
        </Box>
      )}
    </Stack>
  );
}
