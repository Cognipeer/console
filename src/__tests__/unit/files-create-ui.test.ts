// @vitest-environment jsdom
/**
 * The "Create bucket" screen of the Document Store: the key a name turns into, what the form accepts, where the
 * files will be stored, which providers can be chosen, what is sent, and how a refused request is told. The pure
 * rules come first, then the provider cards and the form against a mocked `fetch`, in both languages and for
 * someone who can only read.
 */

import { act, createElement as h } from 'react';
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

const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));

import { CreateFileBucketForm } from '@/components/files/create/CreateFileBucketForm';
import { ProviderCards } from '@/components/files/create/ProviderCards';
import {
  BUCKET_AUTO_KEY_MAX,
  BUCKET_KEY_MAX,
  BUCKET_NAME_MAX,
  BUCKET_PREFIX_MAX,
  bucketKeyIssue,
  bucketNameIssue,
  bucketPrefixIssue,
  buildCreateBucketInput,
  classifyCreateFailure,
  effectiveBucketPrefix,
  normalizeBucketPrefix,
  normalizeKeyInput,
  slugifyBucketKey,
  storagePreview,
} from '@/components/files/create/bucketForm';
import { FilesApiError, type FileProviderListItem, type ProviderHealth } from '@/components/files/filesApi';

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => notify.show.mockClear());
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

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
const AZURE = provider('azure', 'Azure Blob contoso', 'azure-blob-files', { state: 'ok', testedAt: ago(24 * HOUR) }, {
  storageLocationBase: 'https://contoso.blob.core.windows.net/files/console/t1/azure/',
});
const S3_PROD = provider('s3-prod', 'Amazon S3 prod', 'aws-s3-files', {
  state: 'failed',
  testedAt: ago(3 * HOUR),
  message: 'AccessDenied: the access key was rejected',
});
const UNTESTED = provider('fresh-s3', 'Fresh S3', 'aws-s3-files', { state: 'untested' });
const OFF = provider('off', 'Switched off', 'aws-s3-files', { state: 'inactive', message: 'Disabled by an admin' }, { status: 'disabled' });
const LOCAL = provider('local', 'Local filesystem', 'local-filesystem', { state: 'builtin' }, { storageLocationBase: null });

const SESSION_WRITE = { effectivePermissions: { files: 'write' } };
const SESSION_READ = { effectivePermissions: { files: 'read' } };

const CREATED = { id: 'b1', key: 'marketing-assets', name: 'Marketing assets', providerKey: 'minio', status: 'active' };

function installForm(options: { providers?: FileProviderListItem[] | (() => Response | { providers: FileProviderListItem[] }); session?: unknown } = {}) {
  const { providers = [MINIO, AZURE, OFF, S3_PROD, LOCAL], session = SESSION_WRITE } = options;
  api = installApiMock([
    ['GET', '/api/auth/session', () => session],
    ['GET', '/api/files/providers', () => (typeof providers === 'function' ? providers() : { providers })],
    ['POST', '/api/files/buckets', () => jsonResponse({ bucket: CREATED }, 201)],
  ]);
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });

const onClose = vi.fn();
const onCreated = vi.fn();

function form(options: { opened?: boolean; role?: 'owner' | 'admin' | 'project_admin' | 'user' } = {}) {
  const { opened = true, role } = options;
  const tree = h(QueryClientProvider, { client: newClient() }, h(CreateFileBucketForm, { opened, onClose, onCreated }));
  return role ? h(DashboardUserProvider, { value: { name: 'Ada', email: 'ada@example.com', licenseType: 'pro', role }, children: tree }) : tree;
}

beforeEach(() => {
  onClose.mockClear();
  onCreated.mockClear();
});

const nameInput = () => q<HTMLInputElement>('input[aria-label="Name"]')!;
const keyInput = () => q<HTMLInputElement>('input[aria-label="Key"]')!;
const prefixInput = () => q<HTMLInputElement>('input[aria-label="Prefix inside the provider"]')!;
const descriptionInput = () => q<HTMLTextAreaElement>('textarea[aria-label="Description"]')!;
const radios = () => qa<HTMLInputElement>('input[type="radio"]');
const radioOf = (label: string) =>
  radios().find((radio) => document.getElementById(radio.getAttribute('aria-labelledby') ?? '')?.textContent === label)!;
