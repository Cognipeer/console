// @vitest-environment jsdom
/**
 * The Document Store's front page: the bucket list with its tiles, filters (kept in the address), provider cells,
 * row menu, and the states that replace the table (loading, could not load, no bucket, no file provider), in both
 * languages and for someone who can only read. The pure rules of the list (filters, search, tile numbers) are tested
 * first, then the page against a mocked `fetch`.
 */

import { act, createElement as h, useReducer } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardUserProvider } from '@/components/layout/DashboardUserContext';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  q,
  qa,
  setInput,
  settle,
  text,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';

const nav = vi.hoisted(() => ({ search: '' }));
const push = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, prefetch: vi.fn() }),
  usePathname: () => '/dashboard/files',
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));

import BucketListPage from '@/components/files/list/BucketListPage';
import { useBucketListFilters, SEARCH_URL_DELAY_MS } from '@/components/files/list/useBucketListFilters';
import type { BucketListItem, FileProviderListItem, ProviderHealth } from '@/components/files/filesApi';
import { formatBytes } from '@/components/files/shared';
import {
  FILES_DOCS_URL,
  NO_BUCKET_FILTERS,
  bucketHref,
  bucketListQuery,
  bucketProviderOptions,
  filterBuckets,
  foldForSearch,
  hasActiveFilters,
  parseBucketListFilters,
  summarizeBuckets,
} from '@/components/files/list/bucketListModel';
import {
  canManageProviders,
  driverInfo,
  hasUsableProvider,
  isLocalDiskProvider,
  isProviderUsable,
} from '@/components/files/list/providerModel';

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => {
  nav.search = '';
  push.mockClear();
  replace.mockClear();
  notify.show.mockClear();
});
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function provider(
  key: string,
  label: string,
  driver: string,
  providerHealth: ProviderHealth,
  extra: Partial<FileProviderListItem> = {},
): FileProviderListItem {
  return {
    _id: `id-${key}`,
    tenantId: 't1',
    key,
    label,
    driver,
    type: 'file',
    status: 'active',
    hasCredentials: true,
    providerHealth,
    storageLocationBase: `s3://files/console/t1/${key}/`,
    ...extra,
  } as unknown as FileProviderListItem;
}

const MINIO = provider('minio', 'MinIO (on-prem)', 'aws-s3-files', { state: 'ok', testedAt: ago(2 * HOUR) });
const AZURE = provider('azure', 'Azure Blob contoso', 'azure-blob-files', { state: 'ok', testedAt: ago(24 * HOUR) });
const S3_PROD = provider('s3-prod', 'Amazon S3 prod', 'aws-s3-files', {
  state: 'failed',
  testedAt: ago(3 * HOUR),
  message: 'AccessDenied: the access key was rejected',
});
const LOCAL = provider('local', 'Local filesystem', 'local-filesystem', { state: 'builtin' }, { storageLocationBase: null });
const PROVIDERS = [MINIO, AZURE, S3_PROD, LOCAL];

function bucket(
  key: string,
  name: string,
  owner: FileProviderListItem | null,
  stats: { fileCount: number; totalBytes: number },
  extra: Partial<BucketListItem> = {},
): BucketListItem {
  return {
    id: `b-${key}`,
    tenantId: 't1',
    key,
    name,
    providerKey: owner?.key ?? 'gone',
    status: 'active',
    createdBy: 'u1',
    createdAt: ago(40 * 24 * HOUR),
    updatedAt: ago(2 * HOUR),
    stats,
    providerHealth: owner?.providerHealth ?? { state: 'inactive', message: 'The provider no longer exists.' },
    ...(owner ? { provider: owner } : {}),
    ...extra,
  } as unknown as BucketListItem;
}

const BUCKETS: BucketListItem[] = [
  bucket('marketing-assets', 'Marketing assets', MINIO, { fileCount: 214, totalBytes: Math.round(1.2 * GIB) }, { description: 'Brand kits' }),
  bucket('contracts', 'Contracts', AZURE, { fileCount: 87, totalBytes: 310 * MIB }),
  bucket('support-exports', 'Support exports', S3_PROD, { fileCount: 532, totalBytes: Math.round(1.6 * GIB) }),
  bucket('agent-sessions', 'Agent sessions', LOCAL, { fileCount: 451, totalBytes: 96 * MIB }, { status: 'disabled' }),
  // Asked for a minute ago: the job is running, and not yet taken for lost.
  bucket('old-archive', 'Old archive', MINIO, { fileCount: 12, totalBytes: 4 * MIB }, { status: 'disabled', deleting: true, updatedAt: ago(MINUTE) as unknown as Date }),
];

const SESSION_WRITE = { effectivePermissions: { files: 'write' } };
const SESSION_READ = { effectivePermissions: { files: 'read' } };

