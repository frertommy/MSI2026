import { Container, Box } from '@mantine/core';
import { fetchTeamList } from './_services/compare.service';
import { CompareClient } from './_components/CompareClient';

export const revalidate = 300;

export default async function ComparePage() {
  const { teams, teamLeagues } = await fetchTeamList();

  return (
    <Box style={{ minHeight: '100vh', background: 'var(--background)' }}>
      <Container py="md">
        <CompareClient teams={teams} teamLeagues={teamLeagues} />
      </Container>
    </Box>
  );
}
