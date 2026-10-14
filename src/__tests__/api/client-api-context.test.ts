/**
 * Tests for the SINGLE canonical client (API-token) request wrapper.
 *
 * Every token-authenticated route now funnels through
 * `withClientApiRequestContext` / `withOpenAiApiRequestContext` in
 * fastify-utils. These tests lock the contract that all of them inherit:
 *   - missing/invalid token → 401 (correct envelope per error style)
 *   - valid token → handler runs with `auth` and the tenant DB bound via runWithTenant
 *   - the authorization engine decides every route that resolves to a service
 *     (closing the historical chat/embeddings/ocr-jobs bypass); skippable via
 *     `{ rbac: false }`; a route that declares nothing is refused
 *   - OpenAI error envelope for `withOpenAiApiRequestContext`
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: vi.fn(),
  };
});

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});

vi.mock('@/lib/core/lifecycle', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

import { requireApiTokenFromHeader, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { authz } from '@/lib/iam/routeAuthz';
import {
  withClientApiRequestContext,
  withOpenAiApiRequestContext,
} from '@/server/api/fastify-utils';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'user', tenantId: 'tenant-1' },
};

const runWithTenant = vi.fn(<T>(_db: string, fn: () => T | Promise<T>) => fn());

async function buildApp() {
  return createFastifyApiTestApp(async (app) => {
    // Signed in is all it takes: no permission service applies.
    app.get(
      '/client/v1/probe',
      { config: authz.authenticated() },
      withClientApiRequestContext(async (_req, reply, auth) =>
        reply.send({ ok: true, tenant: auth.tenantDbName, userId: auth.tokenRecord.userId }),
      ),
    );
    // A service the token's owner (a plain member) can use, and one only admins can.
    app.get(
      '/client/v1/probe-models',
      { config: authz.service('models') },
      withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })),
    );
    app.get(
      '/client/v1/probe-members',
      { config: authz.service('members') },
      withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })),
    );
    app.get(
      '/client/v1/probe-norbac',
      { config: authz.service('members') },
      withClientApiRequestContext(
        async (_req, reply) => reply.send({ ok: true }),
        { rbac: false },
      ),
    );
    // Declares nothing and no prefix maps it.
    app.get(
      '/client/v1/probe-undeclared',
      withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })),
    );
    // Mapped by the /client/v1/chat prefix (service: models).
    app.get(
      '/client/v1/chat/probe',
      withOpenAiApiRequestContext(async (_req, reply) => reply.send({ ok: true })),
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb({ runWithTenant } as never));
});

describe('withClientApiRequestContext (canonical token wrapper)', () => {
  it('rejects a missing/invalid token with 401 and a JSON error envelope', async () => {
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Invalid API token', 401),
    );
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/probe' });
    expect(res.statusCode).toBe(401);
    expect(parseJsonBody<{ error: string }>(res.body).error).toMatch(/invalid api token/i);
  });

  it('runs the handler with auth and binds the tenant via runWithTenant', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/probe',
      headers: { authorization: 'Bearer tok_abc' },
    });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ tenant: string; userId: string }>(res.body);
    expect(body.tenant).toBe('tenant_acme');
    expect(body.userId).toBe('user-1');
    expect(runWithTenant).toHaveBeenCalledWith('tenant_acme', expect.any(Function));
  });

  it('enforces the engine: a service the token user is not allowed → 403 with the decision', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/probe-members',
      headers: { authorization: 'Bearer tok_abc' },
    });
    expect(res.statusCode).toBe(403);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({
      code: 'forbidden',
      service: 'members',
      required: 'read',
      decisionId: expect.any(String),
    });
  });

  it('allows a service when the token user IS authorized', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/probe-models',
      headers: { authorization: 'Bearer tok_abc' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('admits a route that only asks for a signed-in token (authenticated)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/probe',
      headers: { authorization: 'Bearer tok_abc' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a route that declares nothing, and counts it', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/probe-undeclared',
      headers: { authorization: 'Bearer tok_abc' },
    });
    expect(res.statusCode).toBe(403);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ code: 'route_not_declared' });
  });

  it('skips the engine when { rbac: false } even on a service the token user lacks', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/probe-norbac',
      headers: { authorization: 'Bearer tok_abc' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('withOpenAiApiRequestContext (OpenAI error envelope)', () => {
  it('emits the OpenAI error shape on auth failure', async () => {
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Invalid API token', 401),
    );
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/chat/probe' });
    expect(res.statusCode).toBe(401);
    const body = parseJsonBody<{ error: { message: string; type: string } }>(res.body);
    expect(body.error.message).toMatch(/invalid api token/i);
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('still binds the tenant and runs the handler on success', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/chat/probe',
      headers: { authorization: 'Bearer tok_abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(runWithTenant).toHaveBeenCalledWith('tenant_acme', expect.any(Function));
  });
});
