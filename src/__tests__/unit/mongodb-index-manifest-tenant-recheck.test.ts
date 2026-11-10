/**
 * Tenant index pass: collections that appear after the first bind of a tenant
 * DB (a first write creates them, or the tenant is created while the process
 * runs) get their manifest indexes on a later bind, without a restart.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';
import {
  ensureTenantDbIndexes,
  TENANT_DB_INDEXES,
  TENANT_INDEX_RECHECK_MS,
} from '@/lib/database/mongodb/indexManifest';

function fakeDb(initial: string[]) {
  const collections = new Set(initial);
  const createIndex = vi.fn(async (_key: unknown, options: { name?: string }) => options.name ?? 'unnamed');
  const created: Array<{ coll: string; name?: string }> = [];
  let listError: Error | null = null;
  const listCollections = vi.fn(() => ({
    toArray: async () => {
      if (listError) throw listError;
      return [...collections].map((name) => ({ name }));
    },
  }));
  const db = {
    databaseName: 'tenant_fake',
    listCollections,
    collection: (coll: string) => ({
      createIndex: (key: unknown, options: { name?: string }) => {
        created.push({ coll, name: options.name });
        return createIndex(key, options);
      },
    }),
  } as unknown as Db;
  return {
    db,
    listCollections,
    created,
    add: (name: string) => collections.add(name),
    failListing: (error: Error | null) => {
      listError = error;
    },
  };
}

let seq = 0;
const freshName = () => `tenant_recheck_${Date.now()}_${seq++}`;
const indexedCollections = (created: Array<{ coll: string }>) => [...new Set(created.map((c) => c.coll))].sort();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ensureTenantDbIndexes', () => {
  it('indexes only the manifest collections that exist on first bind', async () => {
    const fake = fakeDb(['users', 'audit_logs', 'not_in_manifest']);
    await ensureTenantDbIndexes(fake.db, freshName());
    expect(indexedCollections(fake.created)).toEqual(['audit_logs', 'users']);
    expect(fake.created.filter((c) => c.coll === 'users')).toHaveLength(TENANT_DB_INDEXES.users.length);
  });

  it('does not list collections again within the re-check interval', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const fake = fakeDb(['users']);
    const name = freshName();
    await ensureTenantDbIndexes(fake.db, name);
    now.mockReturnValue(1_000_000 + TENANT_INDEX_RECHECK_MS - 1);
    fake.add('audit_logs');
    await ensureTenantDbIndexes(fake.db, name);
    expect(fake.listCollections).toHaveBeenCalledTimes(1);
    expect(indexedCollections(fake.created)).toEqual(['users']);
  });

  it('indexes a collection created after the first bind once the interval has passed, leaving indexed ones alone', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    const fake = fakeDb(['users']);
    const name = freshName();
    await ensureTenantDbIndexes(fake.db, name);
    const usersCalls = fake.created.length;

    fake.add('audit_logs');
    now.mockReturnValue(2_000_000 + TENANT_INDEX_RECHECK_MS);
    await ensureTenantDbIndexes(fake.db, name);

    expect(fake.listCollections).toHaveBeenCalledTimes(2);
    const later = fake.created.slice(usersCalls);
    expect(indexedCollections(later)).toEqual(['audit_logs']);
    expect(later).toHaveLength(TENANT_DB_INDEXES.audit_logs.length);
  });

  it('stops re-checking once every manifest collection is indexed', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000_000);
    const fake = fakeDb(Object.keys(TENANT_DB_INDEXES));
    const name = freshName();
    await ensureTenantDbIndexes(fake.db, name);
    now.mockReturnValue(3_000_000 + 10 * TENANT_INDEX_RECHECK_MS);
    await ensureTenantDbIndexes(fake.db, name);
    expect(fake.listCollections).toHaveBeenCalledTimes(1);
  });

  it('retries on the next bind when the client is not connected yet', async () => {
    const fake = fakeDb(['users']);
    const name = freshName();
    fake.failListing(new Error('MongoNotConnectedError: client not connected'));
    await ensureTenantDbIndexes(fake.db, name);
    expect(fake.created).toHaveLength(0);

    fake.failListing(null);
    await ensureTenantDbIndexes(fake.db, name);
    expect(indexedCollections(fake.created)).toEqual(['users']);
  });

  it('runs one pass for concurrent first binds of the same tenant DB', async () => {
    const fake = fakeDb(['users']);
    const name = freshName();
    await Promise.all([ensureTenantDbIndexes(fake.db, name), ensureTenantDbIndexes(fake.db, name)]);
    expect(fake.listCollections).toHaveBeenCalledTimes(1);
  });
});

describe('index manifest: users', () => {
  const keysOf = () => (TENANT_DB_INDEXES.users ?? []).map((index) => JSON.stringify(index.key));

  it.each([
    [{ emailLower: 1 }],
    [{ email: 1 }],
    [{ authProvider: 1, externalId: 1 }],
    [{ 'externalIds.$**': 1 }],
    [{ kind: 1 }],
  ])('has %j for the sign-in and identity lookups', (key) => {
    expect(keysOf()).toContain(JSON.stringify(key));
  });

  it('has no partial or unique indexes (existing data may hold duplicates; Cosmos DB rejects partial ones)', () => {
    for (const entry of TENANT_DB_INDEXES.users) {
      expect(JSON.stringify(entry.options)).not.toMatch(/partialFilterExpression|unique/);
    }
  });
});
