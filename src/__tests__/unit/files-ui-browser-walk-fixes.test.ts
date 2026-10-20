// @vitest-environment jsdom
/**
 * Behaviour found by walking the Document Store (and the provider forms behind it) in a real browser, kept as
 * component tests so it stays fixed:
 * - a provider form draws each field as a controlled input from its first render (React warned on every open);
 * - the Providers list opens narrowed to the domain its address names (`?domain=file`, the link the Document Store
 *   offers when there is no file provider yet), ignores a name that is no domain, and opens its Add form on that
 *   domain's services;
 * - the wording of the upload screen's Markdown option and of the file search says what the server does;
 * - the delete dialog keeps what it showed once it was answered, while it fades out;
 * - the bucket list keeps its name and number columns readable beside a long provider message;
 * - the bucket page header gives its title room on a phone, its facts under the title are told apart by dots that a
 *   wrapped line cannot strand, and the folder path keeps its icon beside the label;
 * - the Files tab keeps a size and an age on one line when the table is narrow.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, createElement as h, useReducer, useState } from 'react';
import { useForm } from '@mantine/form';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  q,
  qa,
  settle,
  text,
  wait,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';
import { bucketView, limitsPayload, newQueryClient, until as untilReady } from '../helpers/filesUploadDetailHarness';
import { MINIO as MINIO_PROVIDER, MIB, bucketDetail, deletingBucket, fileRecord, installBucketServer } from '../helpers/filesBucketUi';

const nav = vi.hoisted(() => ({ search: '', pathname: '/dashboard/providers' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));
// The drawer is not what the bucket page is mounted for here.
vi.mock('@/components/files/detail/FileDetailDrawer', () => ({ FileDetailDrawer: () => null }));

import { ProviderFormRenderer } from '@/components/providers/ProviderFormRenderer';
import TenantProviders from '@/components/settings/TenantProviders';
import { UploadFilesForm } from '@/components/files/upload/UploadFilesForm';
import BucketPage from '@/components/files/bucket/BucketPage';
import { FolderPath } from '@/components/files/bucket/FileBrowseParts';
import DeleteBucketDialog from '@/components/files/bucket/DeleteBucketDialog';
import BucketListPage from '@/components/files/list/BucketListPage';
import { DocsDrawerProvider } from '@/components/docs/DocsDrawerContext';
import type { BucketDetail, BucketListItem, FileProviderListItem } from '@/components/files/filesApi';
import type { ProviderFormSchema } from '@/lib/providers';
import { SERVICE_CATALOG } from '@/lib/services/serviceCatalog';

let mounted: Mounted | undefined;
let api: ApiMock;

// A whole page mounts in these tests; on a busy machine that takes longer than the helper's default four seconds.
const until = (check: () => boolean, label: string, ms = 15_000) => untilReady(check, label, ms);

beforeAll(() => installDomStubs());
beforeEach(() => {
  nav.search = '';
  nav.pathname = '/dashboard/providers';
  notify.show.mockClear();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/* ── Provider forms: controlled from the first render ────────────────────── */

const SCHEMA: ProviderFormSchema = {
  sections: [
    {
      title: 'Endpoint',
      fields: [
        { name: 'endpoint', label: 'Endpoint URL', type: 'text', scope: 'settings', required: true },
        { name: 'secretKey', label: 'Secret access key', type: 'password' },
        { name: 'port', label: 'Port', type: 'number', scope: 'settings' },
        {
          name: 'region',
          label: 'Region',
          type: 'select',
          scope: 'settings',
          options: [
            { label: 'EU West', value: 'eu-west-1' },
            { label: 'US East', value: 'us-east-1' },
          ],
        },
      ],
    },
  ],
};

const controlWarnings = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => call.map(String).join(' ')).filter((message) => /uncontrolled|controlled input/i.test(message));