const primary = () => qa<HTMLButtonElement>('.form-footer button').find((button) => button.textContent === 'Create bucket')!;
const footer = () => q('.form-footer')?.textContent ?? '';
const preview = () => qa('.form-field').find((field) => field.textContent?.includes('Files will be stored at'))?.textContent ?? '';
const alerts = () => qa('.mantine-Alert-root').map((alert) => alert.textContent ?? '');

async function open(options: Parameters<typeof form>[0] = {}) {
  mounted = await mount(form(options));
  await settle(100);
}

/* ── The rules ───────────────────────────────────────────────────────────── */

describe('the key a name turns into', () => {
  it('is lowercase letters and digits joined by single hyphens', () => {
    expect(slugifyBucketKey('Marketing Assets')).toBe('marketing-assets');
    expect(slugifyBucketKey('  --Hello__World!!  ')).toBe('hello-world');
    expect(slugifyBucketKey('Q3 2026 / Reports')).toBe('q3-2026-reports');
    expect(slugifyBucketKey('!!!')).toBe('');
    expect(slugifyBucketKey('')).toBe('');
  });

  it('drops accents, the Turkish letters included', () => {
    expect(slugifyBucketKey('Doküman Arşivi')).toBe('dokuman-arsivi');
    expect(slugifyBucketKey('İstanbul Işık Çağrı Öğle Ürün')).toBe('istanbul-isik-cagri-ogle-urun');
    expect(slugifyBucketKey('Café Münster Straße')).toBe('cafe-munster-strasse');
    expect(slugifyBucketKey('Łódź Ærø Œuvre Đakovo')).toBe('lodz-aero-oeuvre-dakovo');
  });

  it('stops at the length of an automatic key, without a hyphen left at the end', () => {
    const long = slugifyBucketKey('word '.repeat(30));
    expect(long.length).toBeLessThanOrEqual(BUCKET_AUTO_KEY_MAX);
    expect(long.endsWith('-')).toBe(false);
    expect(slugifyBucketKey('abcdefgh-ijklmnop', 8)).toBe('abcdefgh');
  });

  it('is lowercased and hyphenated as it is typed into the key field', () => {
    expect(normalizeKeyInput('My Key  Here')).toBe('my-key-here');
    expect(normalizeKeyInput('already-fine_1')).toBe('already-fine_1');
  });
});

describe('what the form accepts', () => {
  it('needs a name of at most 120 characters', () => {
    expect(bucketNameIssue('')).toBe('required');
    expect(bucketNameIssue('   ')).toBe('required');
    expect(bucketNameIssue('Docs')).toBeNull();
    expect(bucketNameIssue('x'.repeat(BUCKET_NAME_MAX))).toBeNull();
    expect(bucketNameIssue('x'.repeat(BUCKET_NAME_MAX + 1))).toBe('tooLong');
  });

  it('needs a key of lowercase letters, digits, hyphens and underscores', () => {
    expect(bucketKeyIssue('')).toBe('required');
    expect(bucketKeyIssue('marketing-assets_2')).toBeNull();
    expect(bucketKeyIssue('Marketing')).toBe('invalid');
    expect(bucketKeyIssue('with space')).toBe('invalid');
    expect(bucketKeyIssue('slash/key')).toBe('invalid');
    expect(bucketKeyIssue('dökümanlar')).toBe('invalid');
    expect(bucketKeyIssue('k'.repeat(BUCKET_KEY_MAX))).toBeNull();
    expect(bucketKeyIssue('k'.repeat(BUCKET_KEY_MAX + 1))).toBe('tooLong');
  });

  it('keeps a prefix inside the provider', () => {
    expect(normalizeBucketPrefix('  //docs//2024/  ')).toBe('docs/2024');
    expect(normalizeBucketPrefix('/')).toBe('');
    expect(bucketPrefixIssue('')).toBeNull();
    expect(bucketPrefixIssue('docs/2024/')).toBeNull();
    expect(bucketPrefixIssue('ünlü/dosyalar')).toBeNull();
    expect(bucketPrefixIssue('../outside')).toBe('invalid');
    expect(bucketPrefixIssue('a/../b')).toBe('invalid');
    expect(bucketPrefixIssue('a/./b')).toBe('invalid');
    expect(bucketPrefixIssue('a\\b')).toBe('invalid');
    expect(bucketPrefixIssue('a\u0000b')).toBe('invalid');
    expect(bucketPrefixIssue('p'.repeat(BUCKET_PREFIX_MAX + 1))).toBe('tooLong');
  });

  it('uses the key as the folder when no prefix is given, as the server does', () => {
    expect(effectiveBucketPrefix('', 'marketing-assets')).toBe('marketing-assets');
    expect(effectiveBucketPrefix('   ', 'marketing-assets')).toBe('marketing-assets');
    expect(effectiveBucketPrefix('/docs/2024/', 'marketing-assets')).toBe('docs/2024');
    expect(effectiveBucketPrefix('', '')).toBe('');
  });
});

