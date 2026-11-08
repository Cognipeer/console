/**
 * Web search with a platform-provided (tenant-wide) instance: it is listed and run from a project it was never
 * assigned to, and its key comes from the operator (resolveCredentials) through the existing driver.
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
    status: 'active', credentialsEnc: 'not-decryptable', settings: { managed: true }, allProjects: true, createdBy: 'system',
  });
});

afterAll(async () => {
  resetManagedCreditsHostForTests();
  await db.disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('web search over a tenant-wide record', () => {
  it('lists it for any project', async () => {
    const views = await listWebSearchProviders('platform_websearch_tenant', 't1', 'project-never-assigned');
    expect(views.map((v) => [v.key, v.allProjects])).toEqual([['platform-search', true]]);
  });

  it('runs it from any project with the operator key, never the stored blob', async () => {
    const lease = { id: 'l1', settle: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
    registerManagedCreditsHost({
      isManagedProvider: (ref) => ref.settings?.managed === true,
      reserve: vi.fn(async () => lease),
      resolveCredentials: () => ({ apiKey: 'operator-key' }),
    });
    hoisted.call.mockResolvedValue({ results: [], provider: 'tavily' });
    await runWebSearch('platform_websearch_tenant', 't1', 'project-never-assigned', { query: 'hello' });
    expect(hoisted.call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(hoisted.call.mock.calls[0])).toContain('operator-key');
  });
});