describe('a provider form', () => {
  it('draws every input as a controlled one before it has a value, so filling it in never makes React warn', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let set: (name: string, value: unknown) => void = () => undefined;
    function Harness() {
      // Nothing in the form's values yet: the way a provider that stores no value for an optional field opens.
      const form = useForm<Record<string, unknown>>({ initialValues: {} });
      set = (name, value) => form.setFieldValue(name, value);
      return h(ProviderFormRenderer, { schema: SCHEMA, form });
    }
    mounted = await mount(h(Harness));

    const inputs = qa<HTMLInputElement>('input');
    expect(inputs.length).toBeGreaterThanOrEqual(3);
    for (const input of inputs) expect(input.value).toBe('');
    const endpoint = () => qa('.form-field').find((f) => f.textContent?.includes('Endpoint URL'))!.querySelector<HTMLInputElement>('input')!;

    await act(async () => {
      set('endpoint', 'http://127.0.0.1:19000');
      set('secretKey', 's3cret');
      set('port', 9000);
      set('region', 'eu-west-1');
    });
    await wait(20);
    expect(endpoint().value).toBe('http://127.0.0.1:19000');
    expect(controlWarnings(errors)).toEqual([]);
  });
});

/* ── The Providers list opens on the domain the address names ────────────── */

describe('the Providers list', () => {
  const ROWS = [
    { _id: 'p1', key: 'minio-docs', label: 'MinIO (on-prem)', type: 'file', driver: 's3-compatible-files', status: 'active', projectIds: ['proj'] },
    { _id: 'p2', key: 'gpt-main', label: 'GPT main', type: 'model', driver: 'openai', status: 'active', projectIds: ['proj'] },
  ];
  const labels = () => qa('tbody tr').map((row) => row.textContent ?? '');
  const domainSelect = () => q<HTMLSelectElement>('select[aria-label="Domain"]')!;

  async function open() {
    api = installApiMock([
      ['GET', '/api/providers', () => ({ providers: ROWS })],
      ['GET', '/api/auth/session', () => ({ effectivePermissions: {} })],
      ['GET', '/api/providers/drivers', () => ({ drivers: [{ id: 's3-compatible-files', version: '1.0.0', domains: ['file'], display: { label: 'S3-compatible' } }] })],
      ['GET', /^\/api\/providers\/drivers\/[^/]+\/form$/, () => ({ schema: SCHEMA })],
    ]);
    let bump: () => void = () => undefined;
    function Harness() {
      const [, rerender] = useReducer((n: number) => n + 1, 0);
      bump = rerender;
      return h(TenantProviders);
    }
    mounted = await mount(h(Harness));
    await until(() => api.to('GET', '/api/providers').length > 0, 'the provider request');
    await settle(50);
    return () => act(async () => bump());
  }

  it('shows every domain when the address names none', async () => {
    await open();
    expect(labels().some((row) => row.includes('MinIO (on-prem)'))).toBe(true);
    expect(labels().some((row) => row.includes('GPT main'))).toBe(true);
    expect(domainSelect().value).toBe('all');
  });

  it('opens narrowed to the file providers for ?domain=file, and follows the address when it changes', async () => {
    nav.search = 'domain=file';
    const refresh = await open();
    expect(domainSelect().value).toBe('file');
    expect(labels().some((row) => row.includes('MinIO (on-prem)'))).toBe(true);
    expect(labels().some((row) => row.includes('GPT main'))).toBe(false);

    nav.search = '';
    await refresh();
    await settle(20);
    expect(domainSelect().value).toBe('all');
    expect(labels().some((row) => row.includes('GPT main'))).toBe(true);
  });

  it('keeps a domain the address names selectable when no provider is of that domain yet', async () => {
    nav.search = 'domain=vector';
    await open();
    expect(domainSelect().value).toBe('vector');
    expect(labels().some((row) => row.includes('MinIO (on-prem)') || row.includes('GPT main'))).toBe(false);
  });

  it.each(['nonsense', 'constructor', '__proto__', '', '  '])('shows every domain for an address that names %j, which is no domain', async (name) => {
    nav.search = `domain=${encodeURIComponent(name)}`;
    await open();
    expect(domainSelect().value).toBe('all');
    expect([...domainSelect().options].map((option) => option.value)).toEqual(['all', 'file', 'model']);
    expect(labels().some((row) => row.includes('MinIO (on-prem)'))).toBe(true);
    expect(labels().some((row) => row.includes('GPT main'))).toBe(true);
  });

  describe('Add provider', () => {
    const form = () => q('.form-overlay');
    const filterSelect = () => q<HTMLSelectElement>('select[aria-label="Filter by domain"]', form() ?? document.body);
    const serviceNames = () => qa('.service-card-name', form() ?? document.body).map((node) => node.textContent ?? '');
    const catalogNames = (domain: string) => SERVICE_CATALOG.filter((service) => service.domains.includes(domain as never)).map((service) => service.name);
    const createButton = () => qa<HTMLButtonElement>('.form-overlay button').find((button) => button.textContent?.trim() === 'Create provider');
    const driverRequests = () => api.to('GET', '/api/providers/drivers');

    async function add() {
      await click(buttonByText('Add provider'));
      await until(() => Boolean(filterSelect()), 'the Add form');
      await settle(40);
    }

    it('opens on the services of the domain the address names, with their drivers already loaded', async () => {
      nav.search = 'domain=file';
      await open();
      await add();

      expect(filterSelect()!.value).toBe('file');
      expect(catalogNames('file').length).toBeGreaterThan(1);
      expect(serviceNames().sort()).toEqual(catalogNames('file').sort());
      expect(driverRequests().map((call) => call.query)).toEqual([{ domain: 'file' }]);

      // A service of that domain goes straight on to its form: nothing is waiting for a domain change.
      await click(qa('[role="button"]', form()!).find((card) => card.querySelector('.service-card-name')?.textContent === 'S3-compatible storage'));
      await until(() => Boolean(createButton()) && createButton()!.disabled === false, 'the form to be ready');
      expect(driverRequests()).toHaveLength(1);
      expect(api.to('GET', '/api/providers/drivers/s3-compatible-files/form')).toHaveLength(1);
    });

    it('opens on all services when the address names no domain', async () => {
      await open();
      await add();
      expect(filterSelect()!.value).toBe('all');
      expect(serviceNames().length).toBe(SERVICE_CATALOG.length);
      expect(driverRequests()).toHaveLength(0);
    });

    it('opens on all services when the address names a domain that the form’s filter does not offer', async () => {
      nav.search = 'domain=image';
      await open();
      // The list still narrows to the domain, so a provider of it is found.
      expect(domainSelect().value).toBe('image');
      await add();
      expect(filterSelect()!.value).toBe('all');
      expect(serviceNames().length).toBe(SERVICE_CATALOG.length);
      expect(driverRequests()).toHaveLength(0);
    });

    it('starts from the address again each time the form is opened', async () => {
      nav.search = 'domain=file';
      await open();
      await add();
      await click(qa('[role="button"]', form()!).find((card) => card.querySelector('.service-card-name')?.textContent === 'S3-compatible storage'));
      await settle(60);
      await click(buttonByText('Cancel', form()!));
      await settle(60);
      expect(form()).toBeNull();

      await add();
      expect(filterSelect()!.value).toBe('file');
      expect(serviceNames().sort()).toEqual(catalogNames('file').sort());
    });
  });
});