function installList(
  options: {
    buckets?: BucketListItem[] | (() => Response | { buckets: BucketListItem[] });
    providers?: FileProviderListItem[];
    session?: unknown;
  } = {},
) {
  const { buckets = BUCKETS, providers = PROVIDERS, session = SESSION_WRITE } = options;
  api = installApiMock([
    ['GET', '/api/auth/session', () => session],
    ['GET', '/api/files/buckets', () => (typeof buckets === 'function' ? buckets() : { buckets })],
    ['GET', '/api/files/providers', () => ({ providers })],
    [
      'PATCH',
      /^\/api\/files\/buckets\/[^/]+$/,
      (call) => ({ bucket: { ...BUCKETS[0], status: (call.body as { status?: string }).status } }),
    ],
  ]);
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });

function page(role?: 'owner' | 'admin' | 'project_admin' | 'user') {
  const tree = h(QueryClientProvider, { client: newClient() }, h(BucketListPage));
  return role ? h(DashboardUserProvider, { value: { name: 'Ada', email: 'ada@example.com', licenseType: 'pro', role }, children: tree }) : tree;
}

const rows = () => qa<HTMLTableRowElement>('tbody tr');
const rowOf = (name: string) => rows().find((row) => row.textContent?.includes(name));
const tile = (label: string) => {
  const found = qa('.ds-stat').find((node) => q('.ds-stat-label', node)?.textContent === label);
  return { value: q('.ds-stat-value', found)?.textContent ?? '', delta: q('.ds-stat-delta', found)?.textContent ?? '' };
};
const searchBox = () => q<HTMLInputElement>('input[placeholder^="Search buckets"]')!;

async function choose(select: HTMLSelectElement | null, value: string) {
  if (!select) throw new Error('choose(): select not found');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/* ── The rules ───────────────────────────────────────────────────────────── */

describe('the list’s filters', () => {
  it('reads the address: unknown values are "no filter"', () => {
    expect(parseBucketListFilters(new URLSearchParams('q=%20docs%20&provider=minio&status=active'))).toEqual({
      q: 'docs',
      provider: 'minio',
      status: 'active',
    });
    expect(parseBucketListFilters(new URLSearchParams('status=everything'))).toEqual(NO_BUCKET_FILTERS);
    expect(parseBucketListFilters(new URLSearchParams(''))).toEqual(NO_BUCKET_FILTERS);
  });

  it('writes only what differs from "no filter", and keeps the rest of the address', () => {
    expect(bucketListQuery(NO_BUCKET_FILTERS)).toBe('');
    expect(bucketListQuery({ q: ' docs ', provider: 'minio', status: 'disabled' })).toBe('q=docs&provider=minio&status=disabled');
    expect(bucketListQuery({ q: '', provider: '', status: 'all' }, new URLSearchParams('q=old&view=compact&status=active'))).toBe('view=compact');
    expect(bucketListQuery({ q: 'x', provider: '', status: 'all' }, new URLSearchParams('view=compact'))).toBe('view=compact&q=x');
    expect(hasActiveFilters(NO_BUCKET_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...NO_BUCKET_FILTERS, q: '  ' })).toBe(false);
    expect(hasActiveFilters({ ...NO_BUCKET_FILTERS, provider: 'minio' })).toBe(true);
  });

  it('searches name, key and description without regard to case or accents, the Turkish i included', () => {
    expect(foldForSearch('İstanbul Işık Doküman')).toBe('istanbul isik dokuman');
    const buckets = [
      bucket('istanbul-arsivi', 'İstanbul Arşivi', MINIO, { fileCount: 1, totalBytes: 1 }),
      bucket('contracts', 'Contracts', AZURE, { fileCount: 1, totalBytes: 1 }, { description: 'Signed by the legal team' }),
    ];
    const names = (filters: Partial<typeof NO_BUCKET_FILTERS>) => filterBuckets(buckets, { ...NO_BUCKET_FILTERS, ...filters }).map((b) => b.key);
    expect(names({ q: 'istanbul arsivi' })).toEqual(['istanbul-arsivi']);
    expect(names({ q: 'ARŞİV' })).toEqual(['istanbul-arsivi']);
    expect(names({ q: 'LEGAL' })).toEqual(['contracts']);
    expect(names({ q: 'contracts' })).toEqual(['contracts']);
    expect(names({ q: 'nothing like it' })).toEqual([]);
  });

  it('combines the search with the provider and the status', () => {
    const keys = (filters: Partial<typeof NO_BUCKET_FILTERS>) => filterBuckets(BUCKETS, { ...NO_BUCKET_FILTERS, ...filters }).map((b) => b.key);
    expect(keys({ provider: 'minio' })).toEqual(['marketing-assets', 'old-archive']);
    expect(keys({ provider: 'minio', status: 'active' })).toEqual(['marketing-assets']);
    expect(keys({ status: 'disabled' })).toEqual(['agent-sessions', 'old-archive']);
    expect(keys({ provider: 'minio', status: 'disabled', q: 'archive' })).toEqual(['old-archive']);
  });

  it('offers the providers the buckets are on, once each, by name', () => {
    expect(bucketProviderOptions(BUCKETS)).toEqual([
      { value: 's3-prod', label: 'Amazon S3 prod' },
      { value: 'azure', label: 'Azure Blob contoso' },
      { value: 'local', label: 'Local filesystem' },
      { value: 'minio', label: 'MinIO (on-prem)' },
    ]);
  });

  it('adds the tiles up from the buckets themselves', () => {
    const summary = summarizeBuckets(BUCKETS);
    expect(summary).toMatchObject({ buckets: 5, active: 3, disabled: 2, files: 214 + 87 + 532 + 451 + 12 });
    expect(summary.bytes).toBe(Math.round(1.2 * GIB) + 310 * MIB + Math.round(1.6 * GIB) + 96 * MIB + 4 * MIB);
    // a bucket whose stats are missing or odd counts as empty instead of making the totals NaN
    const odd = [{ ...BUCKETS[0], stats: undefined }, { ...BUCKETS[1], stats: { fileCount: Number.NaN, totalBytes: -5 } }] as unknown as BucketListItem[];
    expect(summarizeBuckets(odd)).toMatchObject({ files: 0, bytes: 0 });
  });

  it('links to the bucket and its tabs', () => {
    expect(bucketHref('docs')).toBe('/dashboard/files/docs');
    expect(bucketHref('my docs', 'settings')).toBe('/dashboard/files/my%20docs?tab=settings');
  });
});

