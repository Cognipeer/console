/**
 * Sizes and counts the Files screens print.
 */

import { formatFileSize } from '@/components/agents/session/sessionAttachmentsUi';

const GIB = 1024 * 1024 * 1024;
const TIB = GIB * 1024;

/**
 * `4.8 MB`, `1.2 GB`: the app's file-size style (`formatFileSize`), carried on past megabytes for bucket totals.
 * An unknown or invalid size is an em dash.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < GIB) return formatFileSize(bytes);
  if (bytes < TIB) return `${(bytes / GIB).toFixed(bytes < 10 * GIB ? 1 : 0)} GB`;
  return `${(bytes / TIB).toFixed(bytes < 10 * TIB ? 1 : 0)} TB`;
}

/** `1,284` in the viewer's locale. */
export function formatCount(value: number | null | undefined, locale: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale).format(value);
}
