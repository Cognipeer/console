// @vitest-environment jsdom
/**
 * The generic provider form as a person meets it: fields that depend on another field's value appear and disappear
 * with it (and a hidden credential is never sent), required fields are enforced, an edited provider's stored secrets
 * may stay blank and say so (a secret it does not store is asked for), a setting the record never held is not written
 * by an edit that did not touch it, and "Test connection" shows what the check did - also for a provider that is
 * already saved, which tests through its own route with the unsaved edits laid over what is stored.
 */
import { createElement, useState } from 'react';
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
  text,
  wait,
  type ApiMock,
  type Mounted,
  type RouteHandler,
} from '../helpers/iamCenterUi';
import ProviderConfigModal, {
  type ProviderConfigModalProps,
  type ProviderConfigModalSubmitPayload,
} from '@/components/providers/ProviderConfigModal';
import ProviderConnectionCard from '@/components/providers/ProviderConnectionCard';
import ProviderTestSteps from '@/components/providers/ProviderTestSteps';
import { providerRequestError } from '@/components/providers/providerFormModel';
import type { ProviderDescriptor, ProviderFormSchema } from '@/lib/providers';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/providers',
}));

// A small catalog of file services: the create flow starts from picking one.
vi.mock('@/config/service-catalog.json', () => ({
  default: {
    services: [
      {
        id: 'mock-blob',
        driver: 'mock-blob-files',
        name: 'Mock Blob',
        glyph: 'MB',
        tagline: 'Blob-like storage',
        description: 'A blob store.',
        domains: ['file'],
        color: '#0078d4',
        tags: [],
        aliases: [],
      },
    ],
  },
}));

let mounted: Mounted | undefined;
let api: ApiMock;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────
const DRIVER = 'mock-blob-files';

/** A blob-store style form: the way to sign in decides which credential fields apply. */
const SCHEMA: ProviderFormSchema = {
  sections: [
    {
      title: 'Location',
      fields: [
        { name: 'accountName', label: 'Account name', type: 'text', scope: 'settings', required: true },
        { name: 'container', label: 'Container', type: 'text', scope: 'settings', required: true },
        { name: 'prefix', label: 'Prefix', type: 'text', scope: 'settings' },
      ],
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
            { label: 'Service principal', value: 'servicePrincipal' },
          ],
        },
        {
          name: 'accountKey',
          label: 'Account key',
          type: 'password',
          required: true,
          placeholder: 'base64 key',
          visibleWhen: { field: 'authMethod', equals: 'accountKey' },
        },
        { name: 'sasToken', label: 'SAS token', type: 'password', required: true, visibleWhen: { field: 'authMethod', equals: 'sas' } },
        { name: 'tenantId', label: 'Tenant ID', type: 'text', scope: 'settings', required: true, visibleWhen: { field: 'authMethod', equals: 'servicePrincipal' } },
        { name: 'clientId', label: 'Client ID', type: 'text', scope: 'settings', required: true, visibleWhen: { field: 'authMethod', equals: 'servicePrincipal' } },
        { name: 'clientSecret', label: 'Client secret', type: 'password', required: true, visibleWhen: { field: 'authMethod', equals: 'servicePrincipal' } },
      ],
    },
    {
      title: 'Service principal only',
      fields: [
        { name: 'authority', label: 'Authority', type: 'text', scope: 'settings', visibleWhen: { field: 'authMethod', equals: 'servicePrincipal' } },
      ],
    },
  ],
};

const DESCRIPTOR: ProviderDescriptor = { id: DRIVER, version: '1.0.0', domains: ['file'], display: { label: 'Mock Blob' } };

/**
 * A saved provider, as the API returns it for the edit form: its credentials are never in it, only the names of the
 * fields that store one.
 */
const SAVED = {
  _id: 'prov-1',
  tenantId: 'tenant-1',
  key: 'blob-main',
  type: 'file',
  driver: DRIVER,
  label: 'Blob main',
  status: 'active',
  settings: { accountName: 'acct', container: 'files', authMethod: 'accountKey' },
  metadata: {},
  createdBy: 'user-1',
  hasCredentials: true,
  credentialFields: ['accountKey'],
} as unknown as ProviderConfigView;
const SAVED_WITHOUT_CREDENTIALS = { ...SAVED, hasCredentials: false, credentialFields: [] } as unknown as ProviderConfigView;
/** The same provider as a list row has it: it says that credentials are stored, not which. */
const SAVED_AS_LISTED = (() => {
  const row = { ...(SAVED as unknown as Record<string, unknown>) };
  delete row.credentialFields;
  return row as unknown as ProviderConfigView;
})();

/** An S3 style form, the way a record saved before `allowInsecureTls` existed meets it. */
const S3_SCHEMA: ProviderFormSchema = {
  sections: [
    {
      title: 'Bucket',
      fields: [
        { name: 'region', label: 'Region', type: 'text', scope: 'settings', required: true, defaultValue: 'us-east-1' },
        { name: 'bucket', label: 'Bucket', type: 'text', scope: 'settings', required: true },
        { name: 'endpoint', label: 'Endpoint', type: 'text', scope: 'settings' },
        { name: 'allowInsecureTls', label: 'Allow insecure TLS', type: 'switch', scope: 'settings', defaultValue: false },
      ],
    },
    {
      title: 'Credentials',
      fields: [
        { name: 'accessKeyId', label: 'Access key ID', type: 'text', required: true },
        { name: 'secretAccessKey', label: 'Secret access key', type: 'password', required: true },
        { name: 'sessionToken', label: 'Session token', type: 'password' },
        { name: 'serviceAccountKey', label: 'Service account key', type: 'textarea' },
      ],
    },
  ],
};
const SAVED_S3 = {
  _id: 'prov-s3',
  tenantId: 'tenant-1',
  key: 's3-main',
  type: 'file',
  driver: DRIVER,
  label: 'S3 main',
  status: 'active',
  // saved before the TLS switch existed: the record has no such key
  settings: { region: 'us-east-1', bucket: 'files', endpoint: 'https://minio.internal:9000' },
  metadata: {},
  createdBy: 'user-1',
  hasCredentials: true,
  credentialFields: ['accessKeyId', 'secretAccessKey'],
} as unknown as ProviderConfigView;
const S3_FORM: Route = ['GET', /^\/api\/providers\/drivers\/[^/]+\/form$/, () => ({ schema: S3_SCHEMA })];

