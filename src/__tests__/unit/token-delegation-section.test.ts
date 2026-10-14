// @vitest-environment jsdom
/**
 * "Acting for users" in the token form (components/iam/tokens/TokenDelegationSection.tsx): what the screen shows for a token
 * with and without the setting, what it refuses to send, what it sends, and what it does with a refusal of the server.
 */
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';
import TokenDelegationSection from '@/components/iam/tokens/TokenDelegationSection';
import type { DelegationView } from '@/components/iam/tokens/delegationModel';

const SECRET = 'a-shared-secret-of-at-least-32-characters-ok';
const URL_PATH = '/api/tokens/tok-1/delegation';

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

const stored = (patch: Partial<DelegationView> = {}): DelegationView => ({
  tokenId: 'tok-1',
  enabled: true,
  trust: {
    issuer: 'https://idp.bank.example/realms/retail',
    audience: 'cognipeer-console',
    algorithms: ['HS256'],
    keys: { hsSecrets: [{ kid: 'k1' }] },
    maxTokenAgeSeconds: 900,
  },
  mapping: { matchBy: ['externalId', 'verifiedEmail'], jit: 'external' },
  allowPrivileged: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T09:30:00.000Z',
  updatedBy: 'u-admin',
  ...patch,
});

async function open(options: { delegation?: DelegationView | null; scoped?: boolean; status?: number; locale?: string } = {}) {
  const state = { delegation: options.delegation ?? null, scoped: options.scoped ?? true };
  api = installApiMock([
    ['GET', URL_PATH, () => (options.status && options.status !== 200
      ? jsonResponse({ error: 'Forbidden' }, options.status)
      : { delegation: state.delegation, tokenScoped: state.scoped })],
    ['PUT', URL_PATH, (call) => {
      state.delegation = { ...stored(), ...(call.body as object) } as unknown as DelegationView;
      return { delegation: stored({ enabled: (call.body as { enabled: boolean }).enabled }), tokenScoped: state.scoped };
    }],
    ['DELETE', URL_PATH, () => {
      state.delegation = null;
      return { deleted: true };
    }],
  ]);
  mounted = await mount(createElement(TokenDelegationSection, { tokenId: 'tok-1' }), options.locale ?? 'en');
  await settle(120);
}

const section = () => document.body;
const text = () => document.body.textContent ?? '';
const field = (id: string): HTMLInputElement | HTMLTextAreaElement => {
  const node = q(`[data-testid="${id}"]`);
  if (!node) throw new Error(`no field ${id}`);
  return (node.matches('input, textarea') ? node : node.querySelector('input, textarea')) as HTMLInputElement | HTMLTextAreaElement;
};
const type = (id: string, value: string) => setInput(field(id), value);
const toggle = (id: string) => click(field(id));
const saveButton = () => q<HTMLButtonElement>('[data-testid="delegation-save"]')!;

describe('reading', () => {
  it('says so for a token that is not set up, and offers to set it up', async () => {
    await open();
    expect(text()).toContain('Not set up');
    expect(buttonByText('Set up')).toBeTruthy();
    expect(buttonByText('Remove')).toBeFalsy();
    expect(q('[data-testid="delegation-unscoped"]')).toBeNull();
    // the header the application sends the user token in is named
    expect(text()).toContain('X-Cognipeer-User-Token');
  });

  it('warns about a token without a scope of its own', async () => {
    await open({ scoped: false });
    expect(q('[data-testid="delegation-unscoped"]')?.textContent).toContain('no scope of its own');
  });

  it('shows what is set up: issuer, audience, algorithm, keys by kind (never a secret), matching and new people', async () => {
    await open({ delegation: stored({ allowPrivileged: true }) });
    const t = text();
    expect(q('[data-testid="delegation-status"]')?.textContent).toBe('On');
    expect(t).toContain('https://idp.bank.example/realms/retail');
    expect(t).toContain('cognipeer-console');
    expect(t).toContain('HS256');
    expect(t).toContain('1 shared secret(s)');
    expect(t).toContain('By identity (issuer and subject), By verified email address');
    expect(t).toContain('An external account');
    expect(t).toContain('Administrators allowed');
    expect(buttonByText('Edit')).toBeTruthy();
    expect(buttonByText('Remove')).toBeTruthy();
  });

  it('tells a person who may not set it up, and shows no buttons', async () => {
    await open({ status: 403 });
    expect(text()).toContain('Only owners and admins can set up acting for users');
    expect(buttonByText('Set up')).toBeFalsy();
  });

  it('says when it could not load', async () => {
    await open({ status: 500 });
    expect(text()).toContain('Could not load this setting');
  });

  it('speaks Turkish', async () => {
    await open({ locale: 'tr' });
    expect(text()).toContain('Ayarlanmamış');
    expect(buttonByText('Ayarla')).toBeTruthy();
  });
});