describe('what the list knows about a provider', () => {
  it('lets a bucket be created only on a provider that is on', () => {
    expect(isProviderUsable(MINIO)).toBe(true);
    // a failed or never-tested connection can still be chosen: the card warns, the person decides
    expect(isProviderUsable(S3_PROD)).toBe(true);
    expect(isProviderUsable({ status: 'active', providerHealth: { state: 'untested' } })).toBe(true);
    expect(isProviderUsable({ status: 'disabled', providerHealth: { state: 'ok' } })).toBe(false);
    expect(isProviderUsable({ status: 'active', providerHealth: { state: 'inactive' } })).toBe(false);
    expect(hasUsableProvider([])).toBe(false);
    expect(hasUsableProvider([{ status: 'disabled', providerHealth: { state: 'inactive' } }])).toBe(false);
    expect(hasUsableProvider([{ status: 'disabled', providerHealth: { state: 'inactive' } }, MINIO])).toBe(true);
  });

  it('knows the server’s own disk by its driver, never by a missing address', () => {
    expect(isLocalDiskProvider(LOCAL)).toBe(true);
    expect(isLocalDiskProvider({ driver: 'local-filesystem' })).toBe(true);
    expect(isLocalDiskProvider({ driver: 'some-future-disk', driverCapabilities: { builtin: true } as never })).toBe(true);
    expect(isLocalDiskProvider(MINIO)).toBe(false);
    // An S3 or Azure provider whose settings name no bucket or container yet has no address either: it is not a disk.
    const unfinished = provider('s3-new', 'Amazon S3 new', 'aws-s3-files', { state: 'untested' }, { storageLocationBase: null });
    expect(isLocalDiskProvider(unfinished)).toBe(false);
    expect(isLocalDiskProvider({ driver: 'azure-blob-files', driverCapabilities: { builtin: false } as never })).toBe(false);
  });

  it('names the driver from the catalog, and by its id when the catalog does not know it', () => {
    expect(driverInfo({ driver: 'aws-s3-files', key: 'minio' }).name).toBe('Amazon S3');
    expect(driverInfo({ driver: 'local-filesystem', key: 'local' }).name).toBe('Local filesystem');
    expect(driverInfo({ driver: 'some-new-driver', key: 'x' })).toMatchObject({ name: 'some-new-driver', glyph: 'S' });
  });

  it('links into the Providers area only for owners and admins', () => {
    expect(canManageProviders('owner')).toBe(true);
    expect(canManageProviders('admin')).toBe(true);
    expect(canManageProviders('project_admin')).toBe(false);
    expect(canManageProviders('user')).toBe(false);
    // outside the dashboard shell the role is not known: a hint, never the gate
    expect(canManageProviders(undefined)).toBe(true);
  });
});

/* ── The page ────────────────────────────────────────────────────────────── */

