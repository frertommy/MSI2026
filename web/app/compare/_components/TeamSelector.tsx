import { Box, Button, Group, NativeSelect } from '@mantine/core';
import cx from 'clsx';
import { TIME_RANGES } from '../_types';
import styles from './TeamSelector.module.css';

interface TeamSelectorProps {
  teams: string[];
  selectedTeam: string;
  timeRange: number;
  onTeamChange: (team: string) => void;
  onTimeRangeChange: (days: number) => void;
}

export function TeamSelector({ teams, selectedTeam, timeRange, onTeamChange, onTimeRangeChange }: TeamSelectorProps) {
  return (
    <Group justify="space-between" wrap="wrap" gap="md">
      <NativeSelect
        value={selectedTeam}
        onChange={(e) => onTeamChange(e.target.value)}
        data={teams}
        className={styles.select}
      />

      <Group gap={4}>
        {TIME_RANGES.map((tr) => (
          <Button
            key={tr.label}
            size="xs"
            onClick={() => onTimeRangeChange(tr.days)}
            className={cx(styles.rangeBtn, { [styles.rangeBtnActive]: timeRange === tr.days })}
          >
            {tr.label}
          </Button>
        ))}
      </Group>
    </Group>
  );
}
