// @vitest-environment jsdom
/**
 * The Settings and API tabs of a bucket page, and the two dialogs that belong to the bucket as a whole (deleting
 * it, importing from its storage), against a fake Files server: General (what is saved, what is refused), Storage
 * (the provider's health and "Test now", the prefix and when it is locked), Usage (the project's limits), the
 * danger zone and the delete dialog in all its cases, the API tab's samples, and the import scan.
 * The page's header, the Files tab and the bulk actions are in `files-bucket-ui.test.ts`.
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
  LIMITS,
  LOCAL_DISK,
  MIB,
  MINUTE,
  bucketDetail,
  deletingBucket,
  failedDeleteBucket,
  fileRecord,
  installBucketServer,
  refusal,
  type BucketServer,
} from '../helpers/filesBucketUi';

/* ── Navigation, notifications and the parts built elsewhere ─────────────── */

const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const store = { pathname: '/dashboard/files/docs', search: '', pushes: [] as string[], replaces: [] as string[] };
  const go = (kind: 'pushes' | 'replaces', href: string) => {
    store[kind].push(href);
    const at = href.indexOf('?');
    store.pathname = at >= 0 ? href.slice(0, at) : href;
    store.search = at >= 0 ? href.slice(at + 1) : '';
    listeners.forEach((listener) => listener());
  };
  const router = {
    push: (href: string) => go('pushes', href),
    replace: (href: string) => go('replaces', href),
    back: () => undefined,
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

const stubs = vi.hoisted(() => ({
  drawer: vi.fn<(props: unknown) => unknown>(() => null),
  upload: vi.fn<(props: unknown) => unknown>(() => null),
}));
vi.mock('@/components/files/detail/FileDetailDrawer', () => ({ FileDetailDrawer: (props: unknown) => stubs.drawer(props) }));
vi.mock('@/components/files/upload/UploadFilesForm', () => ({ UploadFilesForm: (props: unknown) => stubs.upload(props) }));

import BucketPage from '@/components/files/bucket/BucketPage';
import { DELETE_STALLED_AFTER_MS } from '@/components/files/shared/jobClock';
import { SAMPLE_FILE_KEY, buildSnippet } from '@/components/files/bucket/apiSnippets';
import { formatBytes } from '@/components/files/shared';

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
  notify.show.mockClear();
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
      throw new Error(`Timed out waiting for: ${label}\n--- page text ---\n${(copy.textContent ?? '').replace(/\s+/g, ' ').slice(0, 1400)}`);
    }
    await wait(15);
  }
}

const USER = (role: 'owner' | 'admin' | 'project_admin' | 'user') => ({ name: 'Ada', email: 'ada@example.com', licenseType: 'pro', role });

type Tab = 'files' | 'settings' | 'api';
const cardTitles = () => qa('.ds-card .ds-h3').map((node) => node.textContent);
const TAB_READY: Record<Tab, () => boolean> = {
  files: () => qa('tbody tr').length > 0 || Boolean(q('.ds-empty')),
  settings: () => cardTitles().length >= 3 && Boolean(q('.ds-card form input')),
  api: () => qa('pre[role="region"]').length > 0,
};

async function openPage(options: { tab?: Tab; role?: 'owner' | 'admin' | 'project_admin' | 'user'; locale?: string; search?: string } = {}) {
  const tab = options.tab ?? 'settings';
  nav.store.pathname = '/dashboard/files/docs';
  nav.store.search = options.search ?? (tab === 'files' ? '' : `tab=${tab}`);
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
  await waitFor(TAB_READY[tab], `the ${tab} tab`);
  await waitFor(() => server.api.to('GET', '/api/auth/session').length > 0, 'the session request');
  await wait(20);
}

