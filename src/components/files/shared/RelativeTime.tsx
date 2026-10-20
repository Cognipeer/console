'use client';

import { useLocale } from '@/lib/i18n';
import { formatRelativeTime } from '@/components/providers/providerAccessModel';

export interface RelativeTimeProps {
  value: string | Date | null | undefined;
  /** Shown when there is no (valid) time. */
  fallback?: string;
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "2 hours ago" in the viewer's language, with the exact time as the tooltip and in `dateTime`. */
export default function RelativeTime({ value, fallback = '—' }: RelativeTimeProps) {
  const locale = useLocale();
  const date = toDate(value);
  if (!date) return <span className="ds-faint">{fallback}</span>;
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString(locale)}>
      {formatRelativeTime(date, locale)}
    </time>
  );
}
