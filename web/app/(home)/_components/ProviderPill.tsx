import { Box, Group, Text } from '@mantine/core';
import type { CreditRow } from '../_types';
import styles from './ProviderPill.module.css';

interface ProviderPillProps {
  row: CreditRow;
}

function formatInterval(seconds: number): string {
  if (seconds < 60) { return `${seconds}s`; }
  if (seconds < 3600) { return `${Math.round(seconds / 60)}min`; }
  return `${(seconds / 3600).toFixed(1)}h`;
}

function formatAge(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) { return 'just now'; }
  if (mins < 60) { return `${mins}m ago`; }
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) { return `${hrs}h ago`; }
  return `${Math.floor(hrs / 24)}d ago`;
}

function estimateDailySpend(intervalSec: number | null): string {
  if (!intervalSec || intervalSec <= 0) { return '—'; }
  const pollsPerDay = (24 * 3600) / intervalSec;
  const creditsPerDay = Math.round(pollsPerDay * 5);
  return `~${creditsPerDay}/day`;
}

function intervalLabel(seconds: number | null): string {
  if (!seconds) { return '—'; }
  const base = `every ${formatInterval(seconds)}`;
  if (seconds <= 120) { return `${base} — match imminent`; }
  if (seconds <= 300) { return `${base} — match soon`; }
  if (seconds >= 7200) { return `${base} — no matches`; }
  return base;
}

function getUsageColor(used: number, budget: number): string {
  const ratio = used / budget;
  if (ratio < 0.5) { return styles.barGreen; }
  if (ratio < 0.75) { return styles.barAmber; }
  return styles.barRed;
}

function getTextColor(used: number, budget: number): string {
  const ratio = used / budget;
  if (ratio < 0.5) { return styles.textGreen; }
  if (ratio < 0.75) { return styles.textAmber; }
  return styles.textRed;
}

export function ProviderPill({ row }: ProviderPillProps) {
  const used = row.credits_used_today;
  const budget = row.daily_budget;
  const pct = Math.min(100, Math.round((used / budget) * 100));
  const label = row.provider === 'odds_api' ? 'ODDS API' : 'API-FOOTBALL';

  return (
    <Group gap={12} className={styles.root} wrap="nowrap">
      <Text className={styles.providerLabel}>{label}</Text>

      <Group gap={8} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
        <Box className={styles.barTrack}>
          <Box className={`${styles.barFill} ${getUsageColor(used, budget)}`} style={{ width: `${pct}%` }} />
        </Box>
        <Text className={`${styles.usageText} ${getTextColor(used, budget)}`}>
          {used}/{budget}
        </Text>
      </Group>

      {row.credits_remaining !== null && (
        <Text className={styles.meta}>{row.credits_remaining.toLocaleString()} rem</Text>
      )}

      <Text className={`${styles.meta} ${styles.hiddenSm}`}>
        {intervalLabel(row.poll_interval_seconds)}
      </Text>

      <Text className={`${styles.meta} ${styles.hiddenMd}`}>
        {estimateDailySpend(row.poll_interval_seconds)}
      </Text>

      {row.last_poll_at && (
        <Text className={`${styles.meta} ${styles.hiddenLg}`}>
          {formatAge(row.last_poll_at)}
        </Text>
      )}
    </Group>
  );
}
