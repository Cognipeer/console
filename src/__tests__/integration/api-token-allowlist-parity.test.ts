/**
 * API token restrictions in the REAL providers (SQLite and MongoDB run the same
 * contract): the allowlist and expiry round-trip, findApiTokenById is tenant
 * scoped, updateApiToken changes only what it is given, and a pre-existing
 * main database gains the column without touching its rows.
 */
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { isIpAllowed } from '@/lib/services/apiTokens/ipAllowlist';
import { describeForEachProvider } from './db-parity.helper';

const TENANT = 'tenant-restrictions';
let counter = 0;
const nextHash = () => `hash-${Date.now()}-${++counter}`;

describeForEachProvider('API token restrictions', (getDb) => {
  const mint = (extra: Record<string, unknown> = {}) =>
    getDb().createApiToken({
      userId: 'u1',
      tenantId: TENANT,
      projectId: 'p1',
      label: 'ci token',
      tokenHash: nextHash(),
      tokenPrefix: 'cpeer_abcdef',
      ...extra,
    } as never);

  it('round-trips an allowlist and an expiry through create, list and find-by-hash', async () => {
    const expiresAt = new Date(Date.now() + 30 * 86_400_000);
    const created = await mint({ allowedIpRanges: ['203.0.113.0/24', '2001:db8::/32'], expiresAt });

    const byHash = await getDb().findApiTokenByHash(created.tokenHash!);
    expect(byHash?.allowedIpRanges).toEqual(['203.0.113.0/24', '2001:db8::/32']);
    expect(byHash?.expiresAt?.getTime()).toBe(expiresAt.getTime());

    const listed = (await getDb().listProjectApiTokens(TENANT, 'p1')).find((t) => String(t._id) === String(created._id));
    expect(listed?.allowedIpRanges).toEqual(['203.0.113.0/24', '2001:db8::/32']);

    const byUser = (await getDb().listApiTokens('u1')).find((t) => String(t._id) === String(created._id));
    expect(byUser?.allowedIpRanges).toEqual(['203.0.113.0/24', '2001:db8::/32']);
  });

  it('a token minted without a list (or with an empty one) reads back unrestricted', async () => {
    const none = await mint();
    const empty = await mint({ allowedIpRanges: [] });
    const nulled = await mint({ allowedIpRanges: null });
    for (const token of [none, empty, nulled]) {
      const read = await getDb().findApiTokenById(String(token._id), TENANT);
      expect(read).not.toBeNull();
      expect(read?.allowedIpRanges ?? null).toBeNull();
      expect(isIpAllowed('198.51.100.7', read?.allowedIpRanges)).toBe(true);
    }
  });

  it('findApiTokenById is tenant scoped and treats malformed or unknown ids as "not found"', async () => {
    const created = await mint({ allowedIpRanges: ['10.0.0.0/8'] });
    expect((await getDb().findApiTokenById(String(created._id), TENANT))?.label).toBe('ci token');
    expect(await getDb().findApiTokenById(String(created._id), 'another-tenant')).toBeNull();
    expect(await getDb().findApiTokenById('not-an-id', TENANT)).toBeNull();
    expect(await getDb().findApiTokenById('', TENANT)).toBeNull();
    expect(await getDb().findApiTokenById('0123456789abcdef01234567', TENANT)).toBeNull();
  });

  it('updateApiToken changes only the keys it is given', async () => {
    const expiresAt = new Date(Date.now() + 10 * 86_400_000);
    const created = await mint({ allowedIpRanges: ['10.0.0.0/8'], expiresAt });
    const id = String(created._id);

    const renamed = await getDb().updateApiToken(id, TENANT, { label: 'renamed token' });
    expect(renamed).toMatchObject({ label: 'renamed token', allowedIpRanges: ['10.0.0.0/8'] });
    expect(renamed?.expiresAt?.getTime()).toBe(expiresAt.getTime());

    const widened = await getDb().updateApiToken(id, TENANT, { allowedIpRanges: ['10.0.0.0/8', '192.0.2.1/32'] });
    expect(widened?.allowedIpRanges).toEqual(['10.0.0.0/8', '192.0.2.1/32']);
    expect(widened?.label).toBe('renamed token');

    const later = new Date(Date.now() + 20 * 86_400_000);
    const extended = await getDb().updateApiToken(id, TENANT, { expiresAt: later });
    expect(extended?.expiresAt?.getTime()).toBe(later.getTime());
    expect(extended?.allowedIpRanges).toEqual(['10.0.0.0/8', '192.0.2.1/32']);
  });

  it('updateApiToken clears the allowlist and the expiry with null (or an empty list)', async () => {
    const created = await mint({ allowedIpRanges: ['10.0.0.0/8'], expiresAt: new Date(Date.now() + 86_400_000) });
    const id = String(created._id);
    const clearedRanges = await getDb().updateApiToken(id, TENANT, { allowedIpRanges: null });
    expect(clearedRanges?.allowedIpRanges ?? null).toBeNull();
    expect(clearedRanges?.expiresAt).toBeInstanceOf(Date);
    const clearedExpiry = await getDb().updateApiToken(id, TENANT, { expiresAt: null });
    expect(clearedExpiry?.expiresAt ?? null).toBeNull();

    const again = await getDb().updateApiToken(id, TENANT, { allowedIpRanges: ['10.0.0.0/8'] });
    expect(again?.allowedIpRanges).toEqual(['10.0.0.0/8']);
    const emptied = await getDb().updateApiToken(id, TENANT, { allowedIpRanges: [] });
    expect(emptied?.allowedIpRanges ?? null).toBeNull();
  });

  it('updateApiToken with nothing to change returns the token; an unknown or foreign token returns null', async () => {
    const created = await mint();
    const id = String(created._id);
    expect((await getDb().updateApiToken(id, TENANT, {}))?.label).toBe('ci token');
    expect(await getDb().updateApiToken(id, 'another-tenant', { label: 'hijacked' })).toBeNull();
    expect((await getDb().findApiTokenById(id, TENANT))?.label).toBe('ci token');
    expect(await getDb().updateApiToken('not-an-id', TENANT, { label: 'nope' })).toBeNull();
    expect(await getDb().updateApiToken('0123456789abcdef01234567', TENANT, { label: 'nope' })).toBeNull();
  });

  it('does not disturb the other token operations', async () => {
    const created = await mint({ allowedIpRanges: ['10.0.0.0/8'] });
    await getDb().updateTokenLastUsedByHash(created.tokenHash!);
    const read = await getDb().findApiTokenByHash(created.tokenHash!);
    expect(read?.lastUsed).toBeInstanceOf(Date);
    expect(read?.allowedIpRanges).toEqual(['10.0.0.0/8']);
    expect(await getDb().deleteProjectApiToken(String(created._id), TENANT, 'p1')).toBe(true);
    expect(await getDb().findApiTokenById(String(created._id), TENANT)).toBeNull();
  });
});

