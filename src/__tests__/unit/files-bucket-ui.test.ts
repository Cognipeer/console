// @vitest-environment jsdom
/**
 * The bucket page of the Document Store and its Files tab, against a fake Files server: the header and its
 * actions, the states that replace the page (loading, not found, could not load), the notices (read-only,
 * disabled, being deleted), the tabs in the address, and the Files tab itself — folders, search and filters in the
 * address, the grid, selection and the bulk bar, deleting files, "Load more", and the empty and failed states.
 * The Settings and API tabs and the dialogs are in `files-bucket-settings-ui.test.ts`.
 *
 * The file drawer and the upload screen are built by another part of the Document Store; here they are stubs that
 * show what the page hands them (the file's key, the folder to upload into).
 */

import { act, createElement as h, useEffect, useReducer, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsDrawerProvider } from '@/components/docs/DocsDrawerContext';
import { DashboardUserProvider } from '@/components/layout/DashboardUserContext';
import {
  buttonByText,
  click,
  installDomStubs,
  jsonResponse,
  mount,
  q,
  qa,
  setInput,
  text,
  wait,
  type Mounted,
} from '../helpers/iamCenterUi';
import {
  MIB,
  MINUTE,
  ago,
  bucketDetail,
  deletingBucket,
  failedDeleteBucket,
  fileRecord,
  HOUR,
  installBucketServer,
  refusal,
  type BucketServer,
} from '../helpers/filesBucketUi';

/* ── Navigation, notifications, downloads and the parts built elsewhere ─── */

const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  // `before` holds the addresses a push left behind, so `back()` can return to the last one.
  const store = { pathname: '/dashboard/files/docs', search: '', pushes: [] as string[], replaces: [] as string[], before: [] as string[] };
  const apply = (href: string) => {
    const at = href.indexOf('?');
    store.pathname = at >= 0 ? href.slice(0, at) : href;
    store.search = at >= 0 ? href.slice(at + 1) : '';
    listeners.forEach((listener) => listener());
  };
  const go = (kind: 'pushes' | 'replaces', href: string) => {
    store[kind].push(href);
    if (kind === 'pushes') store.before.push(store.search ? `${store.pathname}?${store.search}` : store.pathname);
    apply(href);
  };
  // One router object for the whole test, as Next gives one: the page's callbacks keep their identity.
  const router = {
    push: (href: string) => go('pushes', href),
    replace: (href: string) => go('replaces', href),
    back: () => {
      const previous = store.before.pop();
      if (previous !== undefined) apply(previous);
    },
    prefetch: () => undefined,
  };
  return { listeners, store, router };
});
vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  usePathname: () => nav.store.pathname,
  useSearchParams: () => new URLSearchParams(nav.store.search),
}));

const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));

const saved = vi.hoisted(() => ({ saveBlob: vi.fn() }));
vi.mock('@/components/files/shared/saveBlob', () => ({ saveBlob: saved.saveBlob }));

const stubs = vi.hoisted(() => ({
  drawer: vi.fn<(props: unknown) => unknown>(() => null),
  upload: vi.fn<(props: unknown) => unknown>(() => null),
}));
vi.mock('@/components/files/detail/FileDetailDrawer', () => ({ FileDetailDrawer: (props: unknown) => stubs.drawer(props) }));
vi.mock('@/components/files/upload/UploadFilesForm', () => ({ UploadFilesForm: (props: unknown) => stubs.upload(props) }));

import BucketPage from '@/components/files/bucket/BucketPage';
import { SEARCH_DEBOUNCE_MS } from '@/components/files/bucket/BucketFilesTab';
import { formatBytes } from '@/components/files/shared';

interface DrawerProps {
  fileKey: string | null;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: (key: string) => void;
}
interface UploadProps {
  opened: boolean;
  folder: string;
  onClose: () => void;
}
stubs.drawer.mockImplementation(((props: DrawerProps) =>
  props.fileKey ? h('div', { 'data-testid': 'drawer', 'data-key': props.fileKey }, 'drawer') : null) as never);
stubs.upload.mockImplementation(((props: UploadProps) =>
  props.opened ? h('div', { 'data-testid': 'upload-form', 'data-folder': props.folder }, 'upload') : null) as never);

/* ── Harness ─────────────────────────────────────────────────────────────── */

let mounted: Mounted | undefined;
let server: BucketServer;
let client: QueryClient;
const openDocs = vi.fn();

beforeAll(() => installDomStubs());
beforeEach(() => {
  nav.store.pathname = '/dashboard/files/docs';
  nav.store.search = '';
  nav.store.pushes.length = 0;
  nav.store.replaces.length = 0;
  nav.store.before.length = 0;
  notify.show.mockClear();
  saved.saveBlob.mockClear();
  openDocs.mockClear();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  client?.clear();
  vi.unstubAllGlobals();
  delete (navigator as { clipboard?: unknown }).clipboard;
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** Re-renders the page whenever the (fake) address changes, as Next does for `useSearchParams`. */
function NavHarness({ render }: { render: () => ReactNode }) {
  const [, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    nav.listeners.add(bump);
    return () => {
      nav.listeners.delete(bump);
    };
  }, []);
  return render() as never;
}

async function waitFor(predicate: () => boolean, label: string, timeout = 4000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) {
      const copy = document.body.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('style').forEach((node) => node.remove());
      throw new Error(`Timed out waiting for: ${label}\n--- page text ---\n${(copy.textContent ?? '').replace(/\s+/g, ' ').slice(0, 1200)}`);
    }
    await wait(15);
  }
}

const USER = (role: 'owner' | 'admin' | 'project_admin' | 'user') => ({ name: 'Ada', email: 'ada@example.com', licenseType: 'pro', role });

interface OpenOptions {
  search?: string;
  role?: 'owner' | 'admin' | 'project_admin' | 'user';
  locale?: string;
  /** What to wait for before the test starts; the default is a grid with rows or a state card. */
  until?: () => boolean;
}

async function openPage(options: OpenOptions = {}) {
  nav.store.pathname = '/dashboard/files/docs';
  nav.store.search = options.search ?? '';
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const tree = () =>
    h(
      QueryClientProvider,
      { client },
      h(DocsDrawerProvider, {
        value: { openDocs },
        children: h(DashboardUserProvider, { value: USER(options.role ?? 'owner'), children: h(BucketPage, { bucketKey: 'docs' }) }),
      }),
    );
  mounted = await mount(h(NavHarness, { render: tree }), options.locale ?? 'en');
  await waitFor(options.until ?? (() => rows().length > 0 || Boolean(q('.ds-empty'))), 'the page to show rows or a state');
  // The person's level (it decides which controls are drawn) arrives with its own request.
  await waitFor(() => server.api.to('GET', '/api/auth/session').length > 0, 'the session request');
  await wait(20);
}

async function navigateOutside(search: string) {
  await act(async () => {
    nav.store.search = search;
    nav.listeners.forEach((listener) => listener());
  });
}