describe('BucketListPage', () => {
  it('shows tiles computed from the buckets, without asking for a dashboard', async () => {
    installList();
    mounted = await mount(page());
    await settle(100);

    expect(text()).toContain('Document Store');
    expect(tile('Buckets').value).toBe('5');
    expect(tile('Active').value).toBe('3');
    expect(tile('Disabled').value).toBe('2');
    expect(tile('Stored files').value).toBe('1,296');
    const totalBytes = BUCKETS.reduce((sum, b) => sum + b.stats.totalBytes, 0);
    expect(tile('Stored files').delta).toBe(`${formatBytes(totalBytes)} in all buckets`);
    // the date filter and the dashboard call are gone
    expect(api.to('GET', '/api/files/dashboard')).toHaveLength(0);
    expect(text()).not.toMatch(/last 7 days|last 30 days/i);
  });

  it('lists each bucket with a real link, its provider and health, files, size, status and age', async () => {
    installList();
    mounted = await mount(page());
    await settle(100);

    expect(rows()).toHaveLength(5);
    const marketing = rowOf('Marketing assets')!;
    const link = q<HTMLAnchorElement>('a', marketing)!;
    expect(link.getAttribute('href')).toBe('/dashboard/files/marketing-assets');
    expect(link.textContent).toBe('Marketing assets');
    expect(marketing.textContent).toContain('marketing-assets');
    expect(marketing.textContent).toContain('MinIO (on-prem)');
    expect(marketing.textContent).toContain('Amazon S3');
    expect(marketing.textContent).toContain('Connected');
    expect(marketing.textContent).toContain('214');
    expect(marketing.textContent).toContain(formatBytes(Math.round(1.2 * GIB)));
    expect(marketing.textContent).toContain('Active');
    expect(q('time', marketing)).not.toBeNull();
  });

  it('says why a provider is a problem and links to it, for someone who can open the Providers area', async () => {
    installList();
    mounted = await mount(page('admin'));
    await settle(100);

    const support = rowOf('Support exports')!;
    expect(support.textContent).toContain('Test failed');
    expect(support.textContent).toContain('AccessDenied: the access key was rejected');
    expect(q<HTMLAnchorElement>('a[href="/dashboard/providers/id-s3-prod"]', support)?.textContent).toBe('Open provider');
    // a healthy provider has no such link
    expect(q('a[href^="/dashboard/providers/"]', rowOf('Marketing assets'))).toBeNull();
    // the built-in disk says it needs no test
    expect(rowOf('Agent sessions')!.textContent).toContain('Built-in');
  });

  it('does not offer a link into the Providers area to someone who cannot open it', async () => {
    installList();
    mounted = await mount(page('user'));
    await settle(100);

    const support = rowOf('Support exports')!;
    expect(support.textContent).toContain('AccessDenied: the access key was rejected');
    expect(q('a[href^="/dashboard/providers/"]', support)).toBeNull();
  });

  it('marks a bucket that is being deleted, and one whose provider is gone', async () => {
    installList({ buckets: [...BUCKETS, bucket('orphan', 'Orphan', null, { fileCount: 0, totalBytes: 0 })] });
    mounted = await mount(page());
    await settle(100);

    const archive = rowOf('Old archive')!;
    expect(archive.textContent).toContain('Deleting…');
    expect(archive.textContent).not.toContain('Disabled');
    expect(rowOf('Agent sessions')!.textContent).toContain('Disabled');
    expect(rowOf('Orphan')!.textContent).toContain('Provider unavailable');
  });

  it('marks a bucket whose last deletion failed, with the reason one hover away', async () => {
    const failed = bucket('stuck-export', 'Stuck export', MINIO, { fileCount: 40, totalBytes: 8 * MIB }, {
      status: 'disabled',
      deleteError: 'Access denied by the provider',
    } as Partial<BucketListItem>);
    installList({ buckets: [...BUCKETS, failed] });
    mounted = await mount(page());
    await settle(100);

    const row = rowOf('Stuck export')!;
    expect(row.textContent).toContain('Deletion failed');
    expect(row.textContent).not.toContain('Disabled');
    expect(q('button[aria-label="Deletion failed: Access denied by the provider"]', row)).not.toBeNull();
    // A bucket that merely is disabled is not marked as failed.
    expect(rowOf('Agent sessions')!.textContent).not.toContain('Deletion failed');
  });

  it('reads the reason a bucket carries in its metadata when the list does not say it outright', async () => {
    const failed = bucket('stuck-export', 'Stuck export', MINIO, { fileCount: 40, totalBytes: 8 * MIB }, {
      status: 'disabled',
      metadata: { deleteError: 'Timed out' },
    });
    installList({ buckets: [...BUCKETS, failed] });
    mounted = await mount(page());
    await settle(100);
    expect(q('button[aria-label="Deletion failed: Timed out"]', rowOf('Stuck export'))).not.toBeNull();
  });

  it('shows a bucket that is deleting as deleting, even when it carries the reason of an earlier run', async () => {
    const again = bucket('again', 'Run again', MINIO, { fileCount: 3, totalBytes: MIB }, {
      status: 'disabled',
      deleting: true,
      updatedAt: ago(MINUTE) as unknown as Date,
      deleteError: 'An earlier run',
    } as Partial<BucketListItem>);
    installList({ buckets: [...BUCKETS, again] });
    mounted = await mount(page());
    await settle(100);
    expect(rowOf('Run again')!.textContent).toContain('Deleting…');
    expect(rowOf('Run again')!.textContent).not.toContain('Deletion failed');
  });

  it('opens a bucket from its row, and from the header’s docs link to the guide', async () => {
    installList();
    mounted = await mount(page());
    await settle(100);

    await click(rowOf('Contracts')!);
    expect(push.mock.calls.map((call) => call[0])).toEqual(['/dashboard/files/contracts']);
    expect(FILES_DOCS_URL).toBe('https://docs.cognipeer.com/console/guide/knowledge/files');
    const docs = q<HTMLAnchorElement>(`a[href="${FILES_DOCS_URL}"]`)!;
    expect(docs.getAttribute('href')).toBe('https://docs.cognipeer.com/console/guide/knowledge/files');
    expect(docs.textContent).toBe('Docs');
    expect(docs.getAttribute('target')).toBe('_blank');
    expect(docs.getAttribute('rel')).toContain('noopener');
  });

  it('filters by search, provider and status, and keeps them in the address', async () => {
    installList();
    mounted = await mount(page());
    await settle(100);

    await setInput(searchBox(), 'contr');
    expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining('Contracts')]);
    expect(text()).toContain('Showing 1 of 5 buckets');
    // typing does not write the address letter by letter: it follows after a pause
    expect(replace).not.toHaveBeenCalled();
    await settle(SEARCH_URL_DELAY_MS + 100);
    expect(replace.mock.calls.at(-1)?.[0]).toBe('/dashboard/files?q=contr');

    await setInput(searchBox(), '');
    await choose(q<HTMLSelectElement>('select[aria-label="Filter by provider"]'), 'minio');
    expect(rows().map((row) => q('a', row)?.textContent)).toEqual(['Marketing assets', 'Old archive']);
    expect(replace.mock.calls.at(-1)?.[0]).toBe('/dashboard/files?provider=minio');

    await choose(q<HTMLSelectElement>('select[aria-label="Filter by status"]'), 'disabled');
    expect(rows().map((row) => q('a', row)?.textContent)).toEqual(['Old archive']);
    expect(replace.mock.calls.at(-1)?.[0]).toBe('/dashboard/files?provider=minio&status=disabled');
    expect(text()).toContain('Showing 1 of 5 buckets');
    // the tiles keep counting every bucket: they describe the project, not the view
    expect(tile('Buckets').value).toBe('5');
  });

  it('offers the providers the buckets are on in the provider filter', async () => {
    installList();
    mounted = await mount(page());
    await settle(100);

    const options = qa<HTMLOptionElement>('option', q('select[aria-label="Filter by provider"]')!).map((option) => option.textContent);
    expect(options).toEqual(['All providers', 'Amazon S3 prod', 'Azure Blob contoso', 'Local filesystem', 'MinIO (on-prem)']);
    const statuses = qa<HTMLOptionElement>('option', q('select[aria-label="Filter by status"]')!).map((option) => option.textContent);
    expect(statuses).toEqual(['Any status', 'Active', 'Disabled']);
  });

  it('opens with the filters of the address', async () => {
    nav.search = 'q=contracts&status=active';
    installList();
    mounted = await mount(page());
    await settle(100);

    expect(searchBox().value).toBe('contracts');
    expect(q<HTMLSelectElement>('select[aria-label="Filter by status"]')!.value).toBe('active');
    expect(rows()).toHaveLength(1);
    expect(rowOf('Contracts')).toBeDefined();
  });

  it('keeps a provider from the address in the select even when no bucket is on it any more', async () => {
    nav.search = 'provider=retired';
    installList();
    mounted = await mount(page());
    await settle(100);

    const select = q<HTMLSelectElement>('select[aria-label="Filter by provider"]')!;
    expect(select.value).toBe('retired');
    expect(text()).toContain('No bucket matches');
  });

  it('says nothing matches, and clears the filters from there', async () => {
    installList();
    mounted = await mount(page());
    await settle(100);

    await setInput(searchBox(), 'zzz-no-such-bucket');
    expect(rows()).toHaveLength(0);
    expect(text()).toContain('No bucket matches');
    expect(text()).not.toContain('No buckets yet');
    await click(buttonByText('Clear filters'));
    expect(rows()).toHaveLength(5);
    expect(searchBox().value).toBe('');
    expect(replace.mock.calls.at(-1)?.[0]).toBe('/dashboard/files');
  });

  it('shows skeleton rows while the first answer is on its way', async () => {
    let release: (value: { buckets: BucketListItem[] }) => void = () => {};
    const slow = new Promise<{ buckets: BucketListItem[] }>((resolve) => {
      release = resolve;
    });
    api = installApiMock([
      ['GET', '/api/auth/session', () => SESSION_WRITE],
      ['GET', '/api/files/buckets', () => slow],
      ['GET', '/api/files/providers', () => ({ providers: PROVIDERS })],
    ]);
    mounted = await mount(page());
    await settle(50);

    expect(qa('tr.ds-skeleton-row').length).toBeGreaterThan(0);
    expect(text()).not.toContain('No buckets yet');
    expect(text()).not.toContain('Couldn’t load buckets');
    await act(async () => release({ buckets: BUCKETS }));
    await settle(50);
    expect(qa('tr.ds-skeleton-row')).toHaveLength(0);
    expect(rows()).toHaveLength(5);
  });
});