describe('where the files will be stored', () => {
  it('previews the provider’s location, the folder and the place of a file', () => {
    const example = (base: string, folder: string) =>
      storagePreview({ driver: 'aws-s3-files', storageLocationBase: base }, folder, '<file key>');
    expect(example('s3://b/console/t1/minio/', 'docs')).toEqual({
      kind: 'path',
      path: 's3://b/console/t1/minio/docs/',
      example: 's3://b/console/t1/minio/docs/<file key>',
    });
    // a base without its closing slash still gives a path
    expect(example('s3://b/console/t1/minio', 'docs')).toMatchObject({ example: 's3://b/console/t1/minio/docs/<file key>' });
    // no folder yet: the files are directly under the provider’s base
    expect(example('s3://b/console/t1/minio/', '')).toMatchObject({ example: 's3://b/console/t1/minio/<file key>' });
  });

  it('says so when there is nothing to preview', () => {
    expect(storagePreview(undefined, 'docs', '<file key>')).toEqual({ kind: 'none' });
    expect(storagePreview({ driver: 'local-filesystem', storageLocationBase: null }, 'docs', '<file key>')).toEqual({ kind: 'localDisk' });
    expect(storagePreview({ driver: 'aws-s3-files', storageLocationBase: null }, 'docs', '<file key>')).toEqual({ kind: 'localDisk' });
    // a server that does not send the field at all (as opposed to sending null for its own disk)
    const withoutBase = { driver: 'aws-s3-files' } as Parameters<typeof storagePreview>[0];
    expect(storagePreview(withoutBase, 'docs', '<file key>')).toEqual({ kind: 'unknown' });
  });
});

describe('the request', () => {
  const values = { providerKey: 'minio', name: ' Marketing assets ', key: ' marketing-assets ', description: '  ', prefix: '', active: true };

  it('leaves out what is empty, so the server applies its defaults', () => {
    expect(buildCreateBucketInput(values)).toEqual({
      key: 'marketing-assets',
      name: 'Marketing assets',
      providerKey: 'minio',
      status: 'active',
    });
  });

  it('carries the description, the cleaned prefix and a bucket that starts disabled', () => {
    expect(buildCreateBucketInput({ ...values, description: ' Brand kits ', prefix: '/brand//kits/', active: false })).toEqual({
      key: 'marketing-assets',
      name: 'Marketing assets',
      providerKey: 'minio',
      description: 'Brand kits',
      prefix: 'brand/kits',
      status: 'disabled',
    });
  });
});

