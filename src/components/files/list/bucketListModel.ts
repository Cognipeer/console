/**
 * The bucket list as pure functions: the filters and how they travel in the address (`?q=&provider=&status=`),
 * which buckets they keep, the numbers of the tiles, and the addresses the list links to.
 */

import type { BucketListItem } from '../filesApi';

export const FILES_PATH = '/dashboard/files';

/** The tabs of the bucket page. `files` is the default one, so its address has no `?tab=`. */
export type BucketTab = 'files' | 'settings' | 'api';

export function bucketHref(bucketKey: string, tab: BucketTab = 'files'): string {
  const base = `${FILES_PATH}/${encodeURIComponent(bucketKey)}`;
  return tab === 'files' ? base : `${base}?tab=${tab}`;
}

/** Where the product documentation describes the Document Store (its canonical address; the old one redirects here). */
export const FILES_DOCS_URL = 'https://docs.cognipeer.com/console/guide/knowledge/files';

/* ── Filters ─────────────────────────────────────────────────────────────── */

export type BucketStatusFilter = 'all' | 'active' | 'disabled';

export interface BucketListFilters {
  /** Free text, matched against a bucket's name, key and description. */
  q: string;
  /** A provider key; `''` = every provider. */
  provider: string;
  status: BucketStatusFilter;
}

export const NO_BUCKET_FILTERS: BucketListFilters = { q: '', provider: '', status: 'all' };

export function hasActiveFilters(filters: BucketListFilters): boolean {
  return filters.q.trim() !== '' || filters.provider !== '' || filters.status !== 'all';
}

/** The filters an address carries. Anything unknown is "no filter". */
export function parseBucketListFilters(params: Pick<URLSearchParams, 'get'>): BucketListFilters {
  const status = params.get('status');
  return {
    q: params.get('q')?.trim() ?? '',
    provider: params.get('provider')?.trim() ?? '',
    status: status === 'active' || status === 'disabled' ? status : 'all',
  };
}

/**
 * The filters as a query string (no leading `?`), defaults left out. The other parameters of `base` are kept, so
 * a filter change never drops something else the address carries.
 */
export function bucketListQuery(filters: BucketListFilters, base?: URLSearchParams): string {
  const params = new URLSearchParams(base);
  params.delete('q');
  params.delete('provider');
  params.delete('status');
  const q = filters.q.trim();
  if (q) params.set('q', q);
  if (filters.provider) params.set('provider', filters.provider);
  if (filters.status !== 'all') params.set('status', filters.status);
  return params.toString();
}

/**
 * Text as a search compares it: no case, no accents, and the dotted and dotless Turkish i alike, so "dokuman"
 * finds "Doküman" and "istanbul" finds "İstanbul".
 */
export function foldForSearch(text: string): string {
  return text
    .replace(/İ/g, 'i')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function matchesBucketFilters(bucket: BucketListItem, filters: BucketListFilters): boolean {
  if (filters.status !== 'all' && bucket.status !== filters.status) return false;
  if (filters.provider && bucket.providerKey !== filters.provider) return false;
  const needle = foldForSearch(filters.q.trim());
  if (!needle) return true;
  return [bucket.name, bucket.key, bucket.description ?? ''].some((field) => foldForSearch(field).includes(needle));
}

export function filterBuckets(buckets: readonly BucketListItem[], filters: BucketListFilters): BucketListItem[] {
  return buckets.filter((bucket) => matchesBucketFilters(bucket, filters));
}

/** The providers the buckets are on, one entry each, by name: what the provider filter offers. */
export function bucketProviderOptions(buckets: readonly BucketListItem[]): Array<{ value: string; label: string }> {
  const byKey = new Map<string, string>();
  for (const bucket of buckets) {
    if (!bucket.providerKey || byKey.has(bucket.providerKey)) continue;
    byKey.set(bucket.providerKey, bucket.provider?.label?.trim() || bucket.providerKey);
  }
  return [...byKey.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/* ── Tiles ───────────────────────────────────────────────────────────────── */

export interface BucketListSummary {
  buckets: number;
  active: number;
  disabled: number;
  /** Files in every bucket, session files included. */
  files: number;
  /** Their size, the Markdown copies included. */
  bytes: number;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The numbers of the tiles, from the list itself (the buckets carry their own stats). */
export function summarizeBuckets(buckets: readonly BucketListItem[]): BucketListSummary {
  const summary: BucketListSummary = { buckets: buckets.length, active: 0, disabled: 0, files: 0, bytes: 0 };
  for (const bucket of buckets) {
    if (bucket.status === 'active') summary.active += 1;
    else summary.disabled += 1;
    summary.files += count(bucket.stats?.fileCount);
    summary.bytes += count(bucket.stats?.totalBytes);
  }
  return summary;
}