describe('setting it up', () => {
  it('sends nothing until the form is complete, then sends exactly what was typed', async () => {
    await open();
    await click(buttonByText('Set up'));
    expect(q('[data-testid="delegation-form"]')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);

    await type('delegation-issuer', 'https://idp.bank.example/realms/retail');
    await type('delegation-audience', 'cognipeer-console');
    // RS256 is the starting point: it needs a key set or a key
    expect(saveButton().disabled).toBe(true);
    await type('delegation-jwks', 'https://idp.bank.example/.well-known/jwks.json');
    expect(saveButton().disabled).toBe(false);

    // switch to a shared secret instead
    await toggle('delegation-alg-RS256');
    await toggle('delegation-alg-HS256');
    expect(q('[data-testid="delegation-jwks"]')).toBeNull();
    expect(saveButton().disabled).toBe(true);
    await click(q('[data-testid="delegation-add-secret"]'));
    expect(field('delegation-secret-kid-0').value).toBe('k1');
    await type('delegation-secret-value-0', 'too short');
    expect(saveButton().disabled).toBe(true);
    expect(text()).toContain('Secret 1: at least 32 characters');
    await type('delegation-secret-value-0', SECRET);
    expect(saveButton().disabled).toBe(false);

    await type('delegation-max-age', '900');
    await click(q('[data-testid="delegation-jit"] input[value="person"]'));
    await toggle('delegation-privileged');
    await type('delegation-groupmap', 'sales => Sales (verified)');

    await click(saveButton());
    await settle(150);
    const put = api.to('PUT', URL_PATH);
    expect(put).toHaveLength(1);
    expect(put[0].body).toEqual({
      enabled: true,
      trust: {
        issuer: 'https://idp.bank.example/realms/retail',
        audience: 'cognipeer-console',
        algorithms: ['HS256'],
        keys: { hsSecrets: [{ kid: 'k1', secret: SECRET }] },
        maxTokenAgeSeconds: 900,
      },
      mapping: { matchBy: ['externalId', 'verifiedEmail'], jit: 'person', groupMap: [{ idpGroup: 'sales', consoleGroupName: 'Sales (verified)' }] },
      allowPrivileged: true,
    });
    // back to reading, with what the server answered (no secret in sight)
    expect(q('[data-testid="delegation-form"]')).toBeNull();
    expect(q('[data-testid="delegation-section"]')).toBeTruthy();
    expect(text()).not.toContain(SECRET);
  });

  it('asks for at least one way to find the person, and a valid map', async () => {
    await open();
    await click(buttonByText('Set up'));
    await type('delegation-issuer', 'https://idp.bank.example');
    await type('delegation-audience', 'x');
    await type('delegation-jwks', 'https://idp.bank.example/jwks');
    expect(saveButton().disabled).toBe(false);
    await toggle('delegation-match-identity');
    await toggle('delegation-match-email');
    expect(saveButton().disabled).toBe(true);
    expect(text()).toContain('Choose at least one way to find the person');
    await toggle('delegation-match-identity');
    expect(saveButton().disabled).toBe(false);
    await type('delegation-groupmap', 'no arrow here');
    expect(saveButton().disabled).toBe(true);
    expect(text()).toContain('Line 1');
  });

  it('shows the first problem the server found when it refuses', async () => {
    await open();
    api.on('PUT', URL_PATH, () => jsonResponse({ error: 'bad', code: 'invalid_body', problems: [{ field: 'trust', message: 'The key set address must be an https URL' }] }, 400));
    await click(buttonByText('Set up'));
    await type('delegation-issuer', 'https://idp.bank.example');
    await type('delegation-audience', 'x');
    await type('delegation-jwks', 'http://idp.bank.example/jwks');
    await click(saveButton());
    await settle(120);
    expect(text()).toContain('The key set address must be an https URL');
    // still editing
    expect(q('[data-testid="delegation-form"]')).toBeTruthy();
  });

  it('can be cancelled without sending anything', async () => {
    await open();
    await click(buttonByText('Set up'));
    await type('delegation-issuer', 'x');
    await click(buttonByText('Cancel'));
    expect(q('[data-testid="delegation-form"]')).toBeNull();
    expect(api.to('PUT', URL_PATH)).toHaveLength(0);
  });
});

describe('changing it', () => {
  it('starts from what is stored, keeps the stored secret without asking for it, and sends only a key id for it', async () => {
    await open({ delegation: stored() });
    await click(buttonByText('Edit'));
    expect(field('delegation-issuer').value).toBe('https://idp.bank.example/realms/retail');
    expect(field('delegation-secret-kid-0').value).toBe('k1');
    expect(field('delegation-secret-kid-0').disabled).toBe(true);
    expect(field('delegation-secret-value-0').value).toBe('');
    expect(field('delegation-secret-value-0').placeholder).toBe('Unchanged');
    // nothing changed yet: nothing to save
    expect(saveButton().disabled).toBe(true);

    await toggle('delegation-enabled');
    expect(saveButton().disabled).toBe(false);
    await click(saveButton());
    await settle(150);
    const body = api.to('PUT', URL_PATH)[0].body as { enabled: boolean; trust: { keys: { hsSecrets: unknown[] } } };
    expect(body.enabled).toBe(false);
    expect(body.trust.keys.hsSecrets).toEqual([{ kid: 'k1' }]);
  });

  it('rotates: a second key id with its own secret next to the stored one', async () => {
    await open({ delegation: stored() });
    await click(buttonByText('Edit'));
    await click(q('[data-testid="delegation-add-secret"]'));
    await type('delegation-secret-kid-1', 'k2');
    await type('delegation-secret-value-1', SECRET);
    await click(saveButton());
    await settle(150);
    expect((api.to('PUT', URL_PATH)[0].body as any).trust.keys.hsSecrets).toEqual([{ kid: 'k1' }, { kid: 'k2', secret: SECRET }]);
  });

  it('removes it behind a confirmation', async () => {
    await open({ delegation: stored() });
    await click(buttonByText('Remove'));
    await settle(80);
    const dialog = qa('[role="dialog"]').at(-1)!;
    expect(dialog.textContent).toContain('Stop acting for users?');
    await click(qa<HTMLButtonElement>('button', dialog).find((b) => b.textContent === 'Remove'));
    await settle(200);
    expect(api.to('DELETE', URL_PATH)).toHaveLength(1);
    expect(text()).toContain('Not set up');
    expect(section()).toBeTruthy();
  });
});
