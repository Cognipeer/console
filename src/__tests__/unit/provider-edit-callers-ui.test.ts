// @vitest-environment jsdom
/**
 * The pages that open the provider edit form: they load the provider from the read that names its stored credential
 * fields, and they hand the server's refusal of a save - with the form field it names - back to the form, which marks
 * that field. Run on the tenant's provider list (the real page, the real form, a mocked API), plus a guard that the
 * other pages that edit a provider carry the refusal the same way.
 */
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  q,
  qa,
  setInput,
  settle,
  wait,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';
import TenantProviders from '@/components/settings/TenantProviders';
import type { ProviderDescriptor, ProviderFormSchema } from '@/lib/providers';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/settings',
}));

let mounted: Mounted | undefined;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => {
  // The form logs a refusal it shows; the logged error is not what these tests are about.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

const DRIVER = 'mock-blob-files';
const DESCRIPTOR: ProviderDescriptor = { id: DRIVER, version: '1.0.0', domains: ['file'], display: { label: 'Mock Blob' } };
const SCHEMA: ProviderFormSchema = {
  sections: [
    {
      title: 'Location',
      fields: [{ name: 'accountName', label: 'Account name', type: 'text', scope: 'settings', required: true }],
    },
    {
      title: 'Sign in',
      fields: [
        {
          name: 'authMethod',
          label: 'Method',
          type: 'select',
          scope: 'settings',
          required: true,
          defaultValue: 'accountKey',
          options: [
            { label: 'Account key', value: 'accountKey' },
            { label: 'SAS token', value: 'sas' },
          ],
        },
        { name: 'accountKey', label: 'Account key', type: 'password', required: true, visibleWhen: { field: 'authMethod', equals: 'accountKey' } },
        { name: 'sasToken', label: 'SAS token', type: 'password', required: true, visibleWhen: { field: 'authMethod', equals: 'sas' } },
      ],
    },
  ],
};

/** A row of the list: it says that the provider stores credentials, not which. */
const ROW = { _id: 'prov-1', key: 'blob-main', label: 'Blob main', type: 'file', driver: DRIVER, status: 'active', projectIds: ['p1'], hasCredentials: true };
/** The read the edit form opens from: it names the credential fields that store a value. */
const DETAIL = { ...ROW, tenantId: 'tenant-1', settings: { accountName: 'acct', authMethod: 'accountKey' }, metadata: {}, credentialFields: ['accountKey'] };

const REFUSED = 'Enter the SAS token: the query string that starts with sv=, or the full SAS URL.';

const overlay = () => q('.form-overlay')!;
const labelOf = (el: Element) => el.querySelector('.form-field-label')?.textContent?.replace(/\s*\*$/, '').trim() ?? '';
const field = (label: string) => qa('.form-field', overlay()).find((f) => labelOf(f) === label);
const inputOf = (label: string) => field(label)?.querySelector<HTMLInputElement>('input') ?? null;

async function openEditForm(patch: () => unknown) {
  api = installApiMock([
    ['GET', '/api/providers', () => ({ providers: [ROW] })],
    ['GET', '/api/providers/prov-1', () => ({ provider: DETAIL })],
    ['GET', '/api/providers/drivers', () => ({ drivers: [DESCRIPTOR] })],
    ['GET', /^\/api\/providers\/drivers\/[^/]+\/form$/, () => ({ schema: SCHEMA })],
    ['PATCH', '/api/providers/prov-1', patch],
  ]);
  mounted = await mount(createElement(TenantProviders));
  await settle(120);

  await click(q('button[aria-label="Actions"]'));
  await wait(30);
  await click(qa('[role="menuitem"]').find((item) => item.textContent?.trim() === 'Edit'));
  await settle(120);
}

async function choose(label: string, option: string) {
  await click(inputOf(label));
  await wait(30);
  await click(qa('[role="option"]').find((o) => o.textContent?.trim() === option));
  await wait(30);
}

const saveButton = () => qa<HTMLButtonElement>('button', overlay()).find((b) => b.textContent?.trim() === 'Save changes');

describe('editing a provider from the tenant\'s provider list', () => {
  it('opens the form from the read that names the stored credential fields: the stored secret says so, another method\'s does not', async () => {
    await openEditForm(() => ({ provider: DETAIL }));

    expect(api.to('GET', '/api/providers/prov-1')).toHaveLength(1);
    expect(api.to('GET', '/api/providers/prov-1')[0]!.query).toMatchObject({ scope: 'tenant' });
    expect(inputOf('Account key')?.placeholder).toBe('Stored — leave blank to keep');

    await choose('Method', 'SAS token');
    expect(inputOf('SAS token')?.placeholder).toBe('');
  });

  it('will not save a method whose secret is not stored until it is given - and then sends only that secret', async () => {
    await openEditForm(() => ({ provider: DETAIL }));
    await choose('Method', 'SAS token');

    await click(saveButton());
    await wait(30);
    expect(api.to('PATCH', '/api/providers/prov-1')).toHaveLength(0);
    expect(field('SAS token')?.textContent).toContain('This field is required');

    await setInput(inputOf('SAS token')!, 'sv=2024&sig=abc');
    await click(saveButton());
    await settle(60);
    const patches = api.to('PATCH', '/api/providers/prov-1');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toMatchObject({ credentials: { sasToken: 'sv=2024&sig=abc' }, settings: { authMethod: 'sas' } });
  });

  it('marks the field the server refused, with the server\'s sentence, and keeps the form open', async () => {
    await openEditForm(() => jsonResponse({ error: REFUSED, code: 'provider_settings_invalid', field: 'sasToken' }, 400));
    await choose('Method', 'SAS token');
    await setInput(inputOf('SAS token')!, 'sv-wrong');

    await click(saveButton());
    await settle(60);

    expect(api.to('PATCH', '/api/providers/prov-1')).toHaveLength(1);
    expect(field('SAS token')?.textContent).toContain(REFUSED);
    const marked = inputOf('SAS token');
    expect(marked?.getAttribute('data-invalid') === 'true' || marked?.getAttribute('aria-invalid') === 'true').toBe(true);
    await vi.waitFor(() => expect(document.activeElement).toBe(marked), { timeout: 2000 });
    expect(q('.form-overlay')).not.toBeNull();
  });

  it('a refusal that names no field of the form is only the message', async () => {
    await openEditForm(() => jsonResponse({ error: 'Provider update failed.' }, 400));
    await click(saveButton());
    await settle(60);

    expect(api.to('PATCH', '/api/providers/prov-1')).toHaveLength(1);
    expect(qa('[aria-invalid="true"], [data-invalid="true"]', overlay())).toHaveLength(0);
    expect(q('.form-overlay')).not.toBeNull();
  });
});

describe('the pages that edit a provider', () => {
  const ROOT = process.cwd();
  const PAGES = [
    'src/app/dashboard/providers/[providerId]/page.tsx',
    'src/components/settings/TenantProviders.tsx',
    'src/app/dashboard/websearch/page.tsx',
    'src/app/dashboard/websearch/[key]/page.tsx',
  ];

  it.each(PAGES)('%s hands the refusal of a save, with its field, to the form', (file) => {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    expect(source).toMatch(/throw providerRequestError\(body, 'Failed to update (provider|instance)'\)/);
    // the plain Error of the text alone would drop the field the form needs
    expect(source).not.toMatch(/throw new Error\(body\?\.error \|\| 'Failed to update (provider|instance)'\)/);
  });
});
