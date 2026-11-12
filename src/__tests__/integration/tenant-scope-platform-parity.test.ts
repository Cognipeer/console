/**
 * Two tenants served at the same moment through entry points that open their own
 * tenant scope (quota policies, user display names): each call reads and writes
 * its own tenant's rows, on BOTH real backends. A process-global tenant binding
 * would let an interleaved call for the other tenant redirect the query.
 */
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';

process.env.QUOTA_POLICY_CACHE_TTL_SECONDS = '0';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
import type { DatabaseProvider } from '@/lib/database';
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: DatabaseProvider) => unknown) => {
      const db: DatabaseProvider = await hoisted.getDatabase();
      return db.runWithTenant?.(tenantDbName, () => fn(db));
    },
  };
});

import { reloadConfig } from '@/lib/core/config';
import { createQuotaPolicy, listQuotaPolicies } from '@/lib/services/quota/quotaService';
import { resolveUserDisplayNames } from '@/lib/services/users/userDisplayNames';
import { describeForEachProvider } from './db-parity.helper';

beforeAll(() => reloadConfig());
afterAll(() => {
  delete process.env.QUOTA_POLICY_CACHE_TTL_SECONDS;
  reloadConfig();
});

describeForEachProvider('explicit tenant scope, two tenants at once', (getDb) => {
  let db: DatabaseProvider;
  const tenants: Array<{ slug: string; dbName: string; tenantId: string; userId: string; userName: string }> = [];

  beforeEach(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    tenants.length = 0;
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    for (const name of ['alpha', 'beta']) {
      const slug = `scope-${name}-${suffix}`;
      const dbName = `tenant_${slug}`;
      const tenant = await db.createTenant({ companyName: name, slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
      const tenantId = String(tenant._id);
      const userName = `User of ${name}`;
      const user = await db.runWithTenant!(dbName, () => db.createUser({
        tenantId, email: `${name}@x.io`, name: userName, password: '$2b$10$x', role: 'owner', licenseId: 'FREE', features: [],
      }));
      tenants.push({ slug, dbName, tenantId, userId: String(user._id), userName });
    }
  });

  it('keeps interleaved quota policy writes and reads in their own tenant', async () => {
    const [a, b] = tenants;
    await Promise.all(tenants.map((t) => createQuotaPolicy(t.dbName, t.tenantId, {
      scope: 'tenant', domain: 'llm', priority: 100, enabled: true, label: `policy-of-${t.slug}`, limits: {},
    } as never)));

    const reads = await Promise.all(Array.from({ length: 12 }, (_, i) => {
      const t = i % 2 === 0 ? a : b;
      return listQuotaPolicies(t.dbName, t.tenantId).then((rows) => ({ t, labels: rows.map((r) => r.label) }));
    }));

    for (const { t, labels } of reads) {
      expect(labels).toEqual([`policy-of-${t.slug}`]);
    }
  });

  it('resolves each tenant its own people when the lookups interleave', async () => {
    const [a, b] = tenants;
    const reads = await Promise.all(Array.from({ length: 10 }, (_, i) => {
      const t = i % 2 === 0 ? a : b;
      const other = t === a ? b : a;
      return resolveUserDisplayNames(t.dbName, [t.userId, other.userId]).then((names) => ({ t, other, names }));
    }));

    for (const { t, other, names } of reads) {
      expect(names.get(t.userId)).toBe(t.userName);
      expect(names.has(other.userId)).toBe(false);
    }
  });
});