/** Two optional choices: only one of them decides which other field applies. */
const CHOICES_SCHEMA: ProviderFormSchema = {
  sections: [
    {
      title: 'Options',
      fields: [
        {
          name: 'mode',
          label: 'Mode',
          type: 'select',
          scope: 'settings',
          defaultValue: 'basic',
          options: [
            { label: 'Basic', value: 'basic' },
            { label: 'Advanced', value: 'advanced' },
          ],
        },
        { name: 'depth', label: 'Depth', type: 'text', scope: 'settings', visibleWhen: { field: 'mode', equals: 'advanced' } },
        {
          name: 'note',
          label: 'Note',
          type: 'select',
          scope: 'settings',
          options: [
            { label: 'One', value: 'one' },
            { label: 'Two', value: 'two' },
          ],
        },
      ],
    },
  ],
};
const CHOICES_FORM: Route = ['GET', /^\/api\/providers\/drivers\/[^/]+\/form$/, () => ({ schema: CHOICES_SCHEMA })];

const PASSING = {
  ok: true,
  latencyMs: 412,
  message: 'Connected. Listed, wrote, read and deleted a test object.',
  details: {
    steps: [
      { step: 'list', ok: true },
      { step: 'write', ok: true },
      { step: 'read', ok: true },
      { step: 'delete', ok: true },
    ],
  },
};
const FAILING = {
  ok: false,
  latencyMs: 1500,
  message: 'Could list the container but not write to it.',
  details: {
    steps: [
      { step: 'list', ok: true },
      { step: 'write', ok: false, message: 'Access denied' },
    ],
  },
};

type Route = [string, string | RegExp, RouteHandler];
type Submit = (options: ProviderConfigModalSubmitPayload) => Promise<void>;

async function show(
  props: Pick<ProviderConfigModalProps, 'mode'> & Partial<ProviderConfigModalProps>,
  routes: Route[] = [],
  locale = 'en',
) {
  api = installApiMock([['GET', /^\/api\/providers\/drivers\/[^/]+\/form$/, () => ({ schema: SCHEMA })], ...routes]);
  const onSubmit = vi.fn<Submit>(async () => undefined);
  const onClose = vi.fn();
  mounted = await mount(
    createElement(ProviderConfigModal, {
      opened: true,
      onClose,
      drivers: [DESCRIPTOR],
      domain: 'file',
      onDomainChange: vi.fn(),
      onSubmit,
      hideProjects: true,
      skipAssignStep: true,
      ...props,
    }),
    locale,
  );
  await settle(80);
  return { onSubmit, onClose };
}

/** The modal as a page keeps it: one instance, with the provider it edits swapped from outside. */
function SwitchingModal(props: { first: ProviderConfigView; second: ProviderConfigView; modal: ProviderConfigModalProps }) {
  const [provider, setProvider] = useState(props.first);
  return createElement(
    'div',
    null,
    createElement('button', { id: 'switch-provider', type: 'button', onClick: () => setProvider(props.second) }, 'switch provider'),
    createElement(ProviderConfigModal, { ...props.modal, provider }),
  );
}

// ── helpers over the open form ──────────────────────────────────────────────────────────────────────────────────
const overlay = () => q('.form-overlay')!;
const labelOf = (el: Element) => el.querySelector('.form-field-label')?.textContent?.replace(/\s*\*$/, '').trim() ?? '';
const fieldLabels = () => qa('.form-field', overlay()).map(labelOf);
const field = (label: string) => qa('.form-field', overlay()).find((f) => labelOf(f) === label);
const inputOf = (label: string) => field(label)?.querySelector<HTMLInputElement>('input') ?? null;
const sectionTitles = () => qa('.form-section-title', overlay()).map((t) => t.textContent);
/** Section title -> its number (a section that is marked done shows a check instead). */
const sectionNumbers = () =>
  Object.fromEntries(
    qa('.form-section', overlay()).map((s) => [s.querySelector('.form-section-title')?.textContent, s.querySelector('.form-section-num')?.textContent ?? '']),
  );
const button = (label: string) => qa<HTMLButtonElement>('button', overlay()).find((b) => b.textContent?.trim() === label);

async function type(label: string, value: string) {
  const input = inputOf(label);
  if (!input) throw new Error(`no field "${label}"`);
  await setInput(input, value);
}

/** Opens the dropdown of a Select field and clicks an option. */
async function choose(label: string, option: string) {
  const input = inputOf(label);
  if (!input) throw new Error(`no field "${label}"`);
  await click(input);
  await wait(30);
  const choice = qa('[role="option"]').find((o) => o.textContent?.trim() === option);
  expect(choice, `option "${option}"`).toBeTruthy();
  await click(choice);
  await wait(30);
}

async function save(label = 'Save changes') {
  await click(button(label));
  await wait(30);
}

/** The create flow starts from picking a service; its form loads right after. */
async function pickService(name: string) {
  const card = qa('.service-card', overlay()).find((c) => c.querySelector('.service-card-name')?.textContent === name);
  expect(card, `service "${name}"`).toBeTruthy();
  await click(card);
  await settle(80);
}

