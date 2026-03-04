import { Container, Box } from '@mantine/core';
import { fetchMatches } from './_services/matches.service';
import { enrichMatch } from './_utils/price-impact';
import { MatchList } from './_components/MatchList';

export const revalidate = 300;

export default async function MatchesPage() {
  const matches = await fetchMatches();
  const enriched = matches.map(enrichMatch);

  return (
    <Box style={{ minHeight: '100vh', background: 'var(--background)' }}>
      <Container py="md">
        <MatchList matches={enriched} />
      </Container>
    </Box>
  );
}