describe('when the list cannot be loaded', () => {
  it('says so with the status and a Retry, never as an empty list, and recovers on Retry', async () => {
    let failing = true;
    installList({ buckets: () => (failing ? jsonResponse({ error: 'upstream is down' }, 503) : { buckets: BUCKETS }) });
    mounted = await mount(page());
    await settle(100);

    expect(text()).toContain('Couldn’t load buckets');
    expect(text()).toContain('The server answered 503. Your buckets were not changed.');
    expect(text()).not.toContain('No buckets yet');
    expect(text()).not.toContain('No file provider yet');
    expect(qa('table')).toHaveLength(0);
    expect(q('[role="alert"]')).not.toBeNull();
    // the tiles do not show numbers that were never read
    expect(qa('.ds-stat')).toHaveLength(0);

    failing = false;
    await click(buttonByText('Retry'));
    await settle(100);
    expect(text()).not.toContain('Couldn’t load buckets');
    expect(rows()).toHaveLength(5);
  });

  it('words a refusal and a lost connection in terms the person can act on', async () => {
    installList({ buckets: () => jsonResponse({ error: 'Forbidden' }, 403) });
    mounted = await mount(page());
    await settle(100);
    expect(text()).toContain('You do not have permission to do this.');
    expect(text()).not.toContain('The server answered');
    await mounted.unmount();

    api = installApiMock([
      ['GET', '/api/auth/session', () => SESSION_WRITE],
      [
        'GET',
        '/api/files/buckets',
        () => {
          throw new TypeError('Failed to fetch');
        },
      ],
    ]);
    mounted = await mount(page());
    await settle(100);
    expect(text()).toContain('The server could not be reached. Check your connection and try again.');
  });

  it('keeps the buckets already shown when a refresh fails, and says that the list is old', async () => {
    let failing = false;
    installList({ buckets: () => (failing ? jsonResponse({ error: 'upstream is down' }, 502) : { buckets: BUCKETS }) });
    mounted = await mount(page());
    await settle(100);
    expect(rows()).toHaveLength(5);

    failing = true;
    await click(q('button[aria-label="Refresh"]'));
    await settle(100);
    expect(rows()).toHaveLength(5);
    expect(text()).toContain('Couldn’t refresh the list');
    expect(text()).toContain('Showing the buckets loaded before.');
    expect(text()).not.toContain('Couldn’t load buckets');
  });
});

