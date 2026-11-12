/**
 * Two tenants call the webhook endpoint service at the same time on one real SQLite provider: every call
 * is bound to its own tenant database for its whole run (`runWithTenantScope`), so each reads only its own
 * endpoints however the awaits interleave.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    // The real helper, on the shared provider under test.
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { encryptObject } from '@/lib/utils/crypto';
import { listWebhookEndpoints, type WebhookScope } from '@/lib/services/webhooks/webhookEndpointService';

let db: SQLiteProvider;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'webhooks-scope-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
});

afterEach(async () => {
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function seedTenant(slug: string, urls: string[]): Promise<WebhookScope> {
  const dbName = `tenant_${slug}`;
  const tenant = await db.createTenant({ companyName: slug, slug, dbName, licenseType: 'FREE', ownerId: `owner-${slug}` });
  const tenantId = String(tenant._id);
  await db.runWithTenant(dbName, async () => {
    for (const url of urls) {
      await db.createWebhookEndpoint({
        tenantId,
        projectId: 'proj-1',
        url,
        events: ['session.idled'],
        secretSealed: encryptObject('whsec_test'),
        status: 'active',
        createdBy: 'user-1',
      });
    }
  });
  return {
    tenantDbName: dbName,
    tenantId,
    projectId: 'proj-1',
    userId: 'user-1',
    workspaceAllows: async () => true,
    projectAllows: async () => true,
    capabilities: async () => ({}),
  } as unknown as WebhookScope;
}

describe('tenant scope of the webhook endpoint service', () => {
  it('concurrent calls of two tenants each read only their own endpoints', async () => {
    const a = await seedTenant('alpha', ['https://alpha.example.com/one', 'https://alpha.example.com/two']);
    const b = await seedTenant('bravo', ['https://bravo.example.com/one']);

    const calls = Array.from({ length: 12 }, (_, i) => listWebhookEndpoints(i % 2 === 0 ? a : b));
    const results = await Promise.all(calls);

    results.forEach((result, i) => {
      const urls = result.endpoints.map((endpoint) => String(endpoint.url));
      if (i % 2 === 0) {
        expect(urls).toHaveLength(2);
        expect(urls.every((url) => url.includes('alpha.example.com'))).toBe(true);
      } else {
        expect(urls).toHaveLength(1);
        expect(urls.every((url) => url.includes('bravo.example.com'))).toBe(true);
      }
    });
  });
});