async function choose(select: HTMLSelectElement | null, value: string) {
  if (!select) throw new Error('choose(): select not found');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const rows = () => qa<HTMLTableRowElement>('tbody tr');
const rowTexts = () => rows().map((row) => row.textContent ?? '');
const rowOf = (name: string) => rows().find((row) => row.textContent?.includes(name));
const objectCalls = () => server.api.to('GET', '/api/files/buckets/docs/objects');
const lastListing = () => objectCalls().at(-1)!.query;
const searchBox = () => q<HTMLInputElement>('input[placeholder="Search files by name…"]')!;
const typeSelect = () => q<HTMLSelectElement>('select[aria-label="Filter by file type"]');
const showSelect = () => q<HTMLSelectElement>('select[aria-label="Show"]');
const menuButton = (name: string) => q<HTMLButtonElement>(`button[aria-label="Actions for ${name}"]`);
const menuItems = () => qa('[role="menuitem"]').map((item) => item.textContent?.trim());
const menuItem = (label: string) => qa('[role="menuitem"]').find((item) => item.textContent?.trim() === label);
const rowCheckbox = (name: string) => q<HTMLInputElement>(`input[type="checkbox"][aria-label="Select ${name}"]`);
const selectAll = () => q<HTMLInputElement>('input[type="checkbox"][aria-label="Select all files in this list"]');
const bulkBar = () => q('[role="group"][aria-label="Actions for the selected files"]');
const tabs = () => qa('[role="tab"]');
const drawerKey = () => q('[data-testid="drawer"]')?.getAttribute('data-key') ?? null;
const uploadFolder = () => q('[data-testid="upload-form"]')?.getAttribute('data-folder') ?? null;
const toasts = () => notify.show.mock.calls.map((call) => call[0] as { color?: string; title?: string; message?: string });
const MENU_NOT_OPEN = () => qa('[role="menuitem"]').length === 0;
/** A Mantine modal keeps its (empty) root in the page once it is closed; it is open while its dialog is there. */
const modalOpen = (testId: string) => Boolean(q(`[data-testid="${testId}"] [role="dialog"]`));

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const SESSION_FILE = fileRecord('agent-sessions/support/s1/note.txt', {
  purpose: 'conversation',
  conversationId: 's1',
  agentKey: 'support',
  agentId: 'agent-1',
  uploadedBy: 'u7',
  uploadedByName: 'Ada Lovelace',
  expiresAt: new Date(Date.now() + 3 * 24 * HOUR).toISOString() as unknown as Date,
});

const RECORDS = [
  fileRecord('root.txt', { size: 100 }),
  fileRecord('reports/summary.pdf', { size: 4 * MIB, markdownStatus: 'succeeded', markdownKey: 'reports/summary.md', markdownSize: 900 }),
  fileRecord('reports/2026/q1.pdf', { markdownStatus: 'failed', markdownError: 'The PDF is password protected.' }),
  fileRecord('reports/2026/q2.pdf'),
  fileRecord('photos/logo.png'),
  SESSION_FILE,
];

const manyFiles = (count: number) =>
  Array.from({ length: count }, (_, index) => fileRecord(`f${String(index).padStart(3, '0')}.txt`, { size: 10 + index }));

/* ── The header ──────────────────────────────────────────────────────────── */

describe('the bucket page’s header', () => {
  it('names the bucket with its status, provider, health and how much it holds', async () => {
    server = installBucketServer({ records: RECORDS, bucket: bucketDetail({ stats: { fileCount: 1284, totalBytes: 3 * 1024 * MIB } }) });
    await openPage();

    expect(q('h1')?.textContent).toBe('Docs');
    const header = q('.detail-header')!;
    expect(header.textContent).toContain('Active');
    expect(header.textContent).toContain('docs');
    expect(header.textContent).toContain('MinIO (on-prem)');
    expect(header.textContent).toContain('Amazon S3');
    expect(header.textContent).toContain('Connected');
    expect(header.textContent).toContain('1,284 files · 3.0 GB');
    expect(q('a[aria-label="Back to Document Store"]')?.getAttribute('href')).toBe('/dashboard/files');
  });

  it('says "1 file" for a bucket with one', async () => {
    server = installBucketServer({ records: [RECORDS[0]!], bucket: bucketDetail({ stats: { fileCount: 1, totalBytes: 100 } }) });
    await openPage();
    expect(q('.detail-header')!.textContent).toContain(`1 file · ${formatBytes(100)}`);
  });

  it('has the actions Refresh, Upload and a menu, and three tabs with Files open', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage();

    expect(buttonByText('Refresh')).toBeTruthy();
    expect(buttonByText('Upload')).toBeTruthy();
    expect(q('button[aria-label="More actions"]')).toBeTruthy();
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Files', 'Settings', 'API']);
    expect(tabs().map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
  });

  it('refreshes the bucket and its files together', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage();
    const bucketCalls = () => server.api.to('GET', '/api/files/buckets/docs').length;
    const before = { bucket: bucketCalls(), objects: objectCalls().length };

    await click(buttonByText('Refresh'));
    await waitFor(() => bucketCalls() > before.bucket && objectCalls().length > before.objects, 'both requests again');
    expect(bucketCalls()).toBe(before.bucket + 1);
    expect(objectCalls().length).toBe(before.objects + 1);
  });

  it('speaks Turkish', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ locale: 'tr' });
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Dosyalar', 'Ayarlar', 'API']);
    expect(buttonByText('Yükle')).toBeTruthy();
    expect(q('a[aria-label="Doküman Deposu’na dön"]')).toBeTruthy();
    expect(text()).toContain('Bucket kökü');
    expect(q('input[placeholder="Dosyaları ada göre ara…"]')).toBeTruthy();
  });
});

describe('the tabs', () => {
  it('keep the open tab in the address; Files is the default and leaves no trace', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage();

    await click(tabs().find((tab) => tab.textContent === 'Settings'));
    expect(nav.store.replaces.at(-1)).toBe('/dashboard/files/docs?tab=settings');
    await waitFor(() => text().includes('General'), 'the Settings tab');
    expect(tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent).toBe('Settings');

    await click(tabs().find((tab) => tab.textContent === 'API'));
    expect(nav.store.replaces.at(-1)).toBe('/dashboard/files/docs?tab=api');
    await waitFor(() => text().includes('Connect from code'), 'the API tab');

    await click(tabs().find((tab) => tab.textContent === 'Files'));
    expect(nav.store.replaces.at(-1)).toBe('/dashboard/files/docs');
    await waitFor(() => rows().length > 0, 'the grid again');
  });

  it('open from the address, including the names of the tabs this page used to have', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'tab=settings', until: () => text().includes('General') });
    expect(tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent).toBe('Settings');
    await mounted!.unmount();

    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'tab=usage', until: () => text().includes('Connect from code') });
    expect(tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent).toBe('API');
    await mounted!.unmount();

    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'tab=overview', until: () => text().includes('General') });
    expect(tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent).toBe('Settings');
  });

  it('keep the folder and filters of the Files tab while another tab is open', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F&show=other' });
    await click(tabs().find((tab) => tab.textContent === 'Settings'));
    expect(nav.store.replaces.at(-1)).toBe('/dashboard/files/docs?path=reports%2F&show=other&tab=settings');
    await click(tabs().find((tab) => tab.textContent === 'Files'));
    expect(nav.store.replaces.at(-1)).toBe('/dashboard/files/docs?path=reports%2F&show=other');
  });
});

/* ── States that replace the page ────────────────────────────────────────── */