describe('when there is no bucket', () => {
  it('leads to creating the first one when a provider can take it', async () => {
    installList({ buckets: [] });
    mounted = await mount(page());
    await settle(100);

    expect(text()).toContain('No buckets yet');
    expect(qa('table')).toHaveLength(0);
    expect(qa('button').filter((button) => button.textContent === 'Create bucket')).toHaveLength(2);
  });

  it('leads to adding a file provider when there is none, instead of a create button that cannot work', async () => {
    installList({ buckets: [], providers: [] });
    mounted = await mount(page('admin'));
    await settle(100);

    expect(text()).toContain('No file provider yet');
    const add = buttonByText('Add a file provider') as unknown as HTMLAnchorElement;
    expect(add.getAttribute('href')).toBe('/dashboard/providers?domain=file');
    // only the header keeps its Create bucket button
    expect(qa('button').filter((button) => button.textContent === 'Create bucket')).toHaveLength(1);
  });

  it('tells someone who cannot open the Providers area to ask an administrator', async () => {
    installList({ buckets: [], providers: [] });
    mounted = await mount(page('user'));
    await settle(100);

    expect(text()).toContain('No file provider yet');
    expect(text()).toContain('Ask an administrator to add a file provider, then create your first bucket.');
    expect(buttonByText('Add a file provider')).toBeUndefined();
  });

  it('also leads to the providers when every one of them is switched off', async () => {
    const off = provider('off', 'Switched off', 'aws-s3-files', { state: 'inactive', message: 'Disabled by an admin' }, { status: 'disabled' });
    installList({ buckets: [], providers: [off] });
    mounted = await mount(page('owner'));
    await settle(100);

    expect(text()).toContain('No file provider can take a bucket');
    expect((buttonByText('Manage file providers') as unknown as HTMLAnchorElement).getAttribute('href')).toBe('/dashboard/providers?domain=file');
  });
});

describe('for someone who can only read', () => {
  it('hides every control that changes a bucket and says why', async () => {
    installList({ session: SESSION_READ });
    mounted = await mount(page());
    await settle(100);

    expect(text()).toContain('You have read-only access to the Document Store');
    expect(buttonByText('Create bucket')).toBeUndefined();
    await click(q('button[aria-label="Actions for Marketing assets"]'));
    await settle(30);
    expect(qa('[role="menuitem"]').map((item) => item.textContent?.trim())).toEqual(['Open bucket', 'Bucket settings']);
  });

  it('shows no create button in the empty state either, only the note', async () => {
    installList({ buckets: [], session: SESSION_READ });
    mounted = await mount(page());
    await settle(100);

    expect(text()).toContain('No buckets yet');
    expect(buttonByText('Create bucket')).toBeUndefined();
    expect(text()).toContain('You have read-only access');
  });

  it('draws the controls while the level is not known: the server decides', async () => {
    api = installApiMock([
      ['GET', '/api/auth/session', () => jsonResponse({ error: 'no' }, 500)],
      ['GET', '/api/files/buckets', () => ({ buckets: BUCKETS })],
    ]);
    mounted = await mount(page());
    await settle(100);

    expect(buttonByText('Create bucket')).toBeDefined();
    expect(text()).not.toContain('read-only access');
  });
});