const REQUIRED = 'This field is required';
const hasError = (label: string) => field(label)?.textContent?.includes(REQUIRED) ?? false;
/** The boxes that show a message: a password box marks itself with `data-invalid`, the others with `aria-invalid`. */
const invalidBoxes = () => qa('[aria-invalid="true"], [data-invalid="true"]', overlay());
const isMarked = (label: string) => {
  const input = inputOf(label);
  return input?.getAttribute('aria-invalid') === 'true' || input?.getAttribute('data-invalid') === 'true';
};
/** A switch of the form (not a labelled box): its row. */
const toggleRow = (label: string) => qa('.form-toggle-row', overlay()).find((row) => row.querySelector('.form-toggle-name')?.textContent === label);

// ── fields that depend on another field ─────────────────────────────────────────────────────────────────────────
describe('a field that depends on another field\'s value', () => {
  it('shows the fields of the chosen way to sign in and nothing else, and the section numbers follow what is on screen', async () => {
    await show({ mode: 'edit', provider: SAVED });
    // the Method field defaults to the account key
    expect(fieldLabels()).toEqual(expect.arrayContaining(['Account name', 'Container', 'Prefix', 'Method', 'Account key']));
    for (const hidden of ['SAS token', 'Tenant ID', 'Client ID', 'Client secret', 'Authority']) expect(fieldLabels()).not.toContain(hidden);
    expect(sectionTitles()).toEqual(['Identity', 'Location', 'Sign in', 'Connection test']);
    expect(sectionNumbers()).toMatchObject({ Location: '2', 'Sign in': '3', 'Connection test': '4' });

    await choose('Method', 'SAS token');
    expect(fieldLabels()).toContain('SAS token');
    expect(fieldLabels()).not.toContain('Account key');

    await choose('Method', 'Service principal');
    expect(fieldLabels()).toEqual(expect.arrayContaining(['Tenant ID', 'Client ID', 'Client secret', 'Authority']));
    for (const hidden of ['Account key', 'SAS token']) expect(fieldLabels()).not.toContain(hidden);
    // a section that has something to show again joins the form, and the test section moves down
    expect(sectionTitles()).toEqual(['Identity', 'Location', 'Sign in', 'Service principal only', 'Connection test']);
    expect(sectionNumbers()).toMatchObject({ 'Service principal only': '4', 'Connection test': '5' });
  });

  it('keeps what was typed in a hidden field for when it comes back', async () => {
    await show({ mode: 'edit', provider: SAVED });
    await type('Account key', 'KEY==');
    await choose('Method', 'SAS token');
    expect(inputOf('Account key')).toBeNull();
    await choose('Method', 'Account key');
    expect(inputOf('Account key')?.value).toBe('KEY==');
  });

  it('a chosen option clicked again stays chosen: a choice that other fields depend on cannot be emptied', async () => {
    await show({ mode: 'edit', provider: SAVED });
    await choose('Method', 'SAS token');
    await choose('Method', 'SAS token');
    expect(inputOf('Method')?.value).toBe('SAS token');
    expect(fieldLabels()).toContain('SAS token');
    expect(fieldLabels()).not.toContain('Account key');
  });

  it('an optional choice that other fields depend on cannot be emptied either - one that nothing depends on can', async () => {
    await show({ mode: 'create', provider: undefined }, [CHOICES_FORM]);
    await pickService('Mock Blob');
    await choose('Mode', 'Advanced');
    expect(fieldLabels()).toContain('Depth');

    await choose('Mode', 'Advanced');
    expect(inputOf('Mode')?.value).toBe('Advanced');
    expect(fieldLabels()).toContain('Depth');

    await choose('Note', 'One');
    expect(inputOf('Note')?.value).toBe('One');
    await choose('Note', 'One');
    expect(inputOf('Note')?.value).toBe('');
  });
});

// ── what is submitted ───────────────────────────────────────────────────────────────────────────────────────────
describe('what a new provider submits', () => {
  it('never carries a credential of a way to sign in that was switched away from', async () => {
    const { onSubmit } = await show({ mode: 'create', provider: undefined });
    await pickService('Mock Blob');
    expect(inputOf('Key')?.value).toBe('mock-blob');
    expect(inputOf('Label')?.value).toBe('Mock Blob');

    await type('Account name', 'acct');
    await type('Container', 'files');
    // the account key is typed first and then dropped for a SAS token
    await type('Account key', 'KEY==');
    await choose('Method', 'SAS token');
    await type('SAS token', 'sv=2024&sig=abc');
    await save('Create provider');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.driver).toBe(DRIVER);
    expect(payload.values.credentials).toEqual({ sasToken: 'sv=2024&sig=abc' });
    expect(payload.values.settings).toEqual({ accountName: 'acct', container: 'files', authMethod: 'sas' });
    expect(payload.values.metadata).toEqual({ serviceCatalogId: 'mock-blob' });
    expect(JSON.stringify(payload)).not.toContain('KEY==');
  });

  it('leaves out the optional fields that were not filled in', async () => {
    const { onSubmit } = await show({ mode: 'create', provider: undefined });
    await pickService('Mock Blob');
    await type('Account name', 'acct');
    await type('Container', 'files');
    await type('Account key', 'KEY==');
    await type('Prefix', '   ');
    await save('Create provider');
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.values.settings).toEqual({ accountName: 'acct', container: 'files', authMethod: 'accountKey' });
    expect(payload.values.credentials).toEqual({ accountKey: 'KEY==' });
  });
});

