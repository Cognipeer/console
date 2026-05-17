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
  getLicenseDefaults: vi.fn(),
}));

import { GET as getMetrics } from '@/server/api/routes/metrics/route';
import { GET as getQuotaDefaults } from '@/server/api/routes/quota/defaults/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { collectPrometheusMetrics } from '@/lib/services/metrics/prometheusExporter';
import { getLicenseDefaults } from '@/lib/services/quota/quotaService';

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

function makeQuotaReq(tenantId?: string) {
  const headers: Record<string, string> = tenantId ? { 'x-tenant-id': tenantId } : {};
  return new NextRequest('http://localhost/api/quota/defaults', { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_CTX);
  (collectPrometheusMetrics as ReturnType<typeof vi.fn>).mockResolvedValue('# HELP model_requests_total\nmodel_requests_total 42\n');
  (getLicenseDefaults as ReturnType<typeof vi.fn>).mockResolvedValue({
    licenseType: 'STARTER',
    limits: { maxProjects: 5 },
  });
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
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiTokenAuthError('Unauthorized', 401));
    const req = makeReq('/api/metrics');
    const res = await getMetrics(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 on forbidden token', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiTokenAuthError('Forbidden', 403));
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
    const req = makeQuotaReq('tenant-1');
    const res = await getQuotaDefaults(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.licenseType).toBe('STARTER');
    expect(body.defaults).toBeDefined();
    expect(body.defaults.maxProjects).toBe(5);
  });

  it('returns 400 when tenant id header missing', async () => {
    const req = makeQuotaReq();
    const res = await getQuotaDefaults(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Tenant');
  });

  it('passes tenant id to getLicenseDefaults', async () => {
    const req = makeQuotaReq('tenant-1');
    await getQuotaDefaults(req);
    expect(getLicenseDefaults).toHaveBeenCalledWith('tenant-1');
  });

  it('returns 500 on getLicenseDefaults error', async () => {
    (getLicenseDefaults as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const req = makeQuotaReq('tenant-1');
    const res = await getQuotaDefaults(req);
    expect(res.status).toBe(500);
  });

  it('returns empty defaults object gracefully', async () => {
    (getLicenseDefaults as ReturnType<typeof vi.fn>).mockResolvedValue({
      licenseType: 'FREE',
      limits: {},
    });
    const req = makeQuotaReq('tenant-1');
    const res = await getQuotaDefaults(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.defaults).toEqual({});
  });
});
