'use client';

import { Box } from '@mantine/core';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import cx from 'clsx';
import styles from './Header.module.css';

const NAV_LINKS = [
  { href: '/', label: 'Rankings' },
  { href: '/matches', label: 'Matches' },
  { href: '/v3', label: 'Simulation' },
  { href: '/oracle', label: 'Oracle' },
  { href: '/measureme', label: 'MeasureMe' },
];

export function Header() {
  const pathname = usePathname();

  return (
    <Box component="nav" className={styles.root}>
      <div className={styles.inner}>
        <Link href="/" className={styles.logo}>
          MSI 2026
        </Link>
        <div className={styles.navLinks}>
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cx(styles.link, {
                [styles.linkActive]: pathname === link.href,
              })}
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </Box>
  );
}