async function choose(select: HTMLSelectElement | null, value: string) {
  if (!select) throw new Error('choose(): select not found');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement | null) {
  if (!form) throw new Error('submit(): form not found');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** The code samples of the API tab (its answer examples are regions too, but have no language). */
const samples = () => qa('pre[role="region"]').filter((pre) => /, (cURL|TypeScript|Python) sample$/.test(pre.getAttribute('aria-label') ?? ''));
// The page and its danger zone each host a delete dialog: the one that is open is the one that has its content.
const modalsOf = (testId: string) => qa(`[data-testid="${testId}"]`);
const modalOpen = (testId: string) => modalsOf(testId).some((node) => q('[role="dialog"]', node));
const modal = (testId: string) => modalsOf(testId).find((node) => q('[role="dialog"]', node)) ?? modalsOf(testId)[0]!;
const toasts = () => notify.show.mock.calls.map((call) => call[0] as { color?: string; title?: string; message?: string });
const patches = () => server.api.to('PATCH', '/api/files/buckets/docs');
const deletes = () => server.api.to('DELETE', '/api/files/buckets/docs');
const tabs = () => qa('[role="tab"]');
const nameInput = () => q<HTMLInputElement>('input[aria-label="Name"]')!;
const descriptionInput = () => q<HTMLTextAreaElement>('textarea[aria-label="Description"]')!;
const statusSelect = () => q<HTMLSelectElement>('select[aria-label="Status"]')!;
const saveButton = () => buttonByText('Save changes') as HTMLButtonElement | undefined;
const prefixInput = () => q<HTMLInputElement>('input[aria-label="Prefix inside the provider"]');

const AGENT = { agentId: 'agent-1', agentKey: 'support', name: 'Support' };

/* ── General ─────────────────────────────────────────────────────────────── */

describe('Settings → General', () => {
  it('shows the name, description and status, with the four cards in order', async () => {
    server = installBucketServer({ records: [] });
    await openPage();

    expect(cardTitles()).toEqual(['General', 'Storage', 'Usage', 'Danger zone']);
    expect(nameInput().value).toBe('Docs');
    expect(descriptionInput().value).toBe('Contracts and reports');
    expect(statusSelect().value).toBe('active');
    expect(saveButton()!.disabled).toBe(true);
  });

  it('saves only what changed, then starts again from the saved bucket', async () => {
    server = installBucketServer({ records: [] });
    await openPage();

    await setInput(nameInput(), 'Docs v2');
    expect(saveButton()!.disabled).toBe(false);
    await click(saveButton());
    await waitFor(() => patches().length === 1, 'the PATCH');
    expect(patches()[0]!.body).toEqual({ name: 'Docs v2' });
    await waitFor(() => toasts().length > 0, 'a notification');
    expect(toasts().at(-1)).toMatchObject({ color: 'green', message: 'Bucket saved' });
    // The page re-read the bucket: its header has the new name and the form has nothing left to save.
    await waitFor(() => q('h1')?.textContent === 'Docs v2' && saveButton()!.disabled, 'the saved bucket');
    expect(nameInput().value).toBe('Docs v2');
  });

  it('sends the status and the description when those are what changed', async () => {
    server = installBucketServer({ records: [] });
    await openPage();

    await setInput(descriptionInput(), '');
    await choose(statusSelect(), 'disabled');
    expect(text()).toContain('Files stay readable and downloadable, but nothing new is accepted.');
    await click(saveButton());
    await waitFor(() => patches().length === 1, 'the PATCH');
    expect(patches()[0]!.body).toEqual({ description: '', status: 'disabled' });
    // The page now says the bucket is disabled.
    await waitFor(() => text().includes('This bucket is disabled.'), 'the banner');
  });

  it('is saved by Enter in a field: it is a form', async () => {
    server = installBucketServer({ records: [] });
    await openPage();

    await setInput(nameInput(), 'Renamed');
    await submit(nameInput().closest('form'));
    await waitFor(() => patches().length === 1, 'the PATCH');
    expect(patches()[0]!.body).toEqual({ name: 'Renamed' });
  });

  it('asks for a name of at most 120 characters, and sends nothing until there is one', async () => {
    server = installBucketServer({ records: [] });
    await openPage();

    await setInput(nameInput(), '   ');
    expect(text()).toContain('Enter a name for the bucket.');
    expect(saveButton()!.disabled).toBe(true);
    await submit(nameInput().closest('form'));
    expect(patches()).toHaveLength(0);

    await setInput(nameInput(), 'x'.repeat(121));
    expect(text()).toContain('The name can have at most 120 characters.');
    expect(saveButton()!.disabled).toBe(true);

    await setInput(nameInput(), 'x'.repeat(120));
    expect(text()).not.toContain('at most 120 characters');
    expect(saveButton()!.disabled).toBe(false);
  });

  it('asks for a description of at most 1000 characters, and sends nothing until it fits', async () => {
    server = installBucketServer({ records: [] });
    await openPage();

    await setInput(descriptionInput(), 'x'.repeat(1001));
    expect(text()).toContain('The description can have at most 1000 characters.');
    expect(saveButton()!.disabled).toBe(true);
    await submit(descriptionInput().closest('form'));
    expect(patches()).toHaveLength(0);

    await setInput(descriptionInput(), 'x'.repeat(1000));
    expect(text()).not.toContain('The description can have at most 1000 characters.');
    expect(saveButton()!.disabled).toBe(false);
    await click(saveButton());
    await waitFor(() => patches().length === 1, 'the PATCH');
    expect(patches()[0]!.body).toEqual({ description: 'x'.repeat(1000) });
  });

  it('shows the server’s refusal under the form — with the agents it names — and keeps what was typed', async () => {
    server = installBucketServer({ records: [] });
    const reason = 'The bucket "docs" is where this agent keeps session files: Support. Choose another bucket in its Files settings.';
    server.fail.patch = refusal(409, reason, 'bucket_in_use', { agents: [{ key: 'support', name: 'Support' }, { key: 'sales' }] });
    await openPage();

    await choose(statusSelect(), 'disabled');
    await click(saveButton());
    await waitFor(() => Boolean(q('form [role="alert"]')), 'the refusal');
    expect(q('form [role="alert"]')!.textContent).toBe(`${reason} (sales)`);
    expect(statusSelect().value).toBe('disabled');
    expect(saveButton()!.disabled).toBe(false);
    expect(toasts()).toEqual([]);
  });

  it('is locked for someone who can only read, and for a bucket being deleted', async () => {
    server = installBucketServer({ level: 'read', records: [] });
    await openPage();
    await waitFor(() => nameInput().disabled, 'the fields to lock');
    expect(descriptionInput().disabled).toBe(true);
    expect(statusSelect().disabled).toBe(true);
    expect(saveButton()).toBeUndefined();
    expect(text()).toContain('You have read-only access to the Document Store');
    expect(text()).not.toContain('Danger zone');
    await mounted!.unmount();

    server = installBucketServer({ records: [], bucket: bucketDetail({ deleting: true, status: 'disabled' }) });
    await openPage();
    expect(nameInput().disabled).toBe(true);
    expect(saveButton()).toBeUndefined();
  });

  it('speaks Turkish', async () => {
    server = installBucketServer({ records: [] });
    await openPage({ locale: 'tr' });
    expect(text()).toContain('Genel');
    expect(text()).toContain('Depolama');
    expect(text()).toContain('Kullanım');
    expect(text()).toContain('Tehlikeli bölge');
    expect(buttonByText('Değişiklikleri kaydet')).toBeTruthy();
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Dosyalar', 'Ayarlar', 'API']);
  });
});

/* ── Storage ─────────────────────────────────────────────────────────────── */

describe('Settings → Storage', () => {
  it('shows the provider, its driver and health, where the files are, and the bucket’s key', async () => {
    server = installBucketServer({ records: [] });
    await openPage();

    const storage = text();
    expect(storage).toContain('MinIO (on-prem)');
    expect(storage).toContain('Amazon S3');
    expect(storage).toContain('Connected');
    expect(storage).toContain('s3://files/console/t1/minio/docs/');
    expect(q('button[aria-label="Copy the bucket key"]')).toBeTruthy();
    expect(q('button[aria-label="Copy storage location"]')).toBeTruthy();
  });

  it('links to the provider for owners and admins only', async () => {
    server = installBucketServer({ records: [] });
    await openPage({ role: 'admin' });
    const link = qa<HTMLAnchorElement>('a').find((anchor) => anchor.textContent === 'Open provider');
    expect(link?.getAttribute('href')).toBe('/dashboard/providers/prov-minio');
    await mounted!.unmount();

    server = installBucketServer({ records: [] });
    await openPage({ role: 'project_admin' });
    expect(qa('a').find((anchor) => anchor.textContent === 'Open provider')).toBeUndefined();
    expect(qa('a[href^="/dashboard/providers/"]')).toHaveLength(0);
  });

  it.each(['owner', 'admin'] as const)('offers Test now to the %s', async (role) => {
    server = installBucketServer({ records: [] });
    await openPage({ role });
    expect(buttonByText('Test now')).toBeTruthy();
  });

  it.each(['project_admin', 'user'] as const)(
    'does not offer Test now to a %s: the server refuses the test unless the person is an owner or an admin',
    async (role) => {
      server = installBucketServer({ records: [] });
      await openPage({ role });
      expect(buttonByText('Test now')).toBeUndefined();
      // The provider and its health are still there to read; only the button that asks the server to test is not.
      expect(text()).toContain('MinIO (on-prem)');
      expect(text()).toContain('Connected');
      expect(server.api.to('POST', '/api/providers/prov-minio/test')).toHaveLength(0);
    },
  );

  it('tests the saved provider on demand and shows the outcome step by step', async () => {
    server = installBucketServer({ records: [] });
    await openPage();

    await click(buttonByText('Test now'));
    await waitFor(() => server.api.to('POST', '/api/providers/prov-minio/test').length === 1, 'the test request');
    // The saved provider is tested by its record id, with an empty JSON body.
    expect(server.api.to('POST', '/api/providers/prov-minio/test')[0]!.body).toEqual({});
    await waitFor(() => text().includes('The connection works (12 ms)'), 'the result');
    const steps = qa('li[data-step]');
    expect(steps.map((step) => [step.getAttribute('data-step'), step.getAttribute('data-ok')])).toEqual([
      ['list', 'true'],
      ['write', 'true'],
      ['read', 'true'],
      ['delete', 'true'],
    ]);
  });

  it('shows what failed, and the steps that ran up to it', async () => {
    server = installBucketServer({ records: [] });
    server.testAnswer = () =>
      jsonResponse({
        ok: false,
        latencyMs: 80,
        message: 'AccessDenied: the access key was rejected',
        details: { steps: [{ step: 'list', ok: true }, { step: 'write', ok: false, message: 'AccessDenied' }] },
      });
    await openPage();

    await click(buttonByText('Test now'));
    await waitFor(() => text().includes('The connection test failed'), 'the result');
    expect(text()).toContain('AccessDenied: the access key was rejected');
    const steps = qa('li[data-step]');
    expect(steps.map((step) => [step.getAttribute('data-step'), step.getAttribute('data-ok')])).toEqual([
      ['list', 'true'],
      ['write', 'false'],
    ]);
    expect(steps[1]!.textContent).toContain('AccessDenied');
  });

  it('says so when the driver has no test', async () => {
    server = installBucketServer({ records: [] });
    server.testAnswer = () => jsonResponse({ ok: null, latencyMs: 0, message: '' });
    await openPage();
    await click(buttonByText('Test now'));
    await waitFor(() => text().includes('The test did not return a result.'), 'the result');
  });

  it('asks for provider access when the person has Files access only (403)', async () => {
    server = installBucketServer({ records: [] });
    server.testAnswer = () => refusal(403, 'Forbidden');
    await openPage();

    await click(buttonByText('Test now'));
    await waitFor(() => Boolean(qa('[role="alert"]').find((alert) => alert.textContent?.includes('provider access'))), 'the refusal');
    expect(text()).toContain('You need provider access to test this connection.');
    expect(qa('li[data-step]')).toHaveLength(0);
  });

  it('has no test for the server’s own disk, which needs none', async () => {
    server = installBucketServer({
      records: [],
      bucket: bucketDetail({ provider: LOCAL_DISK, providerKey: 'local', providerHealth: { state: 'builtin' }, storageLocation: null }),
    });
    await openPage();
    expect(buttonByText('Test now')).toBeUndefined();
    expect(text()).toContain('Local filesystem');
    expect(text()).toContain('This server’s disk');
  });

  it('says so when the provider is gone', async () => {
    server = installBucketServer({
      records: [],
      bucket: bucketDetail({ provider: undefined, providerHealth: { state: 'inactive', message: 'The provider no longer exists.' } }),
    });
    await openPage();
    expect(text()).toContain('The provider of this bucket is not available.');
    expect(buttonByText('Test now')).toBeUndefined();
  });
});

describe('Settings → the prefix', () => {
  it('is a field while the bucket has no files, saved on its own with the slashes trimmed', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 0, totalBytes: 0 } }) });
    await openPage();

    expect(prefixInput()!.value).toBe('docs');
    const save = buttonByText('Save prefix') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await setInput(prefixInput()!, ' /team/files/ ');
    expect(save.disabled).toBe(false);
    await click(save);
    await waitFor(() => patches().length === 1, 'the PATCH');
    expect(patches()[0]!.body).toEqual({ prefix: 'team/files' });
    expect(toasts().at(-1)).toMatchObject({ color: 'green', message: 'Prefix saved' });
    await waitFor(() => prefixInput()!.value === 'team/files', 'the saved prefix');
  });

  it('can be emptied: the files then sit at the root of the storage', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 0, totalBytes: 0 } }) });
    await openPage();
    await setInput(prefixInput()!, '');
    await click(buttonByText('Save prefix'));
    await waitFor(() => patches().length === 1, 'the PATCH');
    expect(patches()[0]!.body).toEqual({ prefix: '' });
  });

  it('refuses a prefix the server would, before asking', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 0, totalBytes: 0 } }) });
    await openPage();

    await setInput(prefixInput()!, 'team/../x');
    expect(text()).toContain('A prefix cannot contain “..” or use “.” as a folder name.');
    expect((buttonByText('Save prefix') as HTMLButtonElement).disabled).toBe(true);
    // Two dots are refused inside a name too, not only as a folder of their own.
    await setInput(prefixInput()!, 'team/a..b');
    expect(text()).toContain('A prefix cannot contain “..” or use “.” as a folder name.');
    await setInput(prefixInput()!, 'x'.repeat(201));
    expect(text()).toContain('The prefix can have at most 200 characters.');
    expect((buttonByText('Save prefix') as HTMLButtonElement).disabled).toBe(true);
    await setInput(prefixInput()!, 'a\u0007b');
    expect(text()).toContain('A prefix cannot contain backslashes or control characters.');
    await setInput(prefixInput()!, 'team\\files');
    expect(text()).toContain('A prefix cannot contain backslashes or control characters.');
    expect(patches()).toHaveLength(0);
  });

  it('accepts a prefix of exactly the longest length the server takes, and reads a doubled slash as one', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 0, totalBytes: 0 } }) });
    await openPage();

    await setInput(prefixInput()!, `/${'x'.repeat(200)}/`);
    expect(text()).not.toContain('The prefix can have at most 200 characters.');
    expect((buttonByText('Save prefix') as HTMLButtonElement).disabled).toBe(false);
    await setInput(prefixInput()!, 'team//files');
    await click(buttonByText('Save prefix'));
    await waitFor(() => patches().length === 1, 'the PATCH');
    expect(patches()[0]!.body).toEqual({ prefix: 'team/files' });
  });

  it('shows the server’s refusal when files turned up in the meantime (prefix_locked)', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 0, totalBytes: 0 } }) });
    server.fail.patch = refusal(409, 'The prefix is locked.', 'prefix_locked');
    await openPage();
    await setInput(prefixInput()!, 'other');
    await click(buttonByText('Save prefix'));
    await waitFor(() => text().includes('The prefix cannot be changed while the bucket has files.'), 'the refusal');
  });

  it('is fixed once the bucket has files, and says why', async () => {
    server = installBucketServer({ records: [fileRecord('a.txt')], bucket: bucketDetail({ stats: { fileCount: 1, totalBytes: 10 } }) });
    await openPage();

    expect(prefixInput()).toBeNull();
    expect(buttonByText('Save prefix')).toBeUndefined();
    expect(text()).toContain('docs/');
    expect(text()).toContain('The prefix is fixed because this bucket has files; changing it would leave them behind in the old location.');
  });

  it('names the root of the storage, and the bucket key when the bucket has no prefix of its own', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ prefix: '', stats: { fileCount: 5, totalBytes: 10 } }) });
    await openPage();
    expect(text()).toContain('The root of the storage (no prefix)');
    await mounted!.unmount();

    server = installBucketServer({ records: [], bucket: bucketDetail({ prefix: undefined, stats: { fileCount: 5, totalBytes: 10 } }) });
    await openPage();
    expect(text()).toContain('docs/');
  });

  it('is shown, not editable, to someone who can only read', async () => {
    server = installBucketServer({ level: 'read', records: [], bucket: bucketDetail({ stats: { fileCount: 0, totalBytes: 0 } }) });
    await openPage();
    await waitFor(() => !prefixInput(), 'the field to go');
    expect(text()).toContain('docs/');
    expect(buttonByText('Save prefix')).toBeUndefined();
  });
});

