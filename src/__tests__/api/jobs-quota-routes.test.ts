/**
 * A red-team scan refused by the jobs quota answers 429 and enqueues nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  enforce: vi.fn(),
  enqueueCampaignRun: vi.fn(),
}));

vi.mock('@/lib/quota/serviceQuota', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/quota/serviceQuota')>();
  return { ...actual, enforceServiceQuota: hoisted.enforce };
});
vi.mock('@/lib/services/redteam/campaignJob', () => ({ enqueueCampaignRun: hoisted.enqueueCampaignRun }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  type Handler = (request: unknown, reply: unknown, ctx?: unknown) => unknown;
  const auth = {
    tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1',
    tokenRecord: { _id: 'tok1', userId: 'u1' }, tenant: { licenseType: 'FREE' },
  };
  return {
    ...actual,
    withClientApiRequestContext: (handler: Handler) => async (request: unknown, reply: unknown) => handler(request, reply, auth),
    getApiTokenContextForRequest: vi.fn(async () => auth),
  };
});

import { clientRedTeamApiPlugin } from '@/server/api/plugins/client-redteam';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

describe('jobs quota on run admission', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    app = await createFastifyApiTestApp(clientRedTeamApiPlugin);
  });
  afterEach(async () => { await app.close(); });

  it('red-team scan: 429 with the quota body, nothing enqueued', async () => {
    hoisted.enforce.mockRejectedValue(Object.assign(new Error('Job limit reached'), { name: 'QuotaExceededError' }));
    const res = await app.inject({ method: 'POST', url: '/api/client/v1/redteam/campaigns/c1/scan' });
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: { message: 'Job limit reached', type: 'rate_limit_error', code: 'quota_exceeded' } });
    expect(hoisted.enforce).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1' }),
      { domain: 'jobs', resourceKey: 'redteam', cost: { requests: 1 } },
    );
    expect(hoisted.enqueueCampaignRun).not.toHaveBeenCalled();
  });
});
