/**
 * Web search instances: create / update / delete / get / list over a real SQLite tenant database.
 * An instance holds the behavior; the provider record it points at holds the connection.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('@/lib/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDatabase: async () => hoisted.db,
}));

import { registerManagedCreditsHost, resetManagedCreditsHostForTests } from '@/enterprise/managed-credits';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { WebSearchCacheConfigError } from '@/lib/services/webSearch/cacheSettings';
import { ManagedProviderReadOnlyError, PlatformRecordReadOnlyError } from '@/lib/services/providers/providerService';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { HOSTED_WEBSEARCH_INSTANCE_FORM } from '@/lib/providers/contracts/webSearchContracts';
import {
  createWebSearchInstance,
  deleteWebSearchInstance,
  getWebSearchInstance,
  listWebSearchInstances,
  updateWebSearchInstance,
  WebSearchInstanceKeyExistsError,
  WebSearchInstanceNotFoundError,
} from '@/lib/services/webSearch/webSearchInstanceService';

const TENANT_DB = 'websearch_instances_tenant';
const T = 't1';

let tmpDir = '';
let db: SQLiteProvider;

const provider = (key: string, extra: Record<string, unknown> = {}) => db.createProvider({
  tenantId: T, type: 'websearch', driver: 'tavily', label: key, key, status: 'active',
  credentialsEnc: 'x', settings: {}, projectIds: ['p1'], createdBy: 'u', ...extra,
} as never);

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-websearch-instances-'));
  db = new SQLiteProvider(tmpDir, 'websearch_instances_main');
  await db.connect();
  await db.switchToTenant(TENANT_DB);
  hoisted.db = db;
});

afterAll(async () => {
  await db.disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const i of await db.listWebSearchInstances(T)) await db.deleteWebSearchInstance(String(i._id));
  for (const p of await db.listProviders(T)) await db.deleteProvider(String(p._id));
  await provider('conn-a');
});

afterEach(() => resetManagedCreditsHostForTests());

const make = (key: string, extra: Record<string, unknown> = {}) => createWebSearchInstance(TENANT_DB, T, {
  key, name: key, providerKey: 'conn-a', projectId: 'p1', createdBy: 'u', ...extra,
});

describe('createWebSearchInstance', () => {
  it('stores the behavior next to the provider key and reads it back', async () => {
    const created = await make('docs', { settings: { searchDepth: 'advanced', language: 'en' }, description: 'd' });
    expect(created).toMatchObject({ key: 'docs', providerKey: 'conn-a', projectId: 'p1', status: 'active' });
    const found = await db.findWebSearchInstanceByKey(T, 'docs');
    expect(found).toMatchObject({
      name: 'docs', description: 'd', settings: { searchDepth: 'advanced', language: 'en' }, createdBy: 'u',
    });
    expect(found?.platform).toBeUndefined();
  });

  it('keeps keys unique per tenant', async () => {
    await make('docs');
    await expect(make('docs')).rejects.toBeInstanceOf(WebSearchInstanceKeyExistsError);
    await expect(make('docs', { projectId: null })).rejects.toBeInstanceOf(WebSearchInstanceKeyExistsError);
  });

  it('refuses the key of a web search provider, platform ones included, as a taken key', async () => {
    await provider('hosted', { driver: 'hosted-search', platform: true });
    for (const key of ['conn-a', 'hosted']) {
      await expect(make(key)).rejects.toMatchObject({ name: 'ProviderKeyExistsError', code: 'duplicate_key' });
    }
    expect(await db.findWebSearchInstanceByKey(T, 'conn-a')).toBeNull();
  });

  it('refuses a key the managed host reserves', async () => {
    registerManagedCreditsHost({
      isManagedProvider: (ref: { key: string }) => ref.key === 'reserved',
      reserve: async () => { throw new Error('unused'); },
      listRoutes: () => [],
    } as never);
    await expect(make('reserved')).rejects.toBeInstanceOf(ManagedProviderReadOnlyError);
    await expect(make('free')).resolves.toBeTruthy();
  });

  it('ignores a platform flag from the payload', async () => {
    const created = await make('docs', { platform: true });
    expect(created.platform).toBeFalsy();
    expect((await db.findWebSearchInstanceByKey(T, 'docs'))?.platform).toBeUndefined();
    await expect(deleteWebSearchInstance(TENANT_DB, T, 'docs')).resolves.toBe(true);
  });

  it('refuses a missing, wrong-type or not visible provider', async () => {
    await expect(make('a', { providerKey: 'nope' })).rejects.toBeInstanceOf(ProviderSettingsError);
    await db.createProvider({
      tenantId: T, type: 'llm', driver: 'openai', label: 'm', key: 'model-conn', status: 'active',
      credentialsEnc: 'x', settings: {}, projectIds: ['p1'], createdBy: 'u',
    } as never);
    await expect(make('b', { providerKey: 'model-conn' })).rejects.toThrow(/not a web search provider/);
    await expect(make('c', { projectId: 'p2' })).rejects.toThrow(/not assigned to project p2/);
  });

  it('lets a tenant-wide instance point at a provider visible somewhere', async () => {
    await expect(make('wide', { projectId: undefined })).resolves.toMatchObject({ projectId: null });
    await db.createProvider({
      tenantId: T, type: 'websearch', driver: 'tavily', label: 'x', key: 'unassigned', status: 'active',
      credentialsEnc: 'x', settings: {}, createdBy: 'u',
    } as never);
    // exists, so visible somewhere is not checked against a project
    await expect(make('wide2', { projectId: undefined, providerKey: 'unassigned' })).resolves.toBeTruthy();
  });

  it('validates the key, the name, the cache shape and connection fields', async () => {
    await expect(make('a/b')).rejects.toBeInstanceOf(ProviderSettingsError);
    for (const key of ['has space', 'Upper', 'under_score', 'a'.repeat(65)]) {
      await expect(make(key)).rejects.toMatchObject({ field: 'key' });
    }
    await expect(make('a'.repeat(64))).resolves.toBeTruthy();
    await expect(make('ok', { name: ' ' })).rejects.toBeInstanceOf(ProviderSettingsError);
    await expect(make('ok', { settings: { cache: { enabled: 'yes' } } })).rejects.toBeInstanceOf(WebSearchCacheConfigError);
    await provider('searx', { driver: 'searxng' });
    await expect(make('ok', { providerKey: 'searx', settings: { baseUrl: 'https://x.example' } }))
      .rejects.toThrow(/belongs to the provider connection/);
    await expect(make('ok', { providerKey: 'searx', settings: { engines: 'a,b' } })).resolves.toBeTruthy();
  });

  it('refuses search options a search does not understand, on create and update', async () => {
    for (const [field, value] of [['safeSearch', 'banana'], ['searchDepth', { deep: true }], ['count', 'lots'], ['count', 0]]) {
      await expect(make('bad', { settings: { [field as string]: value } })).rejects.toMatchObject({ field });
    }
    await make('good', { settings: { safeSearch: 'off', searchDepth: 'basic', count: 5 } });
    await expect(updateWebSearchInstance(TENANT_DB, T, 'good', { settings: { safeSearch: 'banana' } }))
      .rejects.toMatchObject({ field: 'safeSearch' });
  });

  it('accepts the search options of the hosted form on a platform provider', async () => {
    // The form the UI shows for an instance on a platform or managed provider: no driver describes these options.
    const names = HOSTED_WEBSEARCH_INSTANCE_FORM.sections.flatMap((section) => section.fields).map((field) => field.name);
    expect(names).toEqual(['searchDepth', 'language', 'country', 'safeSearch']);

    await provider('hosted', { driver: 'hosted-search', platform: true });
    const settings = { searchDepth: 'advanced', language: 'tr', country: 'TR', safeSearch: 'strict' };
    await expect(make('hosted-docs', { providerKey: 'hosted', settings })).resolves.toMatchObject({ settings });
    const updated = await updateWebSearchInstance(TENANT_DB, T, 'hosted-docs', {
      settings: { ...settings, searchDepth: 'basic' },
    });
    expect(updated.settings).toEqual({ ...settings, searchDepth: 'basic' });
  });
});

describe('updateWebSearchInstance / deleteWebSearchInstance', () => {
  it('updates behavior, keeps the key and re-checks a changed provider', async () => {
    await make('docs', { settings: { searchDepth: 'basic' } });
    await provider('conn-b');
    const updated = await updateWebSearchInstance(TENANT_DB, T, 'docs', {
      name: 'Docs', settings: { searchDepth: 'advanced' }, providerKey: 'conn-b', status: 'disabled', updatedBy: 'u2',
    });
    expect(updated).toMatchObject({
      key: 'docs', name: 'Docs', providerKey: 'conn-b', status: 'disabled', settings: { searchDepth: 'advanced' }, updatedBy: 'u2',
    });
    await expect(updateWebSearchInstance(TENANT_DB, T, 'docs', { providerKey: 'nope' }))
      .rejects.toBeInstanceOf(ProviderSettingsError);
    await expect(updateWebSearchInstance(TENANT_DB, T, 'ghost', { name: 'x' }))
      .rejects.toBeInstanceOf(WebSearchInstanceNotFoundError);
  });

  it('keeps a platform instance read-only for tenants', async () => {
    await db.createWebSearchInstance({
      tenantId: T, projectId: null, key: 'plat', name: 'plat', providerKey: 'conn-a', status: 'active',
      settings: {}, platform: true, createdBy: 'system',
    });
    await expect(updateWebSearchInstance(TENANT_DB, T, 'plat', { name: 'x' })).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    await expect(deleteWebSearchInstance(TENANT_DB, T, 'plat')).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    expect(await db.findWebSearchInstanceByKey(T, 'plat')).toBeTruthy();
  });

  it('deletes an instance and reports a missing one', async () => {
    await make('docs');
    await expect(deleteWebSearchInstance(TENANT_DB, T, 'docs')).resolves.toBe(true);
    await expect(deleteWebSearchInstance(TENANT_DB, T, 'docs')).resolves.toBe(false);
  });
});

describe('visibility', () => {
  it('shows an instance in its own project and a tenant-wide one wherever its provider is assigned', async () => {
    await provider('conn-p2', { projectIds: ['p2'] });
    await make('own-p1');
    await make('wide', { projectId: undefined });
    await make('own-p2', { projectId: 'p2', providerKey: 'conn-p2' });
    await make('wide-p2', { projectId: undefined, providerKey: 'conn-p2' });

    const keys = async (p?: string) => (await listWebSearchInstances(TENANT_DB, T, p)).map((i) => i.key);
    expect(await keys('p1')).toEqual(['own-p1', 'wide']);
    expect(await keys('p2')).toEqual(['own-p2', 'wide-p2']);
    expect(await keys('p3')).toEqual([]);
    expect(await keys()).toEqual(['own-p1', 'own-p2', 'wide', 'wide-p2']);
    expect(await getWebSearchInstance(TENANT_DB, T, 'own-p1', 'p2')).toBeNull();
    expect(await getWebSearchInstance(TENANT_DB, T, 'wide', 'p1')).toMatchObject({ key: 'wide' });
    expect(await getWebSearchInstance(TENANT_DB, T, 'wide', 'p2')).toBeNull();
  });

  it('hides an instance whose provider lost the project assignment, and filters by provider', async () => {
    await make('docs');
    const conn = await db.findProviderByKey(T, 'conn-a');
    await db.updateProvider(String(conn?._id), { projectIds: ['p9'] } as never);
    expect(await listWebSearchInstances(TENANT_DB, T, 'p1')).toEqual([]);
    expect((await listWebSearchInstances(TENANT_DB, T, undefined, { providerKey: 'conn-a' })).map((i) => i.key)).toEqual(['docs']);
    expect(await listWebSearchInstances(TENANT_DB, T, undefined, { providerKey: 'other' })).toEqual([]);
  });
});
