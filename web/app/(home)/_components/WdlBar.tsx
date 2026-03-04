import { Box } from '@mantine/core';
import styles from './WdlBar.module.css';

interface WdlBarProps {
  w: number;
  d: number;
  l: number;
}

export function WdlBar({ w, d, l }: WdlBarProps) {
  const total = w + d + l;
  if (total === 0) { return null; }

  const wPct = (w / total) * 100;
  const dPct = (d / total) * 100;

  return (
    <Box className={styles.root}>
      <Box className={styles.win} style={{ width: `${wPct}%` }} />
      <Box className={styles.draw} style={{ width: `${dPct}%` }} />
      <Box className={styles.loss} />
    </Box>
  );
}