// ── required fields ─────────────────────────────────────────────────────────────────────────────────────────────
describe('required fields', () => {
  it('a new provider cannot be created while a required field that applies is empty - the others are not asked for', async () => {
    const { onSubmit } = await show({ mode: 'create', provider: undefined });
    await pickService('Mock Blob');
    await save('Create provider');

    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasError('Account name')).toBe(true);
    expect(hasError('Container')).toBe(true);
    expect(hasError('Account key')).toBe(true);
    // not required, or not on screen
    expect(hasError('Prefix')).toBe(false);
    expect(fieldLabels()).not.toContain('SAS token');
    // the first field that needs attention is where the cursor goes
    await vi.waitFor(() => expect(document.activeElement).toBe(inputOf('Account name')), { timeout: 2000 });
  });

  it('a message goes away when the form is submitted again and the field is filled in; the required field of another method is asked then', async () => {
    const { onSubmit } = await show({ mode: 'create', provider: undefined });
    await pickService('Mock Blob');
    await type('Account name', 'acct');
    await type('Container', 'files');
    await save('Create provider');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasError('Account key')).toBe(true);

    await choose('Method', 'SAS token');
    await save('Create provider');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasError('SAS token')).toBe(true);
    expect(hasError('Account name')).toBe(false);

    await type('SAS token', 'sv=2024&sig=abc');
    await save('Create provider');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0].values.credentials).toEqual({ sasToken: 'sv=2024&sig=abc' });
  });

  it('looks for the message again when it is not drawn yet, and brings the first field that shows one into view', async () => {
    const real = document.querySelector.bind(document);
    let looks = 0;
    vi.spyOn(document, 'querySelector').mockImplementation(((selector: string) => {
      if (selector.includes('aria-invalid')) {
        looks += 1;
        if (looks <= 3) return null;
      }
      return real(selector);
    }) as typeof document.querySelector);
    await show({ mode: 'edit', provider: SAVED_WITHOUT_CREDENTIALS });

    await save();

    await vi.waitFor(() => expect(document.activeElement).toBe(inputOf('Account key')), { timeout: 2000 });
    expect(looks).toBeGreaterThan(3);
  });

  it('a message does not stay on the form of another provider', async () => {
    const other = { ...SAVED_WITHOUT_CREDENTIALS, _id: 'prov-2', key: 'blob-other', label: 'Blob other' } as unknown as ProviderConfigView;
    api = installApiMock([['GET', /^\/api\/providers\/drivers\/[^/]+\/form$/, () => ({ schema: SCHEMA })]]);
    mounted = await mount(
      createElement(SwitchingModal, {
        first: SAVED_WITHOUT_CREDENTIALS,
        second: other,
        modal: {
          opened: true,
          mode: 'edit',
          onClose: vi.fn(),
          drivers: [DESCRIPTOR],
          domain: 'file',
          onDomainChange: vi.fn(),
          onSubmit: vi.fn<Submit>(async () => undefined),
          hideProjects: true,
          skipAssignStep: true,
        },
      }),
    );
    await settle(80);
    await save();
    expect(hasError('Account key')).toBe(true);

    await click(q('#switch-provider'));
    await settle(80);

    expect(inputOf('Label')?.value).toBe('Blob other');
    expect(hasError('Account key')).toBe(false);
    expect(invalidBoxes()).toHaveLength(0);
  });

  it('whitespace is not an answer', async () => {
    const { onSubmit } = await show({ mode: 'create', provider: undefined });
    await pickService('Mock Blob');
    await type('Account name', '   ');
    await type('Container', 'files');
    await type('Account key', 'KEY==');
    await save('Create provider');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasError('Account name')).toBe(true);
  });
});

