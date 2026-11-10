/**
 * Web search with a platform-provided instance: it is listed and run from a project it is
 * assigned to, and its connection comes from the operator (route + resolveConnection), never the stored blob.
 * Real SQLite database and real provider service; only the outbound call is mocked.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ db: undefined as unknown, call: vi.fn() }));

vi.mock('@/lib/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDatabase: async () => hoisted.db,
}));
vi.mock('@/lib/core/asyncTask', () => ({ fireAndForget: vi.fn() }));
vi.mock('@/lib/quota/serviceQuota', () => ({ enforceServiceQuota: vi.fn() }));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({ assertServiceEnabled: vi.fn() }));
vi.mock('@/lib/services/webSearch/webSearchAdapter', () => ({ callWebSearchProvider: hoisted.call }));

import { registerManagedCreditsHost, resetManagedCreditsHostForTests } from '@/enterprise/managed-credits';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { listWebSearchProviders, runWebSearch } from '@/lib/services/webSearch/webSearchService';

let tmpDir = '';
let db: SQLiteProvider;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-platform-websearch-'));
  db = new SQLiteProvider(tmpDir, 'platform_websearch_main');
  await db.connect();
  await db.switchToTenant('platform_websearch_tenant');
  hoisted.db = db;
  await db.createProvider({
    tenantId: 't1', type: 'websearch', driver: 'tavily', label: 'Platform search', key: 'platform-search',
    status: 'active', credentialsEnc: 'not-decryptable', settings: { managed: true }, platform: true, projectIds: ['project-assigned'], createdBy: 'system',
  });
});

afterAll(async () => {
  resetManagedCreditsHostForTests();
  await db.disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('web search over a platform record', () => {
  it('lists it for a project it is assigned to, and for no other', async () => {
    const views = await listWebSearchProviders('platform_websearch_tenant', 't1', 'project-assigned');
    expect(views.map((v) => [v.key, v.platform])).toEqual([['platform-search', true]]);
    expect(await listWebSearchProviders('platform_websearch_tenant', 't1', 'project-other')).toEqual([]);
  });

  it('runs it from an assigned project with the operator key, never the stored blob', async () => {
    const lease = { id: 'l1', settle: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
    registerManagedCreditsHost({
      isManagedProvider: (ref) => ref.settings?.managed === true,
      reserve: vi.fn(async () => lease),
      listRoutes: (query) => (query.providerKey === 'platform-search' ? [{ id: 'route-a', connectionId: 'conn-a', driver: 'search-up' }] : []),
      resolveConnection: (_ref, connectionId) => (
        connectionId === 'conn-a' ? { driver: 'search-up', settings: {}, credentials: { apiKey: 'operator-key' } } : null
      ),
    });
    hoisted.call.mockResolvedValue({ results: [], provider: 'tavily' });
    const result = await runWebSearch('platform_websearch_tenant', 't1', 'project-assigned', { query: 'hello' });
    expect(hoisted.call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(hoisted.call.mock.calls[0])).toContain('operator-key');
    expect(hoisted.call.mock.calls[0][0].driver).toBe('search-up');
    // The tenant still sees the public record's driver.
    expect(result.driver).toBe('tavily');
    expect(JSON.stringify(result)).not.toMatch(/search-up|conn-a|route-a/);
  });

  it('is refused when the host has no live route', async () => {
    registerManagedCreditsHost({
      isManagedProvider: (ref) => ref.settings?.managed === true,
      reserve: vi.fn(),
      listRoutes: () => [],
      resolveConnection: () => null,
    });
    hoisted.call.mockClear();
    await expect(runWebSearch('platform_websearch_tenant', 't1', 'project-assigned', { query: 'hello' }))
      .rejects.toThrow('This provider is not available right now.');
    expect(hoisted.call).not.toHaveBeenCalled();
  });
});
