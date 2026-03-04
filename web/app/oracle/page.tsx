import { Box, Container } from '@mantine/core';
import { fetchOracleData } from './_services/oracle.service';
import { computePmPrices } from './_utils/pm-pricing';
import { OracleClient } from './_components/OracleClient';

export const dynamic = 'force-dynamic';

export default async function OraclePage() {
  const { priceHistory, matches, pmRaw } = await fetchOracleData();
  const pmPrices = computePmPrices(pmRaw);

  return (
    <Box style={{ minHeight: '100vh', background: 'var(--background)' }}>
      <Container py="md" size="xl">
        <OracleClient priceHistory={priceHistory} matches={matches} pmPrices={pmPrices} />
      </Container>
    </Box>
  );
}
