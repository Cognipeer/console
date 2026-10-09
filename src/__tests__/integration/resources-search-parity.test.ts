/**
 * Picker search parity: the same `searchResources()` answers (rows, keys, the
 * display attributes the filters read, project names, order, cap) on SQLite and
 * MongoDB. The filters live on facts the two backends store differently (a
 * provider's `type`, a model's `category`, a tenant-wide row's missing project),
 * which is exactly where they could drift.
 */
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

const h = vi.hoisted(() => ({ current: null as unknown as DatabaseProvider }));

// searchResources() binds the tenant through runWithTenantScope; here the harness
// provider is the only provider, so route it through that.
vi.mock('@/lib/database', () => ({
  getDatabase: async () => h.current,
  runWithTenantScope: async (name: string, fn: (db: DatabaseProvider) => unknown) => {
    await h.current.switchToTenant(name);
    return fn(h.current);
  },
}));

import { clearResourceCache, searchResources, SEARCH_MAX_LIMIT } from '@/lib/resources/service';

interface Tenant {
  dbName: string;
  tenantId: string;
  projectA: string;
  projectB: string;
}

describeForEachProvider('Resource registry searchResources', (getDb) => {
  let main: Tenant;
  let other: Tenant;

  beforeAll(() => {
    h.current = getDb();
  });

  async function seedTenant(prefix: string): Promise<Tenant> {
    const db = getDb();
    const slug = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({ companyName: prefix, slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    const tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
    const user = await db.createUser({
      tenantId, email: `owner@${slug}.io`, name: 'Owner', password: '$2b$10$x', role: 'owner', licenseId: 'FREE', features: [],
    });
    const by = String(user._id);
    const projectA = String((await db.createProject({ tenantId, key: 'a', name: 'Project A', createdBy: by }))._id);
    const projectB = String((await db.createProject({ tenantId, key: 'b', name: 'Project B', createdBy: by }))._id);
    return { dbName, tenantId, projectA, projectB };
  }

  const model = (t: Tenant, key: string, name: string, category: string, projectId: string) => ({
    tenantId: t.tenantId, projectId, name, key, providerKey: 'openai-prod', providerDriver: 'openai', category: category as never,
    modelId: key, settings: { apiKey: 'NEVER-EXPOSE' }, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 }, createdBy: 'seed',
  });

  const provider = (t: Tenant, key: string, label: string, type: string, driver: string, projectIds: string[]) => ({
    tenantId: t.tenantId, key, type: type as never, driver, label, status: 'active' as const,
    credentialsEnc: 'NEVER-EXPOSE', settings: { token: 'NEVER-EXPOSE' }, projectIds, createdBy: 'seed',
  });

  beforeEach(async () => {
    clearResourceCache();
    h.current = getDb();
    main = await seedTenant('search');
    other = await seedTenant('other');

    const db = getDb();
    await db.switchToTenant(main.dbName);
    await db.createModel(model(main, 'gpt-4o', 'GPT-4o', 'llm', main.projectA));
    await db.createModel(model(main, 'gpt-4o-mini', 'GPT-4o mini', 'llm', main.projectA));
    await db.createModel(model(main, 'claude-sonnet', 'Claude Sonnet', 'llm', main.projectB));
    await db.createModel(model(main, 'text-embedding-3', 'Embedding 3', 'embedding', main.projectB));
    await db.createModel(model(main, 'whisper', 'Whisper', 'stt', main.projectA));

    await db.createProvider(provider(main, 'pg-main', 'Postgres main', 'vector', 'pgvector', [main.projectA]));
    await db.createProvider(provider(main, 'disk', 'Local disk', 'file', 'local-filesystem', [main.projectA, main.projectB]));
    await db.createProvider(provider(main, 'openai-prod', 'OpenAI production', 'model', 'openai', [main.projectA]));
    await db.createProvider(provider(main, 'ddg', 'DuckDuckGo', 'websearch', 'duckduckgo', [main.projectB]));

    const index = (providerKey: string, projectId: string, key: string) => ({
      tenantId: main.tenantId, projectId, providerKey, key, name: `Index ${key}`, externalId: `ext-${providerKey}-${projectId}-${key}`,
      dimension: 1536, metric: 'cosine' as const, createdBy: 'seed',
    });
    await db.createVectorIndex(index('pg-main', main.projectA, 'docs'));
    await db.createVectorIndex(index('pg-main', main.projectB, 'docs'));
    await db.createVectorIndex(index('pg-main', main.projectA, 'faq'));
    await db.createFileBucket({
      tenantId: main.tenantId, projectId: main.projectA, key: 'uploads', name: 'Uploads', providerKey: 'disk', status: 'active', createdBy: 'seed',
    });
    await db.createAgent({
      tenantId: main.tenantId, projectId: main.projectA, key: 'sales-ab12cd', name: 'Sales agent', status: 'active',
      config: { modelKey: 'gpt-4o', connection: { apiKeyEnc: 'NEVER-EXPOSE' } } as never, createdBy: 'seed',
    });

    await db.switchToTenant(other.dbName);
    await db.createModel(model(other, 'other-only', 'Other only', 'llm', other.projectA));
    await db.createProvider(provider(other, 'other-pg', 'Other Postgres', 'vector', 'pgvector', [other.projectA]));
  });

  const search = (t: Tenant, input: Omit<Parameters<typeof searchResources>[0], 'tenantDbName' | 'tenantId'>) =>
    searchResources({ tenantDbName: t.dbName, tenantId: t.tenantId, ...input });
  const keys = (r: Awaited<ReturnType<typeof searchResources>>) => r.items.map((i) => i.key);

  it('filters models by their category', async () => {
    expect(keys(await search(main, { types: ['model'], attributes: { category: ['llm'] } })).sort()).toEqual(['claude-sonnet', 'gpt-4o', 'gpt-4o-mini']);
    expect(keys(await search(main, { types: ['model'], attributes: { category: ['embedding'] } }))).toEqual(['text-embedding-3']);
    expect(keys(await search(main, { types: ['model'], attributes: { category: ['stt'] } }))).toEqual(['whisper']);
    expect((await search(main, { types: ['model'], attributes: { category: ['ocr'] } })).items).toEqual([]);
  });

  it('filters providers by their type, and says which projects each one is assigned to', async () => {
    const vector = await search(main, { types: ['provider'], attributes: { type: ['vector'] } });
    expect(keys(vector)).toEqual(['pg-main']);
    expect(vector.items[0].projectDisplay).toEqual({ kind: 'project', projectId: main.projectA, projectName: 'Project A' });
    expect(vector.items[0].attributes).toEqual(expect.arrayContaining([{ key: 'type', value: 'vector' }, { key: 'driver', value: 'pgvector' }]));

    const file = await search(main, { types: ['provider'], attributes: { type: ['file'] } });
    expect(keys(file)).toEqual(['disk']);
    expect(file.items[0].projectDisplay).toMatchObject({ kind: 'multi-project', projectNames: expect.arrayContaining(['Project A', 'Project B']) });

    expect(keys(await search(main, { types: ['provider'], attributes: { type: ['vector', 'file'] } })).sort()).toEqual(['disk', 'pg-main']);
    expect(keys(await search(main, { types: ['provider'] })).sort()).toEqual(['ddg', 'disk', 'openai-prod', 'pg-main']);
  });

  it('keeps two indexes that share a key apart, one per project', async () => {
    const docs = await search(main, { types: ['vector-index'], q: 'docs' });
    expect(docs.items.map((i) => [i.key, i.projectName]).sort()).toEqual([['docs', 'Project A'], ['docs', 'Project B']]);
    expect(new Set(docs.items.map((i) => i.id)).size).toBe(2);
  });

  it('searches several types at once and finds a bucket, an index and a model by key', async () => {
    const all = await search(main, { types: ['model', 'vector-index', 'file-bucket'], limit: 50 });
    expect(new Set(all.items.map((i) => i.type))).toEqual(new Set(['model', 'vector-index', 'file-bucket']));
    expect(keys(await search(main, { types: ['model', 'vector-index', 'file-bucket'], q: 'uploads' }))).toEqual(['uploads']);
  });

  it('puts the exact key before a longer one, and finds an agent by its name', async () => {
    expect(keys(await search(main, { types: ['model'], q: 'gpt-4o' }))).toEqual(['gpt-4o', 'gpt-4o-mini']);
    const agents = await search(main, { types: ['agent'], q: 'Sales agent' });
    expect(agents.items.map((i) => [i.name, i.key])).toEqual([['Sales agent', 'sales-ab12cd']]);
  });

  it('never returns more than the cap, and still counts everything', async () => {
    const db = getDb();
    await db.switchToTenant(main.dbName);
    for (let i = 0; i < 60; i++) await db.createModel(model(main, `bulk-${i}`, `Bulk ${i}`, 'llm', main.projectA));
    clearResourceCache();

    const first = await search(main, { types: ['model'], attributes: { category: ['llm'] } });
    expect(first.items).toHaveLength(20);
    expect(first.total).toBe(63);
    const widest = await search(main, { types: ['model'], attributes: { category: ['llm'] }, limit: 100_000 });
    expect(widest.items).toHaveLength(SEARCH_MAX_LIMIT);
    expect(widest.total).toBe(63);
    // Narrowing by a typed query still sees past the first page.
    expect(keys(await search(main, { types: ['model'], q: 'bulk-59' }))).toEqual(['bulk-59']);
  });

  it('keeps two tenants apart', async () => {
    const mine = await search(main, { types: ['model', 'provider'], limit: 50 });
    const theirs = await search(other, { types: ['model', 'provider'], limit: 50 });
    expect(keys(theirs).sort()).toEqual(['other-only', 'other-pg']);
    expect(keys(mine)).not.toContain('other-only');
    expect(keys(mine)).not.toContain('other-pg');
    // A tenant that searches its own keys finds nothing of the other's.
    expect((await search(main, { types: ['model'], q: 'other-only' })).items).toEqual([]);
    expect((await search(other, { types: ['model'], q: 'gpt-4o' })).items).toEqual([]);
  });

  it('exposes none of the secrets it was seeded with', async () => {
    const everything = await search(main, { types: ['model', 'provider', 'vector-index', 'file-bucket', 'agent'], limit: 50 });
    expect(everything.items.length).toBeGreaterThan(10);
    expect(JSON.stringify(everything)).not.toContain('NEVER-EXPOSE');
    expect(JSON.stringify(everything)).not.toContain('"edges"');
  });
});
