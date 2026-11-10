/**
 * Platform-provided provider records through /api/providers: a project-scope read opens a platform record assigned
 * to the project (and 404s one that is not), a write answers 403 (not 404), only the tenant-scope PATCH may change
 * the assignment, and replies carry identity fields and the assignment only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1', userRole: 'owner' } as Record<string, string>,
  getProviderConfigById: vi.fn(),
  listProviderConfigs: vi.fn(),
  updateProviderConfig: vi.fn(),
  deleteProviderConfig: vi.fn(),
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    withApiRequestContext: (handler: unknown) => handler,
    requireSessionContext: () => hoisted.session,
    requireProjectContextForRequest: vi.fn(async () => ({ projectId: 'proj-ctx', session: hoisted.session })),
    sendProjectContextError: () => null,
  };
});
vi.mock('@/lib/services/providers/providerService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/providers/providerService')>();
  return {
    ...actual,
    getProviderConfigById: hoisted.getProviderConfigById,
    listProviderConfigs: hoisted.listProviderConfigs,
    updateProviderConfig: hoisted.updateProviderConfig,
    deleteProviderConfig: hoisted.deleteProviderConfig,
  };
});

import { providersApiPlugin } from '@/server/api/plugins/providers';
import { PlatformRecordReadOnlyError } from '@/lib/services/providers/managedProviderErrors';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const wide = {
  _id: 'prov-wide', tenantId: 'tenant-1', key: 'platform', type: 'model', driver: 'openai', label: 'Platform',
  status: 'active', platform: true, projectIds: ['proj-ctx'], hasCredentials: true, createdBy: 'op',
  description: 'internal note', settings: { endpoint: 'https://internal.example', managed: true },
  metadata: { region: 'internal' }, credentialFields: ['apiKey'],
};

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.getProviderConfigById.mockResolvedValue(wide);
  hoisted.listProviderConfigs.mockResolvedValue([wide]);
  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(providersApiPlugin);
  });
});
afterEach(async () => {
  await app.close();
});

const expectRedacted = (provider: Record<string, unknown>) => {
  expect(provider).toMatchObject({ key: 'platform', driver: 'openai', label: 'Platform', platform: true });
  expect(provider.settings).toEqual({});
  for (const hidden of ['description', 'metadata', 'credentialFields']) expect(provider).not.toHaveProperty(hidden);
};

describe('platform provider record over the dashboard routes', () => {
  it('opens in project scope and lists, both with identity fields only', async () => {
    const detail = await app.inject({ method: 'GET', url: '/api/providers/prov-wide' });
    expect(detail.statusCode).toBe(200);
    expectRedacted(parseJsonBody<{ provider: Record<string, unknown> }>(detail.body).provider);

    const list = await app.inject({ method: 'GET', url: '/api/providers' });
    expectRedacted(parseJsonBody<{ providers: Record<string, unknown>[] }>(list.body).providers[0]);

    const tenantScope = await app.inject({ method: 'GET', url: '/api/providers/prov-wide?scope=tenant' });
    expectRedacted(parseJsonBody<{ provider: Record<string, unknown> }>(tenantScope.body).provider);
  });

  it('answers a write with 403 and the platform code', async () => {
    hoisted.updateProviderConfig.mockRejectedValue(new PlatformRecordReadOnlyError());
    hoisted.deleteProviderConfig.mockRejectedValue(new PlatformRecordReadOnlyError());
    const patch = await app.inject({ method: 'PATCH', url: '/api/providers/prov-wide', payload: { label: 'x' } });
    expect(patch.statusCode).toBe(403);
    expect(parseJsonBody<{ code: string }>(patch.body).code).toBe('platform_record_read_only');
    const del = await app.inject({ method: 'DELETE', url: '/api/providers/prov-wide' });
    expect(del.statusCode).toBe(403);
  });

  it('keeps the tenant assignment in the redacted view', async () => {
    const detail = await app.inject({ method: 'GET', url: '/api/providers/prov-wide' });
    expect(parseJsonBody<{ provider: Record<string, unknown> }>(detail.body).provider.projectIds).toEqual(['proj-ctx']);
  });

  it('hides a platform record that is not assigned to the project (and opens it tenant-wide)', async () => {
    hoisted.getProviderConfigById.mockResolvedValue({ ...wide, projectIds: ['other'] });
    expect((await app.inject({ method: 'GET', url: '/api/providers/prov-wide' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/providers/prov-wide?scope=tenant' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: '/api/providers/prov-wide', payload: { projectIds: [] } })).statusCode).toBe(404);
  });

  it('lets only the tenant-scope PATCH change the assignment of a platform provider', async () => {
    hoisted.updateProviderConfig.mockResolvedValue({ ...wide });
    const tenant = await app.inject({ method: 'PATCH', url: '/api/providers/prov-wide?scope=tenant', payload: { projectIds: [] } });
    expect(tenant.statusCode).toBe(200);
    expect(hoisted.updateProviderConfig).toHaveBeenLastCalledWith(
      'tenant_acme', 'prov-wide', expect.objectContaining({ projectIds: [] }), { allowPlatformAssignment: true },
    );
    await app.inject({ method: 'PATCH', url: '/api/providers/prov-wide', payload: { projectIds: [] } });
    expect(hoisted.updateProviderConfig).toHaveBeenLastCalledWith(
      'tenant_acme', 'prov-wide', expect.anything(), { projectId: 'proj-ctx' },
    );
  });

  it('never takes platform from a tenant payload', async () => {
    hoisted.updateProviderConfig.mockResolvedValue({ ...wide });
    await app.inject({ method: 'PATCH', url: '/api/providers/prov-wide?scope=tenant', payload: { projectIds: [], platform: true, label: 'x' } });
    expect(hoisted.updateProviderConfig.mock.calls[0][2]).not.toHaveProperty('platform');
  });

  it('still hides an ordinary record of another project', async () => {
    hoisted.getProviderConfigById.mockResolvedValue({ ...wide, platform: false, projectIds: ['other'] });
    expect((await app.inject({ method: 'GET', url: '/api/providers/prov-wide' })).statusCode).toBe(404);
  });
});
