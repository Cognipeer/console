/**
 * Platform-provided records (`allProjects`): visible in every project of the tenant through the project-filtered
 * lookups of the SQLite provider (real database) and the MongoDB provider (the filter each method builds).
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
  it('shows a tenant-wide provider in every project, and only that one', async () => {
    await db.createProvider({ ...providerBase, key: 'wide', allProjects: true });
    await db.createProvider({ ...providerBase, key: 'p1-only', projectIds: ['p1'] });
    await db.createProvider({ ...providerBase, key: 'legacy', projectId: 'p1' });
    await db.createProvider({ ...providerBase, key: 'p2-only', projectIds: ['p2'] });

    const keys = async (projectId?: string, extra: Record<string, unknown> = {}) =>
      (await db.listProviders('t1', { projectId, ...extra })).map((p) => p.key).sort();
    expect(await keys('p1')).toEqual(['legacy', 'p1-only', 'wide']);
    expect(await keys('p2')).toEqual(['p2-only', 'wide']);
    expect(await keys('p3')).toEqual(['wide']);
    expect(await keys(undefined)).toEqual(['legacy', 'p1-only', 'p2-only', 'wide']);

    expect((await db.findProviderByKey('t1', 'wide', 'p9'))?.allProjects).toBe(true);
    expect(await db.findProviderByKey('t1', 'p2-only', 'p9')).toBeNull();
    expect((await db.findProviderByKey('t1', 'p1-only', 'p1'))?.allProjects).toBeUndefined();
  });

  it('does not widen the other filters', async () => {
    await db.createProvider({ ...providerBase, key: 'wide-search', type: 'websearch', driver: 'tavily', allProjects: true });
    await db.createProvider({ ...providerBase, key: 'off', status: 'disabled', projectIds: ['p1'] });
    const keys = async (filters: Record<string, unknown>) =>
      (await db.listProviders('t1', filters as never)).map((p) => p.key).sort();
    expect(await keys({ projectId: 'p5', type: 'websearch' })).toEqual(['wide-search']);
    expect(await keys({ projectId: 'p5', type: 'model' })).toEqual(['wide']);
    expect(await keys({ projectId: 'p1', status: 'disabled' })).toEqual(['off']);
    expect(await keys({ projectId: 'p5', status: 'disabled' })).toEqual([]);
    expect(await keys({ projectId: 'p5', driver: 'tavily' })).toEqual(['wide-search']);
  });

  it('persists allProjects on update when an internal caller passes it', async () => {
    const created = await db.createProvider({ ...providerBase, key: 'later', projectIds: ['p1'] });
    expect((await db.findProviderById(String(created._id)))?.allProjects).toBeUndefined();
    await db.updateProvider(String(created._id), { allProjects: true });
    expect((await db.findProviderById(String(created._id)))?.allProjects).toBe(true);
    await db.updateProvider(String(created._id), { allProjects: false });
    expect((await db.findProviderById(String(created._id)))?.allProjects).toBeUndefined();
  });
});

describe('sqlite models', () => {
  it('shows a tenant-wide model in every project, by key and by id', async () => {
    const wide = await db.createModel({ ...modelBase, key: 'wide-m', allProjects: true });
    await db.createModel({ ...modelBase, key: 'm-p1', projectId: 'p1' });
    await db.createModel({ ...modelBase, key: 'm-p2', projectId: 'p2', category: 'embedding' });

    const keys = async (filters: Record<string, unknown>) =>
      (await db.listModels(filters as never)).map((m) => m.key).sort();
    expect(await keys({ projectId: 'p1' })).toEqual(['m-p1', 'wide-m']);
    expect(await keys({ projectId: 'p3' })).toEqual(['wide-m']);
    expect(await keys({})).toEqual(['m-p1', 'm-p2', 'wide-m']);
    // other filters do not widen
    expect(await keys({ projectId: 'p1', category: 'embedding' })).toEqual([]);
    expect(await keys({ projectId: 'p2', category: 'embedding' })).toEqual(['m-p2']);
    expect(await keys({ projectId: 'p3', providerKey: 'other' })).toEqual([]);

    expect((await db.findModelByKey('wide-m', 'p7'))?.allProjects).toBe(true);
    expect((await db.findModelById(String(wide._id), 'p7'))?.key).toBe('wide-m');
    expect(await db.findModelByKey('m-p2', 'p1')).toBeNull();
    expect(await db.findModelById(String(wide._id))).not.toBeNull();
  });

  it('persists allProjects through update', async () => {
    const created = await db.createModel({ ...modelBase, key: 'flip', projectId: 'p1' });
    await db.updateModel(String(created._id), { allProjects: true });
    expect((await db.findModelByKey('flip', 'p9'))?.allProjects).toBe(true);
  });
});

describe('mongodb filters', () => {
  type Captured = { filter?: Record<string, unknown> };
  const mongoModels = () => {
    const captured: Captured = {};
    const collection = {
      findOne: vi.fn(async (filter: Record<string, unknown>) => { captured.filter = filter; return null; }),
      find: vi.fn((filter: Record<string, unknown>) => {
        captured.filter = filter;
        return { sort: () => ({ toArray: async () => [] }) };
      }),
    };
    class Base {
      getTenantDb() { return { collection: () => collection, databaseName: 'x' }; }
    }
    const Models = MongoModelMixin(Base as never) as unknown as new () => Record<string, (...a: unknown[]) => Promise<unknown>>;
    const Providers = MongoProviderMixin(Base as never) as unknown as new () => Record<string, (...a: unknown[]) => Promise<unknown>>;
    return { captured, models: new Models(), providers: new Providers() };
  };

  it('models: project OR allProjects, combined (AND) with the other filters', async () => {
    const { captured, models } = mongoModels();
    await models.listModels({ projectId: 'p1', category: 'llm', providerKey: 'k' });
    expect(captured.filter).toEqual({
      $or: [{ projectId: 'p1' }, { allProjects: true }],
      category: 'llm',
      providerKey: 'k',
    });
    await models.listModels({ category: 'llm' });
    expect(captured.filter).toEqual({ category: 'llm' });
    await models.findModelByKey('k', 'p1');
    expect(captured.filter).toEqual({ key: 'k', $or: [{ projectId: 'p1' }, { allProjects: true }] });
    await models.findModelByKey('k');
    expect(captured.filter).toEqual({ key: 'k' });
    await models.findModelById('not-an-object-id', 'p1');
    expect(captured.filter).toEqual({ _id: 'not-an-object-id', $or: [{ projectId: 'p1' }, { allProjects: true }] });
  });

  it('providers: project OR projectIds OR allProjects, combined with type/driver/status', async () => {
    const { captured, providers } = mongoModels();
    await providers.listProviders('t1', { projectId: 'p1', type: 'websearch', status: 'active' });
    expect(captured.filter).toEqual({
      tenantId: 't1',
      $or: [{ projectId: 'p1' }, { projectIds: 'p1' }, { allProjects: true }],
      type: 'websearch',
      status: 'active',
    });
    await providers.findProviderByKey('t1', 'k', 'p1');
    expect(captured.filter).toEqual({
      tenantId: 't1', key: 'k',
      $or: [{ projectId: 'p1' }, { projectIds: 'p1' }, { allProjects: true }],
    });
    await providers.findProviderByKey('t1', 'k');
    expect(captured.filter).toEqual({ tenantId: 't1', key: 'k' });
  });
});
