/**
 * A plan-limit refusal thrown by a dashboard (cookie session) handler answers with
 * its status, headers and the dashboard envelope; any other error is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

import { getDatabase } from '@/lib/database';
import { authz } from '@/lib/iam/routeAuthz';
import { PlanLimitError } from '@/lib/limits/errors';
import { withApiRequestContext } from '@/server/api/fastify-utils';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const SESSION_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-role': 'user',
  'x-user-email': 'u@acme.io',
  'x-license-type': 'STARTER',
};

async function buildApp(thrown: () => unknown) {
  return createFastifyApiTestApp(async (app) => {
    app.get('/dashboard/probe-limit', { config: authz.authenticated() }, withApiRequestContext(async () => {
      throw thrown();
    }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(
    createMockDb({ runWithTenant: <T>(_db: string, fn: () => T | Promise<T>) => fn() } as never),
  );
});

describe('dashboard route refusal for plan limits', () => {
  it('sends the refusal status, Retry-After and the dashboard body', async () => {
    const app = await buildApp(() => new PlanLimitError({
      code: 'tenant_concurrency_limited',
      message: 'No free slot.',
      kind: 'concurrency',
      dimension: 'agent',
      limit: 3,
      used: 3,
      retryAfterMs: 4200,
    }));
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/probe-limit', headers: SESSION_HEADERS });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.headers['x-cognipeer-error-code']).toBe('tenant_concurrency_limited');
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({
      error: 'No free slot.',
      type: 'rate_limit_error',
      code: 'tenant_concurrency_limited',
      kind: 'concurrency',
      dimension: 'agent',
      limit: 3,
      used: 3,
      retry_after_ms: 4200,
    });
  });

  it('omits Retry-After when the refusal has no retry time', async () => {
    const app = await buildApp(() => new PlanLimitError({
      code: 'storage_quota_exceeded', message: 'Storage is full.', kind: 'storage',
    }));
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/probe-limit', headers: SESSION_HEADERS });
    expect(res.statusCode).toBe(413);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ code: 'storage_quota_exceeded' });
  });

  it('leaves other errors to the framework (500)', async () => {
    const app = await buildApp(() => new Error('boom'));
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/probe-limit', headers: SESSION_HEADERS });
    expect(res.statusCode).toBe(500);
    expect(res.headers['x-cognipeer-error-code']).toBeUndefined();
  });
});