describe('before the bucket is there', () => {
  it('shows a loading skeleton with a label while the bucket loads', async () => {
    server = installBucketServer({ records: RECORDS });
    server.api.on('GET', '/api/files/buckets/docs', () => new Promise(() => undefined));
    client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    mounted = await mount(
      h(QueryClientProvider, { client }, h(DocsDrawerProvider, { value: { openDocs }, children: h(BucketPage, { bucketKey: 'docs' }) })),
    );
    await wait(30);
    const busy = q('[aria-busy="true"]');
    expect(busy).toBeTruthy();
    expect(busy!.textContent).toContain('Loading the bucket…');
    expect(q('h1')).toBeNull();
  });

  it('says so when the bucket does not exist, and links back to the Document Store', async () => {
    server = installBucketServer({ records: RECORDS });
    server.fail.bucket = refusal(404, 'Bucket not found', 'bucket_not_found');
    await openPage({ until: () => text().includes('Bucket not found') });
    expect(text()).toContain('This bucket does not exist or was deleted.');
    expect(buttonByText('Retry')).toBeUndefined();
    expect(buttonByText('Back to Document Store')?.getAttribute('href')).toBe('/dashboard/files');
  });

  it('says why a bucket could not be loaded, and tries again', async () => {
    server = installBucketServer({ records: RECORDS });
    server.fail.bucket = refusal(500, 'The database is down');
    await openPage({ until: () => text().includes('The bucket could not be loaded') });
    expect(q('[role="alert"]')?.textContent).toContain('The database is down');

    server.fail.bucket = undefined;
    await click(buttonByText('Retry'));
    await waitFor(() => q('h1')?.textContent === 'Docs', 'the page');
  });

  it('goes back to the list when the bucket vanishes after its files were being deleted', async () => {
    server = installBucketServer({ records: RECORDS, bucket: deletingBucket(MINUTE) });
    await openPage();
    expect(text()).toContain('This bucket is being deleted');

    // The job finishes: the next read says there is no such bucket.
    server.fail.bucket = refusal(404, 'Bucket not found', 'bucket_not_found');
    await click(buttonByText('Refresh'));
    await waitFor(() => nav.store.replaces.includes('/dashboard/files'), 'the redirect');
    expect(toasts().some((toast) => toast.message === 'Bucket “Docs” deleted')).toBe(true);
  });
});

/* ── Who may do what ─────────────────────────────────────────────────────── */

describe('someone who can only read', () => {
  it('sees the files but none of the controls that change them', async () => {
    server = installBucketServer({ level: 'read', records: RECORDS });
    await openPage({ search: 'path=reports%2F', until: () => rows().length > 0 });
    await waitFor(() => !buttonByText('Upload'), 'the write controls to go');

    expect(q('button[aria-label="More actions"]')).toBeNull();
    expect(text()).toContain('You have read-only access to the Document Store');
    expect(rowTexts().join(' ')).toContain('summary.pdf');

    await click(menuButton('summary.pdf'));
    expect(menuItems()).toEqual(['Download original', 'Download Markdown', 'Copy key']);
  });

  it('can still select files and download them, but not delete them', async () => {
    server = installBucketServer({ level: 'read', records: RECORDS });
    await openPage({ search: 'path=reports%2F2026%2F' });
    await waitFor(() => !buttonByText('Upload'), 'the write controls to go');

    await click(rowCheckbox('q1.pdf'));
    expect(bulkBar()?.textContent).toContain('1 selected');
    expect(buttonByText('Download as .zip')).toBeTruthy();
    expect(buttonByText('Delete…')).toBeUndefined();
  });

  it('is told, in an empty bucket, that nothing was uploaded yet — without a button to do it', async () => {
    server = installBucketServer({ level: 'read', records: [] });
    await openPage({ until: () => text().includes('This bucket has no files yet') });
    await waitFor(() => !text().includes('Upload files'), 'the buttons to go');
    expect(text()).toContain('Files uploaded to this bucket will appear here.');
    expect(buttonByText('Import from storage…')).toBeUndefined();
  });
});

describe('a disabled bucket', () => {
  it('can be browsed and downloaded from, but not changed, and offers to be enabled', async () => {
    server = installBucketServer({ records: RECORDS, bucket: bucketDetail({ status: 'disabled' }) });
    await openPage({ search: 'path=reports%2F' });

    expect(q('[role="note"]')?.textContent).toContain('This bucket is disabled. Its files can still be browsed and downloaded');
    expect(q('.detail-header')!.textContent).toContain('Disabled');
    expect(buttonByText('Upload')).toBeUndefined();
    expect(rowTexts().join(' ')).toContain('summary.pdf');

    // The header menu: no import, but the bucket can be enabled or deleted.
    await click(q('button[aria-label="More actions"]'));
    expect(menuItems()).toEqual(['Enable', 'Delete bucket…']);

    // The file menu: downloads and the key, no delete.
    await click(menuButton('summary.pdf'));
    expect(menuItems()).not.toContain('Delete…');
    expect(menuItems()).toContain('Download original');
  });

  it('is enabled from the banner', async () => {
    server = installBucketServer({ records: RECORDS, bucket: bucketDetail({ status: 'disabled' }) });
    await openPage();

    await click(buttonByText('Enable bucket'));
    await waitFor(() => server.api.to('PATCH', '/api/files/buckets/docs').length === 1, 'the PATCH');
    expect(server.api.to('PATCH', '/api/files/buckets/docs')[0]!.body).toEqual({ status: 'active' });
    await waitFor(() => !text().includes('This bucket is disabled.'), 'the banner to go');
    expect(toasts().at(-1)).toMatchObject({ color: 'green', message: 'Docs accepts uploads again.' });
    expect(buttonByText('Upload')).toBeTruthy();
  });

  it('offers no import for it (the server would refuse it) even to someone who may write', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ status: 'disabled', stats: { fileCount: 0, totalBytes: 0 } }) });
    await openPage({ until: () => text().includes('This bucket has no files yet') });
    expect(buttonByText('Upload files')).toBeUndefined();
    expect(buttonByText('Import from storage…')).toBeUndefined();
  });
});

describe('a bucket whose files are being deleted', () => {
  it('takes no changes: a banner says so, and neither the actions nor the file menus offer any', async () => {
    server = installBucketServer({ records: RECORDS, bucket: deletingBucket(MINUTE) });
    await openPage();

    expect(q('[role="status"]')?.textContent).toContain('This bucket is being deleted');
    expect(q('.detail-header')!.textContent).toContain('Deleting…');
    expect(buttonByText('Upload')).toBeUndefined();
    expect(q('button[aria-label="More actions"]')).toBeNull();
    expect(buttonByText('Enable bucket')).toBeUndefined();
    expect(buttonByText('Refresh')).toBeTruthy();
    // A run that has only just been asked for is not offered again.
    expect(buttonByText('Delete again')).toBeUndefined();
  });

  describe('whose job was most likely lost', () => {
    it('offers to run it again from the page’s notice, on the Files tab too, and nothing else', async () => {
      server = installBucketServer({ records: RECORDS, bucket: deletingBucket(2 * HOUR) });
      await openPage();

      expect(text()).toContain('The deletion has not finished for a while.');
      expect(buttonByText('Delete again')).toBeTruthy();
      expect(q('.detail-header')!.textContent).toContain('Deleting…');
      expect(buttonByText('Upload')).toBeUndefined();
      expect(q('button[aria-label="More actions"]')).toBeNull();
      expect(buttonByText('Enable bucket')).toBeUndefined();
    });

    it('asks the delete dialog, which runs it with the files, and then waits as before', async () => {
      server = installBucketServer({ records: RECORDS, bucket: deletingBucket(2 * HOUR) });
      server.deleteAnswer = () => jsonResponse({ status: 'deleting' }, 202);
      await openPage();

      await click(buttonByText('Delete again'));
      expect(modalOpen('delete-bucket-modal')).toBe(true);
      await click(q('[data-testid="delete-bucket-confirm"]'));
      await waitFor(() => server.api.to('DELETE', '/api/files/buckets/docs').length === 1, 'the DELETE');
      expect(server.api.to('DELETE', '/api/files/buckets/docs')[0]!.query).toEqual({ deleteFiles: 'true' });
      await waitFor(() => !modalOpen('delete-bucket-modal'), 'the dialog to close');
      expect(nav.store.pushes).toEqual([]);
    });

    it('is not offered to someone who can only read', async () => {
      server = installBucketServer({ level: 'read', records: RECORDS, bucket: deletingBucket(2 * HOUR) });
      await openPage();
      await waitFor(() => text().includes('read-only access'), 'the read-only notice');
      expect(text()).toContain('The deletion has not finished for a while.');
      expect(buttonByText('Delete again')).toBeUndefined();
    });
  });
});