describe('a refused request', () => {
  const refusal = (status: number, error: string, code?: string) => FilesApiError.fromBody(status, { error, ...(code ? { code } : {}) });

  it('tells a duplicate key (with or without a code) from the other refusals', () => {
    expect(classifyCreateFailure(refusal(409, 'exists', 'duplicate_key'), 'docs')).toEqual({ kind: 'duplicateKey', key: 'docs' });
    expect(classifyCreateFailure(refusal(409, 'Bucket with key "docs" already exists.'), 'docs')).toEqual({ kind: 'duplicateKey', key: 'docs' });
    expect(classifyCreateFailure(refusal(409, 'Provider must be active', 'provider_inactive'), 'docs')).toEqual({ kind: 'providerUnusable' });
    expect(classifyCreateFailure(refusal(400, 'Associated file provider not found.', 'provider_missing'), 'docs')).toEqual({ kind: 'providerUnusable' });
  });

  it('keeps the server’s words for a quota and for a value it did not accept, with the field when it names one', () => {
    expect(classifyCreateFailure(refusal(429, 'File bucket quota exceeded'), 'docs')).toEqual({ kind: 'quota', message: 'File bucket quota exceeded' });
    expect(classifyCreateFailure(refusal(400, 'name is required'), 'docs')).toEqual({ kind: 'invalid', field: 'name', message: 'name is required' });
    expect(classifyCreateFailure(refusal(400, 'key is required'), 'docs')).toMatchObject({ field: 'key' });
    expect(classifyCreateFailure(refusal(400, 'providerKey is required'), 'docs')).toMatchObject({ field: 'provider' });
    expect(classifyCreateFailure(refusal(400, 'The prefix may not contain ".."'), 'docs')).toMatchObject({ field: 'prefix' });
    expect(classifyCreateFailure(refusal(400, 'Invalid request'), 'docs')).toMatchObject({ field: null });
  });

  it('knows a missing permission, a lost connection and anything else', () => {
    expect(classifyCreateFailure(refusal(403, 'Forbidden'), 'docs')).toEqual({ kind: 'forbidden' });
    expect(classifyCreateFailure(FilesApiError.network(new TypeError('Failed to fetch')), 'docs')).toEqual({ kind: 'network' });
    expect(classifyCreateFailure(refusal(500, 'Boom'), 'docs')).toEqual({ kind: 'other', message: 'Boom' });
    expect(classifyCreateFailure(new Error('not an API error'), 'docs')).toEqual({ kind: 'other', message: null });
  });
});

/* ── The provider cards ──────────────────────────────────────────────────── */

