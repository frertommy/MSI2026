import { Box, Group, Text } from '@mantine/core';
import { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceDot,
} from 'recharts';
import type { ChartPoint, MatchPoint, TeamStats } from '../_types';
import { LEAGUE_COLOR, RESULT_COLOR } from '../_types';
import styles from './OracleTeamChart.module.css';
import cx from 'clsx';

const TOOLTIP_STYLE = {
  backgroundColor: '#111',
  border: '1px solid #333',
  borderRadius: '4px',
  fontFamily: 'monospace',
  fontSize: '11px',
};

function formatDateTick(dateStr: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date(dateStr + 'T00:00:00Z');
  return months[d.getUTCMonth()];
}

interface OracleTeamChartProps {
  team: string;
  league: string;
  data: ChartPoint[];
  stats: TeamStats;
  matchPoints: MatchPoint[];
  large?: boolean;
}

export function OracleTeamChart({ team, league, data, stats, matchPoints, large }: OracleTeamChartProps) {
  const monthTicks = useMemo(() => {
    const seen = new Set<string>();
    const ticks: string[] = [];
    for (const pt of data) {
      const ym = pt.date.slice(0, 7);
      if (!seen.has(ym)) { seen.add(ym); ticks.push(pt.date); }
    }
    return ticks;
  }, [data]);

  const height = large ? 280 : 165;

  return (
    <Box className={styles.root}>
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Box className={styles.leagueDot} style={{ background: LEAGUE_COLOR[league] ?? '#888' }} />
          <Text className={styles.teamName} truncate>{team}</Text>
        </Group>
        <Group gap="md" wrap="nowrap" className={styles.meta}>
          <Text className={styles.metaItem}>Elo {Math.round(stats.currentElo)}</Text>
          <Text className={cx(styles.metaItem, styles.green)}>${stats.currentPrice.toFixed(2)}</Text>
          {stats.pmImpliedPrice !== null && <Text className={cx(styles.metaItem, styles.cyan)}>PM ${stats.pmImpliedPrice.toFixed(0)}</Text>}
          {stats.seasonDelta !== null && (
            <Text className={cx(styles.metaItem, stats.seasonDelta >= 0 ? styles.green : styles.red)}>
              {stats.seasonDelta >= 0 ? '+' : ''}{stats.seasonDelta.toFixed(1)}%
            </Text>
          )}
          {stats.annualizedVol !== null && <Text className={styles.metaItem}>vol {stats.annualizedVol.toFixed(0)}%</Text>}
          {stats.priceRange && <Text className={styles.metaItem}>${stats.priceRange[0].toFixed(0)}–${stats.priceRange[1].toFixed(0)}</Text>}
        </Group>
      </Group>

      <Box style={{ width: '100%', height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="date"
              ticks={monthTicks}
              tickFormatter={formatDateTick}
              tick={{ fill: '#666', fontSize: 10, fontFamily: 'monospace' }}
              axisLine={{ stroke: '#333' }}
              tickLine={false}
            />
            <YAxis
              domain={['auto', 'auto']}
              tick={{ fill: '#666', fontSize: 10, fontFamily: 'monospace' }}
              axisLine={false}
              tickLine={false}
              width={40}
              tickFormatter={(v: number) => `$${v.toFixed(0)}`}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={(value: any) => {
                if (value == null) { return ['-', 'Price']; }
                return [`$${Number(value).toFixed(2)}`, 'Price'];
              }}
              labelFormatter={(label: unknown) => String(label)}
            />
            <Line type="monotone" dataKey="price" stroke="#00e676" dot={false} strokeWidth={1.5} connectNulls />
            {matchPoints.map((mp, i) => (
              <ReferenceDot key={i} x={mp.date} y={mp.price} r={3} fill={RESULT_COLOR[mp.result]} stroke="none" />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Box>
    </Box>
  );
}
