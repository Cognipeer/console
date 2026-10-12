/**
 * Where "acting for users" lives (lib/iam/tokenDelegation.ts), on BOTH SQLite and MongoDB: one document per token in the
 * lazily created `iam_delegations` collection, shared secrets sealed at rest, a short cache a local write drops, and a
 * body checked as a whole before anything is stored.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

import type { DatabaseProvider } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import {
  delegationAuditSnapshot,
  deleteTokenDelegation,
  getTokenDelegation,
  parseDelegationInput,
  putTokenDelegation,
  resetTokenDelegationCacheForTests,
  toDelegationView,
  type TokenDelegationConfig,
} from '@/lib/iam/tokenDelegation';
import { describeForEachProvider } from './db-parity.helper';

const SECRET = 'plain-text-secret-that-must-never-be-stored-0123456789';
const ISSUER = 'https://idp.example.com/';

const config = (patch: Partial<TokenDelegationConfig> = {}): TokenDelegationConfig => ({
  enabled: true,
  trust: {
    issuer: ISSUER,
    audience: ['console', 'console-staging'],
    algorithms: ['HS256', 'RS256'],
    keys: { hsSecrets: [{ kid: 'k1', secret: SECRET }], jwksUrl: 'https://idp.example.com/.well-known/jwks.json', pem: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----' },
    maxTokenAgeSeconds: 900,
    clockSkewSeconds: 30,
    requireSingleUse: false,
  },
  mapping: { matchBy: ['externalId', 'verifiedEmail'], jit: 'external', groupMap: [{ idpGroup: 'sales', consoleGroupName: 'Sales (verified)' }] },
  allowPrivileged: false,
  ...patch,
});

describeForEachProvider('token delegation store', (getDb) => {
  let db: DatabaseProvider;
  let tenantDbName: string;

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `deleg-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    tenantDbName = `tenant_${slug}`;
    await db.createTenant({ companyName: 'Store', slug, dbName: tenantDbName, licenseType: 'FREE', ownerId: 'pending' });
  });
  afterAll(() => {
    hoisted.getDatabase.mockReset();
  });
  beforeEach(() => resetTokenDelegationCacheForTests());

  it('round-trips the whole configuration, with the shared secrets opened again for the gate', async () => {
    const put = await putTokenDelegation(tenantDbName, 'tok-1', config(), 'admin-1');
    expect(put).toMatchObject({ tokenId: 'tok-1', updatedBy: 'admin-1' });
    resetTokenDelegationCacheForTests();
    const read = await getTokenDelegation(tenantDbName, 'tok-1');
    expect(read?.config).toEqual(config());
    expect(read).toMatchObject({ tokenId: 'tok-1', updatedBy: 'admin-1', createdAt: put.createdAt });
  });

  it('seals the secrets: the stored document has their key ids and nothing readable', async () => {
    await putTokenDelegation(tenantDbName, 'tok-sealed', config(), 'admin-1');
    const doc = await db.runWithTenant!(tenantDbName, () => db.iamDocGet('iam_delegations', 'tok-sealed'));
    expect(JSON.stringify(doc?.data)).not.toContain(SECRET);
    expect(doc?.data).toMatchObject({ hsKids: ['k1'], hsSecretsSealed: expect.any(String), enabled: true });
    // a configuration without a shared secret stores no sealed block at all
    await putTokenDelegation(tenantDbName, 'tok-nosecret', config({ trust: { ...config().trust, algorithms: ['RS256'], keys: { jwksUrl: 'https://idp.example.com/jwks' } } }), 'admin-1');
    const plain = await db.runWithTenant!(tenantDbName, () => db.iamDocGet('iam_delegations', 'tok-nosecret'));
    expect(plain?.data.hsSecretsSealed).toBeUndefined();
  });

  it('keeps the creation time on replace, and a local write is seen at once through the cache', async () => {
    const first = await putTokenDelegation(tenantDbName, 'tok-2', config(), 'admin-1');
    expect((await getTokenDelegation(tenantDbName, 'tok-2'))?.config.mapping.jit).toBe('external');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await putTokenDelegation(tenantDbName, 'tok-2', config({ mapping: { matchBy: ['externalId'], jit: 'none' } }), 'admin-2');
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedBy).toBe('admin-2');
    // no cache reset in between: the write dropped the entry
    expect((await getTokenDelegation(tenantDbName, 'tok-2'))?.config.mapping.jit).toBe('none');
  });

  it('serves a repeated read from the cache for a short while, and another node\'s write is seen when it expires', async () => {
    await putTokenDelegation(tenantDbName, 'tok-3', config(), 'admin-1');
    const spy = vi.spyOn(db, 'iamDocGet');
    await getTokenDelegation(tenantDbName, 'tok-3');
    await getTokenDelegation(tenantDbName, 'tok-3');
    expect(spy).toHaveBeenCalledTimes(1); // (a write drops the entry; the first read fills it again)
    // another node rewrites the document behind this one's back
    await db.runWithTenant!(tenantDbName, async () => {
      const doc = await db.iamDocGet('iam_delegations', 'tok-3');
      await db.iamDocPut('iam_delegations', 'tok-3', { ...(doc?.data ?? {}), enabled: false });
    });
    expect((await getTokenDelegation(tenantDbName, 'tok-3'))?.config.enabled).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11_000);
      expect((await getTokenDelegation(tenantDbName, 'tok-3'))?.config.enabled).toBe(false);
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });

  it('reads nothing for a token that never had one, deletes once, and tells', async () => {
    expect(await getTokenDelegation(tenantDbName, 'tok-never')).toBeNull();
    await putTokenDelegation(tenantDbName, 'tok-4', config(), 'admin-1');
    expect(await deleteTokenDelegation(tenantDbName, 'tok-4')).toBe(true);
    expect(await getTokenDelegation(tenantDbName, 'tok-4')).toBeNull();
    expect(await deleteTokenDelegation(tenantDbName, 'tok-4')).toBe(false);
  });

  it('refuses to decide on a configuration whose secrets cannot be opened: it throws, it does not return half of it', async () => {
    await putTokenDelegation(tenantDbName, 'tok-broken', config(), 'admin-1');
    await db.runWithTenant!(tenantDbName, async () => {
      const doc = await db.iamDocGet('iam_delegations', 'tok-broken');
      await db.iamDocPut('iam_delegations', 'tok-broken', { ...(doc?.data ?? {}), hsSecretsSealed: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    });
    resetTokenDelegationCacheForTests();
    await expect(getTokenDelegation(tenantDbName, 'tok-broken')).rejects.toThrow();
  });

  it('is invisible to other workspaces', async () => {
    const slug = `deleg-other-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const other = `tenant_${slug}`;
    await db.createTenant({ companyName: 'Other', slug, dbName: other, licenseType: 'FREE', ownerId: 'pending' });
    await putTokenDelegation(tenantDbName, 'tok-shared-id', config(), 'admin-1');
    resetTokenDelegationCacheForTests();
    expect(await getTokenDelegation(other, 'tok-shared-id')).toBeNull();
  });
});

describe('what a read of a pristine workspace costs (SQLite)', () => {
  it('creates no table: the first write does', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'deleg-lazy-'));
    const provider = new SQLiteProvider(dir, 'lazy_main');
    await provider.connect();
    try {
      hoisted.getDatabase.mockImplementation(async () => provider);
      const tenant = await provider.createTenant({ companyName: 'Lazy', slug: 'lazy-1', dbName: 'tenant_lazy', licenseType: 'FREE', ownerId: 'pending' });
      void tenant;
      resetTokenDelegationCacheForTests();
      const tables = () =>
        ((provider as unknown as { getTenantDb(): { prepare(s: string): { all(): Array<{ name: string }> } } })
          .getTenantDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'iam_%'").all()).map((row) => row.name);
      await provider.runWithTenant!('tenant_lazy', async () => {
        expect(await getTokenDelegation('tenant_lazy', 'tok-x')).toBeNull();
        expect(await deleteTokenDelegation('tenant_lazy', 'tok-x')).toBe(false);
        expect(tables()).not.toContain('iam_delegations');
        await putTokenDelegation('tenant_lazy', 'tok-x', config(), 'admin-1');
        expect(tables()).toContain('iam_delegations');
      });
    } finally {
      await provider.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseDelegationInput', () => {
  const body = (patch: Record<string, unknown> = {}) => ({
    enabled: true,
    trust: { issuer: ISSUER, audience: 'console', algorithms: ['HS256'], keys: { hsSecrets: [{ kid: 'k1', secret: SECRET }] } },
    mapping: { matchBy: ['externalId'], jit: 'none' },
    ...patch,
  });
  const problemsOf = (input: unknown, existing: TokenDelegationConfig | null = null) => {
    const result = parseDelegationInput(input, existing);
    return result.ok ? [] : result.problems.map((p) => p.message);
  };

  it('turns a body into a configuration with the defaults filled in', () => {
    const result = parseDelegationInput(body(), null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({
      enabled: true,
      trust: { issuer: ISSUER, audience: 'console', algorithms: ['HS256'], keys: { hsSecrets: [{ kid: 'k1', secret: SECRET }] }, requireSingleUse: false },
      mapping: { matchBy: ['externalId'], jit: 'none' },
      allowPrivileged: false,
    });
    // enabled defaults to on, allowPrivileged to off; the audience keeps its shape; duplicates in the algorithms are one
    const b = body({ enabled: undefined, trust: { ...body().trust, audience: [' a ', 'b'], algorithms: ['HS256', 'HS256'] } });
    const again = parseDelegationInput(b, null);
    expect(again.ok && again.config).toMatchObject({ enabled: true, trust: { audience: ['a', 'b'], algorithms: ['HS256'] }, allowPrivileged: false });
  });

  it('refuses what cannot work, with a message per problem', () => {
    expect(problemsOf(null)).toEqual(['The request body must be an object']);
    expect(problemsOf(body({ trust: { ...body().trust, algorithms: ['none'] } }))).toEqual(expect.arrayContaining([expect.stringContaining('Algorithms must be among')]));
    expect(problemsOf(body({ allowPrivileged: 'yes' }))).toEqual(expect.arrayContaining(['allowPrivileged must be true or false']));
    expect(problemsOf(body({ trust: { ...body().trust, requireSingleUse: true } }))).toEqual(expect.arrayContaining([expect.stringContaining('cannot be single-use')]));
    expect(problemsOf(body({ unknown: 1 }))).toEqual(['Unknown setting "unknown"']);
  });

  it('keeps the stored secret of a key id the body names without one', () => {
    const existing = config({ trust: { ...config().trust, algorithms: ['HS256'], keys: { hsSecrets: [{ kid: 'k1', secret: SECRET }] } } });
    const kept = parseDelegationInput(body({ trust: { ...body().trust, keys: { hsSecrets: [{ kid: 'k1' }] } } }), existing);
    expect(kept.ok && kept.config.trust.keys.hsSecrets).toEqual([{ kid: 'k1', secret: SECRET }]);
    expect(problemsOf(body({ trust: { ...body().trust, keys: { hsSecrets: [{ kid: 'k9' }] } } }), existing))
      .toEqual(expect.arrayContaining([expect.stringContaining('key id "k9" must be provided')]));
    expect(problemsOf(body({ trust: { ...body().trust, keys: { hsSecrets: [{ kid: 'k1' }] } } }), null))
      .toEqual(expect.arrayContaining([expect.stringContaining('key id "k1" must be provided')]));
  });
});

describe('what leaves the module', () => {
  it('shows key ids, never secrets', () => {
    const view = toDelegationView({ tokenId: 't', config: config(), createdAt: 'c', updatedAt: 'u', updatedBy: 'a' });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view.trust.keys.hsSecrets).toEqual([{ kid: 'k1' }]);
    expect(view.trust.keys.pem).toContain('BEGIN PUBLIC KEY');
  });

  it('keeps an audit snapshot to the facts a review needs', () => {
    const snapshot = delegationAuditSnapshot(config());
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(JSON.stringify(snapshot)).not.toContain('BEGIN PUBLIC KEY');
    expect(snapshot).toMatchObject({
      enabled: true, issuer: ISSUER, algorithms: ['HS256', 'RS256'], keySources: ['secret', 'publicKey', 'keySet'],
      jwksUrl: 'https://idp.example.com/.well-known/jwks.json', maxTokenAgeSeconds: 900, matchBy: ['externalId', 'verifiedEmail'], jit: 'external', groupMapEntries: 1, allowPrivileged: false,
    });
    expect(delegationAuditSnapshot(null)).toBeNull();
  });
});
