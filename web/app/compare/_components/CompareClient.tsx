'use client';

import { Box, Center, Loader, Stack, Text } from '@mantine/core';
import { useTeamData } from '../_hooks/useTeamData';
import { TeamSelector } from './TeamSelector';
import { HeaderBar } from './HeaderBar';
import { PriceChart } from './PriceChart';
import { MatchLog } from './MatchLog';
import { TradingStats } from './TradingStats';
import { UpcomingFixtures } from './UpcomingFixtures';
import { ReturnDistribution } from './ReturnDistribution';
import { LEAGUE_COLOR } from '../_types';

interface CompareClientProps {
  teams: string[];
  teamLeagues: Record<string, string>;
}

export function CompareClient({ teams, teamLeagues }: CompareClientProps) {
  const {
    selectedTeam, setSelectedTeam,
    timeRange, setTimeRange,
    loading, enrichment, headerStats, tradingStats, histogram, probByFixture,
  } = useTeamData(teams[0] ?? '');

  const league = teamLeagues[selectedTeam] ?? '';
  const hasData = (enrichment?.chartData.length ?? 0) > 0;

  return (
    <Stack gap="lg">
      <TeamSelector
        teams={teams}
        selectedTeam={selectedTeam}
        timeRange={timeRange}
        onTeamChange={setSelectedTeam}
        onTimeRangeChange={setTimeRange}
      />

      {loading && (
        <Box style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 48, background: 'var(--surface)' }}>
          <Center>
            <Stack align="center" gap="sm">
              <Loader color="var(--accent-green)" size="sm" />
              <Text size="sm" c="dimmed" ff="monospace">Loading team data...</Text>
            </Stack>
          </Center>
        </Box>
      )}

      {!loading && hasData && enrichment && headerStats && tradingStats && (
        <>
          <HeaderBar teamName={selectedTeam} league={league} stats={headerStats} />

          <PriceChart
            chartData={enrichment.chartData}
            matchDots={enrichment.matchDots}
            monthTicks={enrichment.monthTicks}
            timeRange={timeRange}
          />

          <MatchLog matches={enrichment.finishedMatches} />

          <TradingStats stats={tradingStats} />

          <UpcomingFixtures matches={enrichment.upcomingMatches} probByFixture={probByFixture} />

          <ReturnDistribution data={histogram} />
        </>
      )}

      {!loading && !hasData && (
        <Box style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '48px 0', textAlign: 'center' }}>
          <Text size="sm" c="dimmed" ff="monospace">Select a team to view trading details.</Text>
        </Box>
      )}
    </Stack>
  );
}