/* ── Usage ───────────────────────────────────────────────────────────────── */

describe('Settings → Usage', () => {
  it('shows what the bucket holds, the largest file an upload can carry and the project’s limits', async () => {
    server = installBucketServer({ records: [] });
    await openPage();
    await waitFor(() => qa('[role="progressbar"]').length === 2, 'the gauges');

    // The limits are asked for this bucket (its provider can carry its own).
    expect(server.api.to('GET', '/api/files/limits')[0]!.query).toEqual({ bucketKey: 'docs' });
    const tiles = qa('.ds-stat').map((tile) => tile.textContent);
    expect(tiles.join('|')).toContain('Files3');
    expect(tiles.join('|')).toContain(`Stored size${formatBytes(6 * MIB)}`);
    expect(tiles.join('|')).toContain(`Maximum file size${formatBytes(25 * MIB)}`);

    const [storage, files] = qa('[role="progressbar"]');
    expect(storage!.getAttribute('aria-label')).toBe('Project storage');
    expect(storage!.getAttribute('aria-valuenow')).toBe('6');
    expect(storage!.getAttribute('aria-valuetext')).toBe(`${formatBytes(6 * MIB)} of ${formatBytes(100 * MIB)}`);
    expect(files!.getAttribute('aria-label')).toBe('Project files');
    expect(files!.getAttribute('aria-valuetext')).toBe('3 of 1,000');
  });

  it('turns the bar to a warning from 80% and to an error from 95%', async () => {
    server = installBucketServer({
      records: [],
      limits: { ...LIMITS, quota: { usedBytes: 85 * MIB, limitBytes: 100 * MIB, filesUsed: 990, filesLimit: 1000 } },
    });
    await openPage();
    await waitFor(() => qa('[role="progressbar"]').length === 2, 'the gauges');
    const [storage, files] = qa('[role="progressbar"]');
    expect(storage!.getAttribute('aria-valuenow')).toBe('85');
    expect(storage!.firstElementChild!.className).toContain('gaugeWarn');
    expect(files!.getAttribute('aria-valuenow')).toBe('99');
    expect(files!.firstElementChild!.className).toContain('gaugeErr');
  });

  it('draws no bar, and says so, for a limit that is not set', async () => {
    server = installBucketServer({
      records: [],
      limits: { ...LIMITS, quota: { usedBytes: 6 * MIB, limitBytes: null, filesUsed: 3, filesLimit: null } },
    });
    await openPage();
    await waitFor(() => text().includes('No storage limit is set for this project.'), 'the sentence');
    expect(text()).toContain('No file-count limit is set for this project.');
    expect(qa('[role="progressbar"]')).toHaveLength(0);
  });

  it('says why the limits could not be loaded, and loads them on Retry', async () => {
    server = installBucketServer({ records: [] });
    server.fail.limits = refusal(500, 'The quota service is down');
    await openPage();
    await waitFor(() => text().includes('The project limits could not be loaded: The quota service is down'), 'the message');
    expect(qa('[role="progressbar"]')).toHaveLength(0);

    server.fail.limits = undefined;
    const retry = qa<HTMLButtonElement>('button').filter((button) => button.textContent === 'Retry').at(-1);
    await click(retry);
    await waitFor(() => qa('[role="progressbar"]').length === 2, 'the gauges');
  });
});

/* ── The danger zone and the delete dialog ───────────────────────────────── */

const DELETE_DIALOG = 'delete-bucket-modal';
const choiceInputs = () => qa<HTMLInputElement>('input[type="radio"]', modal(DELETE_DIALOG));
const choice = (value: 'files' | 'bucketOnly') => q<HTMLInputElement>(`input[type="radio"][value="${value}"]`, modal(DELETE_DIALOG))!;
const confirmButton = () => q<HTMLButtonElement>('[data-testid="delete-bucket-confirm"]')!;
const dangerButton = (label = 'Delete bucket…') => buttonByText(label) as HTMLButtonElement | undefined;
const SHARED_SENTENCE = 'Another bucket uses this storage location. Delete the bucket without its files, or remove the other bucket first.';

