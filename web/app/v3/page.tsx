import { Box, Container } from '@mantine/core';
import { fetchLegacyElos, fetchMatches, fetchPriceHistory, fetchXgData, fetchClosingOdds } from './_services/v3.service';
import { computeV2Prices } from './_utils/v2-engine';
import { V3Client } from './_components/V3Client';
import type { StartingElo } from './_types';

export const dynamic = 'force-dynamic';

export default async function V3Page() {
  const [legacyElos, matches, priceHistory, xgData] = await Promise.all([
    fetchLegacyElos(),
    fetchMatches(),
    fetchPriceHistory(),
    fetchXgData(),
  ]);

  const fixtureIds = matches.map((m) => m.fixture_id);
  const oddsConsensus = await fetchClosingOdds(fixtureIds);

  const teamLeagues = new Map<string, string>();
  for (const m of matches) {
    if (!teamLeagues.has(m.home_team)) { teamLeagues.set(m.home_team, m.league); }
    if (!teamLeagues.has(m.away_team)) { teamLeagues.set(m.away_team, m.league); }
  }

  const startingElosArr: StartingElo[] = [...teamLeagues.entries()].map(([team, league]) => ({
    team,
    league,
    startingElo: legacyElos[team] ?? 1500,
  }));

  const oddsMap = new Map(oddsConsensus.map((o) => [o.fixture_id, o]));

  const v2Series = computeV2Prices(
    startingElosArr,
    matches,
    oddsMap,
    xgData.byFixtureId,
    xgData.byKey,
  );

  return (
    <Box style={{ minHeight: '100vh', background: 'var(--background)' }}>
      <Container py="md" size="xl">
        <V3Client startingElos={startingElosArr} priceHistory={priceHistory} v2Series={v2Series} />
      </Container>
    </Box>
  );
}
