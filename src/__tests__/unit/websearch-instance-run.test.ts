/**
 * Web search over an instance: resolution (instance key, legacy provider key, no-key rules) and the run path
 * (behavior from the instance, connection from the provider, managed reserve keyed by the provider key, quota / log /
 * usage / cache keyed by the instance key). Real SQLite database and real services; only the outbound call, the
 * quota guard and the cache lookup are mocked.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: undefined as unknown,
  call: vi.fn(),
  quota: vi.fn(),
  logs: [] as Array<Record<string, unknown>>,
  usage: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock('@/lib/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDatabase: async () => hoisted.db,
  runWithTenantScope: async (_name: string, fn: (db: unknown) => unknown) => fn(hoisted.db),
}));
vi.mock('@/lib/core/asyncTask', () => ({ fireAndForget: (_n: string, fn: () => Promise<void>) => fn() }));
vi.mock('@/lib/quota/serviceQuota', () => ({ enforceServiceQuota: hoisted.quota }));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({ assertServiceEnabled: vi.fn() }));
vi.mock('@/lib/services/webSearch/webSearchAdapter', () => ({ callWebSearchProvider: hoisted.call }));
vi.mock('@/lib/services/usage/usageEvents', () => ({
  recordUsageEvent: (event: unknown) => { hoisted.usage(event); return {}; },
}));
vi.mock('@/lib/services/webSearch/webSearchCache', () => ({
  lookupWebSearchCache: hoisted.lookup,
  storeWebSearchCache: vi.fn(async () => true),
  describeCacheFailure: vi.fn(() => 'cache failed'),
}));

import { registerManagedCreditsHost, resetManagedCreditsHostForTests, type ManagedCreditsHost } from '@/enterprise/managed-credits';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { encryptObject } from '@/lib/utils/crypto';
import { resolveWebSearchTarget, runWebSearch } from '@/lib/services/webSearch/webSearchService';

const TENANT_DB = 'websearch_run_tenant';
const T = 't1';
const P = 'p1';

let tmpDir = '';
let db: SQLiteProvider;

const addProvider = (key: string, extra: Record<string, unknown> = {}) => db.createProvider({
  tenantId: T, type: 'websearch', driver: 'searxng', label: key, key, status: 'active',
  credentialsEnc: encryptObject({ authUsername: 'u', authPassword: 'p' }),
  settings: { baseUrl: 'https://search.example', language: 'de', engines: 'legacy' },
  projectIds: [P], createdBy: 'u', ...extra,
} as never);

const addInstance = (key: string, extra: Record<string, unknown> = {}) => db.createWebSearchInstance({
  tenantId: T, projectId: P, key, name: key, providerKey: 'conn', status: 'active',
  settings: { language: 'en', engines: 'a,b' }, createdBy: 'u', ...extra,
} as never);

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-websearch-run-'));
  db = new SQLiteProvider(tmpDir, 'websearch_run_main');
  await db.connect();
  await db.switchToTenant(TENANT_DB);
  hoisted.db = db;
});

afterAll(async () => {
  await db.disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.call.mockResolvedValue({ results: [{ title: 't', url: 'https://r', snippet: 's', position: 1 }] });
  hoisted.lookup.mockResolvedValue({ status: 'miss', embedding: [0.1] });
  for (const i of await db.listWebSearchInstances(T)) await db.deleteWebSearchInstance(String(i._id));
  for (const p of await db.listProviders(T)) await db.deleteProvider(String(p._id));
});

afterEach(() => resetManagedCreditsHostForTests());

describe('resolveWebSearchTarget', () => {
  it('resolves an explicit instance key to the instance and its provider', async () => {
    await addProvider('conn');
    await addInstance('docs');
    const target = await resolveWebSearchTarget(TENANT_DB, T, P, 'docs');
    expect(target.instance?.key).toBe('docs');
    expect(target.providerKey).toBe('conn');
  });

  it('falls back to a provider key (legacy): no instance, the provider acts as the behavior', async () => {
    await addProvider('conn');
    expect(await resolveWebSearchTarget(TENANT_DB, T, P, 'conn')).toEqual({ instance: null, providerKey: 'conn' });
    // An instance hidden from the project does not shadow anything: the key is then taken as a provider key.
    await addInstance('other-p', { projectId: 'p2' });
    expect((await resolveWebSearchTarget(TENANT_DB, T, P, 'other-p')).instance).toBeNull();
  });

  it('without a key takes the project single active instance, then a single visible one, then the provider rule', async () => {
    await addProvider('conn');
    // provider rule: single active own provider
    expect(await resolveWebSearchTarget(TENANT_DB, T, P, undefined)).toEqual({ instance: null, providerKey: 'conn' });

    await addInstance('wide', { projectId: null });
    expect((await resolveWebSearchTarget(TENANT_DB, T, P, undefined)).instance?.key).toBe('wide');

    await addInstance('own');
    expect((await resolveWebSearchTarget(TENANT_DB, T, P, undefined)).instance?.key).toBe('own');

    await addInstance('own-2');
    await expect(resolveWebSearchTarget(TENANT_DB, T, P, undefined)).rejects.toThrow(/Multiple web search instances.*own, own-2/);
  });

  describe('without a key, with a platform instance', () => {
    const addPlatform = async (extra: Record<string, unknown> = {}) => {
      await addProvider('platform-conn', { platform: true });
      return addInstance('cognipeer-search', { projectId: null, providerKey: 'platform-conn', platform: true, ...extra });
    };

    it('the tenant own instance wins over the platform one', async () => {
      await addProvider('conn');
      await addInstance('own');
      await addPlatform();
      expect((await resolveWebSearchTarget(TENANT_DB, T, P, undefined)).instance?.key).toBe('own');
    });

    it('the platform instance is used when it is the only one, with its provider key', async () => {
      await addPlatform();
      const target = await resolveWebSearchTarget(TENANT_DB, T, P, undefined);
      expect(target.instance?.key).toBe('cognipeer-search');
      expect(target.providerKey).toBe('platform-conn');
    });

    it('the multiple error lists only the own keys', async () => {
      await addProvider('conn');
      await addInstance('own');
      await addInstance('own-2');
      await addPlatform();
      const error = await resolveWebSearchTarget(TENANT_DB, T, P, undefined).catch((e: Error) => e);
      expect((error as Error).message).toMatch(/Multiple web search instances.*own, own-2/);
      expect((error as Error).message).not.toContain('cognipeer-search');
    });

    it('a disabled own instance falls through to the platform one', async () => {
      await addProvider('conn', { status: 'disabled' });
      await addInstance('own', { status: 'disabled' });
      await addPlatform();
      expect((await resolveWebSearchTarget(TENANT_DB, T, P, undefined)).instance?.key).toBe('cognipeer-search');
    });

    it('an own legacy provider (no instance) wins over the platform instance', async () => {
      await addProvider('conn');
      await addPlatform();
      expect(await resolveWebSearchTarget(TENANT_DB, T, P, undefined)).toEqual({ instance: null, providerKey: 'conn' });
    });
  });

  it('ignores disabled instances and reports nothing configured', async () => {
    await addProvider('conn', { status: 'disabled' });
    await addInstance('off', { status: 'disabled' });
    await expect(resolveWebSearchTarget(TENANT_DB, T, P, undefined)).rejects.toThrow(/No active web search instance/);
  });

  it('a missing explicit key stays the provider not-found error at run time', async () => {
    await expect(runWebSearch(TENANT_DB, T, P, { query: 'q', providerKey: 'ghost' })).rejects.toThrow(/"ghost" not found/);
  });
});

describe('runWebSearch with an instance', () => {
  it('merges the provider connection with the instance behavior and keys everything by the instance', async () => {
    await addProvider('conn');
    await addInstance('docs');
    const result = await runWebSearch(TENANT_DB, T, P, { query: 'q', providerKey: 'docs', source: 'dashboard' });

    const [record, credentials, input] = hoisted.call.mock.calls[0];
    expect(record.settings).toEqual({ baseUrl: 'https://search.example', language: 'en', engines: 'a,b' });
    expect(credentials).toEqual({ authUsername: 'u', authPassword: 'p' });
    expect(input.query).toBe('q');
    expect(hoisted.quota).toHaveBeenCalledWith(
      { tenantDbName: TENANT_DB, tenantId: T, projectId: P },
      { domain: 'websearch', resourceKey: 'docs', cost: { requests: 1 } },
    );
    expect(hoisted.usage).toHaveBeenCalledWith(expect.objectContaining({ refKey: 'docs', service: 'websearch' }));
    expect(result.providerKey).toBe('docs');
    await vi.waitFor(async () => expect(await db.listWebSearchRunLogs('docs')).toHaveLength(1));
    const logs = await db.listWebSearchRunLogs('docs');
    expect(logs[0].metadata).toMatchObject({ providerKey: 'conn' });
    expect(await db.listWebSearchRunLogs('conn')).toHaveLength(0);
  });

  it('refuses a disabled instance and keeps the legacy provider path unchanged', async () => {
    await addProvider('conn');
    await addInstance('off', { status: 'disabled' });
    await expect(runWebSearch(TENANT_DB, T, P, { query: 'q', providerKey: 'off' })).rejects.toThrow(/Instance "off" is not active/);

    await runWebSearch(TENANT_DB, T, P, { query: 'q', providerKey: 'conn' });
    const [record] = hoisted.call.mock.calls[0];
    expect(record.settings).toMatchObject({ language: 'de', engines: 'legacy' });
    expect(hoisted.quota).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resourceKey: 'conn' }));
    await vi.waitFor(async () => expect(await db.listWebSearchRunLogs('conn')).toHaveLength(1));
    const logs = await db.listWebSearchRunLogs('conn');
    expect(logs[0].metadata?.providerKey).toBeUndefined();
  });

  it('scopes the semantic cache by the instance key and reads its settings from the instance', async () => {
    await addProvider('conn');
    const cache = { enabled: true, vectorProviderKey: 'v', vectorIndexKey: 'i', embeddingModelKey: 'e' };
    await addInstance('docs', { settings: { cache } });
    await runWebSearch(TENANT_DB, T, P, { query: 'q', providerKey: 'docs' });
    expect(hoisted.lookup).toHaveBeenCalledWith(expect.objectContaining({
      scope: expect.objectContaining({ searchKey: 'docs', driver: 'searxng' }),
    }));
  });

  it('reserves a managed provider under the provider key, with the instance behavior on the request', async () => {
    await addProvider('platform-search', {
      platform: true, driver: 'tavily', credentialsEnc: 'not-decryptable', settings: { managed: true },
    });
    await addInstance('search', { projectId: null, providerKey: 'platform-search', settings: { searchDepth: 'advanced', language: 'tr' } });
    const lease = { id: 'l1', settle: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
    const reserve = vi.fn(async () => lease);
    registerManagedCreditsHost({
      isManagedProvider: (ref: { settings?: Record<string, unknown> }) => ref.settings?.managed === true,
      reserve,
      listRoutes: (query: { providerKey: string }) => (query.providerKey === 'platform-search'
        ? [{ id: 'route-a', connectionId: 'conn-a', driver: 'search-up' }]
        : []),
      resolveConnection: () => ({ driver: 'tavily', settings: {}, credentials: { apiKey: 'operator' } }),
    } as never);

    const result = await runWebSearch(TENANT_DB, T, P, { query: 'q', providerKey: 'search' });

    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({
      providerKey: 'platform-search', kind: 'search', estimate: { units: 2 },
    }));
    expect(lease.settle).toHaveBeenCalledWith({ units: 2 });
    expect(hoisted.quota).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resourceKey: 'search' }));
    expect(hoisted.usage).toHaveBeenCalledWith(expect.objectContaining({ refKey: 'search' }));
    expect(result.providerKey).toBe('search');
    const [, credentials, input] = hoisted.call.mock.calls[0];
    expect(credentials).toEqual({ apiKey: 'operator' });
    expect(input.language).toBe('tr');
  });
});
