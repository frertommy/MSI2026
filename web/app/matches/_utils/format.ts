export function deltaColor(delta: number): string {
  if (Math.abs(delta) < 0.10) { return 'muted'; }
  return delta > 0 ? 'green' : 'red';
}

export function deltaArrow(delta: number): string {
  if (Math.abs(delta) < 0.10) { return '·'; }
  return delta > 0 ? '↑' : '↓';
}

export function formatDelta(delta: number): string {
  const prefix = delta > 0 ? '+' : '';
  return `${prefix}$${delta.toFixed(2)}`;
}

export function formatPctDelta(pct: number): string {
  const prefix = pct > 0 ? '+' : '';
  return `${prefix}${pct.toFixed(1)}%`;
}

export function formatPct(prob: number): string {
  return `${(prob * 100).toFixed(0)}%`;
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
