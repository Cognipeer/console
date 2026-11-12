/**
 * Two tenants served at the same moment through entry points that open their own
 * tenant scope (quota policies, user display names, provider usage), on BOTH
 * real backends.
 *
 * Two properties pin that, both deterministic:
 *  - the entry points never move the shared handle (`switchToTenant`), which an
 *    interleaved call for the other tenant could overwrite between a switch and
 *    a query;
 *  - each call lands in its own tenant even when it runs inside an enclosing
 *    scope bound to the other tenant.
 * Reverting these services to `getDatabase()` + `switchToTenant()` fails every case.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

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
import { getProviderUsage } from '@/lib/services/providers/providerUsage';
import { createQuotaPolicy, listQuotaPolicies } from '@/lib/services/quota/quotaService';
import { resolveUserDisplayNames } from '@/lib/services/users/userDisplayNames';
import { describeForEachProvider } from './db-parity.helper';

beforeAll(() => reloadConfig());
afterAll(() => {
  delete process.env.QUOTA_POLICY_CACHE_TTL_SECONDS;
  reloadConfig();
});

interface TenantFixture {
  slug: string;
  dbName: string;
  tenantId: string;
  userId: string;
  userName: string;
  projectId: string;
  projectName: string;
}

describeForEachProvider('explicit tenant scope, two tenants at once', (getDb) => {
  let db: DatabaseProvider;
  const tenants: TenantFixture[] = [];

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
      const projectName = `Project of ${name}`;
      const { user, project } = await db.runWithTenant!(dbName, async () => ({
        user: await db.createUser({
          tenantId, email: `${name}@x.io`, name: userName, password: '$2b$10$x', role: 'owner', licenseId: 'FREE', features: [],
        }),
        project: await db.createProject({ tenantId, key: `${name}-project`, name: projectName, createdBy: 'seed' }),
      }));
      tenants.push({
        slug, dbName, tenantId, userId: String(user._id), userName, projectId: String(project._id), projectName,
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Every entry point under test, for one tenant; `other` is the tenant whose rows must stay invisible. */
  async function work(t: TenantFixture, other: TenantFixture) {
    await createQuotaPolicy(t.dbName, t.tenantId, {
      scope: 'tenant', domain: 'llm', priority: 100, enabled: true, label: `policy-of-${t.slug}`, limits: {},
    } as never);
    const [policies, names, usage] = await Promise.all([
      listQuotaPolicies(t.dbName, t.tenantId),
      resolveUserDisplayNames(t.dbName, [t.userId, other.userId]),
      getProviderUsage(t.dbName, t.tenantId, { key: 'openai', projectId: t.projectId }),
    ]);
    return { policies, names, usage };
  }

  function expectOwnData(t: TenantFixture, other: TenantFixture, result: Awaited<ReturnType<typeof work>>) {
    expect(result.policies.map((r) => r.label)).toEqual([`policy-of-${t.slug}`]);
    expect(result.names.get(t.userId)).toBe(t.userName);
    expect(result.names.has(other.userId)).toBe(false);
    expect(result.usage.projects.map((p) => p.name)).toEqual([t.projectName]);
  }

  it('keeps interleaved quota policy writes and reads in their own tenant', async () => {
    const [a, b] = tenants;
    const switches = vi.spyOn(db, 'switchToTenant');
    await Promise.all(tenants.map((t) => createQuotaPolicy(t.dbName, t.tenantId, {
      scope: 'tenant', domain: 'llm', priority: 100, enabled: true, label: `policy-of-${t.slug}`, limits: {},
    } as never)));

    const reads = await Promise.all(Array.from({ length: 12 }, (_, i) => {
      const t = i % 2 === 0 ? a : b;
      return listQuotaPolicies(t.dbName, t.tenantId).then((rows) => ({ t, labels: rows.map((r) => r.label) }));
    }));

    expect(switches).not.toHaveBeenCalled();
    for (const { t, labels } of reads) {
      expect(labels).toEqual([`policy-of-${t.slug}`]);
    }
  });

  it('resolves each tenant its own people when the lookups interleave', async () => {
    const [a, b] = tenants;
    const switches = vi.spyOn(db, 'switchToTenant');
    const reads = await Promise.all(Array.from({ length: 10 }, (_, i) => {
      const t = i % 2 === 0 ? a : b;
      const other = t === a ? b : a;
      return resolveUserDisplayNames(t.dbName, [t.userId, other.userId]).then((names) => ({ t, other, names }));
    }));

    expect(switches).not.toHaveBeenCalled();
    for (const { t, other, names } of reads) {
      expect(names.get(t.userId)).toBe(t.userName);
      expect(names.has(other.userId)).toBe(false);
    }
  });

  it('lands each call in its own tenant inside an enclosing scope bound to the other tenant', async () => {
    const [a, b] = tenants;
    const switches = vi.spyOn(db, 'switchToTenant');
    const [ra, rb] = await Promise.all([
      db.runWithTenant!(b.dbName, () => work(a, b)),
      db.runWithTenant!(a.dbName, () => work(b, a)),
    ]);

    expect(switches).not.toHaveBeenCalled();
    expectOwnData(a, b, ra);
    expectOwnData(b, a, rb);
  });
});
