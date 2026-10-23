/**
 * The API gate and a switched-off service (serviceAvailability.ts).
 *
 * `enforceServiceAvailability` runs for every declared service route of a
 * session and of an API token, before any permission is asked:
 *   - a service the environment switched off answers 403 `service_disabled`,
 *     one the tenant's license leaves out answers 402 `service_not_licensed`,
 *     in every error dialect;
 *   - a route open to several services (`anyOf`) passes while one of them is on,
 *     and its handler refuses the off one (`authorizeServiceForRequest` resolves
 *     it as not allowed, `serviceRefusalError` answers `service_disabled`);
 *   - a handler that only filters by service leaves an off one out and answers;
 *   - an enterprise module can be off while the permission service it shares
 *     stays on (`/mcp/hubs` vs `/mcp/servers`);
 *   - a route that only asks for a signed-in caller, or none, is never refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  services: { disabled: [] as string[], enabled: [] as string[] },
  license: {} as { services?: { allow?: string[]; deny?: string[] } },
}));

vi.mock('@/lib/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/config')>();
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), services: hoisted.services }) };
});

vi.mock('@/lib/license/tenantLicense', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/license/tenantLicense')>();
  return {
    ...actual,
    resolveLiveLicenseForTenant: async () => ({ licenseType: 'STARTER', ...hoisted.license }),
  };
});

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { authz } from '@/lib/iam/routeAuthz';
import { clearServiceAvailabilityMemo } from '@/lib/services/availability/serviceAvailability';
import {
  authorizeServiceForRequest,
  serviceRefusalError,
  withApiRequestContext,
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

const SESSION_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-role': 'user',
  'x-user-email': 'u@acme.io',
  'x-license-type': 'STARTER',
};
const TOKEN_HEADERS = { authorization: 'Bearer tok_abc' };

async function buildApp() {
  return createFastifyApiTestApp(async (app) => {
    app.get('/dashboard/probe-rag', { config: authz.service('rag') }, withApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    app.get('/dashboard/probe-open', { config: authz.authenticated() }, withApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    app.get('/client/v1/probe-rag', { config: authz.service('rag') }, withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    app.get('/client/v1/probe-oai', { config: authz.service('rag') }, withOpenAiApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    app.get('/client/v1/probe-open', { config: authz.authenticated() }, withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    // Open to two services: the gate lets it in while one is on, and the handler asks about the resource it serves.
    app.get(
      '/client/v1/probe-any/:which',
      { config: authz.serviceAnyOf(['rag', 'models']) },
      withClientApiRequestContext(async (req, reply) => {
        const which = (req.params as { which: 'rag' | 'models' }).which;
        const result = await authorizeServiceForRequest(req, which, { level: 'read' });
        if (!result.allowed) throw serviceRefusalError(req, result);
        return reply.send({ ok: true });
      }),
    );
    // A handler that only filters by service (the overview, a list): what it may not read, it leaves out.
    app.get('/client/v1/probe-filter', { config: authz.authenticated() }, withClientApiRequestContext(async (req, reply) => {
      const [rag, models] = await Promise.all((['rag', 'models'] as const).map((service) =>
        authorizeServiceForRequest(req, service, { level: 'read' })));
      return reply.send({ rag: rag.allowed, models: models.allowed, off: rag.off?.service ?? null });
    }));
    app.get('/client/v1/mcp/hubs', { config: authz.service('mcp') }, withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    app.get('/client/v1/mcp/servers', { config: authz.service('mcp') }, withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.services = { disabled: [], enabled: [] };
  hoisted.license = {};
  clearServiceAvailabilityMemo();
  (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(
    createMockDb({ runWithTenant: <T>(_db: string, fn: () => T | Promise<T>) => fn() } as never),
  );
});

describe('the gate refuses a service that is switched off', () => {
  it('a session route answers 403 service_disabled when the environment switched it off', async () => {
    hoisted.services = { disabled: ['rag'], enabled: [] };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/probe-rag', headers: SESSION_HEADERS });
    expect(res.statusCode).toBe(403);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ code: 'service_disabled', service: 'rag', source: 'env' });
  });

  it('a session route answers 402 service_not_licensed when the license leaves it out', async () => {
    hoisted.license = { services: { deny: ['rag'] } };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/probe-rag', headers: SESSION_HEADERS });
    expect(res.statusCode).toBe(402);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ code: 'service_not_licensed', service: 'rag', source: 'license' });
  });

  it('a client-token route answers the same, 403 (environment) and 402 (license)', async () => {
    hoisted.services = { disabled: ['rag'], enabled: [] };
    const app = await buildApp();
    const env = await app.inject({ method: 'GET', url: '/api/client/v1/probe-rag', headers: TOKEN_HEADERS });
    expect(env.statusCode).toBe(403);
    expect(parseJsonBody<Record<string, unknown>>(env.body)).toMatchObject({ code: 'service_disabled', service: 'rag' });

    hoisted.services = { disabled: [], enabled: [] };
    hoisted.license = { services: { deny: ['rag'] } };
    clearServiceAvailabilityMemo();
    const lic = await app.inject({ method: 'GET', url: '/api/client/v1/probe-rag', headers: TOKEN_HEADERS });
    expect(lic.statusCode).toBe(402);
    expect(parseJsonBody<Record<string, unknown>>(lic.body)).toMatchObject({ code: 'service_not_licensed', service: 'rag' });
  });

  it('the OpenAI error style carries the code in its envelope', async () => {
    hoisted.services = { disabled: ['rag'], enabled: [] };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/probe-oai', headers: TOKEN_HEADERS });
    expect(res.statusCode).toBe(403);
    const body = parseJsonBody<{ error: { message: string; code?: string } }>(res.body);
    expect(body.error.code).toBe('service_disabled');
    expect(body.error.message).toMatch(/rag/);
  });

  it('a service the switches leave on is not refused', async () => {
    hoisted.services = { disabled: ['browser'], enabled: [] };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/probe-any/models', headers: TOKEN_HEADERS });
    expect(res.statusCode).toBe(200);
  });
});

describe('a route open to several services (anyOf)', () => {
  it('passes the gate while one of its services is on, and the handler refuses the off one', async () => {
    hoisted.services = { disabled: ['rag'], enabled: [] };
    const app = await buildApp();
    const on = await app.inject({ method: 'GET', url: '/api/client/v1/probe-any/models', headers: TOKEN_HEADERS });
    expect(on.statusCode).toBe(200);
    expect(parseJsonBody<{ ok: boolean }>(on.body).ok).toBe(true);

    const off = await app.inject({ method: 'GET', url: '/api/client/v1/probe-any/rag', headers: TOKEN_HEADERS });
    expect(off.statusCode).toBe(403);
    expect(parseJsonBody<Record<string, unknown>>(off.body)).toMatchObject({ code: 'service_disabled', service: 'rag' });
  });

  it('is refused at the gate when all of its services are off', async () => {
    hoisted.services = { disabled: ['rag', 'models'], enabled: [] };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/probe-any/models', headers: TOKEN_HEADERS });
    expect(res.statusCode).toBe(403);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ code: 'service_disabled' });
  });
});

describe('a handler that filters by service', () => {
  it('reads a switched-off service as one the caller may not read, and still answers', async () => {
    hoisted.services = { disabled: ['rag'], enabled: [] };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/probe-filter', headers: TOKEN_HEADERS });
    expect(res.statusCode, res.body).toBe(200);
    expect(parseJsonBody(res.body)).toEqual({ rag: false, models: true, off: 'rag' });
  });
});

describe('an enterprise module', () => {
  it('is refused when its module id is off while the permission service it shares stays on', async () => {
    hoisted.services = { disabled: ['mcp-hub'], enabled: [] };
    const app = await buildApp();
    const hubs = await app.inject({ method: 'GET', url: '/api/client/v1/mcp/hubs', headers: TOKEN_HEADERS });
    expect(hubs.statusCode).toBe(403);
    expect(parseJsonBody<Record<string, unknown>>(hubs.body)).toMatchObject({ code: 'service_disabled', service: 'mcp-hub' });

    const servers = await app.inject({ method: 'GET', url: '/api/client/v1/mcp/servers', headers: TOKEN_HEADERS });
    expect(servers.statusCode).toBe(200);
  });
});

describe('a route that asks for no service', () => {
  it('is never refused, whatever is switched off', async () => {
    hoisted.services = { disabled: ['rag', 'models', 'agents', 'mcp', 'mcp-hub'], enabled: [] };
    const app = await buildApp();
    const session = await app.inject({ method: 'GET', url: '/api/dashboard/probe-open', headers: SESSION_HEADERS });
    expect(session.statusCode).toBe(200);
    const token = await app.inject({ method: 'GET', url: '/api/client/v1/probe-open', headers: TOKEN_HEADERS });
    expect(token.statusCode).toBe(200);
  });
});
