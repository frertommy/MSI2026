import { Box, Group, Text } from '@mantine/core';
import { useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { ChartPoint, V2Point } from '../_types';
import { LEAGUE_COLOR } from '../_types';
import { pctDelta, annualizedVol, priceRange, formatDateTick } from '../_utils/chart';
import styles from './TeamChart.module.css';
import cx from 'clsx';

const TOOLTIP_STYLE = {
  backgroundColor: '#111',
  border: '1px solid #333',
  borderRadius: '4px',
  fontFamily: 'monospace',
  fontSize: '11px',
};

interface TeamChartProps {
  team: string;
  league: string;
  elo: number;
  data: ChartPoint[];
  v2Points: V2Point[];
}

export function TeamChart({ team, league, elo, data, v2Points }: TeamChartProps) {
  const delta = pctDelta(v2Points);
  const vol = annualizedVol(v2Points);
  const range = priceRange(v2Points);
  const lastPrice = v2Points.length > 0 ? v2Points[v2Points.length - 1].price : null;

  const monthTicks = useMemo(() => {
    const seen = new Set<string>();
    const ticks: string[] = [];
    for (const pt of data) {
      const ym = pt.date.slice(0, 7);
      if (!seen.has(ym)) { seen.add(ym); ticks.push(pt.date); }
    }
    return ticks;
  }, [data]);

  return (
    <Box className={styles.root}>
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Box className={styles.leagueDot} style={{ background: LEAGUE_COLOR[league] ?? '#888' }} />
          <Text className={styles.teamName} truncate>{team}</Text>
        </Group>
        <Group gap="md" wrap="nowrap" className={styles.meta}>
          <Text className={styles.metaItem}>Elo {Math.round(elo)}</Text>
          {lastPrice !== null && <Text className={cx(styles.metaItem, styles.green)}>${lastPrice.toFixed(0)}</Text>}
          {delta !== null && <Text className={cx(styles.metaItem, delta >= 0 ? styles.green : styles.red)}>{delta >= 0 ? '+' : ''}{delta.toFixed(1)}%</Text>}
          {vol !== null && <Text className={styles.metaItem}>vol {vol.toFixed(0)}%</Text>}
          {range && <Text className={styles.metaItem}>${range[0].toFixed(0)}–${range[1].toFixed(0)}</Text>}
        </Group>
      </Group>

      <Box style={{ width: '100%', height: 165 }}>
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
              formatter={(value: any, name: any) => {
                if (value == null) { return ['-', String(name)]; }
                return [`$${Number(value).toFixed(2)}`, name === 'current' ? 'Current' : 'V2'];
              }}
              labelFormatter={(label: unknown) => String(label)}
            />
            <Line type="monotone" dataKey="current" stroke="#ff6b6b" dot={false} strokeWidth={1.5} connectNulls name="current" />
            <Line type="monotone" dataKey="v2" stroke="#00e676" dot={false} strokeWidth={1.5} connectNulls name="v2" />
          </LineChart>
        </ResponsiveContainer>
      </Box>
    </Box>
  );
}