describe('a bucket whose delete stopped with an error', () => {
  const REASON = 'The provider refused the credentials';

  it('says so in the header and in a notice with the reason, and keeps the actions of a bucket that is not being deleted', async () => {
    server = installBucketServer({ records: RECORDS, bucket: failedDeleteBucket(REASON) });
    await openPage();

    expect(q('.detail-header')!.textContent).toContain('Deletion failed');
    expect(q('[role="alert"]')!.textContent).toContain('Deleting this bucket did not finish');
    expect(q('[role="alert"]')!.textContent).toContain(REASON);
    expect(buttonByText('Try again')).toBeTruthy();
    expect(buttonByText('Keep the bucket')).toBeTruthy();
    // It is a bucket like any other disabled one: the menu is there, to enable it or delete it.
    await click(q('button[aria-label="More actions"]'));
    expect(menuItems()).toContain('Delete bucket…');
  });

  it('opens the delete dialog from “Try again”, with the reason, and deletes with the files when told to', async () => {
    server = installBucketServer({ records: RECORDS, bucket: failedDeleteBucket(REASON) });
    server.deleteAnswer = () => jsonResponse({ status: 'deleting' }, 202);
    await openPage();

    await click(buttonByText('Try again'));
    expect(modalOpen('delete-bucket-modal')).toBe(true);
    expect(q('[data-testid="delete-bucket-modal"]')!.textContent).toContain(REASON);
    await click(q('input[type="radio"][value="files"]'));
    await click(q('[data-testid="delete-bucket-confirm"]'));
    await waitFor(() => server.api.to('DELETE', '/api/files/buckets/docs').length === 1, 'the DELETE');
    expect(server.api.to('DELETE', '/api/files/buckets/docs')[0]!.query).toEqual({ deleteFiles: 'true' });
  });

  it('keeps the bucket: it is switched on again and the notice goes', async () => {
    server = installBucketServer({ records: RECORDS, bucket: failedDeleteBucket(REASON) });
    await openPage();

    await click(buttonByText('Keep the bucket'));
    await waitFor(() => server.api.to('PATCH', '/api/files/buckets/docs').length === 1, 'the PATCH');
    expect(server.api.to('PATCH', '/api/files/buckets/docs')[0]!.body).toEqual({ status: 'active' });
    await waitFor(() => !text().includes('Deleting this bucket did not finish'), 'the notice to go');
    expect(q('.detail-header')!.textContent).not.toContain('Deletion failed');
    expect(toasts().at(-1)).toMatchObject({ color: 'green', message: 'Docs is kept and switched on again.' });
    expect(buttonByText('Upload')).toBeTruthy();
  });

  it('speaks Turkish', async () => {
    server = installBucketServer({ records: RECORDS, bucket: failedDeleteBucket(REASON) });
    await openPage({ locale: 'tr' });
    expect(q('.detail-header')!.textContent).toContain('Silme başarısız');
    expect(text()).toContain('Bu bucket’ın silinmesi tamamlanmadı');
  });
});

describe('the header menu', () => {
  it('disables the bucket, and says what happens to its files', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage();

    await click(q('button[aria-label="More actions"]'));
    expect(menuItems()).toEqual(['Disable', 'Import from storage…', 'Delete bucket…']);
    await click(menuItem('Disable'));
    await waitFor(() => server.api.to('PATCH', '/api/files/buckets/docs').length === 1, 'the PATCH');
    expect(server.api.to('PATCH', '/api/files/buckets/docs')[0]!.body).toEqual({ status: 'disabled' });
    await waitFor(() => toasts().length > 0, 'a notification');
    expect(toasts().at(-1)).toMatchObject({ color: 'green', message: 'Docs keeps its files readable and accepts nothing new.' });
    await waitFor(() => text().includes('This bucket is disabled.'), 'the banner');
  });

  it('shows the server’s refusal, with the agents it names, when an agent keeps its files in the bucket', async () => {
    server = installBucketServer({ records: RECORDS });
    const reason = 'The bucket "docs" is where this agent keeps session files: Support. Choose another bucket in its Files settings.';
    server.fail.patch = refusal(409, reason, 'bucket_in_use', { agents: [{ key: 'support', name: 'Support' }, { key: 'sales' }] });
    await openPage();

    await click(q('button[aria-label="More actions"]'));
    await click(menuItem('Disable'));
    await waitFor(() => toasts().length > 0, 'the refusal');
    expect(toasts().at(-1)).toMatchObject({ color: 'red', title: 'Unable to update bucket', message: `${reason} (sales)` });
    expect(text()).not.toContain('This bucket is disabled.');
  });

  it('opens the import dialog and the delete dialog', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage();

    await click(q('button[aria-label="More actions"]'));
    await click(menuItem('Import from storage…'));
    expect(modalOpen('import-modal')).toBe(true);
    await click(buttonByText('Cancel'));
    await waitFor(() => !modalOpen('import-modal'), 'the import dialog to close');

    await click(q('button[aria-label="More actions"]'));
    await click(menuItem('Delete bucket…'));
    expect(modalOpen('delete-bucket-modal')).toBe(true);
  });
});

/* ── The Files tab ───────────────────────────────────────────────────────── */

describe('the files of a folder', () => {
  it('lists the sub-folders first, then the files, each with its size, type, Markdown state and age', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage();

    expect(rows()).toHaveLength(4);
    const texts = rowTexts();
    expect(texts[0]).toContain('agent-sessions');
    expect(texts[0]).toContain('Folder');
    expect(texts[1]).toContain('photos');
    expect(texts[2]).toContain('reports');
    expect(texts[3]).toContain('root.txt');
    expect(texts[3]).toContain(formatBytes(100));
    expect(texts[3]).toContain('Text');
    // The request is for the root folder, 50 at a time.
    expect(lastListing()).toMatchObject({ prefix: '', limit: '50' });
    expect(q('nav[aria-label="Folder path"]')!.textContent).toContain('Bucket root');
    expect(text()).toContain('Showing 1 file');
  });

  it('shows what a file’s Markdown copy is doing, and why a conversion failed', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F2026%2F' });

    const failed = rowOf('q1.pdf')!;
    expect(failed.textContent).toContain('Failed');
    expect(q('button[aria-label="The Markdown conversion failed: The PDF is password protected."]', failed)).toBeTruthy();
    expect(rowOf('q2.pdf')!.textContent).not.toContain('Failed');
    await mounted!.unmount();

    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F' });
    expect(rowOf('summary.pdf')!.textContent).toContain('Ready');
    expect(rowOf('summary.pdf')!.textContent).toContain('PDF');
    expect(rowOf('summary.pdf')!.textContent).toContain(formatBytes(4 * MIB));
  });

  it('marks session files, and shows their session, expiry and uploader only when there are some', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage();
    // No session file in the root: no session columns.
    expect(qa('th').map((th) => th.textContent)).not.toContain('Session');
    await mounted!.unmount();

    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=agent-sessions%2Fsupport%2Fs1%2F' });
    const headers = qa('th').map((th) => th.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Session', 'Expires', 'Uploaded by']));
    const row = rowOf('note.txt')!;
    expect(row.textContent).toContain('Session file');
    expect(row.textContent).toContain('Ada Lovelace');
    expect(row.textContent).toContain('in 3 days');
    expect(q('a[href="/dashboard/agents/agent-1/sessions/s1"]', row)?.textContent).toBe('support · s1');
  });

  it('draws only the files that match, with the folder they sit in, when searching', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'q=q' });
    expect(lastListing()).toMatchObject({ prefix: '', search: 'q' });
    expect(rows()).toHaveLength(2);
    expect(rowTexts().join('|')).toContain('reports/2026/');
    // A flat list has no folder rows, and says it looks below the folder.
    expect(rowTexts().join('|')).not.toContain('Folder');
    expect(text()).toContain('Matches from Bucket root and its sub-folders are shown as one list.');
  });

  it('every control in the grid has a name a screen reader can say', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F' });
    const grid = q('.ds-card')!;
    const unnamed = qa<HTMLElement>('button, input, select', grid).filter((control) => {
      const name =
        control.getAttribute('aria-label') ||
        control.textContent?.trim() ||
        control.getAttribute('placeholder') ||
        (control.id ? document.querySelector(`label[for="${control.id}"]`)?.textContent : '');
      return !name;
    });
    expect(unnamed.map((control) => control.outerHTML)).toEqual([]);
    expect(menuButton('summary.pdf')).toBeTruthy();
    expect(rowCheckbox('summary.pdf')).toBeTruthy();
  });
});

