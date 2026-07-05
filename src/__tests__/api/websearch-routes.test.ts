/**
 * API tests — Web Search Fastify plugins (dashboard + client v1).
 * Mocks the service layer; verifies routing, validation, and response shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', async () => {
  const actual = await vi.importActual<typeof import('@/lib/database')>('@/lib/database');
  return {
    ...actual,
    getDatabase: vi.fn().mockResolvedValue({
      switchToTenant: vi.fn().mockResolvedValue(undefined),
      runWithTenant: vi.fn((_db: string, fn: () => unknown) => fn()),
      findUserById: vi.fn().mockResolvedValue({
        _id: 'user-1',
        email: 'a@b.com',
        role: 'owner',
        tenantId: 'tenant-1',
        servicePermissions: {},
      }),
    }),
  };
});

vi.mock('@/lib/services/webSearch', () => ({
  listWebSearchProviders: vi.fn(),
  listWebSearchRunLogs: vi.fn(),
  runWebSearch: vi.fn(),
}));

vi.mock('@/lib/services/providers/providerService', () => ({
  getProviderConfigByKey: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return {
    ProjectContextError,
    resolveProjectContext: vi.fn().mockResolvedValue({
      projectId: 'proj-1',
      project: { _id: 'proj-1', key: 'default', name: 'Default' },
      userProject: null,
    }),
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
  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: vi.fn(),
  };
});

import { websearchApiPlugin } from '@/server/api/plugins/websearch';
import { clientWebSearchApiPlugin } from '@/server/api/plugins/client-websearch';
import {
  listWebSearchProviders,
  listWebSearchRunLogs,
  runWebSearch,
} from '@/lib/services/webSearch';
import { getProviderConfigByKey } from '@/lib/services/providers/providerService';
import { requireApiTokenFromHeader, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-email': 'a@b.com',
  'x-user-role': 'admin',
  'x-license-type': 'PROFESSIONAL',
};

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'PROFESSIONAL' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'owner', tenantId: 'tenant-1', servicePermissions: {} },
};

const MOCK_PROVIDER = {
  _id: 'prov-1',
  key: 'brave-main',
  type: 'websearch',
  driver: 'brave-search',
  label: 'Brave',
  status: 'active',
  settings: { aiAnswer: { enabled: true, modelKey: 'gpt-4' } },
  hasCredentials: true,
};

const MOCK_RESULT = {
  providerKey: 'brave-main',
  driver: 'brave-search',
  query: 'hello',
  results: [
    { title: 'A', url: 'https://a.example', snippet: 'aa', position: 1 },
  ],
  answer: undefined,
  latencyMs: 42,
};

const MOCK_LOGS = [
  {
    _id: 'log-1',
    tenantId: 'tenant-1',
    searchKey: 'brave-main',
    driver: 'brave-search',
    query: 'hello',
    resultCount: 3,
    latencyMs: 120,
    status: 'success',
    source: 'api',
    createdAt: new Date('2026-07-01T10:00:00Z'),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  (listWebSearchProviders as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_PROVIDER]);
  (listWebSearchRunLogs as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_LOGS);
  (runWebSearch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RESULT);
  (getProviderConfigByKey as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROVIDER);
  (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
});

// ── Dashboard plugin ─────────────────────────────────────────────────────────

describe('GET /api/websearch/providers/drivers', () => {
  it('lists websearch drivers from the registry', async () => {
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({ method: 'GET', url: '/api/websearch/providers/drivers', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ drivers: Array<{ id: string; domains: string[] }> }>(res.body);
    const ids = body.drivers.map((d) => d.id);
    expect(ids).toEqual(
      expect.arrayContaining(['bing', 'brave-search', 'serper', 'tavily', 'searxng', 'duckduckgo']),
    );
    body.drivers.forEach((d) => expect(d.domains).toContain('websearch'));
  });

});

describe('GET /api/websearch/providers', () => {
  it('lists providers scoped to the active project', async () => {
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({ method: 'GET', url: '/api/websearch/providers', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ providers: unknown[] }>(res.body).providers).toHaveLength(1);
    expect(listWebSearchProviders).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1');
  });
});

describe('GET /api/websearch/providers/:key (dashboard)', () => {
  it('returns the instance when it exists in project scope', async () => {
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({
      method: 'GET',
      url: '/api/websearch/providers/brave-main',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ provider: { key: string } }>(res.body).provider.key).toBe('brave-main');
    expect(getProviderConfigByKey).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'brave-main',
      'proj-1',
    );
  });

  it('404s when the record is not a websearch provider', async () => {
    (getProviderConfigByKey as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...MOCK_PROVIDER,
      type: 'model',
    });
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({
      method: 'GET',
      url: '/api/websearch/providers/openai-main',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/websearch/providers/:key/logs (dashboard)', () => {
  it('returns run logs for the instance', async () => {
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({
      method: 'GET',
      url: '/api/websearch/providers/brave-main/logs?limit=10',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ logs: Array<{ query: string; status: string }> }>(res.body);
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0].query).toBe('hello');
    expect(listWebSearchRunLogs).toHaveBeenCalledWith('tenant_acme', 'brave-main', {
      limit: 10,
      skip: 0,
    });
  });

  it('404s for an unknown instance', async () => {
    (getProviderConfigByKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({
      method: 'GET',
      url: '/api/websearch/providers/nope/logs',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(404);
    expect(listWebSearchRunLogs).not.toHaveBeenCalled();
  });
});

describe('POST /api/websearch/search (dashboard)', () => {
  it('runs a search with the dashboard source', async () => {
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/websearch/search',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'hello', provider: 'brave-main', count: 5 }),
    });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ result: { providerKey: string } }>(res.body).result.providerKey).toBe('brave-main');
    expect(runWebSearch).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      expect.objectContaining({ query: 'hello', providerKey: 'brave-main', count: 5, source: 'dashboard' }),
    );
  });

  it('rejects a missing query with 400', async () => {
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/websearch/search',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });

  it('maps service errors to 400 with the message', async () => {
    (runWebSearch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('No active web search provider is configured.'),
    );
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/websearch/search',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'hello' }),
    });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toMatch(/no active web search provider/i);
  });
});

// ── Client v1 plugin ─────────────────────────────────────────────────────────

describe('GET /api/client/v1/websearch/providers', () => {
  it('returns the trimmed provider listing', async () => {
    const app = await createFastifyApiTestApp(clientWebSearchApiPlugin);
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/websearch/providers',
      headers: { authorization: 'Bearer tok_abc' },
    });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ providers: Array<Record<string, unknown>> }>(res.body);
    expect(body.providers).toEqual([
      { key: 'brave-main', driver: 'brave-search', label: 'Brave', status: 'active', aiAnswer: true },
    ]);
  });

  it('returns 401 for an invalid token', async () => {
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Invalid API token', 401),
    );
    const app = await createFastifyApiTestApp(clientWebSearchApiPlugin);
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/websearch/providers' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/client/v1/websearch/search', () => {
  it('runs a search and returns the normalized envelope', async () => {
    const app = await createFastifyApiTestApp(clientWebSearchApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/websearch/search',
      headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'hello', safe_search: 'strict' }),
    });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{
      id: string;
      provider: string;
      driver: string;
      results: Array<{ title: string; position: number }>;
      latency_ms: number;
    }>(res.body);
    expect(body.id).toMatch(/^websearch-/);
    expect(body.provider).toBe('brave-main');
    expect(body.driver).toBe('brave-search');
    expect(body.results[0]).toMatchObject({ title: 'A', position: 1 });
    expect(body.latency_ms).toBe(42);
    expect(runWebSearch).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      expect.objectContaining({ query: 'hello', safeSearch: 'strict', source: 'api' }),
    );
  });

  it('rejects a missing query with 400', async () => {
    const app = await createFastifyApiTestApp(clientWebSearchApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/websearch/search',
      headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
      payload: JSON.stringify({ provider: 'brave-main' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('passes include_answer through to the service', async () => {
    const app = await createFastifyApiTestApp(clientWebSearchApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/websearch/search',
      headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'hello', include_answer: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(runWebSearch).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      expect.objectContaining({ query: 'hello', includeAnswer: true }),
    );
  });

  it('POST /:key/search targets the named instance, ignoring body.provider', async () => {
    const app = await createFastifyApiTestApp(clientWebSearchApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/websearch/brave-main/search',
      headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'hello', provider: 'other-instance' }),
    });
    expect(res.statusCode).toBe(200);
    expect(runWebSearch).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      expect.objectContaining({ query: 'hello', providerKey: 'brave-main' }),
    );
  });

  it('surfaces service errors as 400 with the message', async () => {
    (runWebSearch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Provider "x" is not a web search provider.'),
    );
    const app = await createFastifyApiTestApp(clientWebSearchApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/websearch/search',
      headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'hello', provider: 'x' }),
    });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toMatch(/not a web search provider/i);
  });
});