describe('editing a provider that stores credentials', () => {
  it('shows that a secret is stored instead of looking empty, in the language of the person', async () => {
    await show({ mode: 'edit', provider: SAVED });
    expect(inputOf('Account key')?.placeholder).toBe('Stored — leave blank to keep');
    expect(inputOf('Account key')?.value).toBe('');
    // a field that is not a secret keeps its own placeholder / none, and shows its stored value
    expect(inputOf('Container')?.placeholder).toBe('');
    expect(inputOf('Container')?.value).toBe('files');
    expect(inputOf('Account name')?.value).toBe('acct');

    await mounted!.unmount();
    mounted = undefined;
    await show({ mode: 'edit', provider: SAVED }, [], 'tr');
    expect(inputOf('Account key')?.placeholder).toBe('Kayıtlı — korumak için boş bırakın');
  });

  it('the cue is on the secret the record stores, not on the secret of another way to sign in, which it never stored', async () => {
    await show({ mode: 'edit', provider: SAVED });
    await choose('Method', 'SAS token');
    expect(inputOf('SAS token')?.placeholder).toBe('');
    await choose('Method', 'Service principal');
    expect(inputOf('Client secret')?.placeholder).toBe('');
    // back on the method it stored: the cue returns
    await choose('Method', 'Account key');
    expect(inputOf('Account key')?.placeholder).toBe('Stored — leave blank to keep');
  });

  it('asks for the secret of a way to sign in the record never used, and marks the field where it is missing', async () => {
    const { onSubmit } = await show({ mode: 'edit', provider: SAVED });
    await choose('Method', 'SAS token');
    await save();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasError('SAS token')).toBe(true);
    expect(isMarked('SAS token')).toBe(true);
    // the settings and the way it was saved before are fine
    expect(hasError('Account name')).toBe(false);
    expect(hasError('Method')).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(inputOf('SAS token')), { timeout: 2000 });

    // given the token, the edit goes through with that secret and none of the stored method's
    await type('SAS token', 'sv=2024&sig=new');
    await save();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.values.credentials).toEqual({ sasToken: 'sv=2024&sig=new' });
    expect(payload.values.settings).toMatchObject({ authMethod: 'sas' });
  });

  it('asks for every secret of the way to sign in it was switched to that it did not store - and only those', async () => {
    const { onSubmit } = await show({ mode: 'edit', provider: SAVED });
    await choose('Method', 'Service principal');
    await type('Tenant ID', 'tenant');
    await type('Client ID', 'client');
    await save();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasError('Client secret')).toBe(true);
    expect(hasError('Tenant ID')).toBe(false);
    expect(hasError('Client ID')).toBe(false);
  });

  it('a record that stores the secret of the way it is switched to may leave it blank', async () => {
    const both = { ...SAVED, credentialFields: ['accountKey', 'sasToken'] } as unknown as ProviderConfigView;
    const { onSubmit } = await show({ mode: 'edit', provider: both });
    await choose('Method', 'SAS token');
    expect(inputOf('SAS token')?.placeholder).toBe('Stored — leave blank to keep');
    await save();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0].values.credentials).toEqual({});
    expect(hasError('SAS token')).toBe(false);
  });

  it('a provider read that only says credentials are stored (a list row) counts every secret as stored', async () => {
    const { onSubmit } = await show({ mode: 'edit', provider: SAVED_AS_LISTED });
    expect(inputOf('Account key')?.placeholder).toBe('Stored — leave blank to keep');
    await choose('Method', 'SAS token');
    expect(inputOf('SAS token')?.placeholder).toBe('Stored — leave blank to keep');
    await save();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('a stored secret of a text or a text-area field says so too, and an optional secret that is not stored does not', async () => {
    const { onSubmit } = await show({ mode: 'edit', provider: SAVED_S3 }, [S3_FORM]);

    // stored: the key id is a text box, the secret a password box
    expect(inputOf('Access key ID')?.placeholder).toBe('Stored — leave blank to keep');
    expect(inputOf('Secret access key')?.placeholder).toBe('Stored — leave blank to keep');
    // not stored: no cue, whatever the input type
    expect(inputOf('Session token')?.placeholder).toBe('');
    expect(field('Service account key')?.querySelector('textarea')?.placeholder).toBe('');
    // the Region is a setting, shown with its value
    expect(inputOf('Region')?.placeholder).toBe('');

    await save();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0].values.credentials).toEqual({});
  });

  it('a stored secret of a text-area field says so', async () => {
    const saved = { ...SAVED_S3, credentialFields: ['serviceAccountKey'] } as unknown as ProviderConfigView;
    await show({ mode: 'edit', provider: saved }, [S3_FORM]);
    expect(field('Service account key')?.querySelector('textarea')?.placeholder).toBe('Stored — leave blank to keep');
    expect(inputOf('Secret access key')?.placeholder).toBe('');
  });

  it('a provider whose stored set is empty must be given its required secrets again (credentials that cannot be opened)', async () => {
    const unreadable = { ...SAVED, credentialFields: [] } as unknown as ProviderConfigView;
    const { onSubmit } = await show({ mode: 'edit', provider: unreadable });
    expect(inputOf('Account key')?.placeholder).toBe('base64 key');
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasError('Account key')).toBe(true);
  });

  it('may save with the required secret left blank: the stored one stays, so nothing is sent for it', async () => {
    const { onSubmit } = await show({ mode: 'edit', provider: SAVED });
    await save();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.providerId).toBe('prov-1');
    expect(payload.values.credentials).toEqual({});
    expect(payload.values.settings).toEqual({ accountName: 'acct', container: 'files', authMethod: 'accountKey' });
    expect(hasError('Account key')).toBe(false);
  });

  it('sends a secret that was typed', async () => {
    const { onSubmit } = await show({ mode: 'edit', provider: SAVED });
    await type('Account key', 'NEW-KEY==');
    await save();
    expect(onSubmit.mock.calls[0]![0].values.credentials).toEqual({ accountKey: 'NEW-KEY==' });
  });

  it('still asks for a required setting', async () => {
    const { onSubmit } = await show({ mode: 'edit', provider: SAVED });
    await type('Container', '');
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasError('Container')).toBe(true);
    expect(hasError('Account key')).toBe(false);

    await type('Container', 'other');
    await save();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0].values.settings).toMatchObject({ container: 'other' });
  });

  it('a provider without stored credentials must be given them, and shows no stored-secret cue', async () => {
    const { onSubmit } = await show({ mode: 'edit', provider: SAVED_WITHOUT_CREDENTIALS });
    expect(inputOf('Account key')?.placeholder).toBe('base64 key');
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasError('Account key')).toBe(true);
  });

  it('a new provider\'s secret field keeps the driver\'s own placeholder', async () => {
    await show({ mode: 'create', provider: undefined });
    await pickService('Mock Blob');
    expect(inputOf('Account key')?.placeholder).toBe('base64 key');
  });
});

