import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/quota/quotaService', () => ({
  listQuotaPolicies: vi.fn(),
  createQuotaPolicy: vi.fn(),
}));

import { GET, POST } from '@/app/api/quota/policies/route';
import { listQuotaPolicies, createQuotaPolicy } from '@/lib/services/quota/quotaService';

const mockListQuotaPolicies = listQuotaPolicies as ReturnType<typeof vi.fn>;
const mockCreateQuotaPolicy = createQuotaPolicy as ReturnType<typeof vi.fn>;

const mockPolicy = {
  _id: 'pol-1',
  scope: 'tenant',
  domain: 'llm',
  limits: { requestsPerMinute: 100 },
  enabled: true,
  label: 'Default Policy',
};

function makeRequest(opts: {
  method?: string;
  body?: unknown;
  searchParams?: string;
  headers?: Record<string, string>;
} = {}) {
  const method = opts.method ?? 'GET';
  const url = `http://localhost/api/quota/policies${opts.searchParams ? '?' + opts.searchParams : ''}`;
  return new NextRequest(url, {
    method,
    headers: {
      'x-tenant-db-name': 'tenant_acme',
      'x-tenant-id': 'tenant-1',
      'x-user-id': 'user-1',
      'x-user-role': 'owner',
      'content-type': 'application/json',
      ...opts.headers,
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe('GET /api/quota/policies', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns policies list', async () => {
    mockListQuotaPolicies.mockResolvedValue([mockPolicy]);
    const req = makeRequest();
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.policies).toHaveLength(1);
    expect(body.policies[0].scope).toBe('tenant');
  });

  it('returns empty list when no policies', async () => {
    mockListQuotaPolicies.mockResolvedValue([]);
    const req = makeRequest();
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.policies).toHaveLength(0);
  });

  it('passes domain, scope, enabled filters', async () => {
    mockListQuotaPolicies.mockResolvedValue([]);
    const req = makeRequest({ searchParams: 'domain=llm&scope=tenant&enabled=true' });
    await GET(req);
    expect(mockListQuotaPolicies).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      expect.objectContaining({ domain: 'llm', scope: 'tenant', enabled: true }),
    );
  });

  it('passes enabled=false filter', async () => {
    mockListQuotaPolicies.mockResolvedValue([]);
    const req = makeRequest({ searchParams: 'enabled=false' });
    await GET(req);
    expect(mockListQuotaPolicies).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      expect.objectContaining({ enabled: false }),
    );
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/quota/policies');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    mockListQuotaPolicies.mockRejectedValue(new Error('DB error'));
    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/quota/policies', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a policy and returns 201', async () => {
    mockCreateQuotaPolicy.mockResolvedValue(mockPolicy);
    const req = makeRequest({
      method: 'POST',
      body: { scope: 'tenant', domain: 'llm', limits: { requestsPerMinute: 100 } },
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.policy.scope).toBe('tenant');
  });

  it('returns 400 when required fields missing', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { scope: 'tenant' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when domain missing', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { scope: 'tenant', limits: {} },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when limits missing', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { scope: 'tenant', domain: 'llm' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/quota/policies', {
      method: 'POST',
      body: JSON.stringify({ scope: 'tenant', domain: 'llm', limits: {} }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when non-owner/admin user', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { scope: 'tenant', domain: 'llm', limits: {} },
      headers: { 'x-user-role': 'user' },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('allows admin to create policy', async () => {
    mockCreateQuotaPolicy.mockResolvedValue(mockPolicy);
    const req = makeRequest({
      method: 'POST',
      body: { scope: 'tenant', domain: 'llm', limits: { requestsPerMinute: 50 } },
      headers: { 'x-user-role': 'admin' },
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
  });

  it('returns 500 on unexpected error', async () => {
    mockCreateQuotaPolicy.mockRejectedValue(new Error('DB error'));
    const req = makeRequest({
      method: 'POST',
      body: { scope: 'tenant', domain: 'llm', limits: {} },
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
