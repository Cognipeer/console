/**
 * switchToTenant inside a runWithTenant scope: the scope's handle serves every
 * query of that caller, so a switch to another tenant is refused (default) or,
 * with DB_TENANT_SCOPE_MISMATCH=warn, allowed and logged. Switching to the
 * scope's own tenant, nested runWithTenant scopes, and switches outside any
 * scope keep working.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getConfig, getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { MongoDBProviderBase } from '@/lib/database/mongodb/base';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';

const original = getConfigSource();
function use(overrides: Record<string, string> = {}) {
  setConfigSource({ get: (k: string) => overrides[k] ?? process.env[k] } as ConfigSource);
}
afterEach(() => setConfigSource(original));

/** Mirrors getTenantDatabase(): the switch happens after an await in a helper. */
async function switchViaHelper(db: { switchToTenant(name: string): Promise<void> }, name: string) {
  await Promise.resolve();
  await db.switchToTenant(name);
}

type Provider = {
  switchToTenant(name: string): Promise<void>;
  runWithTenant<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  getCurrentTenantDbName(): string | null;
};

function fakeMongoProvider(): Provider {
  const fakeDb = (name: string) => ({
    databaseName: name,
    listCollections: () => ({ toArray: async () => [] }),
    collection: () => ({ createIndex: async () => 'ok' }),
  });
  const provider = new MongoDBProviderBase('mongodb://unused', 'scope_main');
  (provider as unknown as { client: unknown }).client = { db: fakeDb };
  return provider;
}

let tmpDir = '';
let sqlite: SQLiteProvider;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-tenant-scope-'));
  sqlite = new SQLiteProvider(tmpDir, 'scope_main');
  await sqlite.connect();
});

afterAll(async () => {
  await sqlite.disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

const providers: Array<[string, () => Provider]> = [
  ['sqlite', () => sqlite as unknown as Provider],
  ['mongodb', fakeMongoProvider],
];

describe.each(providers)('tenant scope (%s)', (_label, make) => {
  it('refuses a switch to another tenant inside a scope by default', async () => {
    use();
    const db = make();
    await expect(
      db.runWithTenant('tenant_scope_a', () => switchViaHelper(db, 'tenant_scope_b')),
    ).rejects.toThrow(/runWithTenantScope\("tenant_scope_b"/);
  });

  it('allows a switch to the scope tenant itself', async () => {
    use();
    const db = make();
    const bound = await db.runWithTenant('tenant_scope_a', async () => {
      await switchViaHelper(db, 'tenant_scope_a');
      return db.getCurrentTenantDbName();
    });
    expect(bound).toBe('tenant_scope_a');
  });

  it('keeps the outer scope tenant after a nested scope for another tenant', async () => {
    use();
    const db = make();
    const seen = await db.runWithTenant('tenant_scope_a', async () => {
      const inner = await db.runWithTenant('tenant_scope_b', () => db.getCurrentTenantDbName());
      return [inner, db.getCurrentTenantDbName()];
    });
    expect(seen).toEqual(['tenant_scope_b', 'tenant_scope_a']);
  });

  it('allows switching between tenants outside any scope', async () => {
    use();
    const db = make();
    await db.switchToTenant('tenant_scope_a');
    await expect(db.switchToTenant('tenant_scope_b')).resolves.toBeUndefined();
  });

  it('with DB_TENANT_SCOPE_MISMATCH=warn the switch is allowed and the scope tenant keeps serving', async () => {
    use({ DB_TENANT_SCOPE_MISMATCH: 'warn' });
    const db = make();
    const bound = await db.runWithTenant('tenant_scope_a', async () => {
      await switchViaHelper(db, 'tenant_scope_b');
      return db.getCurrentTenantDbName();
    });
    expect(bound).toBe('tenant_scope_a');
  });
});

describe('DB_TENANT_SCOPE_MISMATCH config', () => {
  it('defaults to error and accepts warn', () => {
    use();
    expect(getConfig().database.tenantScopeMismatch).toBe('error');
    use({ DB_TENANT_SCOPE_MISMATCH: 'warn' });
    expect(getConfig().database.tenantScopeMismatch).toBe('warn');
    use({ DB_TENANT_SCOPE_MISMATCH: 'something-else' });
    expect(getConfig().database.tenantScopeMismatch).toBe('error');
  });
});