describe('the folder, search and filters in the address', () => {
  it('start from the address: the request, the box, the selects and the path all follow it', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F&q=sum&type=pdf&show=other' });

    expect(lastListing()).toMatchObject({ prefix: 'reports/', search: 'sum', type: 'pdf', purpose: 'other', limit: '50' });
    expect(searchBox().value).toBe('sum');
    expect(typeSelect()!.value).toBe('pdf');
    expect(showSelect()!.value).toBe('other');
    expect(q('nav[aria-label="Folder path"]')!.textContent).toContain('reports');
    expect(text()).toContain('Matches from reports/ and its sub-folders are shown as one list.');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain('summary.pdf');
  });

  it('push a folder onto the history, so Back returns to the folder before', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage();

    await click(q('button[aria-label="Open folder reports"]'));
    expect(nav.store.pushes.at(-1)).toBe('/dashboard/files/docs?path=reports%2F');
    expect(nav.store.replaces).toEqual([]);
    await waitFor(() => lastListing().prefix === 'reports/' && rowOf('summary.pdf') !== undefined, 'the folder');
    expect(rowTexts().map((row) => row.slice(0, 4))).toEqual(expect.arrayContaining(['2026', 'summ'].map((start) => expect.stringContaining(start))));

    await click(q('button[aria-label="Open folder 2026"]'));
    expect(nav.store.pushes.at(-1)).toBe('/dashboard/files/docs?path=reports%2F2026%2F');
    await waitFor(() => rowOf('q1.pdf') !== undefined, 'the sub-folder');

    // The path above the list: up one level, or any crumb.
    await click(q('button[aria-label="Up one folder"]'));
    expect(nav.store.pushes.at(-1)).toBe('/dashboard/files/docs?path=reports%2F');
    await waitFor(() => rowOf('summary.pdf') !== undefined, 'the parent folder');
    await click(qa('nav[aria-label="Folder path"] button').find((crumb) => crumb.textContent?.includes('Bucket root')));
    expect(nav.store.pushes.at(-1)).toBe('/dashboard/files/docs');
    await waitFor(() => rowOf('root.txt') !== undefined, 'the root');
    expect(q('button[aria-label="Up one folder"]')).toBeNull();
  });

  it('replace, not push, for a search or a filter, and the search waits for the person to stop typing', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage();
    const before = objectCalls().length;

    await setInput(searchBox(), 'q1');
    await wait(SEARCH_DEBOUNCE_MS / 3);
    // Still typing: nothing in the address, no new request.
    expect(nav.store.replaces).toEqual([]);
    expect(objectCalls().length).toBe(before);

    await wait(SEARCH_DEBOUNCE_MS + 100);
    expect(nav.store.replaces.at(-1)).toBe('/dashboard/files/docs?q=q1');
    expect(nav.store.pushes).toEqual([]);
    await waitFor(() => lastListing().search === 'q1', 'the search request');
    await waitFor(() => rows().length === 1, 'the match');
    expect(rows()[0]!.textContent).toContain('q1.pdf');

    // Clearing the box takes it out of the address again.
    await setInput(searchBox(), '');
    await wait(SEARCH_DEBOUNCE_MS + 100);
    expect(nav.store.replaces.at(-1)).toBe('/dashboard/files/docs');
  });

  it('filter by type and by session files, each in its own parameter, and take it out again', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage();

    await choose(typeSelect(), 'image');
    expect(nav.store.replaces.at(-1)).toBe('/dashboard/files/docs?type=image');
    await waitFor(() => lastListing().type === 'image' && rows().length === 1, 'the images');
    expect(rows()[0]!.textContent).toContain('logo.png');
    expect(rows()[0]!.textContent).toContain('Image');

    await choose(showSelect(), 'session');
    expect(nav.store.replaces.at(-1)).toBe('/dashboard/files/docs?type=image&show=session');
    await waitFor(() => lastListing().purpose === 'conversation', 'the session request');

    await choose(typeSelect(), 'all');
    await choose(showSelect(), 'all');
    expect(nav.store.replaces.at(-1)).toBe('/dashboard/files/docs');
  });

  it('follow the address when it changes on its own, as it does when the person goes Back', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'q=q1&type=pdf' });
    expect(searchBox().value).toBe('q1');

    await navigateOutside('');
    await waitFor(() => searchBox().value === '' && lastListing().search === undefined, 'the box and the listing to follow');
    expect(typeSelect()!.value).toBe('all');
    // Following the address is not a change of its own: nothing is written back.
    expect(nav.store.replaces).toEqual([]);
  });

  it('offer to clear the filters when nothing matches, and keep the folder', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F&q=zzz' });
    expect(text()).toContain('No files match');
    expect(text()).toContain('No file matches the current search and filters.');

    await click(buttonByText('Clear filters'));
    expect(nav.store.replaces.at(-1)).toBe('/dashboard/files/docs?path=reports%2F');
    await waitFor(() => rowOf('summary.pdf') !== undefined, 'the folder’s files');
  });
});

describe('Load more', () => {
  it('asks for the next page with the cursor and adds it to the list', async () => {
    server = installBucketServer({ records: manyFiles(60) });
    await openPage();

    expect(rows()).toHaveLength(50);
    expect(text()).toContain('Showing 50 files');
    expect(objectCalls().at(-1)!.query.cursor).toBeUndefined();

    await click(buttonByText('Load more'));
    await waitFor(() => rows().length === 60, 'the next page');
    expect(objectCalls().at(-1)!.query.cursor).toBe('50');
    expect(text()).toContain('Showing 60 files');
    expect(buttonByText('Load more')).toBeUndefined();
  });
});

