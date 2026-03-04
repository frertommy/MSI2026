import type { PriceHistoryRow, V2Point, ChartPoint } from '../_types';

export function mergeTimelines(currentPrices: PriceHistoryRow[], v2Points: V2Point[]): ChartPoint[] {
  const map = new Map<string, ChartPoint>();

  for (const p of v2Points) {
    if (!map.has(p.date)) { map.set(p.date, { date: p.date }); }
    map.get(p.date)!.v2 = Math.round(p.price * 100) / 100;
  }

  for (const p of currentPrices) {
    if (!map.has(p.date)) { map.set(p.date, { date: p.date }); }
    map.get(p.date)!.current = Math.round(p.dollar_price * 100) / 100;
  }

  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function pctDelta(pts: V2Point[]): number | null {
  if (pts.length < 2) { return null; }
  const first = pts[0].price;
  const last = pts[pts.length - 1].price;
  if (first === 0) { return null; }
  return ((last - first) / first) * 100;
}

export function annualizedVol(pts: V2Point[]): number | null {
  if (pts.length < 10) { return null; }
  const returns: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i - 1].price === 0) { continue; }
    returns.push((pts[i].price - pts[i - 1].price) / pts[i - 1].price);
  }
  if (returns.length < 5) { return null; }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

export function priceRange(pts: V2Point[]): [number, number] | null {
  if (pts.length === 0) { return null; }
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    if (p.price < min) { min = p.price; }
    if (p.price > max) { max = p.price; }
  }
  return [Math.round(min * 100) / 100, Math.round(max * 100) / 100];
}

export function formatDateTick(dateStr: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date(dateStr + 'T00:00:00Z');
  return months[d.getUTCMonth()];
}
