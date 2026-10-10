/**
 * Storage stays additive: no migration, no new index, no new column. The IAM
 * document tables are created lazily by the first WRITE to them, and everything
 * the request gates READ on every request runs no DDL (SQLite; MongoDB creates
 * collections the same lazy way). With the engine deciding every request, the
 * first evaluation of a workspace writes exactly one document (the project-levels
 * moment) - and nothing at all happens to a workspace that never evaluates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The first decision of a file loads the Cedar WASM module and builds the schema; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import { configureIamEngine, describeTenantPolicySet, resetIamEngineForTests } from '@/lib/iam/engine';
import { decideEnforced, resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectLevelsForTests } from '@/lib/iam/projectLevels';
import { getIamSettings, resetIamSettingsCacheForTests } from '@/lib/iam/settings';
import { createPolicy, getPolicy, getPolicyVersion, listPolicies } from '@/lib/iam/store';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

const TENANT = 'tenant_iam_lazy';
let env: IamTestDb;

beforeEach(async () => {
  env = await createIamTestDb(TENANT);
  hoisted.getDatabase.mockResolvedValue(env.db);
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: false });
  resetProjectLevelsForTests();
  resetIamSettingsCacheForTests();
  resetEnforceStatsForTests();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

const iamTables = () =>
  ((env.db as unknown as { getTenantDb(): { prepare(s: string): { all(): Array<{ name: string }> } } })
    .getTenantDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'iam_%' ORDER BY name")
    .all()).map((r) => r.name);

describe('reads create nothing', () => {
  it('reading, listing and deleting in a pristine workspace runs no DDL', async () => {
    await env.db.runWithTenant(TENANT, async () => {
      expect(await env.db.iamDocGet('iam_meta', 'policy_version')).toBeNull();
      expect(await env.db.iamDocList('iam_policies')).toEqual([]);
      expect(await env.db.iamDocDelete('iam_policies', 'x')).toBe(false);
      expect(await env.db.iamDocClear('iam_meta')).toBe(0);
    });
    expect(iamTables()).toEqual([]);
  });

  it('what the gates read on every request - the policy version, the policy set, the settings - creates nothing', async () => {
    expect(await getPolicyVersion(TENANT)).toBe(0);
    expect(await listPolicies(TENANT)).toEqual([]);
    expect(await getPolicy(TENANT, 'nothing')).toBeNull();
    expect(await describeTenantPolicySet(TENANT)).toMatchObject({ version: 0, custom: 0, skipped: [] });
    expect(await getIamSettings(TENANT)).toEqual({ tokens: { maxLifetimeDays: null, requireExpiry: false } });
    expect(iamTables()).toEqual([]);
  });
});

describe('writes create what they need and nothing more', () => {
  it('the first evaluation of a workspace writes ONE small document: the project-levels moment', async () => {
    const user = await env.db.runWithTenant(TENANT, () => env.db.createUser({
      tenantId: env.tenantId, email: 'u@lazy.example', name: 'U', password: 'h', role: 'user', licenseId: 'FREE', features: [],
    }));
    expect(iamTables()).toEqual([]);

    const decision = await decideEnforced({
      subject: 'session', tenantDbName: TENANT, tenantId: env.tenantId, requestId: 'r', method: 'GET', route: '/api/agents',
      userId: String(user._id), user, groupGrants: [], service: 'agents',
    });
    expect(decision.allowed).toBe(true);
    expect(iamTables()).toEqual(['iam_meta']);
    const docs = await env.db.runWithTenant(TENANT, () => env.db.iamDocList('iam_meta'));
    expect(docs.map((d) => d.id)).toEqual(['project_levels_since']);
  });

  it('the first custom policy creates the policy table and its version counter, in the same two collections', async () => {
    await createPolicy(TENANT, { policyId: 'first', name: 'first', cedar: 'forbid(principal, action == Action::"models.write", resource is Service);' }, 'u');
    expect(iamTables()).toEqual(['iam_meta', 'iam_policies']);
    const ids = (await env.db.runWithTenant(TENANT, () => env.db.iamDocList('iam_meta'))).map((d) => d.id);
    expect(ids).toEqual(['policy_version']);
  });

  it('the retired shadow collection is never created', async () => {
    const user = await env.db.runWithTenant(TENANT, () => env.db.createUser({
      tenantId: env.tenantId, email: 'v@lazy.example', name: 'V', password: 'h', role: 'user', licenseId: 'FREE', features: [],
    }));
    await createPolicy(TENANT, { policyId: 'p', name: 'p', cedar: 'forbid(principal, action == Action::"models.write", resource is Service);' }, 'u');
    for (const method of ['GET', 'POST', 'DELETE']) {
      await decideEnforced({
        subject: 'session', tenantDbName: TENANT, tenantId: env.tenantId, requestId: 'r', method, route: '/api/models',
        userId: String(user._id), user, groupGrants: [], service: 'models',
      });
    }
    expect(iamTables()).not.toContain('iam_shadow');
  });
});
