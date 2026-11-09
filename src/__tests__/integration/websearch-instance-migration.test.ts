/**
 * Existing web search providers become instances: the move runs on both database backends, is repeatable, leaves
 * platform and managed records alone and never overwrites an instance that holds the key for another provider.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';

import { registerManagedCreditsHost, resetManagedCreditsHostForTests } from '@/enterprise/managed-credits';
import { migrateWebSearchProvidersForTenant } from '@/lib/services/webSearch/webSearchInstanceMigration';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Web search provider to instance migration', (getDb) => {
  let tenantId: string;

  beforeEach(async () => {
    const slug = `wsm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Search Co', slug, dbName: `tenant_${slug}`, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(`tenant_${slug}`);
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
    expect((await db.findProviderByKey(tenantId, 'taken'))?.settings).toMatchObject({ engines: 'general' });
  });

  it('does not touch a provider without behavior settings but still gives it an instance', async () => {
    const db = getDb();
    await provider('plain', { driver: 'tavily', settings: {} });
    const result = await migrateWebSearchProvidersForTenant(db, tenantId);
    expect(result).toMatchObject({ created: 1, stripped: 0 });
    expect((await db.findProviderByKey(tenantId, 'plain'))?.metadata?.migratedBehavior).toBeUndefined();
  });
});