describe('opening a file', () => {
  it('opens the drawer for the row that was clicked, by the file’s key', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F' });
    expect(drawerKey()).toBeNull();

    await click(rowOf('summary.pdf'));
    expect(drawerKey()).toBe('reports/summary.pdf');
  });

  it('opens it from the name too, and not from the checkbox or the menu', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F' });

    await click(rowCheckbox('summary.pdf'));
    await click(menuButton('summary.pdf'));
    expect(drawerKey()).toBeNull();
    await click(menuItem('Copy key'));
    expect(drawerKey()).toBeNull();

    await click(qa('button', rowOf('summary.pdf')!).find((button) => button.textContent === 'summary.pdf'));
    expect(drawerKey()).toBe('reports/summary.pdf');
  });

  it('closes the drawer when the drawer deletes the file, and leaves the refresh to the delete', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F2026%2F' });
    await click(rowOf('q2.pdf'));
    expect(drawerKey()).toBe('reports/2026/q2.pdf');

    const props = stubs.drawer.mock.calls.at(-1)![0] as DrawerProps;
    const before = { objects: objectCalls().length, bucket: server.api.to('GET', '/api/files/buckets/docs').length };
    await act(async () => props.onDeleted('reports/2026/q2.pdf'));
    expect(drawerKey()).toBeNull();
    await wait(60);
    // The drawer's delete has already refreshed the lists (see files-bucket-integration-ui.test.ts): asking again is waste.
    expect(objectCalls().length).toBe(before.objects);
    expect(server.api.to('GET', '/api/files/buckets/docs').length).toBe(before.bucket);
  });
});

describe('the open file in the address', () => {
  const lastDrawerProps = () => stubs.drawer.mock.calls.at(-1)![0] as DrawerProps;

  it('opens the drawer for the file a link names, with the folder it is in still listed behind it', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F&file=reports%2Fsummary.pdf' });

    expect(drawerKey()).toBe('reports/summary.pdf');
    expect(rowOf('summary.pdf')).toBeTruthy();
    expect(lastListing().prefix).toBe('reports/');
    expect(lastListing()).not.toHaveProperty('file');
  });

  it('puts the file in the address, as a new history entry, when a row is opened', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F' });

    await click(rowOf('summary.pdf'));
    expect(nav.store.pushes.at(-1)).toBe('/dashboard/files/docs?path=reports%2F&file=reports%2Fsummary.pdf');
    expect(drawerKey()).toBe('reports/summary.pdf');
    // Opening a file is not a new listing: the folder is not asked for again.
    expect(new Set(objectCalls().map((call) => call.query.prefix))).toEqual(new Set(['reports/']));
  });

  it('takes the entry off again when the drawer is closed from the drawer, instead of stacking another', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F' });
    await click(rowOf('summary.pdf'));

    await act(async () => lastDrawerProps().onClose());
    expect(drawerKey()).toBeNull();
    expect(nav.store.search).toBe('path=reports%2F');
    expect(nav.store.replaces).toEqual([]);
    expect(nav.store.before).toEqual([]);

    // Again: every opening is a fresh entry and every closing takes it off.
    await click(rowOf('summary.pdf'));
    expect(drawerKey()).toBe('reports/summary.pdf');
    await act(async () => lastDrawerProps().onClose());
    expect(drawerKey()).toBeNull();
    expect(nav.store.before).toEqual([]);
  });

  it('follows the Back button: the address without the file closes the drawer', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F' });
    await click(rowOf('summary.pdf'));
    expect(drawerKey()).toBe('reports/summary.pdf');

    await navigateOutside('path=reports%2F');
    expect(drawerKey()).toBeNull();

    // Opened again after Back, the drawer is a fresh entry once more.
    await click(rowOf('summary.pdf'));
    await act(async () => lastDrawerProps().onClose());
    expect(drawerKey()).toBeNull();
    expect(nav.store.search).toBe('path=reports%2F');
  });

  it('drops the file from the address when the drawer came with the address and is closed', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F&q=summary&file=reports%2Fsummary.pdf' });
    expect(drawerKey()).toBe('reports/summary.pdf');

    await act(async () => lastDrawerProps().onClose());
    expect(drawerKey()).toBeNull();
    expect(nav.store.replaces.at(-1)).toBe('/dashboard/files/docs?path=reports%2F&q=summary');
    expect(nav.store.pushes).toEqual([]);
  });

  it('closes the drawer of a file that was deleted from it, and the folder stays in the address', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F2026%2F&file=reports%2F2026%2Fq2.pdf' });
    expect(drawerKey()).toBe('reports/2026/q2.pdf');

    await act(async () => lastDrawerProps().onDeleted('reports/2026/q2.pdf'));
    expect(drawerKey()).toBeNull();
    expect(nav.store.search).toBe('path=reports%2F2026%2F');
    expect(rowOf('q1.pdf')).toBeTruthy();
  });

  it('keeps a file of the address that is not a file: the drawer opens and says so', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'file=nowhere%2Fmissing.pdf' });
    expect(drawerKey()).toBe('nowhere/missing.pdf');
  });

  it('ignores the file on the other tabs, and leaving the Files tab drops it', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'tab=settings&file=reports%2Fsummary.pdf', until: () => text().includes('General') });
    expect(drawerKey()).toBeNull();
    await mounted!.unmount();

    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F&file=reports%2Fsummary.pdf' });
    expect(drawerKey()).toBe('reports/summary.pdf');
    await click(tabs().find((tab) => tab.textContent === 'Settings'));
    expect(nav.store.replaces.at(-1)).toBe('/dashboard/files/docs?path=reports%2F&tab=settings');
    expect(drawerKey()).toBeNull();
  });
});

