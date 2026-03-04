import { Box, Container } from '@mantine/core';
import { fetchAllMatches, fetchLatestPrices, computeTeamRows } from './_services/rankings.service';
import { TeamTable } from './_components/TeamTable';
import { CreditBar } from './_components/CreditBar';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [matches, priceMap] = await Promise.all([
    fetchAllMatches(),
    fetchLatestPrices(),
  ]);

  const teams = computeTeamRows(matches, priceMap);
  const leagues = [...new Set(teams.map((t) => t.league))].sort();

  return (
    <Box style={{ minHeight: '100vh', background: 'var(--background)' }}>
      <CreditBar />
      <Container py="md">
        <TeamTable teams={teams} leagues={leagues} />
      </Container>
    </Box>
  );
}
