import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return { requireApiToken: vi.fn(), ApiTokenAuthError };
});

vi.mock('@/lib/services/metrics/prometheusExporter', () => ({
  collectPrometheusMetrics: vi.fn(),
}));

vi.mock('@/lib/services/quota/quotaService', () => ({
  getPlanDefaults: vi.fn(),
}));

import { GET as getMetrics } from '@/app/api/metrics/route';
import { GET as getQuotaDefaults } from '@/app/api/quota/defaults/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { collectPrometheusMetrics } from '@/lib/services/metrics/prometheusExporter';
import { getPlanDefaults } from '@/lib/services/quota/quotaService';

const MOCK_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
  user: { email: 'user@acme.com' },
};

function makeReq(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, { headers });
}

function makeQuotaReq(licenseType?: string) {
  const headers: Record<string, string> = licenseType ? { 'x-license-type': licenseType } : {};
  return new NextRequest('http://localhost/api/quota/defaults', { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_CTX);
  (collectPrometheusMetrics as ReturnType<typeof vi.fn>).mockResolvedValue('# HELP model_requests_total\nmodel_requests_total 42\n');
  (getPlanDefaults as ReturnType<typeof vi.fn>).mockResolvedValue({ models: 10, apiTokens: 5 });
});

describe('GET /api/metrics', () => {
  it('returns Prometheus text format 200', async () => {
    const req = makeReq('/api/metrics', { authorization: 'Bearer tok_abc' });
    const res = await getMetrics(req);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('model_requests_total');
  });

  it('returns correct Content-Type header', async () => {
    const req = makeReq('/api/metrics', { authorization: 'Bearer tok_abc' });
    const res = await getMetrics(req);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
  });

  it('returns 401 on invalid token', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(new (ApiTokenAuthError as any)('Unauthorized', 401));
    const req = makeReq('/api/metrics');
    const res = await getMetrics(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 on forbidden token', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(new (ApiTokenAuthError as any)('Forbidden', 403));
    const req = makeReq('/api/metrics');
    const res = await getMetrics(req);
    expect(res.status).toBe(403);
  });

  it('passes tenantDbName and tenantId to collector', async () => {
    const req = makeReq('/api/metrics', { authorization: 'Bearer tok_abc' });
    await getMetrics(req);
    expect(collectPrometheusMetrics).toHaveBeenCalledWith('tenant_acme', 'tenant-1');
  });

  it('returns 500 on collection error', async () => {
    (collectPrometheusMetrics as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('collector failed'));
    const req = makeReq('/api/metrics', { authorization: 'Bearer tok_abc' });
    const res = await getMetrics(req);
    expect(res.status).toBe(500);
  });
});

describe('GET /api/quota/defaults', () => {
  it('returns quota defaults for license type 200', async () => {
    const req = makeQuotaReq('STARTER');
    const res = await getQuotaDefaults(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.licenseType).toBe('STARTER');
    expect(body.defaults).toBeDefined();
    expect(body.defaults.models).toBe(10);
  });

  it('returns 400 when license type header missing', async () => {
    const req = makeQuotaReq();
    const res = await getQuotaDefaults(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('License');
  });

  it('passes license type to getPlanDefaults', async () => {
    const req = makeQuotaReq('PRO');
    await getQuotaDefaults(req);
    expect(getPlanDefaults).toHaveBeenCalledWith('PRO');
  });

  it('returns 500 on getPlanDefaults error', async () => {
    (getPlanDefaults as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const req = makeQuotaReq('STARTER');
    const res = await getQuotaDefaults(req);
    expect(res.status).toBe(500);
  });

  it('returns empty defaults object gracefully', async () => {
    (getPlanDefaults as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const req = makeQuotaReq('FREE');
    const res = await getQuotaDefaults(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.defaults).toEqual({});
  });
});
