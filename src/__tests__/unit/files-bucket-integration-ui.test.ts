// @vitest-environment jsdom
/**
 * The bucket page together with the two screens it opens, none of them stubbed: the file drawer and the upload
 * screen, over one query cache and one fake Files server. The page's own tests (files-bucket-ui.test.ts) stub both
 * to see what the page hands them; this file checks that what the page hands them is what they take, and that what
 * they change is what the page then shows: the address, the list behind the drawer, the stats, the toasts.
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
  wait,
  type Mounted,
} from '../helpers/iamCenterUi';
import { bucketDetail, fileRecord, installBucketServer, type BucketServer } from '../helpers/filesBucketUi';
import { FakeXhr, makeFile } from '../helpers/filesUploadDetailHarness';

/* ── Navigation and notifications ────────────────────────────────────────── */

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

import BucketPage from '@/components/files/bucket/BucketPage';

/* ── Harness ─────────────────────────────────────────────────────────────── */

let mounted: Mounted | undefined;
let server: BucketServer;
let client: QueryClient;

beforeAll(() => {
  installDomStubs();
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
});
beforeEach(() => {
  nav.store.pathname = '/dashboard/files/docs';
  nav.store.search = '';
  nav.store.pushes.length = 0;
  nav.store.replaces.length = 0;
  nav.store.before.length = 0;
  notify.show.mockClear();
  FakeXhr.reset();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  client?.clear();
  vi.unstubAllGlobals();
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

const BUCKET_OBJECTS = '/api/files/buckets/docs/objects/';
const ONE_FILE = new RegExp(`^${BUCKET_OBJECTS.replace(/\//g, '\\/')}(?!batch-delete$|archive$).+$`);
const keyOf = (path: string) => decodeURIComponent(path.slice(BUCKET_OBJECTS.length));

/** The routes of one file, which the page's own server leaves out: its record, its text, its deletion, a conversion. */
function serveFiles(files: BucketServer) {
  files.api.on('GET', ONE_FILE, (call) => {
    const record = files.records.find((candidate) => candidate.key === keyOf(call.path));
    if (!record) return jsonResponse({ error: 'This file does not exist.' }, 404);
    if (call.query.preview === '1') {
      return new Response('hello from the file', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return { record };
  });
  files.api.on('DELETE', ONE_FILE, (call) => {
    files.records = files.records.filter((candidate) => candidate.key !== keyOf(call.path));
    files.bucket = { ...files.bucket, stats: { ...files.bucket.stats, fileCount: files.bucket.stats.fileCount - 1 } };
    return { success: true };
  });
  files.api.on('POST', '/api/files/buckets/docs/convert', (call) => {
    const key = (call.body as { key: string }).key;
    files.records = files.records.map((candidate) => (candidate.key === key ? { ...candidate, markdownStatus: 'pending' } : candidate));
    return jsonResponse({ record: files.records.find((candidate) => candidate.key === key) }, 202);
  });
}

const RECORDS = [
  fileRecord('root.txt', { size: 100 }),
  fileRecord('reports/notes.txt', { size: 400 }),
  fileRecord('reports/summary.pdf', { size: 4096, markdownStatus: 'succeeded', markdownKey: 'reports/summary.md', markdownSize: 900 }),
];

async function openPage(options: { search?: string; bucket?: ReturnType<typeof bucketDetail>; role?: 'owner' | 'user' } = {}) {
  server = installBucketServer({ records: RECORDS, ...(options.bucket ? { bucket: options.bucket } : {}) });
  serveFiles(server);
  nav.store.pathname = '/dashboard/files/docs';
  nav.store.search = options.search ?? '';
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const user = { name: 'Ada', email: 'ada@example.com', licenseType: 'pro', role: options.role ?? 'owner' };
  const tree = () =>
    h(
      QueryClientProvider,
      { client },
      h(DocsDrawerProvider, {
        value: { openDocs: vi.fn() },
        children: h(DashboardUserProvider, { value: user, children: h(BucketPage, { bucketKey: 'docs' }) }),
      }),
    );
  mounted = await mount(h(NavHarness, { render: tree }));
  await waitFor(() => rows().length > 0, 'the page to show rows');
  // The person's level (it decides which controls are drawn) arrives with its own request.
  await waitFor(() => server.api.to('GET', '/api/auth/session').length > 0, 'the session request');
  await wait(20);
}

const rows = () => qa<HTMLTableRowElement>('tbody tr');
const rowOf = (name: string) => rows().find((row) => row.textContent?.includes(name));
const objectCalls = () => server.api.to('GET', '/api/files/buckets/docs/objects');
const bucketCalls = () => server.api.to('GET', '/api/files/buckets/docs');
const addressParam = (name: string) => new URLSearchParams(nav.store.search).get(name);
const drawer = () => q('.mantine-Drawer-content');
const drawerText = () => drawer()?.textContent ?? '';
const dialogs = () => qa('[role="dialog"]').filter((dialog) => !dialog.classList.contains('mantine-Drawer-content'));
const toasts = () => notify.show.mock.calls.map((call) => call[0] as { color?: string; title?: string; message?: string });

async function openDrawerOf(name: string) {
  await click(rowOf(name));
  await waitFor(() => Boolean(drawer()) && drawerText().includes('hello from the file'), `the drawer of ${name}`);
}

async function drawerTab(name: string) {
  const tab = qa<HTMLButtonElement>('[role="tab"]', drawer()!).find((candidate) => candidate.textContent?.trim() === name);
  if (!tab) throw new Error(`no tab: ${name}`);
  await click(tab);
}

/* ── The file drawer ─────────────────────────────────────────────────────── */

describe('the file drawer on the bucket page', () => {
  it('opens for the row that was clicked, with that file’s own record, and puts it in the address', async () => {
    await openPage({ search: 'path=reports%2F' });
    expect(drawer()).toBeNull();

    await openDrawerOf('notes.txt');

    expect(q('.mantine-Drawer-title')!.textContent).toBe('notes.txt');
    expect(addressParam('file')).toBe('reports/notes.txt');
    expect(addressParam('path')).toBe('reports/');
    // One read of the record, by its key; the folder behind the drawer is not listed again.
    expect(server.api.to('GET', `${BUCKET_OBJECTS}reports/notes.txt`).filter((call) => !call.query.preview)).toHaveLength(1);
    expect(new Set(objectCalls().map((call) => call.query.prefix))).toEqual(new Set(['reports/']));
    expect(rowOf('summary.pdf')).toBeTruthy();
  });

  it('opens from an address that names the file, and closes back to the folder', async () => {
    await openPage({ search: 'path=reports%2F&file=reports%2Fnotes.txt' });
    await waitFor(() => drawerText().includes('hello from the file'), 'the drawer');
    expect(q('.mantine-Drawer-title')!.textContent).toBe('notes.txt');

    await click(q('button[aria-label="Close"]', drawer()!));

    // The drawer came with the address, so closing it takes the file out of the address instead of going back.
    expect(addressParam('file')).toBeNull();
    expect(addressParam('path')).toBe('reports/');
    expect(nav.store.replaces.at(-1)).toBe('/dashboard/files/docs?path=reports%2F');
    await waitFor(() => drawer() === null, 'the drawer to close');
  });

  it('deletes a file after asking: once, with one notice, and the list behind it loses the row and reads the stats once more', async () => {
    await openPage({ search: 'path=reports%2F' });
    await openDrawerOf('notes.txt');
    const before = { objects: objectCalls().length, bucket: bucketCalls().length };

    await click(buttonByText('Delete…', drawer()!));
    await waitFor(() => dialogs().length > 0, 'the question');
    expect(dialogs()[0]!.textContent).toContain('You are about to delete notes.txt.');
    expect(server.api.to('DELETE', ONE_FILE)).toHaveLength(0);
    await click(buttonByText('Delete', dialogs()[0]!));

    await waitFor(() => drawer() === null, 'the drawer to close');
    await waitFor(() => rowOf('notes.txt') === undefined, 'the row to leave the list');
    expect(server.api.to('DELETE', ONE_FILE)).toHaveLength(1);
    expect(keyOf(server.api.to('DELETE', ONE_FILE)[0]!.path)).toBe('reports/notes.txt');
    // The drawer said so; the page does not say it again.
    expect(toasts().filter((toast) => toast.title === 'File deleted')).toHaveLength(1);
    expect(toasts().filter((toast) => toast.color === 'red')).toEqual([]);
    expect(addressParam('file')).toBeNull();
    expect(addressParam('path')).toBe('reports/');
    // Once each: the delete refreshes the listing and the stats, and the page does not ask for them again.
    await wait(100);
    expect(objectCalls().length).toBe(before.objects + 1);
    expect(bucketCalls().length).toBe(before.bucket + 1);
    expect(rowOf('summary.pdf')).toBeTruthy();
  });

  it('starts a conversion from the Markdown tab, and the list behind it shows the file as converting', async () => {
    await openPage({ search: 'path=reports%2F' });
    await openDrawerOf('notes.txt');
    expect(rowOf('notes.txt')!.textContent).not.toContain('Converting…');
    const before = objectCalls().length;

    await drawerTab('Markdown');
    await click(buttonByText('Convert to Markdown', drawer()!));

    await waitFor(() => server.api.to('POST', '/api/files/buckets/docs/convert').length === 1, 'the conversion request');
    expect(server.api.to('POST', '/api/files/buckets/docs/convert')[0]!.body).toEqual({ key: 'reports/notes.txt' });
    await waitFor(() => objectCalls().length > before && rowOf('notes.txt')!.textContent!.includes('Converting…'), 'the list to show the conversion');
    // The drawer follows the same file: its record says it is converting too.
    await waitFor(() => drawerText().includes('Converting…'), 'the drawer to show the conversion');
  });

  it('offers nothing to change in a disabled bucket, and says why, in the drawer as on the page', async () => {
    await openPage({ search: 'file=root.txt', bucket: bucketDetail({ status: 'disabled' }) });
    await waitFor(() => drawerText().includes('hello from the file'), 'the drawer');

    expect(buttonByText('Delete…', drawer()!)).toBeUndefined();
    expect(drawerText()).toContain('This bucket is disabled, so its files can be viewed and downloaded but not deleted or converted.');
    expect(buttonByText('Download', drawer()!)).toBeTruthy();
    await drawerTab('Markdown');
    expect(buttonByText('Convert to Markdown', drawer()!)).toBeUndefined();
    expect(drawerText()).toContain('Enable the bucket to change them.');
    // The page behind it says the same of the bucket as a whole.
    expect(document.body.textContent).toContain('This bucket is disabled. Its files can still be browsed and downloaded');
  });

  it('shows someone who can only read the files, and none of the ways to change them', async () => {
    server = installBucketServer({ records: RECORDS, level: 'read' });
    serveFiles(server);
    nav.store.search = 'file=root.txt';
    client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const user = { name: 'Ada', email: 'ada@example.com', licenseType: 'pro', role: 'user' as const };
    mounted = await mount(
      h(
        NavHarness,
        {
          render: () =>
            h(
              QueryClientProvider,
              { client },
              h(DocsDrawerProvider, {
                value: { openDocs: vi.fn() },
                children: h(DashboardUserProvider, { value: user, children: h(BucketPage, { bucketKey: 'docs' }) }),
              }),
            ),
        },
      ),
    );
    await waitFor(() => drawerText().includes('hello from the file'), 'the drawer');
    await waitFor(() => server.api.to('GET', '/api/auth/session').length > 0, 'the session request');
    await wait(30);

    expect(buttonByText('Delete…', drawer()!)).toBeUndefined();
    expect(buttonByText('Download', drawer()!)).toBeTruthy();
    expect(buttonByText('Upload')).toBeUndefined();
  });
});

/* ── The upload screen ───────────────────────────────────────────────────── */

describe('the upload screen on the bucket page', () => {
  async function pick(files: File[]) {
    const input = q<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('opens for the folder that is open, sends the file there, and the page behind it lists it and reads the stats again', async () => {
    await openPage({ search: 'path=reports%2F' });
    expect(q('.form-overlay')).toBeNull();

    await click(buttonByText('Upload'));
    await waitFor(() => Boolean(q('input[type="file"]')), 'the upload screen');
    // The limits of this bucket are asked for, by its key.
    await waitFor(() => server.api.to('GET', '/api/files/limits').length > 0, 'the limits');
    expect(server.api.to('GET', '/api/files/limits')[0]!.query).toEqual({ bucketKey: 'docs' });
    expect(qa<HTMLInputElement>('input').find((input) => input.placeholder === 'Bucket root')!.value).toBe('reports/');

    await pick([makeFile('fresh.txt')]);
    const before = { objects: objectCalls().length, bucket: bucketCalls().length };
    await click(buttonByText('Upload 1 file'));
    await waitFor(() => FakeXhr.instances.length === 1, 'the upload request');

    const xhr = FakeXhr.instances[0]!;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/files/buckets/docs/objects');
    expect(xhr.body).toMatchObject({ fileName: 'fresh.txt', convertToMarkdown: true });
    expect(String(xhr.body!.folder).replace(/\/$/, '')).toBe('reports');

    const stored = fileRecord('reports/fresh.txt', { size: 1 });
    server.records = [...server.records, stored];
    await act(async () => {
      xhr.respond(201, { record: stored });
    });

    await waitFor(() => rowOf('fresh.txt') !== undefined, 'the new file to be listed behind the form');
    expect(objectCalls().length).toBeGreaterThan(before.objects);
    expect(bucketCalls().length).toBeGreaterThan(before.bucket);

    await click(buttonByText('Done'));
    await waitFor(() => q('.form-overlay') === null, 'the form to close');
    expect(rowOf('fresh.txt')).toBeTruthy();
  });

  it('offers no way into the upload screen for a disabled bucket', async () => {
    await openPage({ bucket: bucketDetail({ status: 'disabled' }) });

    expect(buttonByText('Upload')).toBeUndefined();
    expect(q('.form-overlay')).toBeNull();
  });
});
