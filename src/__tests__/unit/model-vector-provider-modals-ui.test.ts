// @vitest-environment jsdom
/**
 * The Model and the Vector provider modals share the provider form's renderer, so they share its rule too: a field that
 * does not apply to the form as it stands (`visibleWhen`) is not on screen and not in the request, whatever it still
 * holds - a hidden credential included.
 */
import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  click,
  installApiMock,
  installDomStubs,
  mount,
  q,
  qa,
  setInput,
  settle,
  wait,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';
import ModelProviderModal from '@/components/models/ModelProviderModal';
import VectorProviderModal from '@/components/vector/VectorProviderModal';
import type { ProviderDescriptor, ProviderFormSchema } from '@/lib/providers';

let mounted: Mounted | undefined;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => {
  // These modals open their fields without a value (React notes it when one is typed): not what is under test here.
  const logged = console.error.bind(console);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('uncontrolled input to be controlled')) return;
    logged(...args);
  });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

/** A form whose way to sign in decides which secret applies. */
const SCHEMA: ProviderFormSchema = {
  sections: [
    {
      title: 'Connection',
      fields: [
        { name: 'baseUrl', label: 'Base URL', type: 'text', scope: 'settings' },
        {
          name: 'authMode',
          label: 'Sign in with',
          type: 'select',
          scope: 'settings',
          required: true,
          defaultValue: 'apiKey',
          options: [
            { label: 'API key', value: 'apiKey' },
            { label: 'Bearer token', value: 'token' },
          ],
        },
        { name: 'apiKey', label: 'API key', type: 'password', required: true, visibleWhen: { field: 'authMode', equals: 'apiKey' } },
        { name: 'bearerToken', label: 'Bearer token', type: 'password', required: true, visibleWhen: { field: 'authMode', equals: 'token' } },
        { name: 'proxyUrl', label: 'Proxy URL', type: 'text', scope: 'settings', visibleWhen: { field: 'authMode', equals: 'token' } },
      ],
    },
  ],
};

const descriptor = (domain: string): ProviderDescriptor => ({ id: `mock-${domain}`, version: '1.0.0', domains: [domain as never], display: { label: `Mock ${domain}` } });

const field = (label: string) =>
  qa('.form-field').find((f) => f.querySelector('.form-field-label')?.textContent?.replace(/\s*\*$/, '').trim() === label);
const inputOf = (label: string) => field(label)?.querySelector<HTMLInputElement>('input') ?? null;
const fieldLabels = () => qa('.form-field').map((f) => f.querySelector('.form-field-label')?.textContent?.replace(/\s*\*$/, '').trim());

async function type(label: string, value: string) {
  const input = inputOf(label);
  if (!input) throw new Error(`no field "${label}"`);
  await setInput(input, value);
}

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

async function open(domain: 'models' | 'vector') {
  const created = vi.fn();
  api = installApiMock([
    ['GET', `/api/${domain}/providers/drivers`, () => ({ drivers: [descriptor(domain)] })],
    ['GET', new RegExp(`^/api/${domain}/providers/drivers/[^/]+/form$`), () => ({ schema: SCHEMA })],
    ['POST', `/api/${domain}/providers`, () => ({ provider: { key: 'p1' } })],
  ]);
  const element =
    domain === 'models'
      ? createElement(ModelProviderModal, { opened: true, onClose: vi.fn(), onCreated: created })
      : createElement(VectorProviderModal, { opened: true, onClose: vi.fn(), onCreated: created });
  mounted = await mount(element);
  await settle(120);
  return { created };
}

async function fillIdentity() {
  const key = q<HTMLInputElement>('input[placeholder="unique-provider-key"]');
  const label = q<HTMLInputElement>('input[placeholder="Provider name"]');
  await setInput(key!, 'p1');
  await setInput(label!, 'Provider one');
}

async function submit() {
  await click(qa<HTMLButtonElement>('button').find((b) => b.textContent?.trim() === 'Create Provider'));
  await settle(60);
}

describe.each([
  ['the Model provider modal', 'models' as const],
  ['the Vector provider modal', 'vector' as const],
])('%s', (_name, domain) => {
  it('shows the fields of the chosen way to sign in only', async () => {
    await open(domain);

    expect(fieldLabels()).toEqual(expect.arrayContaining(['Base URL', 'Sign in with', 'API key']));
    expect(fieldLabels()).not.toContain('Bearer token');
    expect(fieldLabels()).not.toContain('Proxy URL');

    await choose('Sign in with', 'Bearer token');
    expect(fieldLabels()).toEqual(expect.arrayContaining(['Bearer token', 'Proxy URL']));
    expect(fieldLabels()).not.toContain('API key');
  });

  it('sends the secret and the settings that apply, and nothing typed into a field that was switched away from', async () => {
    await open(domain);
    await fillIdentity();
    await type('Base URL', 'https://api.example.test');
    // typed first, then dropped for the other way to sign in: the form still holds it
    await type('API key', 'sk-LEFT-OVER');
    await choose('Sign in with', 'Bearer token');
    await type('Bearer token', 'tok-CURRENT');
    await type('Proxy URL', 'https://proxy.example.test');
    await submit();

    const posts = api.to('POST', `/api/${domain}/providers`);
    expect(posts).toHaveLength(1);
    const sent = posts[0]!.body as { credentials: Record<string, unknown>; settings: Record<string, unknown>; metadata: Record<string, unknown> };
    expect(sent.credentials).toEqual({ bearerToken: 'tok-CURRENT' });
    expect(sent.settings).toEqual({ baseUrl: 'https://api.example.test', authMode: 'token', proxyUrl: 'https://proxy.example.test' });
    expect(JSON.stringify(posts[0]!.body)).not.toContain('sk-LEFT-OVER');
  });

  it('a field that applies and was filled is sent as before; a blank one is left out', async () => {
    await open(domain);
    await fillIdentity();
    await type('API key', 'sk-ONE');
    await type('Base URL', '   ');
    await submit();

    const sent = api.to('POST', `/api/${domain}/providers`)[0]!.body as { credentials: Record<string, unknown>; settings: Record<string, unknown> };
    expect(sent.credentials).toEqual({ apiKey: 'sk-ONE' });
    // this form does not preload the fields' defaults: a choice that was not made is not sent (the server applies its own)
    expect(sent.settings).toEqual({});
  });
});