describe('the menu of a file', () => {
  it('has the original, the Markdown copy (only for a file that has one), the key and Delete…', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F' });

    await click(menuButton('summary.pdf'));
    expect(menuItems()).toEqual(['Download original', 'Download Markdown', 'Copy key', 'Delete…']);
    await click(menuItem('Copy key'));
    await waitFor(MENU_NOT_OPEN, 'the menu to close');

    await click(q('button[aria-label="Open folder 2026"]'));
    await waitFor(() => rowOf('q2.pdf') !== undefined, 'the sub-folder');
    await click(menuButton('q2.pdf'));
    expect(menuItems()).toEqual(['Download original', 'Copy key', 'Delete…']);
  });

  it('offers the Markdown copy a file still has while its last conversion failed or runs again, and none it never had', async () => {
    // The server keeps the earlier copy through a conversion that is asked for again, whatever becomes of that run.
    const keepsCopy = (name: string, markdownStatus: 'failed' | 'pending' | 'skipped') =>
      fileRecord(`reports/${name}.pdf`, { markdownStatus, markdownKey: `reports/${name}.md`, markdownSize: 400 });
    server = installBucketServer({
      records: [
        keepsCopy('failed-again', 'failed'),
        keepsCopy('running-again', 'pending'),
        keepsCopy('skipped-now', 'skipped'),
        fileRecord('reports/never.pdf', { markdownStatus: 'failed', markdownError: 'The PDF is password protected.' }),
      ],
    });
    await openPage({ search: 'path=reports%2F' });

    for (const name of ['failed-again.pdf', 'running-again.pdf', 'skipped-now.pdf']) {
      await click(menuButton(name));
      expect(menuItems()).toEqual(['Download original', 'Download Markdown', 'Copy key', 'Delete…']);
      await click(menuItem('Copy key'));
      await waitFor(MENU_NOT_OPEN, 'the menu to close');
    }
    await click(menuButton('never.pdf'));
    expect(menuItems()).toEqual(['Download original', 'Copy key', 'Delete…']);
  });

  it('downloads the original under its name, and the Markdown copy under the Markdown name', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F' });

    await click(menuButton('summary.pdf'));
    await click(menuItem('Download original'));
    await waitFor(() => saved.saveBlob.mock.calls.length === 1, 'the download');
    const download = server.api.calls.find((call) => call.path === '/api/files/buckets/docs/objects/reports/summary.pdf')!;
    expect(download.query).toMatchObject({ download: 'original', variant: 'original' });
    expect(saved.saveBlob.mock.calls[0]![0]).toBeInstanceOf(Blob);
    expect(saved.saveBlob.mock.calls[0]![1]).toBe('summary.pdf');

    await click(menuButton('summary.pdf'));
    await click(menuItem('Download Markdown'));
    await waitFor(() => saved.saveBlob.mock.calls.length === 2, 'the Markdown download');
    expect(server.api.calls.at(-1)!.query).toMatchObject({ download: 'markdown', variant: 'markdown' });
    expect(saved.saveBlob.mock.calls[1]![1]).toBe('summary.md');
  });

  it('tells the person when a download fails', async () => {
    server = installBucketServer({ records: RECORDS });
    server.api.on('GET', /^\/api\/files\/buckets\/docs\/objects\/.+$/, () => refusal(404, 'File not found'));
    await openPage({ search: 'path=reports%2F' });

    await click(menuButton('summary.pdf'));
    await click(menuItem('Download original'));
    await waitFor(() => toasts().length > 0, 'a notification');
    expect(toasts().at(-1)).toMatchObject({ color: 'red', title: 'The download failed', message: 'This item no longer exists.' });
    expect(saved.saveBlob).not.toHaveBeenCalled();
  });

  it('copies the key', async () => {
    server = installBucketServer({ records: RECORDS });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await openPage({ search: 'path=reports%2F' });

    await click(menuButton('summary.pdf'));
    await click(menuItem('Copy key'));
    await waitFor(() => toasts().length > 0, 'a notification');
    expect(writeText).toHaveBeenCalledWith('reports/summary.pdf');
    expect(toasts().at(-1)).toMatchObject({ color: 'teal', message: 'Key copied' });
  });

  it('says so when the key cannot be copied', async () => {
    server = installBucketServer({ records: RECORDS });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    await openPage({ search: 'path=reports%2F' });

    await click(menuButton('summary.pdf'));
    await click(menuItem('Copy key'));
    await waitFor(() => toasts().length > 0, 'a notification');
    expect(toasts().at(-1)).toMatchObject({ color: 'red', message: 'The key could not be copied to the clipboard.' });
  });

  it('asks before deleting one file, then deletes it by key', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F2026%2F' });

    await click(menuButton('q1.pdf'));
    await click(menuItem('Delete…'));
    const dialog = q('[data-testid="delete-files-modal"]')!;
    expect(dialog.textContent).toContain('Delete file');
    expect(dialog.textContent).toContain('Delete “q1.pdf”?');
    expect(dialog.textContent).toContain('This cannot be undone.');
    // Asking is not deleting.
    expect(server.api.to('POST', '/api/files/buckets/docs/objects/batch-delete')).toHaveLength(0);

    await click(q('[data-testid="delete-files-confirm"]'));
    await waitFor(() => server.api.to('POST', '/api/files/buckets/docs/objects/batch-delete').length === 1, 'the delete');
    expect(server.api.to('POST', '/api/files/buckets/docs/objects/batch-delete')[0]!.body).toEqual({ keys: ['reports/2026/q1.pdf'] });
    await waitFor(() => !modalOpen('delete-files-modal'), 'the dialog to close');
    expect(toasts().at(-1)).toMatchObject({ color: 'green', message: 'File deleted' });
    await waitFor(() => rowOf('q1.pdf') === undefined, 'the file to leave the list');
  });

  it('leaves the file alone when the question is cancelled', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F2026%2F' });

    await click(menuButton('q1.pdf'));
    await click(menuItem('Delete…'));
    await click(buttonByText('Cancel'));
    await waitFor(() => !modalOpen('delete-files-modal'), 'the dialog to close');
    expect(server.api.to('POST', '/api/files/buckets/docs/objects/batch-delete')).toHaveLength(0);
    expect(rowOf('q1.pdf')).toBeTruthy();
  });
});

describe('several files at once', () => {
  it('shows a bar with the count once files are selected, and the header box selects the files of the list', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F2026%2F' });
    expect(bulkBar()).toBeNull();

    await click(rowCheckbox('q1.pdf'));
    expect(bulkBar()?.textContent).toContain('1 selected');
    expect(selectAll()!.indeterminate).toBe(true);
    expect(rowOf('q1.pdf')!.className).toContain('selected');

    await click(selectAll());
    expect(bulkBar()?.textContent).toContain('2 selected');
    expect(selectAll()!.checked).toBe(true);

    await click(selectAll());
    expect(bulkBar()).toBeNull();
    await click(rowCheckbox('q1.pdf'));
    await click(q('button[aria-label="Clear selection"]'));
    expect(bulkBar()).toBeNull();
    expect(rowCheckbox('q1.pdf')!.checked).toBe(false);
  });

  it('does not select folders, and starts again in another folder', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F' });
    // The folder row has no checkbox; the select-all box counts the files only.
    expect(qa('input[type="checkbox"]', rowOf('2026')!)).toHaveLength(0);
    await click(selectAll());
    expect(bulkBar()?.textContent).toContain('1 selected');

    await click(q('button[aria-label="Open folder 2026"]'));
    await waitFor(() => rowOf('q1.pdf') !== undefined, 'the sub-folder');
    expect(bulkBar()).toBeNull();
  });

  it('downloads the selection as one zip', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F2026%2F' });

    await click(selectAll());
    await click(buttonByText('Download as .zip'));
    await waitFor(() => saved.saveBlob.mock.calls.length === 1, 'the zip');
    const archive = server.api.to('POST', '/api/files/buckets/docs/objects/archive');
    expect(archive).toHaveLength(1);
    expect(archive[0]!.body).toEqual({ keys: ['reports/2026/q1.pdf', 'reports/2026/q2.pdf'] });
    expect(saved.saveBlob.mock.calls[0]![1]).toBe('docs-files.zip');
  });

  it('cannot download more than 50 as a zip, and says why', async () => {
    server = installBucketServer({ records: manyFiles(60) });
    await openPage();

    await click(selectAll());
    expect(bulkBar()?.textContent).toContain('50 selected');
    expect(buttonByText('Download as .zip')!.disabled).toBe(false);

    await click(buttonByText('Load more'));
    await waitFor(() => rows().length === 60, 'the next page');
    await click(selectAll());
    expect(bulkBar()?.textContent).toContain('60 selected');
    expect(buttonByText('Download as .zip')!.disabled).toBe(true);
    expect(server.api.to('POST', '/api/files/buckets/docs/objects/archive')).toHaveLength(0);
  });

  it('asks before deleting them, then deletes them in one request and clears the selection', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=reports%2F2026%2F' });

    await click(selectAll());
    await click(buttonByText('Delete…'));
    const dialog = q('[data-testid="delete-files-modal"]')!;
    expect(dialog.textContent).toContain('Delete files');
    expect(dialog.textContent).toContain('Delete 2 files?');
    expect(server.api.to('POST', '/api/files/buckets/docs/objects/batch-delete')).toHaveLength(0);

    await click(q('[data-testid="delete-files-confirm"]'));
    await waitFor(() => !modalOpen('delete-files-modal'), 'the dialog to close');
    const requests = server.api.to('POST', '/api/files/buckets/docs/objects/batch-delete');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({ keys: ['reports/2026/q1.pdf', 'reports/2026/q2.pdf'] });
    expect(toasts().at(-1)).toMatchObject({ color: 'green', message: '2 files deleted' });
    expect(bulkBar()).toBeNull();
    await waitFor(() => text().includes('This folder has no files.'), 'the empty folder');
  });

  it('sends more than 100 files in turns of 100', async () => {
    server = installBucketServer({ records: manyFiles(120) });
    await openPage();
    await click(buttonByText('Load more'));
    await waitFor(() => rows().length === 100, 'the second page');
    await click(buttonByText('Load more'));
    await waitFor(() => rows().length === 120, 'the third page');

    await click(selectAll());
    expect(bulkBar()?.textContent).toContain('120 selected');
    await click(buttonByText('Delete…'));
    await click(q('[data-testid="delete-files-confirm"]'));
    await waitFor(() => !modalOpen('delete-files-modal'), 'the dialog to close');

    const requests = server.api.to('POST', '/api/files/buckets/docs/objects/batch-delete');
    expect(requests.map((request) => (request.body as { keys: string[] }).keys.length)).toEqual([100, 20]);
    expect(toasts().at(-1)).toMatchObject({ message: '120 files deleted' });
  });

  it('lists the files that could not be deleted, with the reason, and keeps them selected', async () => {
    server = installBucketServer({ records: RECORDS });
    server.refuse.set('reports/2026/q2.pdf', 'The file is in use.');
    await openPage({ search: 'path=reports%2F2026%2F' });

    await click(selectAll());
    await click(buttonByText('Delete…'));
    await click(q('[data-testid="delete-files-confirm"]'));
    await waitFor(() => Boolean(q('[data-testid="delete-files-close"]')), 'the result');

    const dialog = q('[data-testid="delete-files-modal"]')!;
    expect(dialog.textContent).toContain('1 deleted, 1 could not be deleted.');
    const list = q('ul[aria-label="Files that were not deleted"]', dialog)!;
    expect(list.textContent).toContain('reports/2026/q2.pdf');
    expect(list.textContent).toContain('The file is in use.');
    expect(toasts().filter((toast) => toast.color === 'green')).toHaveLength(0);

    await click(q('[data-testid="delete-files-close"]'));
    await waitFor(() => !modalOpen('delete-files-modal'), 'the dialog to close');
    await waitFor(() => rowOf('q1.pdf') === undefined, 'the deleted file to leave');
    expect(bulkBar()?.textContent).toContain('1 selected');
    expect(rowCheckbox('q2.pdf')!.checked).toBe(true);
  });

  it('says that nothing could be deleted when the whole request fails', async () => {
    server = installBucketServer({ records: RECORDS });
    server.api.on('POST', /batch-delete$/, () => refusal(403, 'Forbidden'));
    await openPage({ search: 'path=reports%2F2026%2F' });

    await click(selectAll());
    await click(buttonByText('Delete…'));
    await click(q('[data-testid="delete-files-confirm"]'));
    await waitFor(() => Boolean(q('[data-testid="delete-files-close"]')), 'the result');
    const dialog = q('[data-testid="delete-files-modal"]')!;
    expect(dialog.textContent).toContain('None of the 2 files could be deleted.');
    expect(dialog.textContent).toContain('You do not have permission to do this.');
    expect(rowOf('q1.pdf')).toBeTruthy();
  });
});

