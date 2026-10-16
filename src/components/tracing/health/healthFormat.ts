/** Number formatting for the health views. Pure; the caller passes the UI locale. */

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A percentage in 0..100 ("—" when there is no value). */
export function formatHealthPercent(value: number | null | undefined, locale?: string): string {
  if (!isNum(value)) return '—';
  const digits = value !== 0 && Math.abs(value) < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)}%`;
}

/** A duration in milliseconds as ms / s / min / h ("—" when there is no value). */
export function formatHealthMs(value: number | null | undefined, locale?: string): string {
  if (!isNum(value)) return '—';
  const fmt = (n: number, digits: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);
  if (value < 1000) return `${fmt(Math.round(value), 0)} ms`;
  if (value < 60_000) return `${fmt(value / 1000, value < 10_000 ? 2 : 1)} s`;
  if (value < 3_600_000) return `${fmt(value / 60_000, 1)} min`;
  return `${fmt(value / 3_600_000, 1)} h`;
}

/** A US-dollar amount; tiny amounts keep four decimals so they do not read as zero. */
export function formatHealthCost(value: number | null | undefined, locale?: string): string {
  if (!isNum(value)) return '—';
  const digits = value > 0 && value < 0.01 ? 4 : value < 100 ? 2 : 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Math.min(digits, 2),
    maximumFractionDigits: digits,
  }).format(value);
}

/** A whole count with the locale's grouping. */
export function formatHealthCount(value: number | null | undefined, locale?: string): string {
  if (!isNum(value)) return '—';
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

/**
 * A calendar day given as `YYYY-MM-DD` (the day buckets of the tracing analytics) as a short local date.
 * It is parsed as a plain calendar day, not as a UTC instant, so no time zone moves it to its neighbour.
 */
export function formatDayLabel(day: string, locale?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return day;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

/** Same as `formatDayLabel`, without the year (chart axes). */
export function formatDayAxisLabel(day: string, locale?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return day;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
}
