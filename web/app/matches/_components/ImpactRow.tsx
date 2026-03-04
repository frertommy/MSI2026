import { Group, Text } from '@mantine/core';
import { deltaColor, deltaArrow, formatDelta, formatPctDelta } from '../_utils/format';
import styles from './ImpactRow.module.css';
import cx from 'clsx';

interface ImpactRowProps {
  label: string;
  delta: number;
  pctDelta: number;
  align?: 'left' | 'right';
}

export function ImpactRow({ label, delta, pctDelta, align = 'left' }: ImpactRowProps) {
  const color = deltaColor(delta);

  if (align === 'right') {
    return (
      <Group justify="space-between" gap={8} className={styles.root}>
        <Text component="span" className={cx(styles.arrow, styles[color])}>{deltaArrow(delta)}</Text>
        <Text component="span" className={cx(styles.pct, styles[color])}>{formatPctDelta(pctDelta)}</Text>
        <Text component="span" className={cx(styles.delta, styles[color])}>{formatDelta(delta)}</Text>
        <Text component="span" className={styles.label}>{label}</Text>
      </Group>
    );
  }

  return (
    <Group justify="space-between" gap={8} className={styles.root}>
      <Text component="span" className={styles.label}>{label}</Text>
      <Group gap={6} wrap="nowrap">
        <Text component="span" className={cx(styles.delta, styles[color])}>{formatDelta(delta)}</Text>
        <Text component="span" className={cx(styles.pct, styles[color])}>{formatPctDelta(pctDelta)}</Text>
        <Text component="span" className={cx(styles.arrow, styles[color])}>{deltaArrow(delta)}</Text>
      </Group>
    </Group>
  );
}
