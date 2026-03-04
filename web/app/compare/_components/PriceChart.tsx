import { Box, Group, Text } from '@mantine/core';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceDot,
} from 'recharts';
import type { ChartDot } from '../_types';
import { RESULT_COLOR } from '../_types';
import { formatDateTick } from '../_utils/enrichment';
import styles from './PriceChart.module.css';

const TOOLTIP_STYLE = {
  backgroundColor: '#111',
  border: '1px solid #333',
  borderRadius: '4px',
  fontFamily: 'monospace',
  fontSize: '11px',
};

interface PriceChartProps {
  chartData: { date: string; price: number }[];
  matchDots: ChartDot[];
  monthTicks: string[];
  timeRange: number;
}

export function PriceChart({ chartData, matchDots, monthTicks, timeRange }: PriceChartProps) {
  return (
    <Box className={styles.root}>
      <Group justify="space-between" mb="md">
        <Text className={styles.title}>Price History</Text>
        <Group gap="md">
          {(['W', 'D', 'L'] as const).map((r) => (
            <Group key={r} gap={6}>
              <Box className={styles.legendDot} style={{ background: RESULT_COLOR[r] }} />
              <Text className={styles.legendLabel}>{r === 'W' ? 'Win' : r === 'D' ? 'Draw' : 'Loss'}</Text>
            </Group>
          ))}
          <Text className={styles.legendHint}>dot size = surprise</Text>
        </Group>
      </Group>

      <ResponsiveContainer width="100%" height={400}>
        <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" vertical={false} />
          <XAxis
            dataKey="date"
            ticks={monthTicks}
            tickFormatter={timeRange <= 30 ? (d: string) => d.slice(5) : formatDateTick}
            tick={{ fill: '#666', fontSize: 10, fontFamily: 'monospace' }}
            axisLine={{ stroke: '#333' }}
            tickLine={false}
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fill: '#666', fontSize: 10, fontFamily: 'monospace' }}
            axisLine={false}
            tickLine={false}
            width={45}
            tickFormatter={(v: number) => `$${v.toFixed(0)}`}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={((value: any) => [`$${Number(value).toFixed(2)}`, 'Price']) as never}
            labelFormatter={(label: unknown) => String(label)}
          />
          <Line type="monotone" dataKey="price" stroke="#ffffff" dot={false} strokeWidth={2} connectNulls />
          {matchDots.map((dot, i) => (
            <ReferenceDot
              key={i}
              x={dot.date}
              y={dot.price}
              r={dot.r}
              fill={RESULT_COLOR[dot.result]}
              stroke="none"
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );
}
