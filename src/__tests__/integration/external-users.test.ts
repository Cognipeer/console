/**
 * External accounts and the identities they are found by, on BOTH SQLite and MongoDB.
 *
 *   storage    `kind: 'external'` and `externalIds` (issuer -> subject) round-trip; an issuer is a URL full of dots, which
 *              MongoDB field names cannot hold, so the provider encodes them - and nobody else ever sees the encoding
 *   lookup     an account is found again by (issuer, subject), oldest first, and never by email; a second subject
 *              for an issuer is a conflict, not an overwrite; hostile input cannot become a query operator
 *   scope      an external account stays out of the member lists, the pickers and the cross-workspace email directory,
 *              is counted on its own and listed on its own
 *   upgrade    a SQLite workspace that predates external accounts opens unchanged (no column, no table) and its rows read
 *              as members
 *   documents  SQLite keeps the kind and the identities in a small document per account (the users table has no column
 *              for them); only the accounts that need one have one, and it goes with the account
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

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

import type { DatabaseProvider, IUser } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { decodeIssuerKey, encodeIssuerKey } from '@/lib/database/provider/externalIds';
import { describeForEachProvider } from './db-parity.helper';

const ISSUER = 'https://idp.example.com/realms/acme';

describeForEachProvider('external accounts: storage and lookup', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  let tenantDbName: string;
  const run = <T,>(fn: () => Promise<T>): Promise<T> => db.runWithTenant!(tenantDbName, fn);

  const base = () => ({ tenantId, password: '!external-account', role: 'user' as const, licenseId: 'FREE', features: [] as string[] });
  const mkExternal = (name: string, externalIds: Record<string, string>, extra: Partial<IUser> = {}) =>
    db.createUser({ ...base(), email: extra.email ?? '', name, canLogin: false, kind: 'external', externalIds, ...extra });
  const mkMember = (email: string, name: string, extra: Partial<IUser> = {}) =>
    db.createUser({ ...base(), email, name, ...extra });

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    tenantDbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: 'External', slug, dbName: tenantDbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(row._id);
  });
  afterAll(() => {
    hoisted.getDatabase.mockReset();
  });
  beforeEach(async () => {
    await run(async () => {
      for (const user of await db.listUsers({ includeExternal: true })) await db.deleteUser(String(user._id));
    });
  });

  describe('storage', () => {
    it('round-trips kind and externalIds, issuers with dots, percent signs and dollars included', async () => {
      await run(async () => {
        const ids = {
          [ISSUER]: 'sub-1',
          'https://login.microsoftonline.com/9188040d/v2.0': 'oid-9',
          'weird%2Eissuer$with.dots': 'sub-3',
          '$leading-dollar': 'sub-4',
        };
        const created = await mkExternal('Vera', ids);
        expect(created).toMatchObject({ kind: 'external', externalIds: ids });

        const byId = await db.findUserById(String(created._id));
        expect(byId).toMatchObject({ kind: 'external', externalIds: ids });
        for (const [issuer, subject] of Object.entries(ids)) {
          const found = await db.findUsersByExternalIdentity(issuer, subject);
          expect(found.map((u) => String(u._id)), issuer).toEqual([String(created._id)]);
          expect(found[0].externalIds).toEqual(ids);
        }
        // no stored field name leaks out: the listings decode too
        const listed = (await db.listUsers({ includeExternal: true })).find((u) => String(u._id) === String(created._id));
        expect(listed?.externalIds).toEqual(ids);
        const viaDirectory = (await db.iamListUsers({ tenantId, external: true, limit: 10 })).items[0];
        expect(viaDirectory.externalIds).toEqual(ids);
      });
    });

    it('encodes issuer names reversibly', () => {
      for (const issuer of ['a.b', 'a%2Eb', '%', '$x', 'a\u0000b', 'https://x.example.com/a.b%24', '']) {
        expect(decodeIssuerKey(encodeIssuerKey(issuer)), JSON.stringify(issuer)).toBe(issuer);
      }
      expect(encodeIssuerKey('a.b$c%d')).not.toMatch(/[.$]/);
    });

    it('a member has no kind and no identities', async () => {
      await run(async () => {
        const member = await mkMember('plain@example.com', 'Plain');
        const read = await db.findUserById(String(member._id));
        expect(read?.kind).toBeUndefined();
        expect(read?.externalIds).toBeUndefined();
      });
    });

    it('updates replace the map as a whole, and an empty map clears it', async () => {
      await run(async () => {
        const created = await mkExternal('Mover', { [ISSUER]: 'old' });
        await db.updateUser(String(created._id), { externalIds: { [ISSUER]: 'new', 'https://other.example.com': 'x' } });
        expect(await db.findUsersByExternalIdentity(ISSUER, 'old')).toEqual([]);
        expect((await db.findUsersByExternalIdentity(ISSUER, 'new')).map((u) => String(u._id))).toEqual([String(created._id)]);
        expect((await db.findUserById(String(created._id)))?.externalIds).toEqual({ [ISSUER]: 'new', 'https://other.example.com': 'x' });

        await db.updateUser(String(created._id), { externalIds: {} });
        expect((await db.findUserById(String(created._id)))?.externalIds).toBeUndefined();
        expect(await db.findUsersByExternalIdentity(ISSUER, 'new')).toEqual([]);
        // still an external account
        expect((await db.findUserById(String(created._id)))?.kind).toBe('external');
      });
    });

    it('drops entries that are not usable instead of storing them', async () => {
      await run(async () => {
        const created = await mkExternal('Odd', { good: 'g', '': 'empty-issuer', bad1: '', bad2: 5 as never, bad3: { $gt: '' } as never });
        expect(created.externalIds).toEqual({ good: 'g' });
        expect((await db.findUserById(String(created._id)))?.externalIds).toEqual({ good: 'g' });
      });
    });
  });

  describe('lookup', () => {
    it('finds by issuer and subject, and by nothing else', async () => {
      await run(async () => {
        const a = await mkExternal('A', { [ISSUER]: 'abc' });
        expect((await db.findUsersByExternalIdentity(ISSUER, 'abc')).map((u) => String(u._id))).toEqual([String(a._id)]);
        expect(await db.findUsersByExternalIdentity(ISSUER, 'other')).toEqual([]);
        expect(await db.findUsersByExternalIdentity('https://elsewhere.example.com', 'abc')).toEqual([]);
        expect(await db.findUsersByExternalIdentity(`${ISSUER}/`, 'abc')).toEqual([]);
        expect(await db.findUsersByExternalIdentity(ISSUER.toUpperCase(), 'abc')).toEqual([]);
        expect(await db.findUsersByExternalIdentity('', 'abc')).toEqual([]);
        expect(await db.findUsersByExternalIdentity(ISSUER, '')).toEqual([]);
      });
    });

    it('treats operators, objects and oversized values as nothing, not as a query', async () => {
      await run(async () => {
        await mkExternal('Target', { [ISSUER]: 'abc' });
        const hostile: unknown[] = [{ $ne: null }, { $regex: '.*' }, ['abc'], 5, null, undefined, 'x'.repeat(600)];
        for (const subject of hostile) {
          expect(await db.findUsersByExternalIdentity(ISSUER, subject as never), JSON.stringify(subject)).toEqual([]);
        }
        for (const issuer of [{ $ne: null }, ['x'], 7, null, 'x'.repeat(600)]) {
          expect(await db.findUsersByExternalIdentity(issuer as never, 'abc')).toEqual([]);
        }
      });
    });

    it('lists the accounts that hold an identity oldest first, so a race has one deterministic winner', async () => {
      await run(async () => {
        const first = await mkExternal('First', { [ISSUER]: 'dup' });
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = await mkExternal('Second', { [ISSUER]: 'dup' });
        expect((await db.findUsersByExternalIdentity(ISSUER, 'dup')).map((u) => String(u._id))).toEqual([String(first._id), String(second._id)]);
      });
    });

    it('keeps issuers apart: the same subject at two issuers is two people', async () => {
      await run(async () => {
        const a = await mkExternal('A', { 'https://a.example.com': 'same' });
        const b = await mkExternal('B', { 'https://b.example.com': 'same' });
        expect((await db.findUsersByExternalIdentity('https://a.example.com', 'same')).map((u) => String(u._id))).toEqual([String(a._id)]);
        expect((await db.findUsersByExternalIdentity('https://b.example.com', 'same')).map((u) => String(u._id))).toEqual([String(b._id)]);
      });
    });

    it('a member can hold an identity too (linked by an administrator or by a verified address)', async () => {
      await run(async () => {
        const member = await mkMember('linked@example.com', 'Linked', { externalIds: { [ISSUER]: 'linked-1' } });
        expect((await db.findUsersByExternalIdentity(ISSUER, 'linked-1')).map((u) => String(u._id))).toEqual([String(member._id)]);
      });
    });
  });

  describe('linking', () => {
    it('writes once, then says already, and refuses a different subject for the same issuer', async () => {
      await run(async () => {
        const member = await mkMember('link@example.com', 'Link');
        const id = String(member._id);
        expect(await db.linkUserExternalIdentity(id, ISSUER, 'sub-1')).toBe('linked');
        expect(await db.linkUserExternalIdentity(id, ISSUER, 'sub-1')).toBe('already');
        expect(await db.linkUserExternalIdentity(id, ISSUER, 'sub-2')).toBe('conflict');
        // another issuer is another entry
        expect(await db.linkUserExternalIdentity(id, 'https://other.example.com', 'sub-9')).toBe('linked');
        expect((await db.findUserById(id))?.externalIds).toEqual({ [ISSUER]: 'sub-1', 'https://other.example.com': 'sub-9' });
        expect((await db.findUsersByExternalIdentity(ISSUER, 'sub-1')).map((u) => String(u._id))).toEqual([id]);
      });
    });

    it('does not touch what else the account has, and says not_found for nobody', async () => {
      await run(async () => {
        const member = await mkMember('keep@example.com', 'Keep', { role: 'admin' });
        await db.linkUserExternalIdentity(String(member._id), ISSUER, 'k');
        expect(await db.findUserById(String(member._id))).toMatchObject({ role: 'admin', name: 'Keep', email: 'keep@example.com' });
        expect(await db.linkUserExternalIdentity('0123456789abcdef01234567', ISSUER, 'x')).toBe('not_found');
        expect(await db.linkUserExternalIdentity('not-an-id', ISSUER, 'x')).toBe('not_found');
        expect(await db.linkUserExternalIdentity(String(member._id), '', 'x')).toBe('not_found');
      });
    });

    it('survives two links at once: exactly one writes', async () => {
      await run(async () => {
        const member = await mkMember('race@example.com', 'Race');
        const results = await Promise.all([
          db.linkUserExternalIdentity(String(member._id), ISSUER, 'one'),
          db.linkUserExternalIdentity(String(member._id), ISSUER, 'two'),
        ]);
        expect(results.filter((r) => r === 'linked')).toHaveLength(1);
        expect(results.filter((r) => r === 'conflict')).toHaveLength(1);
      });
    });
  });

  describe('scope', () => {
    it('is never found by email, whoever else holds the address, and stays out of the email directory', async () => {
      await run(async () => {
        const member = await mkMember('shared@example.com', 'Member');
        const external = await mkExternal('Twin', { [ISSUER]: 'twin' }, { email: 'shared@example.com' });
        expect(String((await db.findUserByEmail('shared@example.com'))?._id)).toBe(String(member._id));
        expect(String((await db.findUserByEmail('SHARED@example.com'))?._id)).toBe(String(member._id));
        // an address only an external account holds finds nobody
        await mkExternal('Lonely', { [ISSUER]: 'lonely' }, { email: 'lonely@host.example.com' });
        expect(await db.findUserByEmail('lonely@host.example.com')).toBeNull();
        expect(await db.findUserById(String(external._id))).toMatchObject({ email: 'shared@example.com', kind: 'external' });
      });
      expect(await db.listTenantsForUser('lonely@host.example.com')).toEqual([]);
    });

    it('stays out of listUsers unless asked for, and is counted on its own', async () => {
      await run(async () => {
        const member = await mkMember('m@example.com', 'M');
        const external = await mkExternal('E', { [ISSUER]: 'e' });
        const service = await mkMember('', 'Svc', { canLogin: false });
        expect((await db.listUsers()).map((u) => String(u._id)).sort()).toEqual([String(member._id), String(service._id)].sort());
        expect((await db.listUsers({ includeExternal: true })).map((u) => String(u._id))).toContain(String(external._id));
        expect(await db.countExternalUsers()).toBe(1);

        expect(await db.iamCountUsers({ tenantId, external: true })).toBe(1);
        expect(await db.iamCountUsers({ tenantId, external: false })).toBe(2);
        expect(await db.iamCountUsers({ tenantId })).toBe(3);
        expect((await db.iamListUsers({ tenantId, external: true, limit: 50 })).items.map((u) => String(u._id))).toEqual([String(external._id)]);
        expect((await db.iamListUsers({ tenantId, external: false, limit: 50 })).items.some((u) => u.kind === 'external')).toBe(false);
        expect((await db.iamListUsers({ tenantId, limit: 50 })).items).toHaveLength(3);

        await db.deleteUser(String(external._id));
        expect(await db.countExternalUsers()).toBe(0);
        expect(await db.findUsersByExternalIdentity(ISSUER, 'e')).toEqual([]);
      });
    });
  });
});

// ── a SQLite workspace that existed before external accounts ──────────────

describe('upgrading an existing SQLite workspace', () => {
  let tmpDir: string;
  let provider: SQLiteProvider;
  const MAIN = 'legacy_main';
  const TENANT = 'legacy_tenant';

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-external-users-'));
    // The users table of a release that predates accounts of kind external.
    const legacy = new Database(path.join(tmpDir, `${TENANT}.db`));
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, emailLower TEXT NOT NULL, password TEXT NOT NULL, name TEXT NOT NULL,
        tenantId TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', projectIds TEXT DEFAULT '[]', servicePermissions TEXT DEFAULT '{}',
        licenseId TEXT NOT NULL DEFAULT 'FREE', features TEXT DEFAULT '[]', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
    `);
    legacy.prepare(`
      INSERT INTO users (id, email, emailLower, password, name, tenantId, createdAt, updatedAt)
      VALUES ('old-1', 'Old@Example.com', 'old@example.com', 'x', 'Old Member', 't-old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();
    legacy.close();
  });
  afterAll(async () => {
    await provider?.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** What the workspace file holds: the columns of the users table and the IAM document tables. */
  const inspect = () => {
    const raw = new Database(path.join(tmpDir, `${TENANT}.db`), { readonly: true });
    try {
      return {
        columns: (raw.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name),
        iamTables: (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'iam_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name),
      };
    } finally {
      raw.close();
    }
  };

  it('adds no column and no table when the workspace is opened, reads the old rows as members, and creates the identity collection only for the first identity', async () => {
    provider = new SQLiteProvider(tmpDir, MAIN);
    await provider.connect();
    await provider.runWithTenant(TENANT, async () => {
      // storage stays additive: the kind and the external identities are not columns
      const opened = inspect();
      expect(opened.columns).not.toContain('kind');
      expect(opened.columns).not.toContain('externalIds');
      expect(opened.iamTables).toEqual([]);

      const old = await provider.findUserById('old-1');
      expect(old).toMatchObject({ name: 'Old Member' });
      expect(old?.kind).toBeUndefined();
      expect(old?.externalIds).toBeUndefined();
      expect((await provider.listUsers()).map((u) => u._id)).toEqual(['old-1']);
      expect((await provider.listUsers({ includeExternal: true })).map((u) => u._id)).toEqual(['old-1']);
      expect((await provider.findUserByEmail('old@example.com'))?._id).toBe('old-1');
      expect(await provider.countExternalUsers()).toBe(0);
      expect(await provider.findUsersByExternalIdentity(ISSUER, 'x')).toEqual([]);
      // none of the reads above created anything
      expect(inspect()).toEqual(opened);

      // the old row can be linked afterwards: the first identity creates the collection, still no column
      expect(await provider.linkUserExternalIdentity('old-1', ISSUER, 'late')).toBe('linked');
      expect(inspect()).toEqual({ columns: opened.columns, iamTables: ['iam_identities'] });
      expect((await provider.findUsersByExternalIdentity(ISSUER, 'late')).map((u) => u._id)).toEqual(['old-1']);
      expect((await provider.findUserById('old-1'))?.externalIds).toEqual({ [ISSUER]: 'late' });
      // a member that holds an identity is still a member
      expect((await provider.listUsers()).map((u) => u._id)).toEqual(['old-1']);
    });
  });
});

