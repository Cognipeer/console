/**
 * API requests per minute at the client API wrapper: counted once per request,
 * refused in the caller's dialect with the rate headers, skipped for routes
 * configured `countRpm: false`, and untouched when plan limits are off.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// The engine's real function is the default; a test swaps it to count calls or refuse.
vi.mock('@/lib/limits/rpm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/limits/rpm')>();
  return { ...actual, assertApiRequestRate: vi.fn(actual.assertApiRequestRate) };
});

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { authz } from '@/lib/iam/routeAuthz';
import { assertApiRequestRate } from '@/lib/limits/rpm';
import { PlanLimitError } from '@/lib/limits/errors';
import {
  getApiTokenContextForRequest,
  withAnthropicApiRequestContext,
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

const assertRate = assertApiRequestRate as unknown as ReturnType<typeof vi.fn>;
const original = assertRate.getMockImplementation()!;

function refusal() {
  return new PlanLimitError({
    code: 'tenant_rate_limited',
    message: 'Tenant API limit reached: 60 requests per minute. Retry after 7 seconds.',
    kind: 'api_rpm',
    dimension: 'apiRpm',
    limit: 60,
    used: 60,
    retryAfterMs: 6500,
  });
}

async function buildApp() {
  return createFastifyApiTestApp(async (app) => {
    app.get('/client/v1/probe', { config: authz.authenticated() },
      withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    app.get('/client/v1/twice', { config: authz.authenticated() },
      withClientApiRequestContext(async (req, reply) => {
        // A second authentication inside the handler (as several routes do) must not count again.
        await getApiTokenContextForRequest(req, reply);
        await getApiTokenContextForRequest(req, reply);
        return reply.send({ ok: true });
      }));
    app.get('/client/v1/status', { config: { ...authz.authenticated(), countRpm: false } as never },
      withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    app.get('/client/v1/chat/probe', { config: authz.authenticated() },
      withOpenAiApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    app.get('/client/v1/messages/probe', { config: authz.authenticated() },
      withAnthropicApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
  });
}

const get = (app: Awaited<ReturnType<typeof buildApp>>, url: string) =>
  app.inject({ method: 'GET', url: `/api${url}`, headers: { authorization: 'Bearer tok_abc' } });

beforeEach(() => {
  vi.clearAllMocks();
  assertRate.mockImplementation(original);
  (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(
    createMockDb({ runWithTenant: <T>(_db: string, fn: () => T | Promise<T>) => fn() } as never),
  );
});

describe('client API requests per minute', () => {
  it('counts a request once, even when the handler authenticates again', async () => {
    assertRate.mockResolvedValue({ 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '59', 'X-RateLimit-Reset': '60' });
    const app = await buildApp();
    const res = await get(app, '/client/v1/twice');
    expect(res.statusCode).toBe(200);
    expect(assertRate).toHaveBeenCalledTimes(1);
    expect(assertRate).toHaveBeenCalledWith({ tenantId: 'tenant-1', source: { type: 'api_token', id: 'tok-1' } });
  });

  it('puts the rate headers on a successful response', async () => {
    assertRate.mockResolvedValue({ 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '59', 'X-RateLimit-Reset': '60' });
    const app = await buildApp();
    const res = await get(app, '/client/v1/probe');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('60');
    expect(res.headers['x-ratelimit-remaining']).toBe('59');
    expect(res.headers['x-ratelimit-reset']).toBe('60');
  });

  it('skips a route configured countRpm: false', async () => {
    const app = await buildApp();
    const res = await get(app, '/client/v1/status');
    expect(res.statusCode).toBe(200);
    expect(assertRate).not.toHaveBeenCalled();
  });

  it('refuses in the json dialect with the code and the retry headers', async () => {
    assertRate.mockRejectedValue(refusal());
    const app = await buildApp();
    const res = await get(app, '/client/v1/probe');
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('7');
    expect(res.headers['x-ratelimit-limit']).toBe('60');
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(res.headers['x-cognipeer-error-code']).toBe('tenant_rate_limited');
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ code: 'tenant_rate_limited', type: 'rate_limit_error', limit: 60 });
  });

  it('refuses in the OpenAI dialect', async () => {
    assertRate.mockRejectedValue(refusal());
    const app = await buildApp();
    const res = await get(app, '/client/v1/chat/probe');
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('7');
    expect(parseJsonBody<{ error: Record<string, unknown> }>(res.body).error).toMatchObject({
      type: 'rate_limit_error',
      code: 'tenant_rate_limited',
    });
  });

  it('refuses in the Anthropic dialect', async () => {
    assertRate.mockRejectedValue(refusal());
    const app = await buildApp();
    const res = await get(app, '/client/v1/messages/probe');
    expect(res.statusCode).toBe(429);
    expect(res.headers['x-cognipeer-error-code']).toBe('tenant_rate_limited');
    const body = parseJsonBody<{ type: string; error: Record<string, unknown> }>(res.body);
    expect(body.type).toBe('error');
    expect(body.error).toMatchObject({ type: 'rate_limit_error', code: 'tenant_rate_limited' });
  });

  it('refuses a used-up monthly allowance with 402 and no Retry-After in every dialect, so SDKs do not retry it', async () => {
    assertRate.mockRejectedValue(new PlanLimitError({
      code: 'monthly_allowance_exhausted', message: 'Allowance used up.', kind: 'monthly', dimension: 'flowRuns', retryAfterMs: 86_400_000,
    }));
    const app = await buildApp();
    for (const [url, type] of [
      ['/client/v1/probe', 'insufficient_quota'],
      ['/client/v1/chat/probe', 'insufficient_quota'],
      ['/client/v1/messages/probe', 'invalid_request_error'],
    ] as const) {
      const res = await get(app, url);
      expect(res.statusCode).toBe(402);
      expect(res.headers['retry-after']).toBeUndefined();
      expect(res.headers['x-allowance-name']).toBe('flowRuns');
      const body = parseJsonBody<Record<string, unknown> & { error: unknown }>(res.body);
      expect(typeof body.error === 'object' ? body.error : body).toMatchObject({ type, code: 'monthly_allowance_exhausted' });
    }
  });

  it('leaves the request untouched when plan limits are off (default deployment)', async () => {
    const app = await buildApp();
    const res = await get(app, '/client/v1/probe');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(parseJsonBody<{ ok: boolean }>(res.body).ok).toBe(true);
  });
});

describe('public entry points requests per minute', () => {
  async function publicApp() {
    const { gatePublicRequestRate } = await import('@/server/api/publicRpmGate');
    return createFastifyApiTestApp(async (app) => {
      app.post('/public/probe', async (request, reply) => {
        const refused = await gatePublicRequestRate(request, reply, { tenantId: 'tenant-1', sourceType: 'webhook', sourceId: 'trg-1' });
        if (refused) return refused;
        return reply.send({ ok: true });
      });
    });
  }

  it('counts under the entry point source and sets the rate headers', async () => {
    assertRate.mockResolvedValue({ 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '10', 'X-RateLimit-Reset': '30' });
    const res = await (await publicApp()).inject({ method: 'POST', url: '/api/public/probe' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-remaining']).toBe('10');
    expect(assertRate).toHaveBeenCalledWith({ tenantId: 'tenant-1', source: { type: 'webhook', id: 'trg-1' } });
  });

  it('refuses with the plan limit body and headers', async () => {
    assertRate.mockRejectedValue(refusal());
    const res = await (await publicApp()).inject({ method: 'POST', url: '/api/public/probe' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('7');
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ code: 'tenant_rate_limited' });
  });

  it('does nothing when plan limits are off', async () => {
    const res = await (await publicApp()).inject({ method: 'POST', url: '/api/public/probe' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });
});
