'use client';

import { useState, useMemo } from 'react';
import { Box, Button, Group, SimpleGrid, Text } from '@mantine/core';
import cx from 'clsx';
import type { StartingElo, PriceHistoryRow, V2Point } from '../_types';
import { LEAGUE_SHORT } from '../_types';
import { mergeTimelines } from '../_utils/chart';
import { TeamChart } from './TeamChart';
import styles from './V3Client.module.css';

const INITIAL_SHOW = 20;
const LEAGUES = ['All', 'EPL', 'ESP', 'BUN', 'ITA', 'FRA'];

interface V3ClientProps {
  startingElos: StartingElo[];
  priceHistory: PriceHistoryRow[];
  v2Series: Record<string, V2Point[]>;
}

export function V3Client({ startingElos, priceHistory, v2Series }: V3ClientProps) {
  const [activeLeague, setActiveLeague] = useState('All');
  const [showAll, setShowAll] = useState(false);

  const currentByTeam = useMemo(() => {
    const map = new Map<string, PriceHistoryRow[]>();
    for (const r of priceHistory) {
      if (!map.has(r.team)) { map.set(r.team, []); }
      map.get(r.team)!.push(r);
    }
    return map;
  }, [priceHistory]);

  const filteredTeams = useMemo(() => {
    let teams = startingElos;
    if (activeLeague !== 'All') {
      const fullName = Object.entries(LEAGUE_SHORT).find(([, v]) => v === activeLeague)?.[0];
      if (fullName) { teams = teams.filter((t) => t.league === fullName); }
    }
    return [...teams].sort((a, b) => {
      const aV2 = v2Series[a.team];
      const bV2 = v2Series[b.team];
      const aElo = aV2 && aV2.length > 0 ? aV2[aV2.length - 1].elo : a.startingElo;
      const bElo = bV2 && bV2.length > 0 ? bV2[bV2.length - 1].elo : b.startingElo;
      return bElo - aElo;
    });
  }, [startingElos, activeLeague, v2Series]);

  const displayTeams = showAll ? filteredTeams : filteredTeams.slice(0, INITIAL_SHOW);

  return (
    <Box>
      <Group justify="space-between" mb="md" wrap="wrap">
        <Group gap={4}>
          {LEAGUES.map((l) => (
            <Button
              key={l}
              size="xs"
              onClick={() => { setActiveLeague(l); setShowAll(false); }}
              className={cx(styles.filterBtn, { [styles.filterBtnActive]: activeLeague === l })}
            >
              {l}
            </Button>
          ))}
        </Group>

        <Group gap="lg">
          <Group gap={6}>
            <Box className={styles.legendLine} style={{ background: '#ff6b6b' }} />
            <Text className={styles.legendLabel}>Current Oracle</Text>
          </Group>
          <Group gap={6}>
            <Box className={styles.legendLine} style={{ background: '#00e676' }} />
            <Text className={styles.legendLabel}>V2 Oracle</Text>
          </Group>
        </Group>
      </Group>

      <Box className={styles.spec}>
        <Text component="span" className={styles.specBold}>V2 Spec:</Text>{' '}
        price = max($10, (elo − 800) / 5) · K=20 · carry decay 0.1%/day → 45d MA · xG mult [0.4, 1.8] · shocks permanent
      </Box>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mt="md">
        {displayTeams.map((t) => {
          const v2 = v2Series[t.team] ?? [];
          const current = currentByTeam.get(t.team) ?? [];
          const merged = mergeTimelines(current, v2);
          const latestElo = v2.length > 0 ? v2[v2.length - 1].elo : t.startingElo;
          return (
            <TeamChart key={t.team} team={t.team} league={t.league} elo={latestElo} data={merged} v2Points={v2} />
          );
        })}
      </SimpleGrid>

      {!showAll && filteredTeams.length > INITIAL_SHOW && (
        <Box mt="lg" style={{ textAlign: 'center' }}>
          <Button
            variant="outline"
            size="xs"
            onClick={() => setShowAll(true)}
            className={styles.showAllBtn}
          >
            Show all {filteredTeams.length} teams
          </Button>
        </Box>
      )}

      {showAll && filteredTeams.length > INITIAL_SHOW && (
        <Box mt="lg" style={{ textAlign: 'center' }}>
          <Button
            variant="outline"
            size="xs"
            onClick={() => setShowAll(false)}
            className={styles.showLessBtn}
          >
            Show top {INITIAL_SHOW} only
          </Button>
        </Box>
      )}
    </Box>
  );
}