describe('uploading', () => {
  it('opens the upload screen for the bucket root, or the folder that is open', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage();
    expect(uploadFolder()).toBeNull();

    await click(buttonByText('Upload'));
    expect(uploadFolder()).toBe('');
    const opened = stubs.upload.mock.calls.at(-1)![0] as UploadProps;
    expect(opened.opened).toBe(true);
    await act(async () => opened.onClose());
    expect(uploadFolder()).toBeNull();

    await click(q('button[aria-label="Open folder reports"]'));
    await waitFor(() => rowOf('summary.pdf') !== undefined, 'the folder');
    await click(buttonByText('Upload'));
    expect(uploadFolder()).toBe('reports/');
  });

  it('offers to upload into an empty folder', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=nothing-here%2F', until: () => text().includes('This folder has no files.') });
    await click(buttonByText('Upload here'));
    expect(uploadFolder()).toBe('nothing-here/');
  });
});

describe('an empty or failed list', () => {
  it('invites an empty bucket to be filled: upload, or import what is already in the storage', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 0, totalBytes: 0 } }) });
    await openPage({ until: () => text().includes('This bucket has no files yet') });

    expect(text()).toContain('Upload files to start, or import the objects that are already in the storage provider.');
    await click(buttonByText('Upload files'));
    expect(uploadFolder()).toBe('');
    await act(async () => (stubs.upload.mock.calls.at(-1)![0] as UploadProps).onClose());

    await click(buttonByText('Import from storage…'));
    expect(modalOpen('import-modal')).toBe(true);
  });

  it('says an empty folder is empty, but an empty bucket only at the root', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'path=photos%2Fnone%2F', until: () => text().includes('This folder has no files.') });
    expect(text()).not.toContain('This bucket has no files yet');
    expect(q('nav[aria-label="Folder path"]')!.textContent).toContain('none');
  });

  it('shows why the files could not be loaded, and loads them on Retry', async () => {
    server = installBucketServer({ records: RECORDS });
    server.fail.objects = refusal(500, 'The storage provider timed out');
    await openPage({ until: () => text().includes('The files could not be loaded') });
    expect(q('[role="alert"]')?.textContent).toContain('The storage provider timed out');
    expect(rows()).toHaveLength(0);

    server.fail.objects = undefined;
    await click(buttonByText('Retry'));
    await waitFor(() => rows().length > 0, 'the files');
    expect(text()).not.toContain('The files could not be loaded');
  });

  it('keeps the list on screen and shows the error above it when a refresh fails', async () => {
    server = installBucketServer({ records: RECORDS });
    await openPage();
    expect(rows()).toHaveLength(4);

    server.fail.objects = refusal(500, 'Temporarily unavailable');
    await click(buttonByText('Refresh'));
    await waitFor(() => Boolean(q('[role="alert"]')), 'the error');
    expect(q('[role="alert"]')!.textContent).toContain('Temporarily unavailable');
    expect(rows()).toHaveLength(4);
  });

  it('is not an empty bucket when only the filters hide the files', async () => {
    server = installBucketServer({ records: RECORDS });
    // Session files exist, but not in this folder: nothing matches, and the filters can be cleared.
    await openPage({ search: 'path=photos%2F&show=session', until: () => text().includes('No files match') });
    expect(text()).not.toContain('This bucket has no files yet');
    expect(buttonByText('Clear filters')).toBeTruthy();
    await mounted!.unmount();

    // At the root the folder that holds them is still named.
    server = installBucketServer({ records: RECORDS });
    await openPage({ search: 'show=session' });
    expect(lastListing()).toMatchObject({ purpose: 'conversation' });
    expect(rowTexts()).toHaveLength(1);
    expect(rowTexts()[0]).toContain('agent-sessions');
  });
});

describe('a response that arrives as a JSON body without the fields', () => {
  it('does not break the page', async () => {
    server = installBucketServer({ records: RECORDS });
    server.api.on('GET', /^\/api\/files\/buckets\/docs\/objects$/, () => jsonResponse({}));
    await openPage({ until: () => text().includes('This bucket has no files yet') });
    expect(rows()).toHaveLength(0);
  });
});

describe('time', () => {
  it('shows when a file last changed, relative to now', async () => {
    server = installBucketServer({ records: [fileRecord('root.txt', { updatedAt: ago(2 * HOUR) as unknown as Date })] });
    await openPage();
    expect(rows()[0]!.textContent).toMatch(/2 hours ago|2h ago/);
  });
});
