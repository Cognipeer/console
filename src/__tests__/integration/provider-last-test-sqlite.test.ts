/**
 * The outcome of "Test connection" lives on the provider record: a real SQLite provider keeps it
 * (the `lastTest` column), an old table gains the column in place, and a provider created with
 * `projectIds` reads them back (what the list rows show as "Unassigned" or not).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (orig) => ({ ...(await orig<typeof import('@/lib/database')>()), getDatabase: hoisted.getDatabase }));

import {
  createProviderConfig,
  getProviderConfigById,
  listProviderConfigs,
  recordProviderTest,
  resolveTenantProjectIds,
} from '@/lib/services/providers/providerService';

vi.mock('@/lib/services/providers/providerEndpointGuard', () => ({ assertProviderEndpointsAllowed: vi.fn(async () => undefined) }));

let ctx: IamTestDb;
beforeAll(async () => {
  ctx = await createIamTestDb('tenant_lasttest');
  hoisted.getDatabase.mockResolvedValue(ctx.db);
});
afterAll(async () => {
  await ctx.cleanup();
});

describe('provider record: projectIds and lastTest (SQLite)', () => {
  it('creates a provider with projectIds, lists them, and keeps the last test', async () => {
    const created = await createProviderConfig(ctx.tenantDbName, ctx.tenantId, {
      key: 'openai-main',
      type: 'model',
      driver: 'openai',
      label: 'OpenAI',
      credentials: { apiKey: 'sk-test' },
      projectIds: ['p1', 'p2', 'p1'],
      createdBy: 'u1',
    });
    expect(created.projectIds).toEqual(['p1', 'p2']);
    expect(created.lastTest).toBeUndefined();

    const unassigned = await createProviderConfig(ctx.tenantDbName, ctx.tenantId, {
      key: 'free-floating',
      type: 'model',
      driver: 'openai',
      label: 'Unassigned',
      credentials: { apiKey: 'sk-test' },
      createdBy: 'u1',
    });

    const rows = await listProviderConfigs(ctx.tenantDbName, ctx.tenantId);
    expect(rows.find((r) => r.key === 'openai-main')?.projectIds).toEqual(['p1', 'p2']);
    expect(rows.find((r) => r.key === 'free-floating')?.projectIds ?? []).toEqual([]);

    await recordProviderTest(ctx.tenantDbName, String(created._id), {
      ok: true,
      at: new Date('2026-10-15T10:00:00Z'),
      latencyMs: 87,
      message: 'Connected. 3 models found.',
      deployments: 3,
    });
    const reread = await getProviderConfigById(ctx.tenantDbName, String(created._id));
    expect(reread?.lastTest).toMatchObject({ ok: true, latencyMs: 87, message: 'Connected. 3 models found.', deployments: 3 });
    expect(new Date(reread!.lastTest!.at as string).toISOString()).toBe('2026-10-15T10:00:00.000Z');
    // The other provider is untouched.
    expect((await getProviderConfigById(ctx.tenantDbName, String(unassigned._id)))?.lastTest).toBeUndefined();

    // A null outcome ("no test for this driver") is kept as it is.
    await recordProviderTest(ctx.tenantDbName, String(created._id), { ok: null, at: new Date(), latencyMs: 0, message: 'n/a' });
    expect((await getProviderConfigById(ctx.tenantDbName, String(created._id)))?.lastTest?.ok).toBeNull();
  });

  it('checks project ids against the projects of the tenant', async () => {
    const project = await ctx.db.createProject({ tenantId: ctx.tenantId, key: 'support', name: 'Support', createdBy: 'u1' });
    const id = String(project._id);
    await expect(resolveTenantProjectIds(ctx.tenantDbName, ctx.tenantId, [id, id, 'ghost'])).resolves.toEqual({
      projectIds: [id],
      unknown: ['ghost'],
    });
    // Another tenant's project is as unknown as a made-up id.
    await expect(resolveTenantProjectIds(ctx.tenantDbName, 'other-tenant', [id])).resolves.toEqual({ projectIds: [], unknown: [id] });
    await expect(resolveTenantProjectIds(ctx.tenantDbName, ctx.tenantId, [])).resolves.toEqual({ projectIds: [], unknown: [] });
  });
});
