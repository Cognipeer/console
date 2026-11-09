/**
 * Platform-provided records (`platform`): a platform provider is assigned to projects like any provider; a platform
 * model (no project of its own) is visible in the projects its provider is assigned to. Covered through the
 * project-filtered lookups of the SQLite provider (real database) and the MongoDB provider (the filters each method builds).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { ModelMixin as MongoModelMixin } from '@/lib/database/mongodb/model.mixin';
import { ProviderRecordMixin as MongoProviderMixin } from '@/lib/database/mongodb/provider-record.mixin';

let tmpDir = '';
let db: SQLiteProvider;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-platform-records-'));
  db = new SQLiteProvider(tmpDir, 'platform_records_main');
  await db.connect();
  await db.switchToTenant('platform_records_tenant');
});

afterAll(async () => {
  await db.disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

const providerBase = {
  tenantId: 't1', type: 'model' as const, driver: 'openai', label: 'P', status: 'active' as const,
  credentialsEnc: 'enc', createdBy: 'u1', settings: {},
};
const modelBase = {
  tenantId: 't1', name: 'M', providerKey: 'prov', providerDriver: 'openai',
  category: 'llm' as const, modelId: 'gpt', settings: {}, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 },
};

describe('sqlite providers', () => {
  it('shows a platform provider only in the projects it is assigned to', async () => {
    await db.createProvider({ ...providerBase, key: 'plat', platform: true, projectIds: ['p1', 'p3'] });
    await db.createProvider({ ...providerBase, key: 'plat-legacy', platform: true, projectId: 'p2' });
    await db.createProvider({ ...providerBase, key: 'plat-none', platform: true });
    await db.createProvider({ ...providerBase, key: 'p1-only', projectIds: ['p1'] });

    const keys = async (projectId?: string, extra: Record<string, unknown> = {}) =>
      (await db.listProviders('t1', { projectId, ...extra })).map((p) => p.key).sort();
    expect(await keys('p1')).toEqual(['p1-only', 'plat']);
    expect(await keys('p2')).toEqual(['plat-legacy']);
    expect(await keys('p3')).toEqual(['plat']);
    expect(await keys('p9')).toEqual([]);
    expect(await keys(undefined)).toEqual(['p1-only', 'plat', 'plat-legacy', 'plat-none']);

    expect((await db.findProviderByKey('t1', 'plat', 'p1'))?.platform).toBe(true);
    expect(await db.findProviderByKey('t1', 'plat', 'p9')).toBeNull();
    expect(await db.findProviderByKey('t1', 'plat-none', 'p1')).toBeNull();
    expect((await db.findProviderByKey('t1', 'p1-only', 'p1'))?.platform).toBeUndefined();
  });

  it('persists platform on update when an internal caller passes it', async () => {
    const created = await db.createProvider({ ...providerBase, key: 'later', projectIds: ['p1'] });
    expect((await db.findProviderById(String(created._id)))?.platform).toBeUndefined();
    await db.updateProvider(String(created._id), { platform: true });
    expect((await db.findProviderById(String(created._id)))?.platform).toBe(true);
    await db.updateProvider(String(created._id), { platform: false });
    expect((await db.findProviderById(String(created._id)))?.platform).toBeUndefined();
  });
});

describe('sqlite models', () => {
  it('shows a platform model where its provider is assigned and the model was added, by list, key and id', async () => {
    // Providers of this block: 'pm-prov' is platform and assigned to p1 and p3, 'pm-other' is a platform provider
    // assigned to nobody, 'pm-plain' is an ordinary provider assigned to p1.
    await db.createProvider({ ...providerBase, key: 'pm-prov', platform: true, projectIds: ['p1', 'p3'] });
    await db.createProvider({ ...providerBase, key: 'pm-other', platform: true });
    await db.createProvider({ ...providerBase, key: 'pm-plain', projectIds: ['p1'] });
    const wide = await db.createModel({ ...modelBase, key: 'wide-m', providerKey: 'pm-prov', platform: true, projectIds: ['p1', 'p3', 'p7'] });
    await db.createModel({ ...modelBase, key: 'hidden-m', providerKey: 'pm-other', platform: true, projectIds: ['p1'] });
    // The provider is assigned to p1 but this model was never added there: hidden everywhere.
    await db.createModel({ ...modelBase, key: 'not-added-m', providerKey: 'pm-prov', platform: true });
    await db.createModel({ ...modelBase, key: 'added-elsewhere-m', providerKey: 'pm-prov', platform: true, projectIds: ['p2'] });
    // A non-platform model on an assigned platform-looking provider key is not widened.
    await db.createModel({ ...modelBase, key: 'plain-m', providerKey: 'pm-plain' });
    await db.createModel({ ...modelBase, key: 'm-p1', providerKey: 'x', projectId: 'p1' });
    await db.createModel({ ...modelBase, key: 'm-p2', providerKey: 'x', projectId: 'p2', category: 'embedding' });

    const keys = async (filters: Record<string, unknown>) =>
      (await db.listModels(filters as never)).map((m) => m.key).sort();
    expect(await keys({ projectId: 'p1' })).toEqual(['m-p1', 'wide-m']);
    expect(await keys({ projectId: 'p3' })).toEqual(['wide-m']);
    expect(await keys({ projectId: 'p2' })).toEqual(['m-p2']);
    expect(await keys({})).toEqual(['added-elsewhere-m', 'hidden-m', 'm-p1', 'm-p2', 'not-added-m', 'plain-m', 'wide-m']);
    // other filters do not widen
    expect(await keys({ projectId: 'p1', category: 'embedding' })).toEqual([]);
    expect(await keys({ projectId: 'p3', providerKey: 'other' })).toEqual([]);

    expect((await db.findModelByKey('wide-m', 'p3'))?.platform).toBe(true);
    expect(await db.findModelByKey('wide-m', 'p7')).toBeNull();
    // p7 added the model, but its provider is not assigned there; 'hidden-m' is added to p1, but its provider is not assigned.
    expect(await db.findModelByKey('wide-m', 'p7')).toBeNull();
    expect(await db.findModelByKey('hidden-m', 'p1')).toBeNull();
    expect(await db.findModelByKey('not-added-m', 'p1')).toBeNull();
    expect(await db.findModelByKey('added-elsewhere-m', 'p1')).toBeNull();
    expect((await db.findModelByKey('wide-m', 'p1'))?.projectIds).toEqual(['p1', 'p3', 'p7']);
    expect((await db.findModelById(String(wide._id), 'p1'))?.key).toBe('wide-m');
    expect(await db.findModelById(String(wide._id), 'p7')).toBeNull();
    expect(await db.findModelByKey('m-p2', 'p1')).toBeNull();
    expect(await db.findModelById(String(wide._id))).not.toBeNull();
  });

  it('follows a change of the provider assignment and of the projects the model was added to', async () => {
    const provider = await db.createProvider({ ...providerBase, key: 'pm-move', platform: true, projectIds: ['q1'] });
    await db.createModel({ ...modelBase, key: 'move-m', providerKey: 'pm-move', platform: true, projectIds: ['q1', 'q2'] });
    expect((await db.findModelByKey('move-m', 'q1'))?.key).toBe('move-m');
    expect(await db.findModelByKey('move-m', 'q2')).toBeNull();
    await db.updateProvider(String(provider._id), { projectIds: ['q2'] });
    expect(await db.findModelByKey('move-m', 'q1')).toBeNull();
    expect((await db.findModelByKey('move-m', 'q2'))?.key).toBe('move-m');
    const move = await db.findModelByKey('move-m');
    await db.updateModel(String(move?._id), { projectIds: ['q1'] });
    expect(await db.findModelByKey('move-m', 'q2')).toBeNull();
    await db.updateModel(String(move?._id), { projectIds: [] });
    expect((await db.findModelByKey('move-m'))?.projectIds).toEqual([]);
  });

  it('the gateway and client listing cannot reach a platform model that is not added in the calling project', async () => {
    // Both resolve through listModels / findModelByKey with the caller's project: the provider is assigned to g1 and g2,
    // the model was added to g1 only.
    await db.createProvider({ ...providerBase, key: 'pm-gw', platform: true, projectIds: ['g1', 'g2'] });
    await db.createModel({ ...modelBase, key: 'gw-m', providerKey: 'pm-gw', platform: true, projectIds: ['g1'] });
    expect((await db.listModels({ projectId: 'g1' })).map((m) => m.key)).toEqual(['gw-m']);
    expect(await db.listModels({ projectId: 'g2' })).toEqual([]);
    expect((await db.findModelByKey('gw-m', 'g1'))?.key).toBe('gw-m');
    expect(await db.findModelByKey('gw-m', 'g2')).toBeNull();
    const model = await db.findModelByKey('gw-m');
    expect(await db.findModelById(String(model?._id), 'g2')).toBeNull();
  });

  it('keeps a row without projectIds (older local data) added nowhere', async () => {
    await db.createProvider({ ...providerBase, key: 'pm-legacy', platform: true, projectIds: ['l1'] });
    await db.createModel({ ...modelBase, key: 'legacy-m', providerKey: 'pm-legacy', platform: true });
    expect(await db.findModelByKey('legacy-m', 'l1')).toBeNull();
    expect((await db.findModelByKey('legacy-m'))?.projectIds).toBeUndefined();
  });

  it('persists platform through update', async () => {
    const created = await db.createModel({ ...modelBase, key: 'flip', projectId: 'p1' });
    await db.updateModel(String(created._id), { platform: true });
    expect((await db.findModelByKey('flip'))?.platform).toBe(true);
  });
});

describe('mongodb filters', () => {
  type Captured = { filter?: Record<string, unknown>; providerFilter?: Record<string, unknown> };
  const mongoModels = (platformProviderKeys: string[] = ['plat']) => {
    const captured: Captured = {};
    const collection = (name: string) => ({
      findOne: vi.fn(async (filter: Record<string, unknown>) => { captured.filter = filter; return null; }),
      find: vi.fn((filter: Record<string, unknown>) => {
        const isProviders = name === 'providers';
        if (isProviders) captured.providerFilter = filter; else captured.filter = filter;
        const list = isProviders ? platformProviderKeys.map((key) => ({ key })) : [];
        return { sort: () => ({ toArray: async () => list }), project: () => ({ toArray: async () => list }) };
      }),
    });
    class Base {
      getTenantDb() { return { collection, databaseName: 'x' }; }
    }
    const Models = MongoModelMixin(Base as never) as unknown as new () => Record<string, (...a: unknown[]) => Promise<unknown>>;
    const Providers = MongoProviderMixin(Base as never) as unknown as new () => Record<string, (...a: unknown[]) => Promise<unknown>>;
    return { captured, models: new Models(), providers: new Providers() };
  };

  it('models: own project OR platform models of an assigned platform provider, combined (AND) with the other filters', async () => {
    const { captured, models } = mongoModels(['plat']);
    const visible = [{ projectId: 'p1' }, { platform: true, projectIds: 'p1', providerKey: { $in: ['plat'] } }];
    await models.listModels({ projectId: 'p1', category: 'llm', providerKey: 'k' });
    expect(captured.providerFilter).toEqual({ platform: true, $or: [{ projectId: 'p1' }, { projectIds: 'p1' }] });
    expect(captured.filter).toEqual({ $or: visible, category: 'llm', providerKey: 'k' });
    await models.listModels({ category: 'llm' });
    expect(captured.filter).toEqual({ category: 'llm' });
    await models.findModelByKey('k', 'p1');
    expect(captured.filter).toEqual({ key: 'k', $or: visible });
    await models.findModelByKey('k');
    expect(captured.filter).toEqual({ key: 'k' });
    await models.findModelById('not-an-object-id', 'p1');
    expect(captured.filter).toEqual({ _id: 'not-an-object-id', $or: visible });
  });

  it('models: no platform provider assigned leaves only the project own models', async () => {
    const { captured, models } = mongoModels([]);
    await models.listModels({ projectId: 'p1' });
    expect(captured.filter).toEqual({ $or: [{ projectId: 'p1' }, { platform: true, projectIds: 'p1', providerKey: { $in: [] } }] });
  });

  it('providers: project OR projectIds, combined with type/driver/status (platform providers are ordinary)', async () => {
    const { captured, providers } = mongoModels();
    await providers.listProviders('t1', { projectId: 'p1', type: 'websearch', status: 'active' });
    expect(captured.providerFilter).toEqual({
      tenantId: 't1',
      $or: [{ projectId: 'p1' }, { projectIds: 'p1' }],
      type: 'websearch',
      status: 'active',
    });
    await providers.findProviderByKey('t1', 'k', 'p1');
    expect(captured.filter).toEqual({
      tenantId: 't1', key: 'k',
      $or: [{ projectId: 'p1' }, { projectIds: 'p1' }],
    });
    await providers.findProviderByKey('t1', 'k');
    expect(captured.filter).toEqual({ tenantId: 't1', key: 'k' });
  });
});
