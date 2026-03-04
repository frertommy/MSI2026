import { Box, Container, Text } from '@mantine/core';
import { fetchMeasureMeData } from './_services/measureme.service';
import { MeasureMeClient } from './_components/MeasureMeClient';

export const dynamic = 'force-dynamic';

export default async function MeasureMePage() {
  const { rows, runId, teamElos } = await fetchMeasureMeData();

  if (!runId) {
    return (
      <Box style={{ minHeight: '100vh', background: 'var(--background)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Text size="sm" c="dimmed" ff="monospace" ta="center">
          No results yet. Run{' '}
          <Text component="code" c="var(--accent-green)" ff="monospace">
            cd scheduler && npm run measureme
          </Text>{' '}
          to generate grid search results.
        </Text>
      </Box>
    );
  }

  return (
    <Box style={{ minHeight: '100vh', background: 'var(--background)' }}>
      <Container py="md" size="xl">
        <MeasureMeClient results={rows} runId={runId} teamElos={teamElos} />
      </Container>
    </Box>
  );
}
