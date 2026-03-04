'use client';

import { useEffect, useRef, useState } from 'react';
import { Box, Group, Text } from '@mantine/core';
import { supabase } from '@/lib/supabase';
import type { CreditRow } from '../_types';
import { ProviderPill } from './ProviderPill';
import styles from './CreditBar.module.css';

function useCreditData() {
  const [rows, setRows] = useState<CreditRow[]>([]);
  const [error, setError] = useState(false);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;

    async function load() {
      try {
        const { data, error: fetchErr } = await supabase.from('api_credits').select('*');
        if (!isMounted.current) { return; }
        if (fetchErr) {
          setError(true);
          return;
        }
        if (data && data.length > 0) {
          setRows(data as CreditRow[]);
          setError(false);
        }
      } catch {
        if (isMounted.current) { setError(true); }
      }
    }

    load().catch(() => null);
    const interval = setInterval(() => load().catch(() => null), 60_000);

    return () => {
      isMounted.current = false;
      clearInterval(interval);
    };
  }, []);

  return { rows, error };
}

export function CreditBar() {
  const { rows, error } = useCreditData();

  if (error || rows.length === 0) {
    return (
      <Box className={styles.root}>
        <Group className={styles.inner} gap={8}>
          <Box className={styles.dotOffline} />
          <Text className={styles.offlineLabel}>Scheduler not connected</Text>
        </Group>
      </Box>
    );
  }

  const oddsApi = rows.find((r) => r.provider === 'odds_api');
  const apiFootball = rows.find((r) => r.provider === 'api_football');

  return (
    <Box className={styles.root}>
      <Group className={styles.inner} gap={24} wrap="wrap">
        <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
          <Box className={styles.dotLive} />
          <Text className={styles.liveLabel}>Live</Text>
        </Group>

        {oddsApi && <ProviderPill row={oddsApi} />}

        {oddsApi && apiFootball && <Box className={styles.divider} />}

        {apiFootball && <ProviderPill row={apiFootball} />}
      </Group>
    </Box>
  );
}