describe('Settings → Danger zone', () => {
  it('describes what deleting this bucket takes with it', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 0, totalBytes: 0 } }) });
    await openPage();
    expect(text()).toContain('This bucket has no files. Deleting it removes the bucket only, and cannot be undone.');
    await mounted!.unmount();

    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 1, totalBytes: 10 } }) });
    await openPage();
    expect(text()).toContain(
      'This bucket holds 1 file in MinIO (on-prem). When you delete the bucket you choose whether the file is deleted too. This cannot be undone.',
    );
    await mounted!.unmount();

    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 1284, totalBytes: 10 } }) });
    await openPage();
    expect(text()).toContain(
      'This bucket holds 1,284 files in MinIO (on-prem). When you delete the bucket you choose whether the files are deleted too. This cannot be undone.',
    );
  });

  it('deletes an empty bucket after a plain question, and goes back to the list', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 0, totalBytes: 0 } }) });
    await openPage();

    await click(buttonByText('Delete bucket…'));
    expect(modalOpen(DELETE_DIALOG)).toBe(true);
    expect(modal(DELETE_DIALOG).textContent).toContain('Delete the bucket “Docs”?');
    expect(modal(DELETE_DIALOG).textContent).toContain('The bucket is empty, so only the bucket itself is removed.');
    // No question about files when there are none.
    expect(choiceInputs()).toHaveLength(0);
    expect(deletes()).toHaveLength(0);

    await click(confirmButton());
    await waitFor(() => deletes().length === 1, 'the DELETE');
    expect(deletes()[0]!.query).toEqual({});
    await waitFor(() => nav.store.pushes.includes('/dashboard/files'), 'the way back to the list');
    expect(toasts().at(-1)).toMatchObject({ color: 'green', message: 'Bucket “Docs” deleted' });
    await waitFor(() => !modalOpen(DELETE_DIALOG), 'the dialog to close');
  });

  it('will not delete a bucket with files until the person says what happens to them', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 3, totalBytes: 10 } }) });
    server.deleteAnswer = () => jsonResponse({ status: 'deleting' }, 202);
    await openPage();

    await click(buttonByText('Delete bucket…'));
    const dialog = modal(DELETE_DIALOG);
    expect(dialog.textContent).toContain('This bucket holds 3 files, stored in MinIO (on-prem). Choose what happens to them.');
    // Two answers, and neither is picked for the person.
    expect(choiceInputs().map((input) => input.value)).toEqual(['files', 'bucketOnly']);
    expect(choiceInputs().map((input) => input.checked)).toEqual([false, false]);
    expect(dialog.textContent).toContain('Delete the bucket and its 3 files');
    expect(dialog.textContent).toContain('The files are removed from MinIO (on-prem) in the background. This cannot be undone.');
    expect(dialog.textContent).toContain('Delete the bucket only');
    expect(dialog.textContent).toContain('The files stay in MinIO (on-prem) and keep counting toward the project’s storage.');
    expect(confirmButton().disabled).toBe(true);
    await click(confirmButton());
    expect(deletes()).toHaveLength(0);

    await click(choice('files'));
    expect(choice('files').checked).toBe(true);
    expect(confirmButton().disabled).toBe(false);
    await click(confirmButton());
    await waitFor(() => deletes().length === 1, 'the DELETE');
    // Asking for the files to go is the one parameter that is sent.
    expect(deletes()[0]!.query).toEqual({ deleteFiles: 'true' });
    // Removing the files is a background job: the dialog closes, the page stays and says it started.
    await waitFor(() => !modalOpen(DELETE_DIALOG), 'the dialog to close');
    expect(toasts().at(-1)).toMatchObject({ color: 'blue', message: 'Deleting “Docs”. Its files are being removed in the background.' });
    expect(nav.store.pushes).toEqual([]);
  });

  it('deletes only the bucket when that is what the person picks, and says where the files stay', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 3, totalBytes: 10 } }) });
    await openPage();

    await click(buttonByText('Delete bucket…'));
    await click(choice('bucketOnly'));
    expect(choice('bucketOnly').checked).toBe(true);
    expect(choice('files').checked).toBe(false);
    await click(confirmButton());

    await waitFor(() => deletes().length === 1, 'the DELETE');
    expect(deletes()[0]!.query).toEqual({ force: 'true' });
    await waitFor(() => nav.store.pushes.includes('/dashboard/files'), 'the way back to the list');
    expect(toasts().at(-1)).toMatchObject({ color: 'green', message: 'Bucket “Docs” deleted. Its files stay in MinIO (on-prem).' });
    await waitFor(() => !modalOpen(DELETE_DIALOG), 'the dialog to close');
  });

  it('changes its mind with the choice: the last pick is what is sent', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 3, totalBytes: 10 } }) });
    server.deleteAnswer = () => jsonResponse({ status: 'deleting' }, 202);
    await openPage();

    await click(buttonByText('Delete bucket…'));
    await click(choice('bucketOnly'));
    await click(choice('files'));
    await click(confirmButton());
    await waitFor(() => deletes().length === 1, 'the DELETE');
    expect(deletes()[0]!.query).toEqual({ deleteFiles: 'true' });
  });

  it('starts every opening without a choice made', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 3, totalBytes: 10 } }) });
    await openPage();

    await click(buttonByText('Delete bucket…'));
    await click(choice('files'));
    await click(buttonByText('Cancel'));
    await waitFor(() => !modalOpen(DELETE_DIALOG), 'the dialog to close');
    await click(buttonByText('Delete bucket…'));
    await waitFor(() => modalOpen(DELETE_DIALOG), 'the dialog to open');
    expect(choiceInputs().map((input) => input.checked)).toEqual([false, false]);
    expect(confirmButton().disabled).toBe(true);
    expect(deletes()).toHaveLength(0);
  });

  it('words the question for a single file in the singular', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 1, totalBytes: 10 } }) });
    await openPage();
    await click(buttonByText('Delete bucket…'));
    const dialog = modal(DELETE_DIALOG);
    expect(dialog.textContent).toContain('This bucket holds 1 file, stored in MinIO (on-prem). Choose what happens to it.');
    expect(dialog.textContent).toContain('Delete the bucket and its file');
    expect(dialog.textContent).toContain('The file is removed from MinIO (on-prem) in the background.');
    expect(dialog.textContent).toContain('The file stays in MinIO (on-prem) and keeps counting toward the project’s storage.');
  });

  it('asks again, with the choice, when the server finds files the numbers did not show', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 0, totalBytes: 0 } }) });
    let answers = 0;
    server.deleteAnswer = () => (answers++ === 0 ? refusal(409, 'The bucket is not empty.', 'bucket_not_empty') : jsonResponse({ status: 'deleting' }, 202));
    await openPage();

    await click(buttonByText('Delete bucket…'));
    await click(confirmButton());
    await waitFor(() => modal(DELETE_DIALOG).textContent!.includes('The bucket now contains files.'), 'the second question');
    expect(modal(DELETE_DIALOG).textContent).toContain('This bucket holds files, stored in MinIO (on-prem). Choose what happens to them.');
    expect(modal(DELETE_DIALOG).textContent).toContain('Delete the bucket and its files');
    expect(choiceInputs().map((input) => input.checked)).toEqual([false, false]);
    expect(confirmButton().disabled).toBe(true);

    await click(choice('files'));
    await click(confirmButton());
    await waitFor(() => deletes().length === 2, 'the second DELETE');
    expect(deletes()[0]!.query).toEqual({});
    expect(deletes()[1]!.query).toEqual({ deleteFiles: 'true' });
  });

  it('can delete only the bucket when the server found files the numbers did not show', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 0, totalBytes: 0 } }) });
    let answers = 0;
    server.deleteAnswer = () => (answers++ === 0 ? refusal(409, 'The bucket is not empty.', 'bucket_not_empty') : jsonResponse({ success: true }));
    await openPage();

    await click(buttonByText('Delete bucket…'));
    await click(confirmButton());
    await waitFor(() => choiceInputs().length === 2, 'the choice');
    await click(choice('bucketOnly'));
    await click(confirmButton());
    await waitFor(() => deletes().length === 2, 'the second DELETE');
    expect(deletes()[1]!.query).toEqual({ force: 'true' });
    await waitFor(() => nav.store.pushes.includes('/dashboard/files'), 'the way back to the list');
  });

  it('shows the failure and keeps the dialog when the server refuses', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 0, totalBytes: 0 } }) });
    server.deleteAnswer = () => refusal(500, 'The storage provider is unreachable');
    await openPage();
    await click(buttonByText('Delete bucket…'));
    await click(confirmButton());
    await waitFor(() => modal(DELETE_DIALOG).textContent!.includes('The storage provider is unreachable'), 'the failure');
    expect(modalOpen(DELETE_DIALOG)).toBe(true);
    expect(nav.store.pushes).toEqual([]);
    // Cancel closes it and nothing was deleted.
    await click(buttonByText('Cancel'));
    await waitFor(() => !modalOpen(DELETE_DIALOG), 'the dialog to close');
  });

  it('says why a delete with the files was refused when the bucket holds files of other people’s sessions', async () => {
    const sentence = 'This bucket holds files of sessions started by someone else, and you are not allowed to change them, so it cannot be deleted with its files.';
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 3, totalBytes: 10 } }) });
    server.deleteAnswer = () => refusal(403, sentence, 'forbidden');
    await openPage();
    await click(buttonByText('Delete bucket…'));
    await click(choice('files'));
    await click(confirmButton());

    await waitFor(() => modal(DELETE_DIALOG).textContent!.includes(sentence), 'the refusal');
    expect(modalOpen(DELETE_DIALOG)).toBe(true);
    // The bucket can still be deleted without its files: the choice stays open.
    expect(choice('files').checked).toBe(true);
    await click(choice('bucketOnly'));
    expect(confirmButton().disabled).toBe(false);
  });

  describe('when another bucket uses the same storage location', () => {
    it('explains, in the person’s words, why the bucket cannot go with its files, and moves the choice to the bucket only', async () => {
      server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 3, totalBytes: 10 } }) });
      server.deleteAnswer = (call) => (call.query.deleteFiles ? refusal(409, SHARED_SENTENCE, 'storage_location_shared') : jsonResponse({ success: true }));
      await openPage();
      await click(buttonByText('Delete bucket…'));
      const dialog = modal(DELETE_DIALOG);
      await click(choice('files'));
      await click(confirmButton());

      await waitFor(() => dialog.textContent!.includes('Another bucket uses this storage location'), 'the refusal');
      // The server's sentence, in the viewer's language, and it advises exactly what the dialog now offers.
      expect(q('[role="alert"]', dialog)!.textContent).toBe(SHARED_SENTENCE);
      expect(choice('bucketOnly').checked).toBe(true);
      expect(choice('files').checked).toBe(false);
      expect(modalOpen(DELETE_DIALOG)).toBe(true);
      expect(deletes()).toHaveLength(1);
      expect(deletes()[0]!.query).toEqual({ deleteFiles: 'true' });
      expect(nav.store.pushes).toEqual([]);
      expect(toasts().filter((toast) => toast.color === 'green')).toEqual([]);
    });

    it('lets the person delete the bucket without its files after that', async () => {
      server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 3, totalBytes: 10 } }) });
      server.deleteAnswer = (call) => (call.query.deleteFiles ? refusal(409, SHARED_SENTENCE, 'storage_location_shared') : jsonResponse({ success: true }));
      await openPage();
      await click(buttonByText('Delete bucket…'));
      await click(choice('files'));
      await click(confirmButton());
      await waitFor(() => modal(DELETE_DIALOG).textContent!.includes('remove the other bucket first.'), 'the refusal');

      expect(confirmButton().disabled).toBe(false);
      await click(confirmButton());
      await waitFor(() => deletes().length === 2, 'the second DELETE');
      expect(deletes().map((call) => call.query)).toEqual([{ deleteFiles: 'true' }, { force: 'true' }]);
      await waitFor(() => nav.store.pushes.includes('/dashboard/files'), 'the way back to the list');
      expect(toasts().at(-1)).toMatchObject({ color: 'green', message: 'Bucket “Docs” deleted. Its files stay in MinIO (on-prem).' });
    });

    it('lets the person cancel, and ask again with the files once the other bucket is gone', async () => {
      server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 3, totalBytes: 10 } }) });
      let answers = 0;
      server.deleteAnswer = () => (answers++ === 0 ? refusal(409, SHARED_SENTENCE, 'storage_location_shared') : jsonResponse({ status: 'deleting' }, 202));
      await openPage();
      await click(buttonByText('Delete bucket…'));
      await click(choice('files'));
      await click(confirmButton());
      await waitFor(() => modal(DELETE_DIALOG).textContent!.includes('remove the other bucket first.'), 'the refusal');

      // The way out is there, and so is the other choice.
      expect(buttonByText('Cancel')).toBeTruthy();
      await click(choice('files'));
      await click(confirmButton());
      await waitFor(() => deletes().length === 2, 'the second DELETE');
      expect(deletes().map((call) => call.query)).toEqual([{ deleteFiles: 'true' }, { deleteFiles: 'true' }]);
      await waitFor(() => !modalOpen(DELETE_DIALOG), 'the dialog to close');
      expect(toasts().at(-1)).toMatchObject({ color: 'blue', message: 'Deleting “Docs”. Its files are being removed in the background.' });
    });

    it('does not get in the way of deleting a bucket that holds no files: that asks nothing about files at all', async () => {
      server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 0, totalBytes: 0 } }) });
      // The server refuses only the delete that takes the files along.
      server.deleteAnswer = () => jsonResponse({ success: true });
      await openPage();
      await click(buttonByText('Delete bucket…'));
      expect(choiceInputs()).toHaveLength(0);

      await click(confirmButton());

      await waitFor(() => deletes().length === 1, 'the DELETE');
      expect(deletes()[0]!.query).toEqual({});
      await waitFor(() => nav.store.pushes.includes('/dashboard/files'), 'the way back to the list');
      expect(toasts().at(-1)).toMatchObject({ color: 'green', message: 'Bucket “Docs” deleted' });
    });

    it('speaks Turkish', async () => {
      server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 3, totalBytes: 10 } }) });
      server.deleteAnswer = () => refusal(409, SHARED_SENTENCE, 'storage_location_shared');
      await openPage({ locale: 'tr' });
      await click(buttonByText('Bucket’ı sil…'));
      const dialog = modal(DELETE_DIALOG);
      await click(q('input[type="radio"][value="files"]', dialog));
      await click(q('[data-testid="delete-bucket-confirm"]'));

      await waitFor(() => dialog.textContent!.includes('Başka bir bucket bu depolama konumunu kullanıyor'), 'the refusal');
      expect(q('[role="alert"]', dialog)!.textContent).toBe(
        'Başka bir bucket bu depolama konumunu kullanıyor. Bucket’ı dosyaları olmadan silin ya da önce diğer bucket’ı kaldırın.',
      );
      expect(dialog.textContent).not.toContain('Another bucket');
      expect(q<HTMLInputElement>('input[type="radio"][value="bucketOnly"]', dialog)!.checked).toBe(true);
    });
  });

  it('is blocked while an agent keeps its session files in the bucket, and names the agents', async () => {
    server = installBucketServer({
      records: [],
      bucket: bucketDetail({ usedBy: [AGENT, { agentId: 'agent 2', agentKey: 'sales', name: 'Sales' }] }),
    });
    await openPage();

    const links = qa<HTMLAnchorElement>('a[href*="/dashboard/agents/"]');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Support', '/dashboard/agents/agent-1?tab=files'],
      ['Sales', '/dashboard/agents/agent%202?tab=files'],
    ]);
    expect(text()).toContain('This bucket cannot be deleted while these agents keep their session files in it:');
    expect((buttonByText('Delete bucket…') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is blocked in the dialog of the header menu too: it lists the agents and offers no deletion', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ usedBy: [AGENT] }) });
    await openPage({ tab: 'files' });

    await click(q('button[aria-label="More actions"]'));
    await click(qa('[role="menuitem"]').find((item) => item.textContent === 'Delete bucket…'));
    const dialog = modal(DELETE_DIALOG);
    expect(dialog.textContent).toContain('An agent keeps its session files in this bucket, so it cannot be deleted yet.');
    expect(q('ul[aria-label="Agents using this bucket"]', dialog)!.textContent).toContain('Support');
    expect(q('[data-testid="delete-bucket-confirm"]')).toBeNull();
    expect(choiceInputs()).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
    await click(buttonByText('Close'));
    await waitFor(() => !modalOpen(DELETE_DIALOG), 'the dialog to close');
  });

  it('is open from the header menu of a bucket with files too, with the same choice', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ stats: { fileCount: 3, totalBytes: 10 } }) });
    await openPage({ tab: 'files' });

    await click(q('button[aria-label="More actions"]'));
    await click(qa('[role="menuitem"]').find((item) => item.textContent === 'Delete bucket…'));
    expect(choiceInputs().map((input) => input.value)).toEqual(['files', 'bucketOnly']);
    expect(confirmButton().disabled).toBe(true);
  });

  it('says that a delete job is running, and offers nothing while it does', async () => {
    server = installBucketServer({ records: [], bucket: deletingBucket(MINUTE) });
    await openPage();
    expect(text()).toContain('This bucket is being deleted. Its files are being removed from the storage provider.');
    expect((buttonByText('Delete bucket…') as HTMLButtonElement).disabled).toBe(true);
    // A job that has only just started is not offered again.
    expect(buttonByText('Delete again')).toBeUndefined();
    expect(buttonByText('Delete again…')).toBeUndefined();
    expect(q('.detail-header')!.textContent).toContain('Deleting…');
  });

  describe('a delete job that was most likely lost', () => {
    it('is told from a running one on the page: a notice with “Delete again”, and a danger zone that offers it', async () => {
      server = installBucketServer({ records: [], bucket: deletingBucket(DELETE_STALLED_AFTER_MS + MINUTE) });
      await openPage();

      expect(text()).toContain('The deletion has not finished for a while. If the server was restarted since, the background run may have been lost.');
      expect(text()).not.toContain('Its files are being removed from the storage provider, so nothing can be changed until that finishes.');
      expect(buttonByText('Delete again')).toBeTruthy();
      expect(text()).toContain('The deletion has not finished for a while; the background run may have been lost. Delete again to continue where it stopped.');
      const again = dangerButton('Delete again…')!;
      expect(again.disabled).toBe(false);
      expect(dangerButton()).toBeUndefined();
      // The badge still says what the server says, and nothing else about the bucket becomes changeable.
      expect(q('.detail-header')!.textContent).toContain('Deleting…');
      expect(nameInput().disabled).toBe(true);
    });

    it('asks again for the files to go, from the notice, and stays on the page while the job runs', async () => {
      server = installBucketServer({ records: [], bucket: deletingBucket(DELETE_STALLED_AFTER_MS + MINUTE, { stats: { fileCount: 2, totalBytes: 10 } }) });
      server.deleteAnswer = () => jsonResponse({ status: 'deleting' }, 202);
      await openPage();

      await click(buttonByText('Delete again'));
      const dialog = modal(DELETE_DIALOG);
      expect(dialog.textContent).toContain('The deletion has not finished for a while.');
      expect(dialog.textContent).toContain('Deleting again continues where it stopped; files already removed stay removed.');
      // The files are the question already answered: there is no choice to make.
      expect(choiceInputs()).toHaveLength(0);
      expect(confirmButton().textContent).toBe('Delete again');
      expect(confirmButton().disabled).toBe(false);
      await click(confirmButton());

      await waitFor(() => deletes().length === 1, 'the DELETE');
      expect(deletes()[0]!.query).toEqual({ deleteFiles: 'true' });
      await waitFor(() => !modalOpen(DELETE_DIALOG), 'the dialog to close');
      expect(toasts().at(-1)).toMatchObject({ color: 'blue', message: 'Deleting “Docs”. Its files are being removed in the background.' });
      expect(nav.store.pushes).toEqual([]);
    });

    it('asks again from the danger zone as well', async () => {
      server = installBucketServer({ records: [], bucket: deletingBucket(DELETE_STALLED_AFTER_MS + MINUTE) });
      server.deleteAnswer = () => jsonResponse({ status: 'deleting' }, 202);
      await openPage();

      await click(dangerButton('Delete again…'));
      expect(modalOpen(DELETE_DIALOG)).toBe(true);
      await click(confirmButton());
      await waitFor(() => deletes().length === 1, 'the DELETE');
      expect(deletes()[0]!.query).toEqual({ deleteFiles: 'true' });
    });

    it('is not offered again before the time has come', async () => {
      server = installBucketServer({ records: [], bucket: deletingBucket(DELETE_STALLED_AFTER_MS - MINUTE) });
      await openPage();
      expect(buttonByText('Delete again')).toBeUndefined();
      expect(buttonByText('Delete again…')).toBeUndefined();
      expect(qa('[role="status"]').some((notice) => notice.textContent!.includes('Its files are being removed from the storage provider'))).toBe(true);
      expect(text()).not.toContain('The deletion has not finished for a while');
    });

    it('is offered the moment the bucket page notices that the time has come', async () => {
      // A job asked for just under the limit ago crosses it while the page stays open.
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      try {
        server = installBucketServer({ records: [], bucket: deletingBucket(DELETE_STALLED_AFTER_MS - 20_000) });
        await openPage();
        expect(buttonByText('Delete again')).toBeUndefined();
        await act(async () => {
          vi.advanceTimersByTime(60_000);
        });
        expect(buttonByText('Delete again')).toBeTruthy();
        expect(text()).toContain('The deletion has not finished for a while.');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not offer anyone who cannot write a deletion to run again', async () => {
      server = installBucketServer({ level: 'read', records: [], bucket: deletingBucket(DELETE_STALLED_AFTER_MS + MINUTE) });
      await openPage();
      await waitFor(() => nameInput().disabled, 'the fields to lock');
      expect(text()).toContain('The deletion has not finished for a while.');
      expect(buttonByText('Delete again')).toBeUndefined();
      expect(buttonByText('Delete again…')).toBeUndefined();
    });

    describe('when another bucket uses the storage location', () => {
      type DeleteCall = Parameters<BucketServer['deleteAnswer']>[0];
      // As the server answers a bucket that is being deleted: the files cannot be asked for again, a plain delete is
      // refused while the run is on, and `force` removes the bucket record (the files stay where they are).
      const answerAsTheServerDoes = (call: DeleteCall) =>
        call.query.force
          ? jsonResponse({ success: true })
          : call.query.deleteFiles
            ? refusal(409, SHARED_SENTENCE, 'storage_location_shared')
            : refusal(409, 'The bucket is being deleted.', 'bucket_deleting');

      /** Opens the dialog of a bucket whose run looks lost and asks again, until the server refuses. */
      const askAgainUntilRefused = async (bucket = deletingBucket(DELETE_STALLED_AFTER_MS + MINUTE), locale = 'en') => {
        server = installBucketServer({ records: [], bucket });
        server.deleteAnswer = answerAsTheServerDoes;
        await openPage({ locale });
        await click(buttonByText(locale === 'tr' ? 'Yeniden sil' : 'Delete again'));
        await click(confirmButton());
        await waitFor(() => q('[role="alert"]', modal(DELETE_DIALOG)) !== null, 'the refusal');
      };

      it('says why asking again fails, and offers the way the sentence recommends: delete only the bucket', async () => {
        server = installBucketServer({ records: [], bucket: deletingBucket(DELETE_STALLED_AFTER_MS + MINUTE) });
        server.deleteAnswer = answerAsTheServerDoes;
        await openPage();
        await click(buttonByText('Delete again'));
        // Nothing to choose while the run can still be asked for: asking again is the one thing on offer.
        expect(choiceInputs()).toHaveLength(0);
        await click(confirmButton());

        await waitFor(() => q('[role="alert"]', modal(DELETE_DIALOG)) !== null, 'the refusal');
        expect(q('[role="alert"]', modal(DELETE_DIALOG))!.textContent).toBe(SHARED_SENTENCE);
        expect(modalOpen(DELETE_DIALOG)).toBe(true);
        // The sentence advises deleting the bucket without its files: that is offered now, and picked.
        expect(choiceInputs().map((input) => input.value)).toEqual(['files', 'bucketOnly']);
        expect(choice('bucketOnly').checked).toBe(true);
        expect(choice('files').checked).toBe(false);
        const dialog = modal(DELETE_DIALOG);
        expect(dialog.textContent).toContain('Delete the bucket only');
        expect(dialog.textContent).toContain('The files stay in MinIO (on-prem) and keep counting toward the project’s storage.');
        expect(confirmButton().textContent).toBe('Delete bucket');
        expect(confirmButton().disabled).toBe(false);
        expect(deletes()).toHaveLength(1);
        expect(nav.store.pushes).toEqual([]);
      });

      it('deletes only the bucket then: the files stay, and the person is told where', async () => {
        await askAgainUntilRefused();

        await click(confirmButton());
        await waitFor(() => deletes().length === 2, 'the second DELETE');
        // The request the server lets past a bucket that is being deleted.
        expect(deletes().map((call) => call.query)).toEqual([{ deleteFiles: 'true' }, { force: 'true' }]);
        await waitFor(() => nav.store.pushes.includes('/dashboard/files'), 'the way back to the list');
        expect(toasts().at(-1)).toMatchObject({ color: 'green', message: 'Bucket “Docs” deleted. Its files stay in MinIO (on-prem).' });
        await waitFor(() => !modalOpen(DELETE_DIALOG), 'the dialog to close');
      });

      it('can still ask again with the files once the other bucket is gone', async () => {
        await askAgainUntilRefused();
        let answers = 0;
        server.deleteAnswer = (call) => (answers++ === 0 ? jsonResponse({ status: 'deleting' }, 202) : answerAsTheServerDoes(call));

        await click(choice('files'));
        expect(confirmButton().textContent).toBe('Delete again');
        await click(confirmButton());
        await waitFor(() => deletes().length === 2, 'the second DELETE');
        expect(deletes().map((call) => call.query)).toEqual([{ deleteFiles: 'true' }, { deleteFiles: 'true' }]);
        await waitFor(() => !modalOpen(DELETE_DIALOG), 'the dialog to close');
        expect(toasts().at(-1)).toMatchObject({ color: 'blue', message: 'Deleting “Docs”. Its files are being removed in the background.' });
        expect(nav.store.pushes).toEqual([]);
      });

      it('moves the choice back to the bucket only when asking again with the files is refused once more', async () => {
        await askAgainUntilRefused();

        await click(choice('files'));
        await click(confirmButton());
        await waitFor(() => deletes().length === 2, 'the second DELETE');
        await waitFor(() => choice('bucketOnly').checked, 'the choice to move');
        expect(choice('files').checked).toBe(false);
        expect(modalOpen(DELETE_DIALOG)).toBe(true);
      });

      it('keeps the dialog and the choice when deleting only the bucket fails', async () => {
        await askAgainUntilRefused();
        server.deleteAnswer = () => refusal(500, 'The bucket could not be deleted');

        await click(confirmButton());
        await waitFor(() => deletes().length === 2, 'the second DELETE');
        await waitFor(() => modal(DELETE_DIALOG).textContent!.includes('The bucket could not be deleted'), 'the failure');
        expect(deletes()[1]!.query).toEqual({ force: 'true' });
        expect(choice('bucketOnly').checked).toBe(true);
        expect(modalOpen(DELETE_DIALOG)).toBe(true);
        expect(nav.store.pushes).toEqual([]);
      });

      it('offers nothing of the kind for a refusal that has another reason', async () => {
        server = installBucketServer({ records: [], bucket: deletingBucket(DELETE_STALLED_AFTER_MS + MINUTE) });
        server.deleteAnswer = () => refusal(503, 'The queue is not available.', 'queue_unavailable');
        await openPage();
        await click(buttonByText('Delete again'));
        await click(confirmButton());

        await waitFor(() => q('[role="alert"]', modal(DELETE_DIALOG)) !== null, 'the refusal');
        expect(choiceInputs()).toHaveLength(0);
        expect(confirmButton().textContent).toBe('Delete again');
        expect(confirmButton().disabled).toBe(false);
      });

      it('starts every opening without it: the bucket only goes once the server has refused again', async () => {
        await askAgainUntilRefused();
        expect(choiceInputs()).toHaveLength(2);

        await click(buttonByText('Close', modal(DELETE_DIALOG)));
        await waitFor(() => !modalOpen(DELETE_DIALOG), 'the dialog to close');
        await click(buttonByText('Delete again'));
        await waitFor(() => modalOpen(DELETE_DIALOG), 'the dialog to open');
        expect(choiceInputs()).toHaveLength(0);
        expect(q('[role="alert"]', modal(DELETE_DIALOG))).toBeNull();
        expect(confirmButton().textContent).toBe('Delete again');
        expect(deletes()).toHaveLength(1);
      });

      it('asks the same when the numbers show no files left, since the run cannot be asked for either', async () => {
        await askAgainUntilRefused(deletingBucket(DELETE_STALLED_AFTER_MS + MINUTE, { stats: { fileCount: 0, totalBytes: 0 } }));

        expect(choiceInputs().map((input) => input.value)).toEqual(['files', 'bucketOnly']);
        expect(choice('bucketOnly').checked).toBe(true);
        expect(modal(DELETE_DIALOG).textContent).toContain('Delete the bucket and its files');
        await click(confirmButton());
        await waitFor(() => deletes().length === 2, 'the second DELETE');
        expect(deletes()[1]!.query).toEqual({ force: 'true' });
      });

      it('is offered from the danger zone as well', async () => {
        server = installBucketServer({ records: [], bucket: deletingBucket(DELETE_STALLED_AFTER_MS + MINUTE) });
        server.deleteAnswer = answerAsTheServerDoes;
        await openPage();
        await click(dangerButton('Delete again…'));
        await click(confirmButton());
        await waitFor(() => q('[role="alert"]', modal(DELETE_DIALOG)) !== null, 'the refusal');

        expect(choiceInputs().map((input) => input.value)).toEqual(['files', 'bucketOnly']);
        await click(confirmButton());
        await waitFor(() => deletes().length === 2, 'the second DELETE');
        expect(deletes()[1]!.query).toEqual({ force: 'true' });
      });

      it('speaks Turkish', async () => {
        await askAgainUntilRefused(deletingBucket(DELETE_STALLED_AFTER_MS + MINUTE), 'tr');

        const dialog = modal(DELETE_DIALOG);
        expect(q('[role="alert"]', dialog)!.textContent).toBe(
          'Başka bir bucket bu depolama konumunu kullanıyor. Bucket’ı dosyaları olmadan silin ya da önce diğer bucket’ı kaldırın.',
        );
        expect(dialog.textContent).toContain('Yalnızca bucket’ı sil');
        expect(dialog.textContent).toContain('Dosyalar MinIO (on-prem) üzerinde kalır ve projenin depolama kullanımına saymaya devam eder.');
        expect(q<HTMLInputElement>('input[type="radio"][value="bucketOnly"]', dialog)!.checked).toBe(true);
        expect(confirmButton().textContent).toBe('Bucket’ı sil');
        expect(dialog.textContent).not.toContain('Delete the bucket only');
      });
    });

    it('speaks Turkish', async () => {
      server = installBucketServer({ records: [], bucket: deletingBucket(DELETE_STALLED_AFTER_MS + MINUTE) });
      await openPage({ locale: 'tr' });
      expect(text()).toContain('Silme bir süredir tamamlanmadı.');
      expect(buttonByText('Yeniden sil')).toBeTruthy();
      expect(buttonByText('Yeniden sil…')).toBeTruthy();
    });
  });

  describe('a delete that stopped with an error', () => {
    const REASON = 'Access denied by the provider';

    it('shows why on the page, with a way to try again or to keep the bucket', async () => {
      server = installBucketServer({ records: [], bucket: failedDeleteBucket(REASON) });
      await openPage();

      expect(text()).toContain('Deleting this bucket did not finish');
      expect(q('[role="alert"]')!.textContent).toContain(REASON);
      expect(text()).toContain('Files that were already removed stay removed. Try again once the cause is fixed, or keep the bucket.');
      expect(q('.detail-header')!.textContent).toContain('Deletion failed');
      expect(q(`button[aria-label="Deletion failed: ${REASON}"]`)).toBeTruthy();
      expect(buttonByText('Try again')).toBeTruthy();
      expect(buttonByText('Keep the bucket')).toBeTruthy();
      // The danger zone says it too, and offers the deletion again.
      expect(text()).toContain(`The last attempt to delete this bucket failed: ${REASON}`);
      expect(dangerButton('Delete again…')!.disabled).toBe(false);
      expect(dangerButton()).toBeUndefined();
    });

    it('reads the reason the bucket carries in its metadata, as an answer to an update does', async () => {
      server = installBucketServer({ records: [], bucket: bucketDetail({ metadata: { deleteError: REASON } }) });
      await openPage();
      expect(text()).toContain(`The last attempt to delete this bucket failed: ${REASON}`);
      expect(text()).toContain('Deleting this bucket did not finish');
      expect(dangerButton('Delete again…')!.disabled).toBe(false);
    });

    it('asks the question again, with the reason, when “Try again” is pressed', async () => {
      server = installBucketServer({ records: [], bucket: failedDeleteBucket(REASON, { stats: { fileCount: 3, totalBytes: 10 } }) });
      server.deleteAnswer = () => jsonResponse({ status: 'deleting' }, 202);
      await openPage();

      await click(buttonByText('Try again'));
      const dialog = modal(DELETE_DIALOG);
      expect(dialog.textContent).toContain(`The last attempt to delete this bucket with its files stopped: ${REASON}`);
      expect(dialog.textContent).toContain('Files that were already removed stay removed.');
      // The files are still there to be decided about: nothing is picked for the person, as the first time.
      expect(choiceInputs().map((input) => input.checked)).toEqual([false, false]);
      expect(confirmButton().disabled).toBe(true);
      await click(choice('files'));
      await click(confirmButton());
      await waitFor(() => deletes().length === 1, 'the DELETE');
      expect(deletes()[0]!.query).toEqual({ deleteFiles: 'true' });
      await waitFor(() => !modalOpen(DELETE_DIALOG), 'the dialog to close');
    });

    it('can still delete only the bucket after a failure', async () => {
      server = installBucketServer({ records: [], bucket: failedDeleteBucket(REASON, { stats: { fileCount: 3, totalBytes: 10 } }) });
      await openPage();
      await click(dangerButton('Delete again…'));
      await click(choice('bucketOnly'));
      await click(confirmButton());
      await waitFor(() => deletes().length === 1, 'the DELETE');
      expect(deletes()[0]!.query).toEqual({ force: 'true' });
    });

    it('keeps the bucket when asked to: it is switched on, and the failure is forgotten', async () => {
      server = installBucketServer({ records: [], bucket: failedDeleteBucket(REASON) });
      await openPage();

      await click(buttonByText('Keep the bucket'));
      await waitFor(() => patches().length === 1, 'the PATCH');
      expect(patches()[0]!.body).toEqual({ status: 'active' });
      await waitFor(() => toasts().length > 0, 'a notification');
      expect(toasts().at(-1)).toMatchObject({ color: 'green', message: 'Docs is kept and switched on again.' });
      await waitFor(() => !text().includes('Deleting this bucket did not finish'), 'the notice to go');
      expect(q('.detail-header')!.textContent).toContain('Active');
      expect(q('.detail-header')!.textContent).not.toContain('Deletion failed');
      expect(text()).not.toContain('The last attempt to delete this bucket failed');
      expect(dangerButton()!.disabled).toBe(false);
    });

    it('says why keeping it failed, and leaves the notice where it is', async () => {
      server = installBucketServer({ records: [], bucket: failedDeleteBucket(REASON) });
      server.fail.patch = refusal(409, 'This bucket is being deleted.', 'bucket_deleting');
      await openPage();

      await click(buttonByText('Keep the bucket'));
      await waitFor(() => toasts().some((toast) => toast.color === 'red'), 'the failure');
      expect(toasts().find((toast) => toast.color === 'red')!.message).toBe('This bucket is being deleted, so it cannot be changed.');
      expect(text()).toContain('Deleting this bucket did not finish');
    });

    it('shows a person who can only read the reason, and no way to act on it', async () => {
      server = installBucketServer({ level: 'read', records: [], bucket: failedDeleteBucket(REASON) });
      await openPage();
      await waitFor(() => nameInput().disabled, 'the fields to lock');
      expect(q('[role="alert"]')!.textContent).toContain(REASON);
      expect(buttonByText('Try again')).toBeUndefined();
      expect(buttonByText('Keep the bucket')).toBeUndefined();
    });

    it('does not show the failure of a run that has been asked for again', async () => {
      // The server clears `deleteError` when it marks the bucket again; a stale copy never hides the running notice.
      server = installBucketServer({ records: [], bucket: deletingBucket(MINUTE, { deleteError: REASON, metadata: { deleteError: REASON } }) });
      await openPage();
      expect(text()).not.toContain('Deleting this bucket did not finish');
      expect(text()).not.toContain('The last attempt to delete this bucket failed');
      expect(q('.detail-header')!.textContent).toContain('Deleting…');
    });

    it('speaks Turkish', async () => {
      server = installBucketServer({ records: [], bucket: failedDeleteBucket(REASON) });
      await openPage({ locale: 'tr' });
      expect(text()).toContain('Bu bucket’ın silinmesi tamamlanmadı');
      expect(q('.detail-header')!.textContent).toContain('Silme başarısız');
      expect(buttonByText('Yeniden dene')).toBeTruthy();
      expect(buttonByText('Bucket’ı tut')).toBeTruthy();
    });
  });
});

