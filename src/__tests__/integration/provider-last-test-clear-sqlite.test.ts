/**
 * The stored "last test" describes the connection as it was tested: it is cleared when the connection
 * settings or the credentials change through updateProviderConfig, and kept by edits that do not touch them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (orig) => ({ ...(await orig<typeof import('@/lib/database')>()), getDatabase: hoisted.getDatabase }));
vi.mock('@/lib/services/providers/providerEndpointGuard', () => ({ assertProviderEndpointsAllowed: vi.fn(async () => undefined) }));

import {
  createProviderConfig,
  getProviderConfigById,
  recordProviderTest,
  updateProviderConfig,
} from '@/lib/services/providers/providerService';

let ctx: IamTestDb;
beforeAll(async () => {
  ctx = await createIamTestDb('tenant_lasttest_clear');
  hoisted.getDatabase.mockResolvedValue(ctx.db);
});
afterAll(async () => {
  await ctx.cleanup();
});

async function tested(key: string) {
  const created = await createProviderConfig(ctx.tenantDbName, ctx.tenantId, {
    key,
    type: 'model',
    driver: 'openai',
    label: key,
    credentials: { apiKey: 'sk-one' },
    settings: { baseUrl: 'https://api.example.com/v1', retries: 2 },
    createdBy: 'u1',
  });
  const id = String(created._id);
  await recordProviderTest(ctx.tenantDbName, id, { ok: true, at: new Date(), latencyMs: 40, message: 'Connected.' });
  expect((await getProviderConfigById(ctx.tenantDbName, id))?.lastTest?.ok).toBe(true);
  return id;
}

const lastTestOf = async (id: string) => (await getProviderConfigById(ctx.tenantDbName, id))?.lastTest;

describe('updateProviderConfig and the stored last test', () => {
  it('clears it when a credential changes', async () => {
    const id = await tested('creds-changed');
    await updateProviderConfig(ctx.tenantDbName, id, { credentials: { apiKey: 'sk-two' } });
    expect(await lastTestOf(id) ?? undefined).toBeUndefined();
  });

  it('clears it when the connection settings change', async () => {
    const id = await tested('settings-changed');
    await updateProviderConfig(ctx.tenantDbName, id, { settings: { baseUrl: 'https://other.example.com/v1', retries: 2 } });
    expect(await lastTestOf(id) ?? undefined).toBeUndefined();
  });

  it('keeps it for edits that do not change the connection', async () => {
    const id = await tested('label-only');
    await updateProviderConfig(ctx.tenantDbName, id, { label: 'Renamed', description: 'x', status: 'disabled' });
    expect((await lastTestOf(id))?.ok).toBe(true);
    // The edit form re-sends the unchanged settings and blank secret fields: still the same connection.
    await updateProviderConfig(ctx.tenantDbName, id, {
      settings: { retries: 2, baseUrl: 'https://api.example.com/v1' },
      credentials: { apiKey: '' },
    });
    expect((await lastTestOf(id))?.ok).toBe(true);
    // Re-sending the same key is not a change either; assignment edits never are.
    await updateProviderConfig(ctx.tenantDbName, id, { credentials: { apiKey: 'sk-one' }, projectIds: ['p1'] });
    expect((await lastTestOf(id))?.ok).toBe(true);
  });

  it('a new test after the change is stored again', async () => {
    const id = await tested('retest');
    await updateProviderConfig(ctx.tenantDbName, id, { credentials: { apiKey: 'sk-new' } });
    await recordProviderTest(ctx.tenantDbName, id, { ok: false, at: new Date(), latencyMs: 12, message: '401' });
    expect((await lastTestOf(id))?.ok).toBe(false);
  });
});

describe('updateProviderConfig and a legacy single projectId', () => {
  it('folds the legacy field into projectIds: a project dropped from the list is no longer assigned', async () => {
    const created = await createProviderConfig(ctx.tenantDbName, ctx.tenantId, {
      key: 'legacy-scoped',
      type: 'model',
      driver: 'openai',
      label: 'Legacy',
      credentials: { apiKey: 'sk-one' },
      projectId: 'legacy-project',
      createdBy: 'u1',
    });
    const id = String(created._id);
    await ctx.db.updateProvider(id, { projectId: 'legacy-project', projectIds: [] });

    await updateProviderConfig(ctx.tenantDbName, id, { projectIds: ['p2'] });
    const after = await getProviderConfigById(ctx.tenantDbName, id);
    expect(after?.projectIds).toEqual(['p2']);
    expect(after?.projectId ?? undefined).toBeUndefined();
  });
});
