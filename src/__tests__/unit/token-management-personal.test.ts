// @vitest-environment jsdom
/**
 * The personal tokens list: the caller's own tokens only (the server decides),
 * no secret and no copy button (a secret is shown once, when it is created),
 * and a create form that names neither an owner nor a project of its own.
 */
import { createElement, type ComponentType } from 'react';
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
  text,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/tokens',
  useSearchParams: () => new URLSearchParams(),
}));

import TokenManagement from '@/components/settings/TokenManagement';
import CreateTokenModal from '@/components/settings/CreateTokenModal';
import { FormSection as FormSectionImpl } from '@/components/common/ui/FormShell';

// the section takes its body as children: typed without them so the body can be passed the usual way
const FormSection = FormSectionImpl as ComponentType<{ number: number; title: string; done: boolean }>;

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const TOKENS = [
  { _id: 't1', label: 'laptop', tokenPrefix: 'cp_aa11', userId: 'u-me', createdAt: '2026-04-01T00:00:00.000Z', lastUsedAt: null, expiresAt: null, canDelete: true, canEdit: true },
  { _id: 't2', label: 'ci-runner', tokenPrefix: 'cp_bb22', userId: 'u-me', createdAt: '2026-04-02T00:00:00.000Z', lastUsedAt: '2026-04-03T00:00:00.000Z', expiresAt: null, canDelete: true, canEdit: true },
];
const POLICY = { maxLifetimeDays: null, requireExpiry: false, expiryRequired: false, maxIpRanges: 10, clientIp: null, trustsForwardedHeaders: false };

describe('TokenManagement', () => {
  async function render(props: { projectId?: string } = {}) {
    api = installApiMock([
      ['GET', '/api/tokens', () => ({ tokens: TOKENS })],
      ['GET', /^\/api\/projects\/[^/]+\/tokens$/, () => ({ tokens: TOKENS })],
      ['GET', '/api/tokens/policy', () => POLICY],
    ]);
    mounted = await mount(createElement(TokenManagement, props));
    await settle(100);
  }

  it('lists the caller\'s tokens from the personal endpoint, without asking for anybody else\'s', async () => {
    await render();
    expect(api.to('GET', '/api/tokens')).toHaveLength(1);
    expect(api.to('GET', '/api/tokens')[0]?.query).toEqual({});
    expect(text()).toContain('laptop');
    expect(text()).toContain('cp_aa11...');
  });

  it('shows only the visible start of a token, with no copy button', async () => {
    await render();
    expect(buttonByText(/copy token/i)).toBeUndefined();
    expect(qa('button').some((b) => /copy/i.test(b.textContent ?? ''))).toBe(false);
  });

  it('searches the label and the prefix', async () => {
    await render();
    const box = q<HTMLInputElement>('.ds-toolbar-search input')!;
    await setInput(box, 'bb22');
    expect(text()).toContain('ci-runner');
    expect(text()).not.toContain('laptop');
    await setInput(box, 'laptop');
    expect(text()).toContain('laptop');
    expect(text()).not.toContain('ci-runner');
  });

  it('a project page lists the project\'s tokens from the project endpoint', async () => {
    await render({ projectId: 'p-1' });
    expect(api.to('GET', '/api/projects/p-1/tokens')).toHaveLength(1);
  });
});

describe('CreateTokenModal', () => {
  it('creates a token for the caller: no owner, no project in the body', async () => {
    api = installApiMock([
      ['GET', '/api/tokens/policy', () => POLICY],
      ['POST', '/api/tokens', () => jsonResponse({ id: 't9', token: 'cp_secret', label: 'mine' }, 201)],
    ]);
    mounted = await mount(createElement(CreateTokenModal, { opened: true, onClose: vi.fn(), onSuccess: vi.fn() }));
    await settle(80);
    await setInput(q<HTMLInputElement>('input[placeholder^="Production API"]')!, 'mine');
    await click(buttonByText('Create Token'));
    await settle(100);
    const body = api.to('POST', '/api/tokens')[0]?.body as Record<string, unknown>;
    expect(body.label).toBe('mine');
    expect(body.userId).toBeUndefined();
    expect(body.projectId).toBeUndefined();
  });

  it('renders a lead section before the label, numbers the sections after it, and holds the submit until it is complete', async () => {
    api = installApiMock([['GET', '/api/tokens/policy', () => POLICY]]);
    mounted = await mount(
      createElement(CreateTokenModal, {
        opened: true,
        onClose: vi.fn(),
        onSuccess: vi.fn(),
        extraValid: false,
        leadSection: createElement(FormSection, { number: 1, title: 'Lead section', done: false }, createElement('div', null, 'lead-body')),
      }),
    );
    await settle(80);
    const sections = qa('.form-section-title').map((s) => s.textContent);
    expect(sections[0]).toBe('Lead section');
    // four sections now (the lead one, the label, the expiry, the network); a finished one shows a tick instead of its number
    expect(qa('.form-section-num')).toHaveLength(4);
    expect(qa('.form-section-num').map((n) => n.textContent).slice(0, 2)).toEqual(['1', '2']);
    await setInput(q<HTMLInputElement>('input[placeholder^="Production API"]')!, 'valid-label');
    expect((buttonByText('Create Token') as HTMLButtonElement).disabled).toBe(true);
  });
});