describe('editing a provider saved before a setting existed', () => {
  it('a rename sends the settings the record holds - not the default of a switch nobody touched', async () => {
    const { onSubmit } = await show({ mode: 'edit', provider: SAVED_S3 }, [S3_FORM]);
    // the switch opens off, which is its default
    expect(toggleRow('Allow insecure TLS')?.querySelector<HTMLInputElement>('input')?.checked).toBe(false);

    await type('Label', 'S3 renamed');
    await save();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.values.base.label).toBe('S3 renamed');
    expect(payload.values.settings).toEqual({ region: 'us-east-1', bucket: 'files', endpoint: 'https://minio.internal:9000' });
    expect(payload.values.settings).not.toHaveProperty('allowInsecureTls');
    expect(payload.values.credentials).toEqual({});
  });

  it('a setting the record never held opens with the default of its field, and a rename does not write it', async () => {
    const withoutRegion = { ...SAVED_S3, settings: { bucket: 'files', endpoint: 'https://minio.internal:9000' } } as unknown as ProviderConfigView;
    const { onSubmit } = await show({ mode: 'edit', provider: withoutRegion }, [S3_FORM]);
    expect(inputOf('Region')?.value).toBe('us-east-1');

    await type('Label', 'S3 renamed');
    await save();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0].values.settings).toEqual({ bucket: 'files', endpoint: 'https://minio.internal:9000' });
  });

  it('a setting that was changed is sent, the switch included once it is turned on', async () => {
    const { onSubmit } = await show({ mode: 'edit', provider: SAVED_S3 }, [S3_FORM]);
    await type('Bucket', 'other-files');
    await click(toggleRow('Allow insecure TLS')?.querySelector('input'));
    await save();

    expect(onSubmit.mock.calls[0]![0].values.settings).toEqual({
      region: 'us-east-1',
      bucket: 'other-files',
      endpoint: 'https://minio.internal:9000',
      allowInsecureTls: true,
    });
  });

  it('a record that already holds the switch keeps sending it', async () => {
    const holding = { ...SAVED_S3, settings: { ...SAVED_S3.settings, allowInsecureTls: false } } as unknown as ProviderConfigView;
    const { onSubmit } = await show({ mode: 'edit', provider: holding }, [S3_FORM]);
    await save();
    expect(onSubmit.mock.calls[0]![0].values.settings).toEqual({
      region: 'us-east-1',
      bucket: 'files',
      endpoint: 'https://minio.internal:9000',
      allowInsecureTls: false,
    });
  });

  it('a test of the saved provider carries the same settings a save would store', async () => {
    await show({ mode: 'edit', provider: SAVED_S3 }, [S3_FORM, ['POST', '/api/providers/prov-s3/test', () => PASSING]]);
    await click(button('Test connection'));
    await settle(40);

    const body = api.to('POST', '/api/providers/prov-s3/test')[0]!.body as { settings: Record<string, unknown> };
    expect(body.settings).toEqual({ region: 'us-east-1', bucket: 'files', endpoint: 'https://minio.internal:9000' });
  });

  it('a new provider sends every default it holds', async () => {
    const { onSubmit } = await show({ mode: 'create', provider: undefined }, [S3_FORM]);
    await pickService('Mock Blob');
    await type('Bucket', 'files');
    await type('Access key ID', 'AKIA');
    await type('Secret access key', 'secret');
    await save('Create provider');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0].values.settings).toEqual({ region: 'us-east-1', bucket: 'files', allowInsecureTls: false });
  });
});

describe('a save the server refuses', () => {
  const REFUSED_TOKEN = 'Enter the SAS token: the query string that starts with sv=, or the full SAS URL.';

  // The form logs a refusal it shows; the logged error is not what these tests are about.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  async function refusing(error: unknown, provider = { ...SAVED, credentialFields: ['accountKey', 'sasToken'] } as unknown as ProviderConfigView) {
    const onSubmit = vi.fn<Submit>(async () => {
      throw error;
    });
    await show({ mode: 'edit', provider, onSubmit });
    await choose('Method', 'SAS token');
    await type('SAS token', 'sv-wrong');
    await save();
    return onSubmit;
  }

  it('marks the field it names, says why, and brings it into view', async () => {
    const onSubmit = await refusing(providerRequestError({ error: REFUSED_TOKEN, code: 'provider_settings_invalid', field: 'sasToken' }, 'Failed to update provider'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(field('SAS token')?.textContent).toContain(REFUSED_TOKEN);
    expect(isMarked('SAS token')).toBe(true);
    await vi.waitFor(() => expect(document.activeElement).toBe(inputOf('SAS token')), { timeout: 2000 });
  });

  it('the message goes away when the form is submitted again', async () => {
    let answers = 0;
    const onSubmit = vi.fn<Submit>(async () => {
      answers += 1;
      if (answers === 1) throw providerRequestError({ error: REFUSED_TOKEN, field: 'sasToken' }, 'Failed to update provider');
    });
    await show({ mode: 'edit', provider: { ...SAVED, credentialFields: ['accountKey', 'sasToken'] } as unknown as ProviderConfigView, onSubmit });
    await choose('Method', 'SAS token');
    await type('SAS token', 'sv-wrong');
    await save();
    expect(field('SAS token')?.textContent).toContain(REFUSED_TOKEN);

    await type('SAS token', 'sv=2024&sig=abc');
    await save();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(field('SAS token')?.textContent ?? '').not.toContain(REFUSED_TOKEN);
    expect(invalidBoxes()).toHaveLength(0);
  });

  it('a refusal that names a field the form does not show, or none, marks nothing', async () => {
    for (const error of [
      providerRequestError({ error: 'Not allowed.', field: 'accountKey' }, 'Failed to update provider'),
      providerRequestError({ error: 'Not allowed.', field: 'nowhere' }, 'Failed to update provider'),
      providerRequestError({ error: 'Not allowed.' }, 'Failed to update provider'),
      new Error('Failed to update provider'),
    ]) {
      await refusing(error);
      expect(invalidBoxes(), error.message).toHaveLength(0);
      await mounted!.unmount();
      mounted = undefined;
    }
  });
});

// ── test connection ─────────────────────────────────────────────────────────────────────────────────────────────
describe('Test connection of a new provider', () => {
  it('sends what is typed for the way to sign in that applies, and shows the message, the steps and the time it took', async () => {
    await show({ mode: 'create', provider: undefined }, [['POST', '/api/providers/test', () => PASSING]]);
    await pickService('Mock Blob');
    await type('Account name', 'acct');
    await type('Container', 'files');
    await type('Account key', 'KEY==');
    await choose('Method', 'SAS token');
    await type('SAS token', 'sv=2024&sig=abc');

    await click(button('Test connection'));
    await settle(40);

    const calls = api.to('POST', '/api/providers/test');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      type: 'file',
      driver: DRIVER,
      credentials: { sasToken: 'sv=2024&sig=abc' },
      settings: { accountName: 'acct', container: 'files', authMethod: 'sas' },
    });
    expect(JSON.stringify(calls[0]!.body)).not.toContain('KEY==');

    expect(q('.ds-badge-ok', overlay())?.textContent).toContain('Connection works');
    expect(text()).toContain('Latency 412 ms');
    expect(text()).toContain('Connected. Listed, wrote, read and deleted a test object.');
    const steps = qa('ul[aria-label="Test steps"] li', overlay());
    expect(steps.map((s) => s.getAttribute('data-step'))).toEqual(['list', 'write', 'read', 'delete']);
    expect(steps.every((s) => s.getAttribute('data-ok') === 'true')).toBe(true);
    expect(steps.map((s) => s.textContent)).toEqual([
      expect.stringContaining('List'),
      expect.stringContaining('Write test object'),
      expect.stringContaining('Read back'),
      expect.stringContaining('Delete'),
    ]);
  });

  it('shows the step that failed with the reason, and the time in seconds from one second up', async () => {
    await show({ mode: 'create', provider: undefined }, [['POST', '/api/providers/test', () => FAILING]]);
    await pickService('Mock Blob');
    await type('Account name', 'acct');
    await type('Container', 'files');
    await type('Account key', 'KEY==');
    await click(button('Test connection'));
    await settle(40);

    expect(q('.ds-badge-err', overlay())?.textContent).toContain('Connection failed');
    expect(text()).toContain('Latency 1.5 s');
    const steps = qa('ul[aria-label="Test steps"] li', overlay());
    expect(steps.map((s) => s.getAttribute('data-ok'))).toEqual(['true', 'false']);
    expect(steps[1]!.textContent).toContain('Write test object');
    expect(steps[1]!.textContent).toContain('Access denied');
    expect(steps[1]!.textContent).toContain('Failed');
  });

  it('a driver whose check has no steps shows the message and no list', async () => {
    await show({ mode: 'create', provider: undefined }, [
      ['POST', '/api/providers/test', () => ({ ok: true, latencyMs: 20, message: 'Reachable.' })],
    ]);
    await pickService('Mock Blob');
    await click(button('Test connection'));
    await settle(40);
    expect(text()).toContain('Reachable.');
    expect(q('ul[aria-label="Test steps"]', overlay())).toBeNull();
  });
});

