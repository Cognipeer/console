// @vitest-environment jsdom
/**
 * The settings and project screens that read and write through React Query: what they show, which requests they
 * make, and how a failed request reaches the person.
 */
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { notifications } from '@mantine/notifications';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  q,
  setInput,
  settle,
  text,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';
import { renderWithQuery } from '../helpers/renderWithQuery';
import { createQueryClient } from '@/lib/api/queries/queryClient';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/settings',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

import AuditLogViewer from '@/components/settings/AuditLogViewer';
import LicenseManagement from '@/components/settings/LicenseManagement';
import TokenManagement from '@/components/settings/TokenManagement';
import WebhookManagement from '@/components/settings/WebhookManagement';
import ProjectProvidersManager from '@/components/projects/ProjectProvidersManager';
import { en } from '@/lib/i18n/messages/en';

let mounted: Mounted | undefined;
let api: ApiMock;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const shown = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => call[0] as { message?: string; title?: string; color?: string });

describe('LicenseManagement', () => {
  const LICENSE = {
    canManage: true,
    projectCount: 2,
    tenantSlug: 'acme',
    services: [],
    license: { licenseId: 'L-1', licenseType: 'free', source: 'none', status: 'free', limits: { maxProjects: 5 } },
  };

  it('shows the license it read, and applies a key then reads the license again', async () => {
    let status = 'free';
    api = installApiMock([
      ['GET', '/api/license', () => ({ ...LICENSE, license: { ...LICENSE.license, status } })],
      ['POST', '/api/license', () => { status = 'active'; return { ok: true }; }],
    ]);
    const show = vi.spyOn(notifications, 'show').mockImplementation(() => 'id');
    mounted = await renderWithQuery(createElement(LicenseManagement));
    await settle(100);
    expect(text()).toContain('acme');
    expect(text()).toContain('2 / 5');

    await setInput(q<HTMLTextAreaElement>('textarea')!, ` ${'K'.repeat(24)} `);
    await click(buttonByText(en.license.actions.apply));
    await settle(100);
    expect(api.to('POST', '/api/license')[0]?.body).toEqual({ licenseKey: 'K'.repeat(24) });
    expect(api.to('GET', '/api/license')).toHaveLength(2);
    expect(shown(show).some((n) => n.message === en.license.messages.saved && n.color === 'green')).toBe(true);
  });

  it('says why a key was refused, with the words of the server', async () => {
    api = installApiMock([
      ['GET', '/api/license', () => LICENSE],
      ['POST', '/api/license', () => jsonResponse({ error: 'Signature does not match' }, 400)],
    ]);
    const show = vi.spyOn(notifications, 'show').mockImplementation(() => 'id');
    mounted = await renderWithQuery(createElement(LicenseManagement));
    await settle(100);
    await setInput(q<HTMLTextAreaElement>('textarea')!, 'K'.repeat(24));
    await click(buttonByText(en.license.actions.apply));
    await settle(100);
    expect(shown(show).some((n) => n.message === 'Signature does not match' && n.color === 'red')).toBe(true);
    expect(api.to('GET', '/api/license')).toHaveLength(1);
  });

  it('says so when the license cannot be read', async () => {
    api = installApiMock([['GET', '/api/license', () => jsonResponse({ error: 'License store is down' }, 500)]]);
    const show = vi.spyOn(notifications, 'show').mockImplementation(() => 'id');
    mounted = await renderWithQuery(createElement(LicenseManagement));
    await settle(100);
    expect(shown(show).filter((n) => n.message === 'License store is down' && n.color === 'red')).toHaveLength(1);
  });
});

describe('TokenManagement', () => {
  it('says the person may not see tokens when the server refuses (403), without a failure message', async () => {
    api = installApiMock([['GET', '/api/tokens', () => jsonResponse({ error: 'Forbidden' }, 403)]]);
    const show = vi.spyOn(notifications, 'show').mockImplementation(() => 'id');
    mounted = await renderWithQuery(createElement(TokenManagement));
    await settle(100);
    expect(text()).toContain(en.common.forbidden);
    expect(show).not.toHaveBeenCalled();
  });

  it('shows one failure message when the list cannot be read', async () => {
    api = installApiMock([['GET', '/api/tokens', () => jsonResponse({ error: 'Boom' }, 500)]]);
    const show = vi.spyOn(notifications, 'show').mockImplementation(() => 'id');
    mounted = await renderWithQuery(createElement(TokenManagement));
    await settle(100);
    expect(shown(show)).toHaveLength(1);
    expect(shown(show)[0]).toMatchObject({ color: 'red' });
  });
});