// ── SQLite: the identity document ─────────────────────────────────────────

describe('SQLite keeps the kind and the identities in the account\'s identity document', () => {
  let tmpDir: string;
  let provider: SQLiteProvider;
  const MAIN = 'doc_main';
  const TENANT = 'doc_tenant';
  const base = { tenantId: 't-doc', password: '!external-account', role: 'user' as const, licenseId: 'FREE', features: [] as string[] };

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-identity-docs-'));
    provider = new SQLiteProvider(tmpDir, MAIN);
    await provider.connect();
  });
  afterAll(async () => {
    await provider?.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** The documents of the collection, by account id (null while the collection does not exist), read through a second handle. */
  const documents = (): Record<string, unknown> | null => {
    const raw = new Database(path.join(tmpDir, `${TENANT}.db`), { readonly: true });
    try {
      const table = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='iam_identities'").get();
      if (!table) return null;
      return Object.fromEntries((raw.prepare('SELECT id, data FROM iam_identities').all() as Array<{ id: string; data: string }>).map((row) => [row.id, JSON.parse(row.data)]));
    } finally {
      raw.close();
    }
  };

  it('writes a document only for an account that needs one, changes it with the account and removes it with the account', async () => {
    await provider.runWithTenant(TENANT, async () => {
      const member = await provider.createUser({ ...base, email: 'plain@example.com', name: 'Plain' });
      expect(documents(), 'an ordinary member needs none, and nothing creates the table').toBeNull();

      const external = await provider.createUser({ ...base, email: '', name: 'Ext', canLogin: false, kind: 'external', externalIds: { [ISSUER]: 'e-1' } });
      expect(documents()).toEqual({ [String(external._id)]: { kind: 'external', externalIds: { [ISSUER]: 'e-1' } } });

      // linking a member gives it a document that holds the identity only; it stays a member
      expect(await provider.linkUserExternalIdentity(String(member._id), ISSUER, 'm-1')).toBe('linked');
      expect(documents()?.[String(member._id)]).toEqual({ externalIds: { [ISSUER]: 'm-1' } });
      expect((await provider.findUserById(String(member._id)))?.kind).toBeUndefined();
      expect((await provider.listUsers()).map((u) => String(u._id))).toEqual([String(member._id)]);
      expect((await provider.listUsers({ includeExternal: true })).map((u) => String(u._id)).sort()).toEqual([String(member._id), String(external._id)].sort());

      // the whole map is replaced, an empty one clears it; a document with nothing left is removed
      await provider.updateUser(String(member._id), { externalIds: { [ISSUER]: 'm-2', other: 'x' } });
      expect(documents()?.[String(member._id)]).toEqual({ externalIds: { [ISSUER]: 'm-2', other: 'x' } });
      await provider.updateUser(String(member._id), { externalIds: {} });
      expect(documents()?.[String(member._id)]).toBeUndefined();
      expect((await provider.findUserById(String(member._id)))?.externalIds).toBeUndefined();

      // kind and identities change independently; a null kind clears it
      await provider.updateUser(String(external._id), { name: 'Ext renamed' });
      expect(documents()?.[String(external._id)]).toEqual({ kind: 'external', externalIds: { [ISSUER]: 'e-1' } });
      await provider.updateUser(String(external._id), { kind: null as never });
      expect(documents()?.[String(external._id)]).toEqual({ externalIds: { [ISSUER]: 'e-1' } });
      expect((await provider.findUserById(String(external._id)))?.kind).toBeUndefined();
      await provider.updateUser(String(external._id), { kind: 'external' });
      expect(await provider.countExternalUsers()).toBe(1);

      // the document goes with the account
      expect(await provider.deleteUser(String(external._id))).toBe(true);
      expect(documents()).toEqual({});
      expect(await provider.countExternalUsers()).toBe(0);
      expect(await provider.findUsersByExternalIdentity(ISSUER, 'e-1')).toEqual([]);
    });
  });

  it('never finds, counts or lists an account by a document whose account is gone', async () => {
    await provider.runWithTenant(TENANT, async () => {
      const raw = new Database(path.join(tmpDir, `${TENANT}.db`));
      try {
        raw.prepare('INSERT INTO iam_identities (id, data, updatedAt) VALUES (?, ?, ?)')
          .run('ghost-account', JSON.stringify({ kind: 'external', externalIds: { [ISSUER]: 'ghost' } }), new Date().toISOString());
      } finally {
        raw.close();
      }
      expect(await provider.findUsersByExternalIdentity(ISSUER, 'ghost')).toEqual([]);
      expect(await provider.countExternalUsers()).toBe(0);
      // (what is left in the workspace is the ordinary member of the test above)
      expect((await provider.listUsers({ includeExternal: true })).every((user) => user.kind === undefined)).toBe(true);
    });
  });
});