describe('Test connection of a saved provider', () => {
  it('goes through the provider\'s own route with the unsaved edits, and sends no secret that was left blank', async () => {
    await show({ mode: 'edit', provider: SAVED }, [['POST', '/api/providers/prov-1/test', () => PASSING]]);
    await type('Container', 'other-container');
    await click(button('Test connection'));
    await settle(40);

    expect(api.to('POST', '/api/providers/test')).toHaveLength(0);
    const calls = api.to('POST', '/api/providers/prov-1/test');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      credentials: {},
      settings: { accountName: 'acct', container: 'other-container', authMethod: 'accountKey' },
    });

    expect(q('.ds-badge-ok', overlay())?.textContent).toContain('Connection works');
    expect(text()).toContain('Latency 412 ms');
    expect(qa('ul[aria-label="Test steps"] li', overlay())).toHaveLength(4);
  });

  it('sends a secret that was typed, and none of a way to sign in that is not selected', async () => {
    await show({ mode: 'edit', provider: SAVED }, [['POST', '/api/providers/prov-1/test', () => PASSING]]);
    await type('Account key', 'NEW-KEY==');
    await choose('Method', 'SAS token');
    await type('SAS token', 'sv=2024&sig=new');
    await click(button('Test connection'));
    await settle(40);

    const body = api.to('POST', '/api/providers/prov-1/test')[0]!.body;
    expect(body).toEqual({
      credentials: { sasToken: 'sv=2024&sig=new' },
      settings: { accountName: 'acct', container: 'files', authMethod: 'sas' },
    });
    expect(JSON.stringify(body)).not.toContain('NEW-KEY==');
  });

  it('says how a blank field is handled: credentials keep their stored values, the other fields are used as shown', async () => {
    const hint = 'Credentials you leave blank keep their stored values; the other fields are used as shown.';
    await show({ mode: 'edit', provider: SAVED });
    expect(text()).toContain(hint);
    // the old wording promised more than a setting does: a cleared setting is not kept
    expect(text()).not.toContain('Fields you leave blank keep their stored values.');
    await mounted!.unmount();
    mounted = undefined;
    await show({ mode: 'create', provider: undefined });
    expect(text()).not.toContain(hint);
  });

  it('says it in Turkish too', async () => {
    await show({ mode: 'edit', provider: SAVED }, [], 'tr');
    expect(text()).toContain('Boş bıraktığınız kimlik bilgileri kayıtlı değerlerini korur; diğer alanlar gösterildiği gibi kullanılır.');
    expect(text()).not.toContain('Boş bıraktığınız alanlar kayıtlı değerlerini korur.');
  });

  it('marks the field the server refused, and says why', async () => {
    await show({ mode: 'edit', provider: SAVED }, [
      [
        'POST',
        '/api/providers/prov-1/test',
        () => jsonResponse({ error: 'Container names are 3 to 63 characters.', code: 'provider_settings_invalid', field: 'container' }, 400),
      ],
    ]);
    await type('Container', 'x');
    await click(button('Test connection'));
    await settle(40);

    expect(field('Container')?.textContent).toContain('Container names are 3 to 63 characters.');
    expect(inputOf('Container')?.getAttribute('aria-invalid')).toBe('true');
    expect(q('[role="alert"]', overlay())?.textContent).toContain('The test could not be run');
    expect(q('[role="alert"]', overlay())?.textContent).toContain('Container names are 3 to 63 characters.');
    // no result is shown for a test that was refused
    expect(text()).not.toContain('Connection works');
    expect(text()).not.toContain('Connection failed');
  });

  it('a refusal that names a field the form does not show is only the message', async () => {
    await show({ mode: 'edit', provider: SAVED }, [
      ['POST', '/api/providers/prov-1/test', () => jsonResponse({ error: 'Not allowed.', code: 'x', field: 'sasToken' }, 400)],
    ]);
    await click(button('Test connection'));
    await settle(40);
    expect(q('[role="alert"]', overlay())?.textContent).toContain('Not allowed.');
    expect(qa('[aria-invalid="true"]', overlay())).toHaveLength(0);

    // the field it names comes into the form later: nothing was left on it
    await choose('Method', 'SAS token');
    expect(field('SAS token')?.textContent ?? '').not.toContain('Not allowed.');
    expect(isMarked('SAS token')).toBe(false);
  });

  it('a refusal without a body says the test could not be run', async () => {
    await show({ mode: 'edit', provider: SAVED }, [['POST', '/api/providers/prov-1/test', () => new Response('nope', { status: 502 })]]);
    await click(button('Test connection'));
    await settle(40);
    expect(q('[role="alert"]', overlay())?.textContent).toContain('The test could not be run');
  });
});

