/**
 * Existing web search providers become instances: the move runs on both database backends, is repeatable, leaves
 * platform and managed records alone and never overwrites an instance that holds the key for another provider.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('@/lib/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDatabase: async () => hoisted.db,
}));

import { registerManagedCreditsHost, resetManagedCreditsHostForTests } from '@/enterprise/managed-credits';
import { createProviderConfig, updateProviderConfig } from '@/lib/services/providers/providerService';
import { migrateWebSearchProvidersForTenant } from '@/lib/services/webSearch/webSearchInstanceMigration';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Web search provider to instance migration', (getDb) => {
  let tenantId: string;
  let tenantDbName: string;

  beforeEach(async () => {
    const slug = `wsm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Search Co', slug, dbName: `tenant_${slug}`, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    tenantDbName = `tenant_${slug}`;
    await db.switchToTenant(tenantDbName);
    hoisted.db = db;
  });

  afterEach(() => resetManagedCreditsHostForTests());

  const provider = (key: string, extra: Record<string, unknown> = {}) => getDb().createProvider({
    tenantId, type: 'websearch', driver: 'searxng', label: `Label ${key}`, key, description: `About ${key}`, status: 'active',
    credentialsEnc: 'sealed', projectIds: ['p1'], createdBy: 'creator-1',
    settings: { baseUrl: 'https://s.example', engines: 'general', language: 'en', aiAnswer: { enabled: true, modelKey: 'm' } },
    ...extra,
  } as never);

  it('creates a tenant-wide instance with the behavior and strips it from the provider, keeping a copy', async () => {
    const db = getDb();
    await provider('docs-search');

    const result = await migrateWebSearchProvidersForTenant(db, tenantId);
    expect(result).toMatchObject({ providers: 1, created: 1, stripped: 1, conflicts: [] });

    const instance = await db.findWebSearchInstanceByKey(tenantId, 'docs-search');
    expect(instance).toMatchObject({
      key: 'docs-search', name: 'Label docs-search', description: 'About docs-search', providerKey: 'docs-search',
      status: 'active', createdBy: 'creator-1', metadata: { migratedFromProvider: true },
      settings: { engines: 'general', language: 'en', aiAnswer: { enabled: true, modelKey: 'm' } },
    });
    expect(instance?.projectId ?? null).toBeNull();

    const after = await db.findProviderByKey(tenantId, 'docs-search');
    expect(after?.settings).toEqual({ baseUrl: 'https://s.example' });
    expect(after?.credentialsEnc).toBe('sealed');
    expect(after?.metadata?.migratedBehavior).toEqual({ engines: 'general', language: 'en', aiAnswer: { enabled: true, modelKey: 'm' } });
    expect(after?.metadata?.behaviorOnInstances).toBe(true);

    // The second run is a no-op.
    expect(await migrateWebSearchProvidersForTenant(db, tenantId)).toMatchObject({ created: 0, stripped: 0 });
  });

  it('does not bring back an instance the user deleted', async () => {
    const db = getDb();
    await provider('docs-search');
    await migrateWebSearchProvidersForTenant(db, tenantId);
    const instance = await db.findWebSearchInstanceByKey(tenantId, 'docs-search');
    await db.deleteWebSearchInstance(String(instance?._id));

    const again = await migrateWebSearchProvidersForTenant(db, tenantId);
    expect(again).toMatchObject({ created: 0, stripped: 0 });
    expect(await db.listWebSearchInstances(tenantId)).toEqual([]);
  });

  it('creates no same-key instance for a provider that an instance with another key already uses, and marks it', async () => {
    const db = getDb();
    await provider('conn', { settings: { baseUrl: 'https://s.example' } });
    await db.createWebSearchInstance({
      tenantId, projectId: null, key: 'on-top', name: 'On top', providerKey: 'conn', status: 'active', settings: {}, createdBy: 'u',
    });

    const result = await migrateWebSearchProvidersForTenant(db, tenantId);
    expect(result).toMatchObject({ created: 0, stripped: 0 });
    expect(await db.findWebSearchInstanceByKey(tenantId, 'conn')).toBeNull();
    const after = await db.findProviderByKey(tenantId, 'conn');
    expect(after?.metadata?.behaviorOnInstances).toBe(true);
    expect(after?.settings).toEqual({ baseUrl: 'https://s.example' });
  });

  it('a provider created through the service carries the marker and the sweep adds nothing to it', async () => {
    const db = getDb();
    const created = await createProviderConfig(tenantDbName, tenantId, {
      key: 'fresh', type: 'websearch', driver: 'tavily', label: 'Fresh', credentials: { apiKey: 'k' },
      projectId: 'p1', createdBy: 'u', metadata: { note: 'kept', behaviorOnInstances: false },
    });
    expect(created.metadata).toMatchObject({ note: 'kept', behaviorOnInstances: true });

    expect(await migrateWebSearchProvidersForTenant(db, tenantId)).toMatchObject({ created: 0, stripped: 0 });
    expect(await db.listWebSearchInstances(tenantId)).toEqual([]);
  });

  it('keeps the marker server-owned on update', async () => {
    const db = getDb();
    const created = await createProviderConfig(tenantDbName, tenantId, {
      key: 'fresh', type: 'websearch', driver: 'tavily', label: 'Fresh', credentials: { apiKey: 'k' }, createdBy: 'u',
    });
    const cleared = await updateProviderConfig(tenantDbName, String(created._id), { metadata: { note: 'x', behaviorOnInstances: false } });
    expect(cleared?.metadata).toEqual({ note: 'x', behaviorOnInstances: true });

    await provider('legacy');
    const legacy = await db.findProviderByKey(tenantId, 'legacy');
    const set = await updateProviderConfig(tenantDbName, String(legacy?._id), { metadata: { behaviorOnInstances: true } });
    expect(set?.metadata?.behaviorOnInstances).toBeUndefined();
  });

  it('keeps a disabled provider disabled on its instance', async () => {
    const db = getDb();
    await provider('off', { status: 'disabled' });
    await migrateWebSearchProvidersForTenant(db, tenantId);
    expect((await db.findWebSearchInstanceByKey(tenantId, 'off'))?.status).toBe('disabled');
  });

  it('changes nothing the second time', async () => {
    const db = getDb();
    await provider('docs-search');
    await migrateWebSearchProvidersForTenant(db, tenantId);
    const instanceBefore = await db.findWebSearchInstanceByKey(tenantId, 'docs-search');
    const providerBefore = await db.findProviderByKey(tenantId, 'docs-search');

    const again = await migrateWebSearchProvidersForTenant(db, tenantId);
    expect(again).toMatchObject({ created: 0, stripped: 0 });
    expect(await db.findWebSearchInstanceByKey(tenantId, 'docs-search')).toEqual(instanceBefore);
    expect(await db.findProviderByKey(tenantId, 'docs-search')).toEqual(providerBefore);
    expect(await db.listWebSearchInstances(tenantId)).toHaveLength(1);
  });

  it('skips platform and managed records', async () => {
    const db = getDb();
    await provider('platform-search', { platform: true });
    await provider('managed-search');
    registerManagedCreditsHost({
      isManagedProvider: (ref: { key: string }) => ref.key === 'managed-search',
      reserve: async () => { throw new Error('unused'); },
      listRoutes: () => [],
    } as never);

    const result = await migrateWebSearchProvidersForTenant(db, tenantId);
    expect(result).toMatchObject({ providers: 0, created: 0, skipped: 2 });
    expect(await db.listWebSearchInstances(tenantId)).toEqual([]);
    expect((await db.findProviderByKey(tenantId, 'platform-search'))?.settings).toMatchObject({ engines: 'general' });
  });

  it('leaves a key that an instance of another provider holds alone', async () => {
    const db = getDb();
    await provider('taken');
    await db.createWebSearchInstance({
      tenantId, projectId: null, key: 'taken', name: 'Other', providerKey: 'elsewhere', status: 'active',
      settings: { language: 'tr' }, createdBy: 'u',
    });

    const result = await migrateWebSearchProvidersForTenant(db, tenantId);
    expect(result).toMatchObject({ created: 0, stripped: 0, conflicts: ['taken'] });
    expect(await db.findWebSearchInstanceByKey(tenantId, 'taken')).toMatchObject({ providerKey: 'elsewhere', settings: { language: 'tr' } });
    const after = await db.findProviderByKey(tenantId, 'taken');
    expect(after?.settings).toMatchObject({ engines: 'general' });
    expect(after?.metadata?.behaviorOnInstances).toBeUndefined();
  });

  it('does not touch a provider without behavior settings but still gives it an instance', async () => {
    const db = getDb();
    await provider('plain', { driver: 'tavily', settings: {} });
    const result = await migrateWebSearchProvidersForTenant(db, tenantId);
    expect(result).toMatchObject({ created: 1, stripped: 0 });
    const after = await db.findProviderByKey(tenantId, 'plain');
    expect(after?.metadata?.migratedBehavior).toBeUndefined();
    expect(after?.metadata?.behaviorOnInstances).toBe(true);
  });
});