// ── a main database that existed before the column ──────────────────────────

describe('upgrading an existing SQLite main database', () => {
  let tmpDir: string;
  let provider: SQLiteProvider;
  const MAIN = 'legacy_main';

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-token-allowlist-'));
    // The api_tokens table of a release that predates scope, creator and allowlist.
    const legacy = new Database(path.join(tmpDir, `${MAIN}.db`));
    legacy.exec(`
      CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        tenantId TEXT NOT NULL,
        projectId TEXT,
        label TEXT NOT NULL,
        tokenHash TEXT NOT NULL UNIQUE,
        tokenPrefix TEXT NOT NULL,
        lastUsed TEXT,
        createdAt TEXT NOT NULL,
        expiresAt TEXT
      );
    `);
    legacy.prepare(`
      INSERT INTO api_tokens (id, userId, tenantId, projectId, label, tokenHash, tokenPrefix, createdAt)
      VALUES ('legacy-1', 'u-old', 'tenant-old', 'p-old', 'legacy token', 'legacy-hash', 'cpeer_legacy', '2026-01-01T00:00:00.000Z')
    `).run();
    legacy.close();
  });

  afterAll(async () => {
    await provider?.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds the column on connect and leaves the legacy row untouched and unrestricted', async () => {
    provider = new SQLiteProvider(tmpDir, MAIN);
    await provider.connect();

    const raw = new Database(path.join(tmpDir, `${MAIN}.db`), { readonly: true });
    const columns = (raw.prepare('PRAGMA table_info(api_tokens)').all() as Array<{ name: string }>).map((c) => c.name);
    raw.close();
    expect(columns).toContain('allowedIpRanges');

    const legacy = await provider.findApiTokenByHash('legacy-hash');
    expect(legacy).toMatchObject({ _id: 'legacy-1', userId: 'u-old', tenantId: 'tenant-old', label: 'legacy token' });
    expect(legacy?.allowedIpRanges ?? null).toBeNull();
    expect(isIpAllowed('198.51.100.7', legacy?.allowedIpRanges)).toBe(true);
  });

  it('connecting again is a no-op (the migration is idempotent)', async () => {
    await provider.disconnect();
    provider = new SQLiteProvider(tmpDir, MAIN);
    await expect(provider.connect()).resolves.not.toThrow();
    expect((await provider.findApiTokenByHash('legacy-hash'))?.label).toBe('legacy token');
  });

  it('the legacy row can be restricted afterwards', async () => {
    const updated = await provider.updateApiToken('legacy-1', 'tenant-old', { allowedIpRanges: ['10.0.0.0/8'] });
    expect(updated?.allowedIpRanges).toEqual(['10.0.0.0/8']);
    expect(isIpAllowed('198.51.100.7', updated?.allowedIpRanges)).toBe(false);
  });

  it('a damaged column value restricts instead of unlocking the token', async () => {
    const raw = new Database(path.join(tmpDir, `${MAIN}.db`));
    raw.prepare(`UPDATE api_tokens SET allowedIpRanges = 'garbage{' WHERE id = 'legacy-1'`).run();
    raw.close();
    const read = await provider.findApiTokenByHash('legacy-hash');
    expect(read?.allowedIpRanges).toEqual(['garbage{']);
    expect(isIpAllowed('10.0.0.1', read?.allowedIpRanges)).toBe(false);

    const rawAgain = new Database(path.join(tmpDir, `${MAIN}.db`));
    rawAgain.prepare(`UPDATE api_tokens SET allowedIpRanges = '"10.0.0.0/8"' WHERE id = 'legacy-1'`).run();
    rawAgain.close();
    const single = await provider.findApiTokenByHash('legacy-hash');
    expect(single?.allowedIpRanges).toEqual(['10.0.0.0/8']);
  });
});