/* ── The API tab ─────────────────────────────────────────────────────────── */

describe('the API tab', () => {
  it('gives the real address, this bucket’s key and the header to send', async () => {
    server = installBucketServer({ records: [] });
    await openPage({ tab: 'api' });
    await waitFor(() => text().includes(`${window.location.origin}/api/client/v1`), 'the real host');

    expect(text()).toContain('docs');
    expect(text()).toContain('Authorization: Bearer YOUR_API_TOKEN');
    expect(q('button[aria-label="Copy the base URL"]')).toBeTruthy();
    expect(q('button[aria-label="Copy the bucket key"]')).toBeTruthy();
    expect(q('button[aria-label="Copy the authorization header"]')).toBeTruthy();
    const token = qa<HTMLAnchorElement>('a').find((anchor) => anchor.textContent === 'Create a token');
    expect(token?.getAttribute('href')).toBe('/dashboard/tokens');
  });

  it('opens the documentation of the Files API', async () => {
    server = installBucketServer({ records: [] });
    await openPage({ tab: 'api' });
    await click(buttonByText('Docs'));
    expect(openDocs).toHaveBeenCalledWith('api-files');
  });

  it('shows the six calls, each with its request line and a sample in the language chosen', async () => {
    server = installBucketServer({ records: [] });
    await openPage({ tab: 'api' });
    await waitFor(() => text().includes(window.location.origin), 'the real host');

    const headings = qa('h3').map((heading) => heading.textContent);
    expect(headings).toEqual(['List files', 'List a folder', 'Upload a file', 'Upload into a folder', 'Download a file', 'Delete a file']);
    expect(text()).toContain('GET /api/client/v1/files/buckets/docs/objects');
    expect(text()).toContain('POST /api/client/v1/files/buckets/docs/objects');
    expect(text()).toContain('GET /api/client/v1/files/buckets/docs/objects/{key}/download');
    expect(text()).toContain('DELETE /api/client/v1/files/buckets/docs/objects/{key}');

    const regions = samples;
    expect(regions()).toHaveLength(6);
    expect(regions()[0]!.getAttribute('aria-label')).toBe('List files, cURL sample');
    expect(regions()[0]!.textContent).toBe(buildSnippet('list', 'curl', { origin: window.location.origin, bucketKey: 'docs' }));
    expect(regions()[0]!.getAttribute('tabindex')).toBe('0');
    expect(text()).toContain('Needs curl.');

    await click(q('input[type="radio"][value="typescript"]'));
    expect(regions()[0]!.getAttribute('aria-label')).toBe('List files, TypeScript sample');
    expect(regions()[0]!.textContent).toContain("client.files.list('docs'");
    expect(regions()[0]!.textContent).toContain(`baseURL: '${window.location.origin}'`);
    expect(text()).toContain('npm install @cognipeer/console-sdk');

    await click(q('input[type="radio"][value="python"]'));
    expect(regions()[5]!.textContent).toContain('import httpx');
    expect(regions()[5]!.textContent).toContain('httpx.delete');
    expect(text()).toContain('pip install httpx');
  });

  it('copies a sample exactly as shown', async () => {
    server = installBucketServer({ records: [] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await openPage({ tab: 'api' });

    await click(q('button[aria-label="Copy the sample for “Download a file”"]'));
    expect(writeText).toHaveBeenCalledTimes(1);
    const sample = samples()[4]!.textContent;
    expect(writeText).toHaveBeenCalledWith(sample);
    expect(sample).toContain(encodeURIComponent(SAMPLE_FILE_KEY));
    await waitFor(() => text().includes('Copied'), 'the confirmation');
  });

  it('explains the key a file gets, with the answers a caller reads it from', async () => {
    server = installBucketServer({ records: [] });
    await openPage({ tab: 'api' });
    expect(text()).toContain(`A file’s key is generated when it is uploaded (for example ${SAMPLE_FILE_KEY})`);
    const regions = qa('pre[role="region"]');
    expect(regions[6]!.getAttribute('aria-label')).toBe('Example answer of an upload');
    expect(JSON.parse(regions[6]!.textContent!).file).toMatchObject({ bucketKey: 'docs', key: SAMPLE_FILE_KEY });
    expect(JSON.parse(regions[7]!.textContent!)).toMatchObject({ nextCursor: null });
  });

  it('says what a disabled bucket still answers', async () => {
    server = installBucketServer({ records: [], bucket: bucketDetail({ status: 'disabled' }) });
    await openPage({ tab: 'api' });
    const notes = qa('[role="note"]').map((note) => note.textContent);
    expect(notes).toContain('This bucket is disabled. Listing and downloading work, but uploads and deletes are refused until it is enabled.');
  });

  it('is shown to someone who can only read, too: it only reads', async () => {
    server = installBucketServer({ level: 'read', records: [] });
    await openPage({ tab: 'api' });
    expect(text()).toContain('Connect from code');
    expect(qa('pre[role="region"]').length).toBeGreaterThan(5);
  });

  it('speaks Turkish', async () => {
    server = installBucketServer({ records: [] });
    await openPage({ tab: 'api', locale: 'tr' });
    await waitFor(() => text().includes('Koddan bağlanın'), 'the Turkish tab');
    expect(text()).toContain('Örnekler');
    expect(text()).toContain('Dosya anahtarları');
    expect(qa('h3').map((heading) => heading.textContent)).toContain('Dosyaları listele');
  });
});

/* ── Import from storage ─────────────────────────────────────────────────── */

describe('Import from storage', () => {
  async function openImport() {
    await click(q('button[aria-label="More actions"]'));
    await click(qa('[role="menuitem"]').find((item) => item.textContent === 'Import from storage…'));
    expect(modalOpen('import-modal')).toBe(true);
  }
  const importCalls = () => server.api.to('POST', '/api/files/buckets/docs/import');
  const counts = () =>
    Object.fromEntries(qa('dl > div', modal('import-modal')).map((item) => [q('dt', item)!.textContent, q('dd', item)!.textContent]));

  it('explains what it does, where it looks, and that nothing in the storage is changed', async () => {
    server = installBucketServer({ records: [] });
    await openPage({ tab: 'files' });
    await openImport();

    const dialog = modal('import-modal');
    expect(dialog.textContent).toContain('Register the objects that already sit in the storage provider');
    expect(dialog.textContent).toContain('s3://files/console/t1/minio/docs/');
    expect(dialog.textContent).toContain('Nothing in the storage is changed or deleted.');
    expect(dialog.textContent).toContain('Imported files come without a Markdown copy.');
    expect(importCalls()).toHaveLength(0);
  });

  it('scans page after page, shows the counts as they grow and refreshes the files at the end', async () => {
    server = installBucketServer({ records: [] });
    server.importPages = [
      { scanned: 200, imported: 150, skipped: 50, nextCursor: 'c1' },
      { scanned: 40, imported: 40, skipped: 0 },
    ];
    await openPage({ tab: 'files' });
    const before = server.api.to('GET', '/api/files/buckets/docs/objects').length;
    await openImport();

    await click(q('[data-testid="import-start"]'));
    await waitFor(() => modal('import-modal').textContent!.includes('Import finished.'), 'the end of the scan');
    expect(importCalls().map((call) => call.body)).toEqual([{ limit: 200 }, { cursor: 'c1', limit: 200 }]);
    expect(counts()).toEqual({ Scanned: '240', Imported: '190', Skipped: '50' });
    expect(modal('import-modal').textContent).toContain('Import finished. Files added: 190.');
    // What was imported shows up in the list.
    await waitFor(() => server.api.to('GET', '/api/files/buckets/docs/objects').length > before, 'the files to be read again');

    await click(q('[data-testid="import-close"]'));
    await waitFor(() => !modalOpen('import-modal'), 'the dialog to close');
  });

  it('says so when there was nothing new', async () => {
    server = installBucketServer({ records: [] });
    server.importPages = [{ scanned: 5, imported: 0, skipped: 5 }];
    await openPage({ tab: 'files' });
    await openImport();
    await click(q('[data-testid="import-start"]'));
    await waitFor(() => modal('import-modal').textContent!.includes('Nothing new was found'), 'the end of the scan');
    expect(counts()).toEqual({ Scanned: '5', Imported: '0', Skipped: '5' });
  });

  it('can be stopped between two pages and continued from where it left off', async () => {
    server = installBucketServer({ records: [] });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    server.api.on('POST', /\/import$/, async () => {
      calls += 1;
      if (calls === 1) {
        await held;
        return { scanned: 200, imported: 100, skipped: 100, nextCursor: 'c1' };
      }
      return { scanned: 30, imported: 30, skipped: 0 };
    });
    await openPage({ tab: 'files' });
    await openImport();

    await click(q('[data-testid="import-start"]'));
    await waitFor(() => Boolean(q('[data-testid="import-stop"]')), 'the Stop button');
    expect(modal('import-modal').textContent).toContain('Scanning the storage…');
    await click(q('[data-testid="import-stop"]'));
    await act(async () => release());
    await waitFor(() => modal('import-modal').textContent!.includes('The import was stopped.'), 'the stop');
    expect(counts()).toEqual({ Scanned: '200', Imported: '100', Skipped: '100' });
    expect(importCalls()).toHaveLength(1);

    await click(q('[data-testid="import-resume"]'));
    await waitFor(() => modal('import-modal').textContent!.includes('Import finished.'), 'the end of the scan');
    expect(importCalls().map((call) => call.body)).toEqual([{ limit: 200 }, { cursor: 'c1', limit: 200 }]);
    expect(counts()).toEqual({ Scanned: '230', Imported: '130', Skipped: '100' });
  });

  it('shows the server’s reason when the scan fails, and Retry goes on from the same place', async () => {
    server = installBucketServer({ records: [] });
    let calls = 0;
    server.api.on('POST', /\/import$/, () => {
      calls += 1;
      if (calls === 1) return { scanned: 200, imported: 200, skipped: 0, nextCursor: 'c1' };
      if (calls === 2) return refusal(409, 'The bucket is disabled.', 'bucket_inactive');
      return { scanned: 10, imported: 10, skipped: 0 };
    });
    await openPage({ tab: 'files' });
    await openImport();

    await click(q('[data-testid="import-start"]'));
    await waitFor(() => modal('import-modal').textContent!.includes('The import stopped with an error'), 'the failure');
    expect(modal('import-modal').textContent).toContain('This bucket is disabled. Enable it to make changes.');
    expect(counts()).toEqual({ Scanned: '200', Imported: '200', Skipped: '0' });

    await click(q('[data-testid="import-resume"]'));
    await waitFor(() => modal('import-modal').textContent!.includes('Import finished.'), 'the end of the scan');
    expect(importCalls().map((call) => call.body)).toEqual([{ limit: 200 }, { cursor: 'c1', limit: 200 }, { cursor: 'c1', limit: 200 }]);
    expect(counts()).toEqual({ Scanned: '210', Imported: '210', Skipped: '0' });
  });

  describe('when another bucket uses the same storage location', () => {
    it('says so instead of a generic failure, and shows what was scanned (nothing)', async () => {
      server = installBucketServer({ records: [] });
      server.api.on('POST', /\/import$/, () => refusal(409, 'Another bucket uses this storage location, so objects in it cannot be imported.', 'storage_location_shared'));
      await openPage({ tab: 'files' });
      await openImport();

      await click(q('[data-testid="import-start"]'));

      await waitFor(() => modal('import-modal').textContent!.includes('The import stopped with an error'), 'the failure');
      expect(q('[role="alert"]', modal('import-modal'))!.textContent).toContain(
        'Another bucket uses this storage location, so objects in it cannot be imported.',
      );
      expect(modal('import-modal').textContent).not.toContain('Something went wrong');
      expect(counts()).toEqual({ Scanned: '0', Imported: '0', Skipped: '0' });
      expect(importCalls()).toHaveLength(1);
      // Asking again would answer the same until the other bucket is gone: the dialog offers to close, not to retry.
      expect(q('[data-testid="import-resume"]')).toBeNull();
      // The person can leave, and nothing else was touched.
      await click(q('[data-testid="import-close"]'));
      await waitFor(() => !modalOpen('import-modal'), 'the dialog to close');
    });

    it('stops short of the objects it had already read, and says how far it got', async () => {
      server = installBucketServer({ records: [] });
      let calls = 0;
      server.api.on('POST', /\/import$/, () => {
        calls += 1;
        return calls === 1
          ? { scanned: 200, imported: 120, skipped: 80, nextCursor: 'c1' }
          : refusal(409, 'Another bucket uses this storage location, so objects in it cannot be imported.', 'storage_location_shared');
      });
      await openPage({ tab: 'files' });
      await openImport();
      await click(q('[data-testid="import-start"]'));

      await waitFor(() => modal('import-modal').textContent!.includes('The import stopped with an error'), 'the failure');
      expect(counts()).toEqual({ Scanned: '200', Imported: '120', Skipped: '80' });
      expect(q('[data-testid="import-resume"]')).toBeNull();
      expect(q('[role="alert"]', modal('import-modal'))!.textContent).toContain('Another bucket uses this storage location');
    });

    it('speaks Turkish', async () => {
      server = installBucketServer({ records: [] });
      server.api.on('POST', /\/import$/, () => refusal(409, 'Another bucket uses this storage location, so objects in it cannot be imported.', 'storage_location_shared'));
      await openPage({ tab: 'files', locale: 'tr' });
      await click(q('button[aria-label="Diğer işlemler"]'));
      await click(qa('[role="menuitem"]').find((item) => /içe aktar/i.test(item.textContent ?? '')));
      await click(q('[data-testid="import-start"]'));

      await waitFor(() => modal('import-modal').textContent!.includes('Başka bir bucket bu depolama konumunu kullanıyor'), 'the failure');
      expect(modal('import-modal').textContent).toContain('konumdaki nesneler içe aktarılamaz');
      expect(modal('import-modal').textContent).not.toContain('Another bucket');
    });
  });

  it('starts from the explanation again every time it is opened', async () => {
    server = installBucketServer({ records: [] });
    server.importPages = [{ scanned: 1, imported: 1, skipped: 0 }];
    await openPage({ tab: 'files' });
    await openImport();
    await click(q('[data-testid="import-start"]'));
    await waitFor(() => modal('import-modal').textContent!.includes('Import finished.'), 'the end of the scan');
    await click(q('[data-testid="import-close"]'));
    await waitFor(() => !modalOpen('import-modal'), 'the dialog to close');

    await openImport();
    expect(q('[data-testid="import-start"]')).toBeTruthy();
    expect(modal('import-modal').textContent).not.toContain('Import finished.');
  });
});