describe('ProviderCards', () => {
  const choose = vi.fn();
  const cards = (props: Partial<Parameters<typeof ProviderCards>[0]> = {}) =>
    h(ProviderCards, {
      providers: [MINIO, OFF, S3_PROD, UNTESTED, LOCAL],
      value: '',
      onChange: choose,
      canManageProviders: true,
      ...props,
    });
  beforeEach(() => choose.mockClear());

  it('lets only a provider that is switched on be chosen', async () => {
    mounted = await mount(cards());
    expect(q('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Storage provider');
    expect(radios().map((radio) => [document.getElementById(radio.getAttribute('aria-labelledby')!)?.textContent, radio.disabled])).toEqual([
      ['MinIO (on-prem)', false],
      ['Switched off', true],
      ['Amazon S3 prod', false],
      ['Fresh S3', false],
      ['Local filesystem', false],
    ]);
    // one group: the arrow keys move between the cards
    expect(new Set(radios().map((radio) => radio.name)).size).toBe(1);

    await click(radioOf('MinIO (on-prem)'));
    expect(choose).toHaveBeenLastCalledWith('minio');
    await click(radioOf('Switched off'));
    expect(choose).toHaveBeenCalledTimes(1);
  });

  it('gives the reason on a provider that cannot be chosen and links to it in a new tab', async () => {
    mounted = await mount(cards());
    const off = radioOf('Switched off').closest('label')!;
    expect(off.textContent).toContain('Disabled');
    expect(off.textContent).toContain('Disabled by an admin');
    const link = q<HTMLAnchorElement>('a', off)!;
    expect(link.textContent).toBe('Open provider');
    expect(link.getAttribute('href')).toBe('/dashboard/providers/id-off');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('warns about a provider whose test failed or never ran, and still lets it be chosen', async () => {
    mounted = await mount(cards());
    const failed = radioOf('Amazon S3 prod').closest('label')!;
    expect(failed.textContent).toContain('Test failed');
    expect(failed.textContent).toContain('AccessDenied: the access key was rejected');
    expect(q('a', failed)).not.toBeNull();
    const untested = radioOf('Fresh S3').closest('label')!;
    expect(untested.textContent).toContain('Not tested yet');
    expect(q('a', untested)).not.toBeNull();
    // a healthy provider has nothing to warn about
    expect(q('a', radioOf('MinIO (on-prem)').closest('label')!)).toBeNull();
  });

  it('names the driver and says the server’s disk is not shared', async () => {
    mounted = await mount(cards());
    expect(radioOf('MinIO (on-prem)').closest('label')!.textContent).toContain('Amazon S3');
    const local = radioOf('Local filesystem').closest('label')!;
    expect(local.textContent).toContain('Local filesystem');
    expect(local.textContent).toContain('Files stay on this server’s disk, not shared across replicas.');
  });

  it('does not link into the Providers area for someone who cannot open it', async () => {
    mounted = await mount(cards({ canManageProviders: false }));
    expect(qa('a')).toHaveLength(0);
    // the reason is still told
    expect(text()).toContain('Disabled by an admin');
  });

  it('marks the chosen card, and not a chosen provider that has since been switched off', async () => {
    mounted = await mount(cards({ value: 'minio' }));
    expect(radioOf('MinIO (on-prem)').checked).toBe(true);
    expect(radioOf('MinIO (on-prem)').closest('label')!.className).toContain('selected');
    expect(radios().filter((radio) => radio.checked)).toHaveLength(1);
    await mounted.unmount();

    mounted = await mount(cards({ value: 'off' }));
    expect(radios().filter((radio) => radio.checked)).toHaveLength(0);
  });

  it('shows why the choice was refused under the cards', async () => {
    mounted = await mount(cards({ error: 'This provider can no longer take a bucket.' }));
    expect(q('[role="alert"]')?.textContent).toBe('This provider can no longer take a bucket.');
    expect(q('[role="radiogroup"]')?.getAttribute('aria-invalid')).toBe('true');
  });
});

/* ── The form ────────────────────────────────────────────────────────────── */

describe('CreateFileBucketForm', () => {
  it('is not drawn while closed, and every opening starts from an empty form', async () => {
    installForm();
    mounted = await mount(form({ opened: false }));
    await settle(50);
    expect(q('.form-overlay')).toBeNull();
    expect(api.to('GET', '/api/files/providers')).toHaveLength(0);
    await mounted.unmount();

    await open();
    expect(q('.form-overlay')).not.toBeNull();
    await setInput(nameInput(), 'Left over');
    await mounted.unmount();
    await open();
    expect(nameInput().value).toBe('');
  });

  it('is not drawn for someone who can only read', async () => {
    installForm({ session: SESSION_READ });
    await open();
    expect(q('.form-overlay')).toBeNull();
  });

  it('shows its four sections, with the name field ready to type in', async () => {
    installForm();
    await open();
    expect(text()).toContain('Create bucket');
    for (const title of ['Storage provider', 'Bucket', 'Location', 'Status']) expect(text()).toContain(title);
    expect(document.activeElement).toBe(nameInput());
    expect(primary().disabled).toBe(true);
  });

  it('makes the key from the name until the person types one', async () => {
    installForm();
    await open();

    await setInput(nameInput(), 'Marketing Assets');
    expect(keyInput().value).toBe('marketing-assets');
    await setInput(nameInput(), 'Doküman Arşivi');
    expect(keyInput().value).toBe('dokuman-arsivi');

    await setInput(keyInput(), 'My Own Key');
    expect(keyInput().value).toBe('my-own-key');
    await setInput(nameInput(), 'Something else entirely');
    expect(keyInput().value).toBe('my-own-key');

    // emptying the key hands it back to the name
    await setInput(keyInput(), '');
    expect(keyInput().value).toBe('something-else-entirely');
  });

  it('calls out an empty field once it was left, and a value that cannot be right as it is typed', async () => {
    installForm();
    await open();

    // empty is not an error yet: the person has not had a chance to type
    expect(text()).not.toContain('Give the bucket a name.');
    expect(text()).not.toContain('The bucket needs a key.');
    await act(async () => {
      nameInput().focus();
      nameInput().blur();
    });
    expect(text()).toContain('Give the bucket a name.');

    await setInput(nameInput(), 'Docs');
    expect(text()).not.toContain('Give the bucket a name.');
    // a letter the key does not take is told at once
    await setInput(keyInput(), 'bad.key');
    expect(text()).toContain('Use lowercase letters, numbers, hyphens and underscores only.');
    expect(keyInput().getAttribute('aria-invalid')).toBe('true');
    await setInput(keyInput(), 'good-key');
    expect(text()).not.toContain('Use lowercase letters, numbers, hyphens and underscores only.');
    // so is a name too long to keep
    await setInput(nameInput(), 'n'.repeat(BUCKET_NAME_MAX + 1));
    expect(text()).toContain('The name can have at most 120 characters.');
  });

  it('asks for a key at once when a name was given that no key can be made of', async () => {
    installForm();
    await open();
    await setInput(nameInput(), '!!!');
    expect(keyInput().value).toBe('');
    expect(text()).toContain('The bucket needs a key.');
    await setInput(keyInput(), 'symbols');
    expect(text()).not.toContain('The bucket needs a key.');
  });

  it('previews where the files will be stored, from the provider, the prefix and the key', async () => {
    installForm();
    await open();
    expect(preview()).toContain('Choose a provider to see where the files will be stored.');

    await click(radioOf('MinIO (on-prem)'));
    await setInput(nameInput(), 'Marketing assets');
    expect(preview()).toContain('s3://files/console/t1/minio/marketing-assets/<file key>');

    await setInput(prefixInput(), '/docs/2024/');
    expect(preview()).toContain('s3://files/console/t1/minio/docs/2024/<file key>');
    expect(text()).toContain('docs/2024');

    await click(radioOf('Azure Blob contoso'));
    expect(preview()).toContain('https://contoso.blob.core.windows.net/files/console/t1/azure/docs/2024/<file key>');

    expect(text()).toContain('Left empty, the key is used. It cannot be changed once the bucket has files.');
    expect(prefixInput().placeholder).toBe('marketing-assets');
  });

  it('warns that files on the local disk stay on one server', async () => {
    installForm();
    await open();
    expect(alerts().join(' ')).not.toContain('They are not shared between replicas');

    await click(radioOf('Local filesystem'));
    expect(preview()).toContain('This server’s disk');
    expect(alerts().join(' ')).toContain('Files stay on this server’s disk');
    expect(alerts().join(' ')).toContain('They are not shared between replicas');

    await click(radioOf('MinIO (on-prem)'));
    expect(alerts().join(' ')).not.toContain('They are not shared between replicas');
  });

  it('chooses the provider when there is only one to choose from, and leaves the choice otherwise', async () => {
    installForm({ providers: [OFF, MINIO] });
    await open();
    expect(radioOf('MinIO (on-prem)').checked).toBe(true);
    expect(radioOf('Switched off').disabled).toBe(true);
    await mounted.unmount();

    installForm();
    await open();
    expect(radios().filter((radio) => radio.checked)).toHaveLength(0);
    expect(footer()).toContain('1 of 3 ready');
  });

  it('counts what is ready and enables Create only when everything is', async () => {
    installForm();
    await open();
    expect(footer()).toContain('1 of 3 ready');
    // the prefix is fine while empty
    expect(qa('.form-checklist li.done').map((item) => item.textContent)).toEqual(['Prefix is valid']);

    await setInput(nameInput(), 'Docs');
    expect(footer()).toContain('2 of 3 ready');
    expect(primary().disabled).toBe(true);

    await click(radioOf('MinIO (on-prem)'));
    expect(footer()).toContain('3 of 3 ready');
    expect(primary().disabled).toBe(false);

    await setInput(prefixInput(), '../escape');
    expect(footer()).toContain('2 of 3 ready');
    expect(primary().disabled).toBe(true);
    expect(text()).toContain('A prefix cannot contain “..”, backslashes or control characters.');
  });

  it('shows the choices in the summary', async () => {
    installForm();
    await open();
    await click(radioOf('MinIO (on-prem)'));
    await setInput(nameInput(), 'Marketing assets');
    const summary = q('.form-summary-content')!.textContent!;
    expect(summary).toContain('MinIO (on-prem)');
    expect(summary).toContain('marketing-assets');
    expect(summary).toContain('Active');
  });

  it('creates the bucket with what was entered and hands it over', async () => {
    installForm();
    await open();
    await click(radioOf('MinIO (on-prem)'));
    await setInput(nameInput(), 'Marketing assets');
    await setInput(descriptionInput(), '  Brand kits  ');
    await setInput(prefixInput(), 'brand/');
    await click(primary());
    await settle(100);

    expect(api.to('POST', '/api/files/buckets').map((call) => call.body)).toEqual([
      {
        key: 'marketing-assets',
        name: 'Marketing assets',
        providerKey: 'minio',
        description: 'Brand kits',
        prefix: 'brand',
        status: 'active',
      },
    ]);
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ color: 'green', title: 'Bucket created' }));
    expect(onCreated).toHaveBeenCalledWith(CREATED);
    expect(onClose).toHaveBeenCalled();
  });

  it('creates the bucket disabled when it is told to start that way', async () => {
    installForm();
    await open();
    await click(radioOf('MinIO (on-prem)'));
    await setInput(nameInput(), 'Archive');
    await click(q('input[type="checkbox"]'));
    await click(primary());
    await settle(100);

    expect(api.to('POST', '/api/files/buckets')[0]?.body).toMatchObject({ key: 'archive', status: 'disabled' });
  });

  it('creates the bucket on Enter in a field, through the form’s own submit', async () => {
    installForm();
    await open();
    await click(radioOf('MinIO (on-prem)'));
    await setInput(nameInput(), 'Docs');

    const element = nameInput().closest('form')!;
    // the browser’s Enter reaches a form through its default (submit) button
    expect(q<HTMLButtonElement>('button[type="submit"]', element)).not.toBeNull();
    await act(async () => element.requestSubmit());
    await settle(100);
    expect(api.to('POST', '/api/files/buckets')).toHaveLength(1);
  });

  it('shows what is missing instead of sending when Enter is pressed on an incomplete form', async () => {
    installForm();
    await open();
    await act(async () => nameInput().closest('form')!.requestSubmit());
    await settle(50);

    expect(api.to('POST', '/api/files/buckets')).toHaveLength(0);
    expect(text()).toContain('Give the bucket a name.');
    expect(text()).toContain('Choose a storage provider.');
  });

  it('tells a duplicate key on the key field, and lets the person fix it', async () => {
    installForm();
    api.on('POST', '/api/files/buckets', () =>
      jsonResponse({ error: 'Bucket with key "docs" already exists.', code: 'duplicate_key' }, 409),
    );
    await open();
    await click(radioOf('MinIO (on-prem)'));
    await setInput(nameInput(), 'Docs');
    await click(primary());
    await settle(100);

    expect(text()).toContain('A bucket with the key “docs” already exists. Choose another key.');
    expect(keyInput().getAttribute('aria-invalid')).toBe('true');
    expect(onCreated).not.toHaveBeenCalled();
    expect(q('.form-overlay')).not.toBeNull();

    await setInput(keyInput(), 'docs-2');
    expect(text()).not.toContain('already exists');
  });

  it('asks again for the providers, and says so under the cards, when the one chosen can no longer take a bucket', async () => {
    installForm();
    api.on('POST', '/api/files/buckets', () =>
      jsonResponse({ error: 'Provider must be active to create a bucket.', code: 'provider_inactive' }, 409),
    );
    await open();
    await click(radioOf('MinIO (on-prem)'));
    await setInput(nameInput(), 'Docs');
    const before = api.to('GET', '/api/files/providers').length;
    await click(primary());
    await settle(100);

    expect(text()).toContain('This provider can no longer take a bucket. Choose another one.');
    expect(api.to('GET', '/api/files/providers').length).toBe(before + 1);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('puts a quota and any other refusal above the form in the server’s words', async () => {
    installForm();
    api.on('POST', '/api/files/buckets', () => jsonResponse({ error: 'File bucket quota exceeded' }, 429));
    await open();
    await click(radioOf('MinIO (on-prem)'));
    await setInput(nameInput(), 'Docs');
    await click(primary());
    await settle(100);

    expect(alerts().join(' ')).toContain('Couldn’t create the bucket');
    expect(alerts().join(' ')).toContain('File bucket quota exceeded');
    expect(onCreated).not.toHaveBeenCalled();

    api.on('POST', '/api/files/buckets', () => {
      throw new TypeError('Failed to fetch');
    });
    await click(primary());
    await settle(100);
    expect(alerts().join(' ')).toContain('The server could not be reached.');
  });

  it('brings the providers up to date when the person comes back to the window', async () => {
    const providers = [MINIO];
    installForm({ providers: () => ({ providers: [...providers] }) });
    await open();
    expect(radios()).toHaveLength(1);

    providers.push(AZURE);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle(100);
    expect(radios()).toHaveLength(2);
    // the one already chosen stays chosen
    expect(radioOf('MinIO (on-prem)').checked).toBe(true);
  });

  it('can refresh the providers by hand', async () => {
    installForm();
    await open();
    const before = api.to('GET', '/api/files/providers').length;
    await click(buttonByText('Refresh providers'));
    await settle(50);
    expect(api.to('GET', '/api/files/providers').length).toBe(before + 1);
  });

  it('opens the Providers area in a new tab, for someone who may', async () => {
    installForm();
    mounted = await mount(form({ role: 'admin' }));
    await settle(100);
    const add = buttonByText('Add a file provider') as unknown as HTMLAnchorElement;
    expect(add.getAttribute('href')).toBe('/dashboard/providers?domain=file');
    expect(add.getAttribute('target')).toBe('_blank');
    expect(add.getAttribute('rel')).toContain('noopener');
    await mounted.unmount();

    mounted = await mount(form({ role: 'user' }));
    await settle(100);
    expect(buttonByText('Add a file provider')).toBeUndefined();
    expect(qa('a[href^="/dashboard/providers"]')).toHaveLength(0);
  });

  it('leads to adding a provider when the project has none', async () => {
    installForm({ providers: [] });
    mounted = await mount(form({ role: 'owner' }));
    await settle(100);

    expect(text()).toContain('No file provider yet');
    expect(radios()).toHaveLength(0);
    expect(buttonByText('Add a file provider')).toBeDefined();
    expect(preview()).toContain('Choose a provider');
    expect(primary().disabled).toBe(true);
    await mounted.unmount();

    installForm({ providers: [] });
    mounted = await mount(form({ role: 'user' }));
    await settle(100);
    expect(text()).toContain('Ask an administrator to add a file provider.');
  });

  it('says when no provider can take a bucket', async () => {
    installForm({ providers: [OFF] });
    mounted = await mount(form({ role: 'admin' }));
    await settle(100);

    expect(radioOf('Switched off').disabled).toBe(true);
    expect(text()).toContain('None of these providers can take a bucket right now. Switch one on in the Providers area, or add another.');
  });

  it('says the providers could not be loaded, and loads them again on Retry', async () => {
    let failing = true;
    installForm({ providers: () => (failing ? jsonResponse({ error: 'upstream is down' }, 503) : { providers: [MINIO] }) });
    await open();

    expect(text()).toContain('Couldn’t load the providers');
    expect(radios()).toHaveLength(0);
    expect(primary().disabled).toBe(true);
    failing = false;
    await click(buttonByText('Retry'));
    await settle(100);
    expect(text()).not.toContain('Couldn’t load the providers');
    expect(radios()).toHaveLength(1);
  });

  it('closes from the header and from Cancel without creating anything', async () => {
    installForm();
    await open();
    await click(q('.form-header button[aria-label="Close"]'));
    await click(buttonByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(api.to('POST', '/api/files/buckets')).toHaveLength(0);
  });

  it('speaks Turkish', async () => {
    installForm();
    mounted = await mount(form(), 'tr');
    await settle(100);

    expect(text()).toContain('Bucket oluştur');
    expect(text()).toContain('Depolama sağlayıcısı');
    expect(q('input[aria-label="Ad"]')).not.toBeNull();
    expect(q('input[aria-label="Anahtar"]')).not.toBeNull();
    expect(q('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Depolama sağlayıcısı seçimi');
    expect(footer()).toContain('3 adımdan 1 tanesi hazır');
    expect(text()).not.toContain('Create bucket');
    await setInput(q<HTMLInputElement>('input[aria-label="Ad"]')!, 'Pazarlama görselleri');
    expect(q<HTMLInputElement>('input[aria-label="Anahtar"]')!.value).toBe('pazarlama-gorselleri');
  });
});