describe('the row menu', () => {
  const menuItems = () => qa('[role="menuitem"]').map((item) => item.textContent?.trim());

  it('is named after its bucket and does not open the bucket by itself', async () => {
    installList();
    mounted = await mount(page());
    await settle(100);

    const buttons = qa('button[aria-label^="Actions for"]').map((button) => button.getAttribute('aria-label'));
    expect(buttons).toEqual([
      'Actions for Marketing assets',
      'Actions for Contracts',
      'Actions for Support exports',
      'Actions for Agent sessions',
      'Actions for Old archive',
    ]);
    await click(q('button[aria-label="Actions for Contracts"]'));
    await settle(30);
    expect(menuItems()).toEqual(['Open bucket', 'Bucket settings', 'Disable', 'Delete bucket…']);
    expect(push).not.toHaveBeenCalled();
  });

  it('opens the bucket and its Settings tab, where deleting is confirmed', async () => {
    installList();
    mounted = await mount(page());
    await settle(100);

    await click(q('button[aria-label="Actions for Contracts"]'));
    await settle(30);
    await click(qa('[role="menuitem"]').find((item) => item.textContent === 'Bucket settings'));
    await click(q('button[aria-label="Actions for Contracts"]'));
    await settle(30);
    await click(qa('[role="menuitem"]').find((item) => item.textContent === 'Delete bucket…'));
    expect(push.mock.calls.map((call) => call[0])).toEqual([
      '/dashboard/files/contracts?tab=settings',
      '/dashboard/files/contracts?tab=settings',
    ]);
    // nothing was deleted from the list
    expect(api.to('DELETE', '/api/files/buckets/contracts')).toHaveLength(0);
  });

  it('disables and enables a bucket and tells the person', async () => {
    installList();
    mounted = await mount(page());
    await settle(100);

    await click(q('button[aria-label="Actions for Marketing assets"]'));
    await settle(30);
    await click(qa('[role="menuitem"]').find((item) => item.textContent === 'Disable'));
    await settle(100);
    expect(api.to('PATCH', '/api/files/buckets/marketing-assets').map((call) => call.body)).toEqual([{ status: 'disabled' }]);
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ color: 'green', title: 'Bucket disabled' }));

    await click(q('button[aria-label="Actions for Agent sessions"]'));
    await settle(30);
    expect(menuItems()).toContain('Enable');
    await click(qa('[role="menuitem"]').find((item) => item.textContent === 'Enable'));
    await settle(100);
    expect(api.to('PATCH', '/api/files/buckets/agent-sessions').map((call) => call.body)).toEqual([{ status: 'active' }]);
    expect(notify.show).toHaveBeenLastCalledWith(expect.objectContaining({ color: 'green', title: 'Bucket enabled' }));
  });

  it('names the agents when a bucket cannot be disabled because they use it', async () => {
    installList();
    api.on('PATCH', /^\/api\/files\/buckets\/[^/]+$/, () =>
      jsonResponse({ error: 'The bucket is used by 1 agent.', code: 'bucket_in_use', agents: [{ name: 'Support bot' }] }, 409),
    );
    mounted = await mount(page());
    await settle(100);

    await click(q('button[aria-label="Actions for Marketing assets"]'));
    await settle(30);
    await click(qa('[role="menuitem"]').find((item) => item.textContent === 'Disable'));
    await settle(100);
    const call = notify.show.mock.calls.at(-1)?.[0];
    expect(call).toMatchObject({ color: 'red', title: 'Unable to update bucket' });
    expect(call.message).toContain('The bucket is used by 1 agent.');
    expect(call.message).toContain('Support bot');
  });

  it('offers no change to a bucket that is being deleted', async () => {
    installList();
    mounted = await mount(page());
    await settle(100);

    await click(q('button[aria-label="Actions for Old archive"]'));
    await settle(30);
    expect(menuItems()).toEqual(['Open bucket', 'Bucket settings']);
  });

  describe('for a bucket whose deletion did not finish', () => {
    const FAILED = bucket('stuck-export', 'Stuck export', MINIO, { fileCount: 40, totalBytes: 8 * MIB }, {
      status: 'disabled',
      deleteError: 'Access denied by the provider',
    } as Partial<BucketListItem>);
    const LOST = bucket('lost-job', 'Lost job', MINIO, { fileCount: 9, totalBytes: 2 * MIB }, {
      status: 'disabled',
      deleting: true,
      updatedAt: ago(2 * HOUR) as unknown as Date,
    });

    it('reads “Delete again…” instead of “Delete bucket…” after a failure, and goes to the same place', async () => {
      installList({ buckets: [...BUCKETS, FAILED] });
      mounted = await mount(page());
      await settle(100);

      await click(q('button[aria-label="Actions for Stuck export"]'));
      await settle(30);
      expect(menuItems()).toEqual(['Open bucket', 'Bucket settings', 'Enable', 'Delete again…']);
      await click(qa('[role="menuitem"]').find((item) => item.textContent === 'Delete again…'));
      expect(push.mock.calls.map((call) => call[0])).toEqual(['/dashboard/files/stuck-export?tab=settings']);
      expect(api.to('DELETE', '/api/files/buckets/stuck-export')).toHaveLength(0);
    });

    it('offers “Delete again…” for a bucket that has been deleting for so long that the job was probably lost', async () => {
      installList({ buckets: [...BUCKETS, LOST] });
      mounted = await mount(page());
      await settle(100);

      await click(q('button[aria-label="Actions for Lost job"]'));
      await settle(30);
      // Changing it is still refused (it is being deleted); running the deletion again is not.
      expect(menuItems()).toEqual(['Open bucket', 'Bucket settings', 'Delete again…']);
    });

    it('offers it to nobody who cannot write', async () => {
      installList({ buckets: [...BUCKETS, FAILED, LOST], session: SESSION_READ });
      mounted = await mount(page());
      await settle(100);

      for (const name of ['Stuck export', 'Lost job']) {
        await click(q(`button[aria-label="Actions for ${name}"]`));
        await settle(30);
        expect(menuItems()).toEqual(['Open bucket', 'Bucket settings']);
        await click(qa('[role="menuitem"]').find((item) => item.textContent === 'Open bucket'));
      }
    });

    it('speaks Turkish', async () => {
      installList({ buckets: [...BUCKETS, FAILED] });
      mounted = await mount(page(), 'tr');
      await settle(100);

      await click(q('button[aria-label="Stuck export için işlemler"]'));
      await settle(30);
      expect(menuItems()).toContain('Yeniden sil…');
    });
  });
});

