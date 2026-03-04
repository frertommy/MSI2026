import { Box, Text } from '@mantine/core';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import type { HistogramBucket } from '../_types';
import styles from './ReturnDistribution.module.css';

const TOOLTIP_STYLE = {
  backgroundColor: '#111',
  border: '1px solid #333',
  borderRadius: '4px',
  fontFamily: 'monospace',
  fontSize: '11px',
};

interface ReturnDistributionProps {
  data: HistogramBucket[];
}

export function ReturnDistribution({ data }: ReturnDistributionProps) {
  const hasData = data.some((b) => b.count > 0);
  if (!hasData) { return null; }

  return (
    <Box className={styles.root}>
      <Text className={styles.title}>Daily Return Distribution</Text>

      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" vertical={false} />
          <XAxis
            dataKey="bin"
            tick={{ fill: '#666', fontSize: 9, fontFamily: 'monospace' }}
            axisLine={{ stroke: '#333' }}
            tickLine={false}
            interval={1}
          />
          <YAxis
            tick={{ fill: '#666', fontSize: 10, fontFamily: 'monospace' }}
            axisLine={false}
            tickLine={false}
            width={30}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={((value: any) => [`${value} days`, 'Count']) as never}
          />
          <ReferenceLine x="0.0%" stroke="#666" strokeDasharray="3 3" />
          <Bar dataKey="count" radius={[2, 2, 0, 0]}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.midpoint >= 0 ? '#00e676' : '#ff1744'} fillOpacity={0.7} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );
}