/* ── Wording that says what the server does ──────────────────────────────── */

describe('the upload screen', () => {
  async function openUpload(locale: 'en' | 'tr') {
    api = installApiMock([
      ['GET', '/api/files/limits', () => limitsPayload()],
      ['GET', '/api/auth/session', () => ({ effectivePermissions: { files: 'write' } })],
    ]);
    mounted = await mount(
      h(
        QueryClientProvider,
        { client: newQueryClient() },
        h(UploadFilesForm, { opened: true, onClose: vi.fn(), onUploaded: vi.fn(), bucket: bucketView(), folder: '' }),
      ),
      locale,
    );
    await until(() => Boolean(q('input[type="file"]')), 'the form');
    await until(() => !text().includes('Checking the upload limits') && !text().includes('Yükleme sınırları kontrol'), 'the limits');
  }

  it('does not promise Markdown copies of images, in English', async () => {
    await openUpload('en');
    expect(text()).toContain('Works for PDF, Word, PowerPoint (.pptx), Excel, HTML and text files such as CSV and JSON.');
    expect(text()).toContain('Other files, such as images, are stored without a Markdown copy.');
    expect(text()).not.toMatch(/HTML, text and images/);
  });

  it('does not promise Markdown copies of images, in Turkish', async () => {
    await openUpload('tr');
    expect(text()).toContain('PDF, Word, PowerPoint (.pptx), Excel, HTML ile CSV ve JSON gibi metin dosyalarında çalışır.');
    expect(text()).toContain('Görseller gibi diğer dosyalar Markdown kopyası olmadan saklanır.');
    expect(text()).not.toContain('metin ve görsellerde');
  });
});

