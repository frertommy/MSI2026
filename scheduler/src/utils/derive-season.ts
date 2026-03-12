/**
 * Derive the football season string (e.g. "2025-26") from a date.
 * Season boundary: July 1 — dates in Jul-Dec belong to the new season.
 */
export function deriveSeason(date: string): string {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  if (month >= 7) return `${year}-${(year + 1).toString().slice(2)}`;
  return `${year - 1}-${year.toString().slice(2)}`;
}