describe('AuditLogViewer', () => {
  const LOG = { id: 'a1', action: 'write', actorType: 'user', actorEmail: 'ann@example.com', event: 'models.update', outcome: 'success', service: 'models', createdAt: '2026-01-01T00:00:00.000Z' };

  it('asks for one row more than a page, from the start, and lists what came', async () => {
    api = installApiMock([
      ['GET', '/api/audit/logs', () => ({ logs: [LOG], total: 1 })],
      ['GET', '/api/audit/services', () => ({ services: [{ id: 'models', label: 'Model Hub' }] })],
    ]);
    mounted = await renderWithQuery(createElement(AuditLogViewer));
    await settle(150);
    expect(api.to('GET', '/api/audit/logs')[0]?.query).toEqual({ limit: '26', skip: '0' });
    expect(text()).toContain('models.update');
    expect(text()).toContain('Model Hub');
  });

  it('says so with the server message when the log cannot be read', async () => {
    api = installApiMock([
      ['GET', '/api/audit/logs', () => jsonResponse({ error: 'Audit store is down' }, 500)],
      ['GET', '/api/audit/services', () => jsonResponse({ error: 'no' }, 500)],
    ]);
    const show = vi.spyOn(notifications, 'show').mockImplementation(() => 'id');
    // The app's own query client carries the notification of a failed read.
    mounted = await renderWithQuery(createElement(AuditLogViewer), { client: createQueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } }) });
    await settle(400);
    expect(shown(show).filter((n) => n.title === 'Audit log' && n.message === 'Audit store is down')).toHaveLength(1);
  });
});

describe('WebhookManagement', () => {
  const ENDPOINT = { id: 'w1', url: 'https://example.com/hook', events: ['alert.fired'], status: 'active', scope: 'project', createdAt: '2026-01-01T00:00:00.000Z' };

  it('lists the endpoints and deletes one after a confirmation', async () => {
    api = installApiMock([
      ['GET', '/api/webhooks', () => ({ endpoints: [ENDPOINT], capabilities: { manage: true, workspaceScope: false } })],
      ['GET', '/api/webhooks/events', () => ({ events: [] })],
      ['DELETE', '/api/webhooks/w1', () => ({ success: true })],
    ]);
    mounted = await renderWithQuery(createElement(WebhookManagement));
    await settle(150);
    expect(text()).toContain('https://example.com/hook');
    await click(q('button[aria-label="Actions"]'));
    await click(buttonByText(en.webhooks.actions.delete) ?? q('[role="menuitem"]:last-child'));
    await settle(50);
    await click(buttonByText(en.webhooks.deleteModal.confirm));
    await settle(150);
    expect(api.to('DELETE', '/api/webhooks/w1')).toHaveLength(1);
    expect(api.to('GET', '/api/webhooks')).toHaveLength(2);
  });

  it('says the person may not see webhooks when the list is refused (403)', async () => {
    api = installApiMock([
      ['GET', '/api/webhooks', () => jsonResponse({ error: 'Forbidden' }, 403)],
      ['GET', '/api/webhooks/events', () => ({ events: [] })],
    ]);
    mounted = await renderWithQuery(createElement(WebhookManagement));
    await settle(150);
    expect(text()).toContain(en.webhooks.forbidden);
  });
});

describe('ProjectProvidersManager', () => {
  const ASSIGNED = { _id: 'pr1', key: 'one', label: 'One', type: 'model', driver: 'openai', status: 'active', projectIds: ['p1'] };
  const FREE = { _id: 'pr2', key: 'two', label: 'Two', type: 'model', driver: 'openai', status: 'active', projectIds: [] };

  it("lists the project's providers from the tenant list and assigns another one", async () => {
    api = installApiMock([
      ['GET', '/api/providers', () => ({ providers: [ASSIGNED, FREE] })],
      ['PATCH', '/api/providers/pr2', () => ({ ok: true })],
    ]);
    const show = vi.spyOn(notifications, 'show').mockImplementation(() => 'id');
    mounted = await renderWithQuery(createElement(ProjectProvidersManager, { projectId: 'p1' }));
    await settle(150);
    expect(api.to('GET', '/api/providers')[0]?.query).toEqual({ scope: 'tenant' });
    expect(text()).toContain('One');
    expect(text()).not.toContain('(two)');

    await click(buttonByText('Add provider'));
    await settle(50);
    await click(q('input[placeholder="Select a provider"]'));
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => /Two/.test(o.textContent ?? '')));
    await click([...document.querySelectorAll('button')].filter((b) => b.textContent === 'Add').pop());
    await settle(150);
    expect(api.to('PATCH', '/api/providers/pr2')[0]?.body).toEqual({ projectIds: ['p1'] });
    expect(api.to('PATCH', '/api/providers/pr2')[0]?.query).toEqual({ scope: 'tenant' });
    expect(shown(show).some((n) => n.message === 'Provider added' && n.color === 'green')).toBe(true);
    expect(api.to('GET', '/api/providers').length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to the project's own providers when the tenant list is refused, and then cannot assign", async () => {
    api = installApiMock([
      ['GET', '/api/providers', (call: { query: Record<string, string> }) => (call.query.scope === 'tenant' ? jsonResponse({ error: 'Forbidden' }, 403) : { providers: [ASSIGNED] })],
    ]);
    mounted = await renderWithQuery(createElement(ProjectProvidersManager, { projectId: 'p1' }));
    await settle(150);
    expect(text()).toContain('One');
    expect(buttonByText('Add provider')).toBeUndefined();
  });

  it('says the person may not see providers when both lists are refused', async () => {
    api = installApiMock([['GET', '/api/providers', () => jsonResponse({ error: 'Forbidden' }, 403)]]);
    mounted = await renderWithQuery(createElement(ProjectProvidersManager, { projectId: 'p1' }));
    await settle(150);
    expect(text()).toContain(en.common.forbidden);
  });
});