describe('the bucket list search box', () => {
  const placeholderIn = async (locale: 'en' | 'tr') => {
    api = installApiMock([
      ['GET', '/api/auth/session', () => ({ effectivePermissions: { files: 'write' } })],
      ['GET', '/api/files/buckets', () => ({ buckets: [{ id: 'b1', tenantId: 't1', key: 'docs', name: 'Docs', providerKey: 'minio', status: 'active', stats: { fileCount: 0, totalBytes: 0 }, providerHealth: { state: 'ok' } }] })],
      ['GET', '/api/files/providers', () => ({ providers: [] })],
    ]);
    mounted = await mount(h(QueryClientProvider, { client: newQueryClient() }, h(BucketListPage)), locale);
    await until(() => Boolean(q('.ds-toolbar-search input')), 'the list');
    return q<HTMLInputElement>('.ds-toolbar-search input')?.getAttribute('placeholder') ?? '';
  };

  it('has a Turkish hint that fits the box the English one fits in (a longer one was cut off in the browser)', async () => {
    const en = await placeholderIn('en');
    await mounted?.unmount();
    mounted = undefined;
    const tr = await placeholderIn('tr');
    expect(en).toBe('Search buckets by name, key or description…');
    expect(tr).toBe('Ada, anahtara veya açıklamaya göre ara…');
    expect(tr.length).toBeLessThanOrEqual(en.length);
  });
});