// ── the steps of a check ────────────────────────────────────────────────────────────────────────────────────────
describe('ProviderTestSteps', () => {
  it('lists each step with how it ended and why it failed; a screen reader hears the outcome too', async () => {
    mounted = await mount(
      createElement(ProviderTestSteps, {
        steps: [
          { step: 'list', ok: true },
          { step: 'write', ok: false, message: 'Access denied' },
        ],
      }),
    );
    const items = qa('ul[aria-label="Test steps"] li');
    expect(items).toHaveLength(2);
    expect(items[0]!.getAttribute('data-ok')).toBe('true');
    expect(items[0]!.textContent).toBe('PassedList');
    expect(items[1]!.getAttribute('data-ok')).toBe('false');
    expect(items[1]!.textContent).toBe('FailedWrite test object — Access denied');
  });

  it('names every step the file drivers report, in both languages', async () => {
    const steps = [{ step: 'list', ok: true }, { step: 'write', ok: true }, { step: 'read', ok: true }, { step: 'delete', ok: true }];
    mounted = await mount(createElement(ProviderTestSteps, { steps }), 'tr');
    expect(qa('ul li').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Listele'),
      expect.stringContaining('Test nesnesi yaz'),
      expect.stringContaining('Geri oku'),
      expect.stringContaining('Sil'),
    ]);
    // no step falls back to its dotted key
    expect(text()).not.toContain('providerAccess');
    expect(text()).not.toContain('test.steps');
  });

  it('shows a step it does not know by its own name', async () => {
    mounted = await mount(createElement(ProviderTestSteps, { steps: [{ step: 'tls-handshake', ok: false, message: 'self-signed certificate' }] }));
    expect(qa('li')[0]!.textContent).toContain('tls-handshake — self-signed certificate');
  });

  it('renders nothing without steps', async () => {
    for (const steps of [undefined, null, []]) {
      mounted = await mount(createElement(ProviderTestSteps, { steps }));
      expect(qa('ul')).toHaveLength(0);
      await mounted.unmount();
      mounted = undefined;
    }
  });
});

// ── the Connection card of the provider page ────────────────────────────────────────────────────────────────────
describe('the Connection card of a saved provider', () => {
  const LAST_TEST = { ok: true, at: new Date(Date.now() - 60_000).toISOString(), latencyMs: 300, message: 'Connected.' };

  async function showCard(routes: Route[], lastTest: typeof LAST_TEST | null = LAST_TEST) {
    api = installApiMock(routes);
    const onTested = vi.fn(async () => undefined);
    mounted = await mount(createElement(ProviderConnectionCard, { providerId: 'prov-1', lastTest, canTest: true, onTested }));
    await settle(20);
    return { onTested };
  }
  const retest = () => qa<HTMLButtonElement>('button').find((b) => /Re-test|Test connection/.test(b.textContent ?? ''));

  it('re-tests what is stored (no body) and shows the steps the check ran', async () => {
    const { onTested } = await showCard([['POST', '/api/providers/prov-1/test', () => FAILING]]);
    expect(qa('ul[aria-label="Test steps"]')).toHaveLength(0);

    await click(retest());
    await settle(20);

    const calls = api.to('POST', '/api/providers/prov-1/test');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toBeUndefined();
    expect(onTested).toHaveBeenCalledTimes(1);
    const steps = qa('ul[aria-label="Test steps"] li');
    expect(steps.map((s) => s.getAttribute('data-step'))).toEqual(['list', 'write']);
    expect(steps[1]!.textContent).toContain('Access denied');
  });

  it('a later check of a driver without steps replaces them', async () => {
    let answer: unknown = PASSING;
    await showCard([['POST', '/api/providers/prov-1/test', () => answer]]);
    await click(retest());
    await settle(20);
    expect(qa('ul[aria-label="Test steps"] li')).toHaveLength(4);

    answer = { ok: true, latencyMs: 5, message: 'Reachable.' };
    await click(retest());
    await settle(20);
    expect(qa('ul[aria-label="Test steps"]')).toHaveLength(0);
  });

  it('shows no steps while the provider has no stored result (never tested, or the connection changed)', async () => {
    await showCard([['POST', '/api/providers/prov-1/test', () => PASSING]], null);
    expect(text()).toContain('Test connection');
    await click(retest());
    await settle(20);
    expect(qa('ul[aria-label="Test steps"]')).toHaveLength(0);
  });
});
