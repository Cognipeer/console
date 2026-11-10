/**
 * /api/usage/summary and /api/usage/events: 404 when plan limits are off (always on onprem),
 * 200 shape when active, owner/admin only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // The gate reads the caller through the tenant scope.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/license/license-manager', () => ({
  LicenseManager: { getEffectiveLicenseForTenant: vi.fn() },
}));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({
  ServiceDisabledError: class ServiceDisabledError extends Error {},
  clearServiceAvailabilityMemo: vi.fn(),
  getDisabledServices: vi.fn(async () => new Map()),
  serviceOffReason: vi.fn(async () => null),
  unknownLicenseServiceIds: vi.fn(() => []),
}));
vi.mock('@/lib/limits/usageSummary', () => ({ buildUsageSummary: vi.fn() }));
vi.mock('@/lib/limits/events', () => ({ listLimitEvents: vi.fn() }));

import { getDatabase } from '@/lib/database';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { listLimitEvents } from '@/lib/limits/events';
import { buildUsageSummary, type UsageSummary } from '@/lib/limits/usageSummary';
import { createMockDb } from '../helpers/db.mock';
import { usageApiPlugin } from '@/server/api/plugins/usage';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const originalSource = getConfigSource();

function withEnv(env: Record<string, string>): void {
  setConfigSource({ get: (key: string) => env[key] } as unknown as ConfigSource);
}

const HEADERS = {
  'x-license-type': 'FREE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
};

const SUMMARY: UsageSummary = {
  mode: 'shadow',
  plan: null,
  capacity: [{ dimension: 'agent', used: 1, limit: 4 }],
  monthly: [{ dimension: 'searches', used: 2 }],
  period: '2026-11',
  resetsAt: '2026-12-01T00:00:00.000Z',
  storage: { usedBytes: 10 },
  credits: null,
  banners: [],
  counterScope: 'pod',
};

describe('usage API', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  // The caller's role is read from the account record, not from the header.
  const asRole = (role: string) => {
    db.findUserById.mockResolvedValue({ _id: 'user-1', tenantId: 'tenant-1', role } as never);
    return { ...HEADERS, 'x-user-role': role };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    withEnv({ DEPLOYMENT_MODE: 'saas', PLAN_LIMITS_MODE: 'shadow' });
    db = createMockDb();
    db.findTenantById.mockResolvedValue({ _id: 'tenant-1', slug: 'acme', dbName: 'tenant_acme', licenseType: 'FREE' } as never);
    db.findUserById.mockResolvedValue({ _id: 'user-1', tenantId: 'tenant-1', role: 'owner' } as never);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    vi.mocked(buildUsageSummary).mockResolvedValue(SUMMARY);
    vi.mocked(listLimitEvents).mockResolvedValue([]);
    app = await createFastifyApiTestApp(usageApiPlugin);
  });

  afterEach(async () => {
    await app.close();
    setConfigSource(originalSource);
  });

  describe('GET /api/usage/summary', () => {
    it('answers 200 with the summary when plan limits are active', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/usage/summary', headers: HEADERS });
      expect(response.statusCode).toBe(200);
      expect(parseJsonBody(response.body)).toEqual(SUMMARY);
      expect(buildUsageSummary).toHaveBeenCalledWith('tenant-1');
    });

    it('answers 404 when PLAN_LIMITS_MODE is off', async () => {
      withEnv({ DEPLOYMENT_MODE: 'saas', PLAN_LIMITS_MODE: 'off' });
      const response = await app.inject({ method: 'GET', url: '/api/usage/summary', headers: HEADERS });
      expect(response.statusCode).toBe(404);
      expect(parseJsonBody(response.body)).toEqual({ error: 'Not Found' });
      expect(buildUsageSummary).not.toHaveBeenCalled();
    });

    it('answers 404 on an onprem deployment whatever PLAN_LIMITS_MODE says', async () => {
      withEnv({ DEPLOYMENT_MODE: 'onprem', PLAN_LIMITS_MODE: 'on' });
      const response = await app.inject({ method: 'GET', url: '/api/usage/summary', headers: HEADERS });
      expect(response.statusCode).toBe(404);
      expect(buildUsageSummary).not.toHaveBeenCalled();
    });

    it('answers 404 when no plan limits apply to the tenant', async () => {
      vi.mocked(buildUsageSummary).mockResolvedValue(null);
      const response = await app.inject({ method: 'GET', url: '/api/usage/summary', headers: HEADERS });
      expect(response.statusCode).toBe(404);
    });

    it('lets owners and admins in and refuses everyone else', async () => {
      for (const role of ['owner', 'admin']) {
        const ok = await app.inject({ method: 'GET', url: '/api/usage/summary', headers: asRole(role) });
        expect(ok.statusCode, role).toBe(200);
      }
      for (const role of ['project_admin', 'user', 'portal_user']) {
        const denied = await app.inject({ method: 'GET', url: '/api/usage/summary', headers: asRole(role) });
        expect(denied.statusCode, role).toBe(403);
      }
    });
  });

  describe('GET /api/usage/events', () => {
    it('answers 200 with the events, passing the filters on', async () => {
      const at = new Date('2026-11-07T10:00:00Z');
      vi.mocked(listLimitEvents).mockResolvedValue([
        { tenantId: 'tenant-1', kind: 'concurrency', dimension: 'agent', outcome: 'refused', mode: 'on', count: 2, at },
        { tenantId: 'tenant-1', kind: 'monthly', dimension: 'searches', outcome: 'would_refuse', mode: 'shadow', count: 1, at },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/usage/events?since=2026-11-01T00:00:00Z&kind=concurrency&limit=50&dimension=agent',
        headers: HEADERS,
      });
      expect(response.statusCode).toBe(200);
      const body = parseJsonBody<{ events: Array<{ dimension: string; at: string }> }>(response.body);
      expect(body.events).toHaveLength(1);
      expect(body.events[0]).toMatchObject({ dimension: 'agent', at: at.toISOString() });
      expect(listLimitEvents).toHaveBeenCalledWith('tenant-1', {
        since: new Date('2026-11-01T00:00:00Z'),
        kind: 'concurrency',
        limit: 50,
      });
    });

    it('ignores an unknown kind and a non-numeric limit, and rejects an invalid since', async () => {
      const ok = await app.inject({ method: 'GET', url: '/api/usage/events?kind=bogus&limit=abc', headers: HEADERS });
      expect(ok.statusCode).toBe(200);
      expect(listLimitEvents).toHaveBeenCalledWith('tenant-1', { since: undefined, kind: undefined, limit: undefined });
      const bad = await app.inject({ method: 'GET', url: '/api/usage/events?since=yesterday', headers: HEADERS });
      expect(bad.statusCode).toBe(400);
    });

    it('answers 404 when plan limits are off and on onprem', async () => {
      for (const env of [
        { DEPLOYMENT_MODE: 'saas', PLAN_LIMITS_MODE: 'off' },
        { DEPLOYMENT_MODE: 'onprem', PLAN_LIMITS_MODE: 'on' },
      ]) {
        withEnv(env);
        const response = await app.inject({ method: 'GET', url: '/api/usage/events', headers: HEADERS });
        expect(response.statusCode, JSON.stringify(env)).toBe(404);
      }
      expect(listLimitEvents).not.toHaveBeenCalled();
    });

    it('is for owners and admins only', async () => {
      const denied = await app.inject({ method: 'GET', url: '/api/usage/events', headers: asRole('user') });
      expect(denied.statusCode).toBe(403);
      expect(listLimitEvents).not.toHaveBeenCalled();
    });
  });
});