describe('the create button', () => {
  it('opens the create screen, and a created bucket opens its own page', async () => {
    installList();
    api.on('POST', '/api/files/buckets', () => jsonResponse({ bucket: { ...BUCKETS[0], key: 'fresh', name: 'Fresh' } }, 201));
    mounted = await mount(page());
    await settle(100);

    await click(buttonByText('Create bucket'));
    await settle(100);
    expect(q('.form-overlay')).not.toBeNull();
    expect(text()).toContain('Storage provider');
    // MinIO, Azure and the local disk can take a bucket; with several to choose from none is chosen for the person
    await click(qa<HTMLInputElement>('input[type="radio"]').find((radio) => !radio.disabled));
    await setInput(q<HTMLInputElement>('input[aria-label="Name"]')!, 'Fresh');
    await click(qa('.form-footer button').find((button) => button.textContent === 'Create bucket'));
    await settle(150);

    expect(api.to('POST', '/api/files/buckets')).toHaveLength(1);
    expect(push.mock.calls.map((call) => call[0])).toEqual(['/dashboard/files/fresh']);
    expect(q('.form-overlay')).toBeNull();
  });
});

describe('both languages', () => {
  it('speaks Turkish', async () => {
    installList();
    mounted = await mount(page(), 'tr');
    await settle(100);

    expect(text()).toContain('Doküman Deposu');
    expect(text()).toContain('Bucket oluştur');
    expect(tile('Saklanan dosya').delta).toContain('tüm bucket’larda');
    expect(text()).toContain('5 bucket’tan 5 tanesi gösteriliyor');
    expect(q('button[aria-label="Marketing assets için işlemler"]')).not.toBeNull();
    expect(q('select[aria-label="Sağlayıcıya göre filtrele"]')).not.toBeNull();
    expect(text()).not.toContain('Create bucket');
  });
});

describe('useBucketListFilters', () => {
  function Probe() {
    const [, bump] = useReducer((count: number) => count + 1, 0);
    const { filters, setStatus } = useBucketListFilters();
    return h(
      'div',
      null,
      h('output', { 'data-filters': '' }, JSON.stringify(filters)),
      h('button', { type: 'button', 'data-bump': '', onClick: () => bump() }, 'bump'),
      h('button', { type: 'button', 'data-status': '', onClick: () => setStatus('disabled') }, 'status'),
    );
  }
  const shown = () => JSON.parse(q('[data-filters]')!.textContent!);

  it('replaces the filters when the address changes from outside (Back, a link), and writes its own changes', async () => {
    nav.search = 'q=first';
    mounted = await mount(h(Probe));
    expect(shown()).toEqual({ q: 'first', provider: '', status: 'all' });

    await click(q('[data-status]'));
    expect(shown()).toEqual({ q: 'first', provider: '', status: 'disabled' });
    expect(replace.mock.calls.at(-1)?.[0]).toBe('/dashboard/files?q=first&status=disabled');

    nav.search = 'provider=minio';
    await click(q('[data-bump]'));
    expect(shown()).toEqual({ q: '', provider: 'minio', status: 'all' });
  });
});
