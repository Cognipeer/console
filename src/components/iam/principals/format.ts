/**
 * Display helpers shared by the Principals and Audit tabs. Pure (no React), so
 * they run in the node test environment.
 */

const DASH = '—';

export type Translate = (key: string, values?: Record<string, string | number | undefined | null>) => string;

/**
 * The message at `path` when the namespace has one, else `fallback`. A missing
 * message echoes its (namespaced) key, so that is what is compared against.
 */
export function translateOr(t: Translate, namespace: string, path: string, fallback: string): string {
  const value = t(path);
  return value === path || value === `${namespace}.${path}` ? fallback : value;
}

/** BCP 47 tag for the app locale code (`en`, `tr`). */
export function localeTag(locale: string): string {
  if (locale === 'tr') return 'tr-TR';
  if (locale === 'en') return 'en-US';
  return locale;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local date and time, or an em dash when the value is missing or not a date. */
export function formatDateTime(value: string | null | undefined, locale?: string): string {
  const d = parseDate(value);
  if (!d) return DASH;
  return d.toLocaleString(locale ? localeTag(locale) : undefined);
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "3 hours ago" / "in 2 days"; an em dash when the value is not a date. */
export function formatRelativeTime(
  value: string | null | undefined,
  options: { now?: number; locale?: string } = {},
): string {
  const d = parseDate(value);
  if (!d) return DASH;
  const diff = d.getTime() - (options.now ?? Date.now());
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(options.locale ? localeTag(options.locale) : undefined, {
    numeric: 'auto',
  });
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(0, 'second');
}

/** First characters of an opaque id, for compact display next to a copy button. */
export function shortId(id: string, length = 8): string {
  return id.length <= length ? id : id.slice(0, length);
}

/** Initials for an avatar: "Ada Lovelace" -> "AL", "ci-bot" -> "CB". */
export function initialsOf(label: string): string {
  const parts = label
    .split(/[\s._@-]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.charAt(0) ?? '';
  const second = parts.length > 1 ? (parts[1]?.charAt(0) ?? '') : '';
  return (first + second).toUpperCase() || '?';
}