describe('the Files tab search box', () => {
  async function openFilesTab(locale: 'en' | 'tr') {
    // A bucket with files: an empty one shows its own empty state, which has no toolbar to search with.
    installBucketServer({ records: [fileRecord('q3-report.pdf')] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    nav.pathname = '/dashboard/files/docs';
    mounted = await mount(
      h(QueryClientProvider, { client }, h(DocsDrawerProvider, { value: { openDocs: vi.fn() }, children: h(BucketPage, { bucketKey: 'docs' }) })),
      locale,
    );
    await until(() => qa('tbody tr').length > 0, 'the Files tab');
  }

  it('says it searches by name, because the server matches the name and not the key', async () => {
    await openFilesTab('en');
    const search = q<HTMLInputElement>('input[placeholder^="Search files"]');
    expect(search?.getAttribute('placeholder')).toBe('Search files by name…');
  });

  it('says so in Turkish too', async () => {
    await openFilesTab('tr');
    expect(q<HTMLInputElement>('input[placeholder^="Dosyaları"]')?.getAttribute('placeholder')).toBe('Dosyaları ada göre ara…');
  });
});

/* ── The delete dialog keeps what it showed once it was answered ─────────── */

describe('the delete bucket dialog', () => {
  const shown = () => text();

  async function openDialog() {
    api = installApiMock([
      ['DELETE', '/api/files/buckets/docs', () => jsonResponse({ status: 'deleting' }, 202)],
      ['GET', '/api/auth/session', () => ({ effectivePermissions: { files: 'write' } })],
    ]);
    const onClose = vi.fn();
    const client = newQueryClient();
    let setBucket: (bucket: BucketDetail) => void = () => undefined;
    function Harness() {
      const [bucket, set] = useState<BucketDetail>(bucketDetail());
      setBucket = set;
      // The parent keeps the dialog open: the closing animation is the moment between `onClose` and its unmount.
      return h(QueryClientProvider, { client }, h(DeleteBucketDialog, { bucket, opened: true, onClose }));
    }
    mounted = await mount(h(Harness));
    await until(() => Boolean(q('[data-testid="delete-bucket-confirm"]')), 'the dialog');
    return { onClose, setBucket: (bucket: BucketDetail) => act(async () => setBucket(bucket)) };
  }

  it('does not swap to "already being deleted" while it fades out after the delete was queued', async () => {
    const { onClose, setBucket } = await openDialog();
    expect(shown()).toContain('Delete the bucket “Docs”?');

    await click(qa<HTMLInputElement>('input[type="radio"]')[0]);
    await click(q('[data-testid="delete-bucket-confirm"]'));
    await until(() => onClose.mock.calls.length === 1, 'the dialog closing');
    expect(api.to('DELETE', '/api/files/buckets/docs')).toHaveLength(1);

    // The page reads the bucket again and it now says it is deleting: the dialog still shows what was asked.
    await setBucket(deletingBucket(1000));
    await wait(30);
    expect(shown()).not.toContain('already being deleted');
    expect(shown()).toContain('Delete the bucket “Docs”?');
  });

  it('still switches to "already being deleted" when the bucket starts deleting while the dialog is open and unanswered', async () => {
    const { setBucket } = await openDialog();
    await setBucket(deletingBucket(1000));
    await until(() => text().includes('already being deleted'), 'the notice');
    expect(text()).not.toContain('Delete the bucket “Docs”?');
  });
});

/* ── The bucket list keeps its columns readable ──────────────────────────── */

describe('the bucket list table', () => {
  const LONG_REASON =
    'The secret access key is wrong, or the region or path-style setting does not match the server. Behind a reverse proxy, the Host header must be forwarded unchanged (nginx: proxy_set_header Host $http_host).';
  const BROKEN = {
    ...MINIO_PROVIDER,
    key: 'minio-broken',
    label: 'MinIO (wrong secret)',
    providerHealth: { state: 'failed', testedAt: new Date().toISOString(), message: LONG_REASON },
  } as unknown as FileProviderListItem;
  const BUCKET = {
    id: 'b1',
    tenantId: 't1',
    key: 'legacy-exports',
    name: 'Legacy exports',
    providerKey: 'minio-broken',
    status: 'active',
    createdBy: 'u1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stats: { fileCount: 1284, totalBytes: 3_400_000_000 },
    providerHealth: BROKEN.providerHealth,
    provider: BROKEN,
  } as unknown as BucketListItem;

  it('gives the name a width of its own, and keeps counts, sizes and ages on one line, beside a long provider message', async () => {
    api = installApiMock([
      ['GET', '/api/auth/session', () => ({ effectivePermissions: { files: 'write' } })],
      ['GET', '/api/files/buckets', () => ({ buckets: [BUCKET] })],
      ['GET', '/api/files/providers', () => ({ providers: [BROKEN] })],
    ]);
    mounted = await mount(h(QueryClientProvider, { client: newQueryClient() }, h(BucketListPage)));
    await until(() => qa('tbody tr').length === 1, 'the row');

    const row = q('tbody tr')!;
    const cells = qa('td', row);
    const link = q<HTMLAnchorElement>('a[href="/dashboard/files/legacy-exports"]', row)!;
    expect(link.closest<HTMLElement>('div.ds-col')!.style.minWidth).toBe('200px');
    // The provider's message wraps inside a capped block, it does not widen the column.
    expect(q<HTMLElement>('div.ds-col', cells[1])!.style.maxWidth).toBe('380px');
    expect(cells[1].textContent).toContain(LONG_REASON);
    for (const index of [2, 3, 5]) {
      expect(q<HTMLElement>('span', cells[index])!.style.whiteSpace, `column ${index}`).toBe('nowrap');
    }
  });
});

/* ── The bucket page header and the folder path on a phone ───────────────── */

describe('the bucket page header', () => {
  async function openBucketPage() {
    installBucketServer({ records: [] });
    nav.pathname = '/dashboard/files/docs';
    mounted = await mount(
      h(QueryClientProvider, { client: newQueryClient() }, h(DocsDrawerProvider, { value: { openDocs: vi.fn() }, children: h(BucketPage, { bucketKey: 'docs' }) })),
    );
    await until(() => Boolean(q('header.detail-header')), 'the header');
  }

  it('sits inside the page container whose stylesheet lets the actions wrap under the title', async () => {
    await openBucketPage();
    const header = q('header.detail-header')!;
    // The container is the module's `page` class (the shared layout's own wrapper is `ds-page`).
    const wrapper = header.closest<HTMLElement>('[class*="page"]:not(.ds-page)');
    expect(wrapper, 'a wrapper with the page class').not.toBeNull();
    expect(wrapper!.className).not.toContain('ds-page');
    expect(wrapper!.contains(header)).toBe(true);

    const css = readFileSync(join(process.cwd(), 'src/components/files/bucket/bucket.module.css'), 'utf8');
    expect(css).toMatch(/\.page :global\(\.detail-header\) \{\s*flex-wrap: wrap;/);
    // The title keeps a basis to wrap against; without one the actions never move and the title shrinks to a letter.
    expect(css).toMatch(/\.page :global\(\.detail-header\) > :global\(\.detail-icon\) \+ div \{\s*flex: 1 1 180px;/);
  });

  it('tells the facts under the title apart with dots that belong to the fact after them, so a wrapped line never ends in one or starts with one', async () => {
    await openBucketPage();
    const row = q<HTMLElement>('.detail-meta-row [class*="factsRow"]')!;
    expect(row, 'the row of facts').not.toBeNull();
    const facts = Array.from(row.children) as HTMLElement[];
    expect(facts.map((fact) => fact.textContent)).toEqual([
      'docs',
      expect.stringMatching(/^MinIO \(on-prem\) · \S/),
      expect.stringMatching(/^Connected · /),
      expect.stringMatching(/^[\d.,]+ files? · /),
    ]);
    // The key and the health chip carry no dot of their own; the provider and the size do.
    expect(facts.map((fact) => fact.className.includes('factBare'))).toEqual([true, false, true, false]);
    // A dot is not a node of the page: the stylesheet draws it in the strip of the fact it belongs to.
    expect(qa<HTMLElement>('.detail-meta-row span').filter((span) => span.textContent === '·')).toHaveLength(0);

    const css = readFileSync(join(process.cwd(), 'src/components/files/bucket/bucket.module.css'), 'utf8');
    // The box clips what leaves it on the left, and the row is pulled left by the width of the strip, so the dot of a
    // fact that starts a line is cut off; one that follows another fact on the same line stays.
    expect(css).toMatch(/\.facts \{[^}]*overflow: hidden;/);
    expect(css).toMatch(/\.factsRow \{[^}]*flex-wrap: wrap;[^}]*margin-left: -20px;/);
    expect(css).toMatch(/\.fact \{[^}]*position: relative;[^}]*padding-left: 20px;/);
    expect(css).toMatch(/\.fact::before \{\s*content: '·';[^}]*position: absolute;/);
    expect(css).toMatch(/\.factBare::before \{\s*content: none;/);
  });
});

describe('the folder path', () => {
  it('draws the home icon inline, because the page resets every svg to a block that would stand above the label', async () => {
    mounted = await mount(h(FolderPath, { prefix: 'reports/', onOpen: vi.fn() }));
    const icon = q<SVGElement>('nav svg.tabler-icon-home')!;
    expect(icon).not.toBeNull();
    expect(icon.style.display).toBe('inline-block');
    expect(text()).toContain('Bucket root');
  });
});

describe('the Files tab table', () => {
  it('keeps a size and an age on one line, so a narrow table does not break "11 MB" from its unit', async () => {
    installBucketServer({ records: [fileRecord('q3-report.pdf', { size: 11 * MIB }), fileRecord('logo.svg', { size: 143 })] });
    nav.pathname = '/dashboard/files/docs';
    mounted = await mount(
      h(QueryClientProvider, { client: newQueryClient() }, h(DocsDrawerProvider, { value: { openDocs: vi.fn() }, children: h(BucketPage, { bucketKey: 'docs' }) })),
    );
    await until(() => qa('tbody tr').length === 2, 'the rows');

    const sizes = qa<HTMLElement>('tbody td span.ds-mono').filter((span) => /^(11 MB|143 B)$/.test(span.textContent ?? ''));
    expect(sizes.map((span) => span.textContent)).toEqual(['11 MB', '143 B']);
    for (const size of sizes) expect(size.style.whiteSpace, size.textContent ?? '').toBe('nowrap');

    const ages = qa<HTMLElement>('tbody td time');
    expect(ages).toHaveLength(2);
    for (const age of ages) expect(age.parentElement!.style.whiteSpace).toBe('nowrap');
  });
});
