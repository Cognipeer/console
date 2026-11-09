/**
 * Pure helpers of the usage page: severity of a row, number formats and the
 * banner text. No React imports so they can be tested on their own.
 */
import type { UsageBanner } from '@/lib/limits/usageSummary';

export type UsageSeverity = 'ok' | 'warning' | 'critical';

/** neutral below 80 %, warning 80-99 %, critical from 100 %; no limit (or a zero limit with no use) is neutral. */
export function severityOf(used: number, limit: number | undefined): UsageSeverity {
  if (limit === undefined) return 'ok';
  if (limit <= 0) return used > 0 ? 'critical' : 'ok';
  const pct = (used / limit) * 100;
  if (pct >= 100) return 'critical';
  if (pct >= 80) return 'warning';
  return 'ok';
}

/** Share of the bar that is filled, 0-100. */
export function fillPercent(used: number, limit: number | undefined): number {
  if (limit === undefined) return 0;
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

export function formatNumber(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

export function formatBytes(bytes: number, locale?: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: index === 0 ? 0 : 1 }).format(value)} ${units[index]}`;
}

export function formatDate(iso: string | undefined, locale?: string): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** `YYYY-MM` as a month name. */
export function formatPeriod(period: string, locale?: string): string {
  const [year, month] = period.split('-').map(Number);
  if (!year || !month) return period;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' });
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The sentence one banner shows, from the `usage` namespace. */
export function bannerMessage(banner: UsageBanner, t: Translate, locale?: string): string {
  const critical = banner.severity === 'critical';
  if (banner.dimension === 'storage') {
    return t(critical ? 'banner.storageCritical' : 'banner.storageWarning', {
      used: formatBytes(banner.used, locale),
      limit: formatBytes(banner.limit, locale),
    });
  }
  if (banner.dimension === 'credits') {
    return t(critical ? 'banner.creditsCritical' : 'banner.creditsWarning');
  }
  const name = t(`rows.${banner.dimension}`);
  if (banner.id.startsWith('capacity:')) return t('banner.capacityWarning', { name });
  return t(critical ? 'banner.monthlyCritical' : 'banner.monthlyWarning', {
    name,
    used: formatNumber(banner.used, locale),
    limit: formatNumber(banner.limit, locale),
  });
}

/** Beyond this many days the runway is shown as "more than a year". */
export const MAX_RUNWAY_DAYS = 365;

/** The runway line: the day count, or the "more than a year" text above a year. */
export function runwayText(
  t: (key: string, values?: Record<string, string | number>) => string,
  locale: string,
  runwayDays: number | undefined,
): string {
  if (runwayDays === undefined) return t('creditCard.noRunway');
  if (runwayDays > MAX_RUNWAY_DAYS) return t('creditCard.runwayOverYear');
  return t('creditCard.runwayValue', { days: formatNumber(runwayDays, locale) });
}
