import { createTheme, type MantineColorsTuple } from '@mantine/core';

const accentGreen: MantineColorsTuple = [
  '#e6fff3', '#b3ffe0', '#80ffcd', '#4dffba', '#1affa7',
  '#00e676', '#00cc69', '#00b35c', '#00994f', '#007a3f',
];

const accentRed: MantineColorsTuple = [
  '#ffe5eb', '#ffb3c1', '#ff8099', '#ff4d71', '#ff1a49',
  '#ff1744', '#e6143d', '#cc1136', '#b30e2f', '#990b28',
];

const accentAmber: MantineColorsTuple = [
  '#fff8e1', '#ffecb3', '#ffe082', '#ffd54f', '#ffca28',
  '#ffc107', '#ffb300', '#ffa000', '#ff8f00', '#ff6f00',
];

export const theme = createTheme({
  primaryColor: 'accentGreen',
  fontFamily: 'var(--font-geist-mono), "Courier New", monospace',
  fontFamilyMonospace: 'var(--font-geist-mono), "Courier New", monospace',
  colors: {
    accentGreen,
    accentRed,
    accentAmber,
  },
  components: {
    Container: {
      defaultProps: { size: 'xl' },
    },
    Table: {
      defaultProps: { highlightOnHover: true },
    },
    Anchor: {
      defaultProps: { underline: 'never' },
    },
  },
});
