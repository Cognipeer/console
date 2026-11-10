/**
 * A storage-limit refusal on a vector upsert (a platform provider's `assertStorageStock`) is answered 413 with the
 * typed envelope, on the dashboard route and on the client API route, not as a 500 with the message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1', userRole: 'owner', licenseType: 'STARTER' } as Record<string, string>,
  auth: {
    token: 'tok',
    tokenRecord: { _id: 'tok-1', userId: 'user-1' },
    tenant: { licenseType: 'STARTER' },
    tenantId: 'tenant-1',
    tenantDbName: 'tenant_acme',
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'owner' },
  },
  db: { switchToTenant: vi.fn(), getProjectVectorCountApprox: vi.fn(), incrementProjectVectorCountApprox: vi.fn() },
  upsertVectors: vi.fn(),
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    withApiRequestContext: (handler: unknown) => handler,
    withClientApiRequestContext: (handler: (...args: unknown[]) => unknown) =>
      (request: unknown, reply: unknown) => handler(request, reply, hoisted.auth),
    getApiTokenContextForRequest: async () => hoisted.auth,
    requireProjectContextForRequest: vi.fn(async () => ({ projectId: 'proj-1', session: hoisted.session })),
    sendProjectContextError: () => null,
  };
});
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => hoisted.db),
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(hoisted.db),
}));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkPerRequestLimits: vi.fn(async () => ({ allowed: true, effectiveLimits: {} })),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  checkResourceQuota: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('@/lib/services/vector', () => ({
  upsertVectors: hoisted.upsertVectors,
  VectorAttachRequiresDetailsError: class extends Error {},
  VectorAttachNotFoundError: class extends Error {},
}));

import { PlanLimitError } from '@/lib/limits/errors';
import { clientVectorApiPlugin } from '@/server/api/plugins/client-vector';
import { vectorApiPlugin } from '@/server/api/plugins/vector';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const BODY = { vectors: [{ id: 'v1', values: [0.1, 0.2] }] };
const refusal = () => new PlanLimitError({
  code: 'storage_quota_exceeded',
  message: 'Storage is full (1.0 of 1.0 GB).',
  kind: 'storage',
  dimension: 'storage',
  limit: 1,
  used: 1,
});

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>> | null = null;
afterEach(async () => { await app?.close(); app = null; });
beforeEach(() => { vi.clearAllMocks(); });

const post = (url: string) =>
  app!.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(BODY) });

describe.each([
  ['dashboard', vectorApiPlugin, '/api/vector/indexes/idx/upsert?providerKey=platform-vector'],
  ['client', clientVectorApiPlugin, '/api/client/v1/vector/providers/platform-vector/indexes/idx/upsert'],
] as const)('%s vector upsert', (_name, plugin, url) => {
  it('answers a storage-limit refusal 413 with the typed envelope', async () => {
    app = await createFastifyApiTestApp(plugin, { rawJsonBody: true });
    hoisted.upsertVectors.mockRejectedValueOnce(refusal());
    const res = await post(url);
    expect(res.statusCode).toBe(413);
    expect(res.headers['x-cognipeer-error-code']).toBe('storage_quota_exceeded');
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({
      error: 'Storage is full (1.0 of 1.0 GB).',
      code: 'storage_quota_exceeded',
      kind: 'storage',
    });
  });

  it('still answers any other failure 500', async () => {
    app = await createFastifyApiTestApp(plugin, { rawJsonBody: true });
    hoisted.upsertVectors.mockRejectedValueOnce(new Error('boom'));
    const res = await post(url);
    expect(res.statusCode).toBe(500);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toEqual({ error: 'boom' });
  });
});