describeForEachProvider('API token requireUserToken', (getDb) => {
  const mint = (extra: Record<string, unknown> = {}) =>
    getDb().createApiToken({
      userId: 'u1', tenantId: TENANT, projectId: 'p1', label: 'app token', tokenHash: nextHash(), tokenPrefix: 'cpeer_abcdef', ...extra,
    } as never);

  it('reads back as required only when it was set; every other token is optional', async () => {
    const required = await mint({ requireUserToken: true });
    const plain = await mint();
    const off = await mint({ requireUserToken: false });
    expect((await getDb().findApiTokenByHash(required.tokenHash!))?.requireUserToken).toBe(true);
    expect((await getDb().findApiTokenById(String(required._id), TENANT))?.requireUserToken).toBe(true);
    expect((await getDb().listProjectApiTokens(TENANT, 'p1')).find((t) => String(t._id) === String(required._id))?.requireUserToken).toBe(true);
    for (const token of [plain, off]) {
      expect((await getDb().findApiTokenById(String(token._id), TENANT))?.requireUserToken ?? false).toBe(false);
    }
  });

  it('updateApiToken switches it on and off and touches nothing else', async () => {
    const created = await mint({ allowedIpRanges: ['10.0.0.0/8'] });
    const on = await getDb().updateApiToken(String(created._id), TENANT, { requireUserToken: true });
    expect(on?.requireUserToken).toBe(true);
    expect(on?.allowedIpRanges).toEqual(['10.0.0.0/8']);
    const renamed = await getDb().updateApiToken(String(created._id), TENANT, { label: 'renamed' });
    expect(renamed?.requireUserToken).toBe(true);
    const off = await getDb().updateApiToken(String(created._id), TENANT, { requireUserToken: false });
    expect(off?.requireUserToken ?? false).toBe(false);
    expect(off?.label).toBe('renamed');
  });
});
