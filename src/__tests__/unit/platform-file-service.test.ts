/**
 * The file service on a platform provider: a fake host names the one route (the real `local-filesystem` driver in a
 * temp folder) and core confines each tenant to its own root. Uploads, lists, downloads and deletes work as on any
 * provider, another tenant cannot reach the files, a `..` never leaves the root, and nothing says where files live.
 */
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as any,
  connection: null as any,
  plan: { mode: 'off', limits: null } as any,
}));

vi.mock('@/lib/core/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
vi.mock('@/lib/database', () => ({
  getDatabase: async () => h.db,
  // Same contract as the real helper: bind the tenant for the whole callback, on the one shared provider.
  runWithTenantScope: async (tenantDbName: string, fn: (db: unknown) => unknown) =>
    h.db.runWithTenant(tenantDbName, () => fn(h.db)),
}));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({ assertServiceEnabled: async () => undefined }));
vi.mock('@cognipeer/to-markdown', () => ({ convertToMarkdown: vi.fn() }));
vi.mock('@/lib/limits/tenantLimits', () => ({ resolveTenantPlan: async () => h.plan }));
vi.mock('@/lib/services/providers/providerService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/providers/providerService')>();
  const { ManagedProviderError } = await import('@/lib/services/providers/managedProviderErrors');
  const { isManagedProviderRecord } = await import('@/enterprise/managed-credits');
  const record = async (tenantDbName: string, tenantId: string, key: string) => {
    await h.db.switchToTenant(tenantDbName);
    return h.db.findProviderByKey(tenantId, key);
  };
  return {
    ...actual,
    getProviderConfigByKey: async (tenantDbName: string, tenantId: string, key: string) => {
      const found = await record(tenantDbName, tenantId, key);
      if (!found) return null;
      const { credentialsEnc, ...rest } = found;
      return { ...rest, platform: Boolean(found.platform), hasCredentials: Boolean(credentialsEnc) };
    },
    loadProviderRuntimeData: async (tenantDbName: string, ref: { tenantId: string; key: string }, options?: any) => {
      const found = await record(tenantDbName, ref.tenantId, ref.key);
      if (!found) throw new Error(`Provider configuration "${ref.key}" not found.`);
      if (!isManagedProviderRecord(found)) return { record: found, credentials: {} };
      if (!options?.managedConnectionId || !h.connection) throw new ManagedProviderError('This provider is not available right now.');
      return {
        record: found,
        credentials: {},
        managedConnection: { id: options.managedConnectionId, driver: h.connection.driver, settings: h.connection.settings },
      };
    },
  };
});

import { registerManagedCreditsHost, resetManagedCreditsHostForTests } from '@/enterprise/managed-credits';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { tenantStorageToken } from '@/lib/services/storage/managedStorage';
import {
  createFileBucket,
  deleteFile,
  downloadFile,
  listFiles,
  requireBucketContext,
  uploadFile,
} from '@/lib/services/files/fileService';
import { getFileBucketDetail, listFileProviderItems } from '@/lib/services/files/fileReads';

const PLATFORM_KEY = 'platform-files';
const S3_KEY = 'own-s3';
const PROJECT = 'proj-1';

interface TestTenant {
  id: string;
  dbName: string;
}

let root: string;
let backendDir: string;
let sqlite: SQLiteProvider;
let a: TestTenant;
let b: TestTenant;

/**
 * Runs a call the way a request of the tenant runs: bound to the tenant's database for the whole call. Both tenants
 * share one provider, and without the binding a query after an await uses whichever tenant was switched to last.
 */
const inTenant = <T>(t: TestTenant, call: () => Promise<T>): Promise<T> => sqlite.runWithTenant(t.dbName, call);

async function newTenant(name: string): Promise<TestTenant> {
  const slug = `${name}-${Math.random().toString(36).slice(2, 8)}`;
  const dbName = `tenant_${slug}`;
  const tenant = await sqlite.createTenant({ companyName: name, slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
  const base = { tenantId: String(tenant._id), projectIds: [PROJECT], type: 'file' as const, status: 'active' as const, credentialsEnc: '', createdBy: 'system' };
  await sqlite.runWithTenant(dbName, async () => {
    await sqlite.createProvider({ ...base, key: PLATFORM_KEY, driver: 'platform-virtual', label: 'Platform Files', platform: true, settings: {} });
    await sqlite.createProvider({ ...base, key: S3_KEY, driver: 'aws-s3-files', label: 'Own S3', settings: { bucket: 'tenant-bucket', region: 'eu-west-1' } });
  });
  return { id: String(tenant._id), dbName };
}

const bucket = (t: TestTenant, key = 'docs', extra: Record<string, unknown> = {}) =>
  inTenant(t, () => createFileBucket(t.dbName, t.id, PROJECT, { providerKey: PLATFORM_KEY, key, name: key, createdBy: 'u1', ...extra } as never));
const upload = (t: TestTenant, fileName = 'a.txt', text = 'hello', extra: Record<string, unknown> = {}) =>
  inTenant(t, () => uploadFile(t.dbName, t.id, PROJECT, {
    bucketKey: 'docs', fileName, contentType: 'text/plain', data: Buffer.from(text), createdBy: 'u1', convertToMarkdown: false, ...extra,
  }));

async function filesBelow(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(path.relative(dir, full));
    }
  };
  await walk(dir);
  return found.sort();
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'platform-files-'));
  backendDir = path.join(root, 'backend');
  sqlite = new SQLiteProvider(path.join(root, 'db'), 'platform_files_main');
  await sqlite.connect();
  h.db = sqlite;
  a = await newTenant('acme');
  b = await newTenant('beta');
});

afterAll(async () => {
  await sqlite.disconnect();
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  h.connection = { driver: 'local-filesystem', settings: { basePath: backendDir } };
  h.plan = { mode: 'off', limits: null };
  registerManagedCreditsHost({
    isManagedProvider: (ref) => ref?.key === PLATFORM_KEY || ref?.platform === true,
    reserve: async () => { throw new Error('storage is never reserved'); },
    listRoutes: (query) => (query.providerKey === PLATFORM_KEY && query.kind === 'file'
      ? [{ id: 'route-1', connectionId: 'conn-1', driver: 'local-filesystem' }]
      : []),
    resolveConnection: () => null,
  });
  return () => resetManagedCreditsHostForTests();
});

describe('a platform file provider: buckets, uploads, lists, downloads and deletes', () => {
  it('works unchanged and lands every object under the tenant root of the route', async () => {
    await bucket(a);
    const uploaded = await upload(a, 'a.txt', 'hello');
    expect(uploaded.record.size).toBe(5);

    const listed = await inTenant(a, () => listFiles(a.dbName, a.id, PROJECT, { bucketKey: 'docs' }));
    expect(listed.items.map((item) => item.name)).toEqual(['a.txt']);

    const downloaded = await inTenant(a, () => downloadFile(a.dbName, a.id, PROJECT, 'docs', uploaded.record.key));
    expect(Buffer.from(downloaded.data).toString()).toBe('hello');

    // Physically: <backend>/<tenant token>/<tenant id>/<provider key>/<bucket prefix>/<file>
    const token = tenantStorageToken(a.id);
    const rootDir = path.join(backendDir, token);
    const files = await filesBelow(rootDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file.startsWith(path.join(a.id, PLATFORM_KEY))).toBe(true);
    // Nothing outside the tenant's token folder.
    expect(await readdir(backendDir)).toEqual([token]);

    expect(await inTenant(a, () => deleteFile(a.dbName, a.id, PROJECT, 'docs', uploaded.record.key, 'u1'))).toBe(true);
    expect((await inTenant(a, () => listFiles(a.dbName, a.id, PROJECT, { bucketKey: 'docs' }))).items).toEqual([]);
    expect(await filesBelow(rootDir)).toEqual([]);
  });

  it('keeps another tenant out: its bucket sees none of the files and its objects are separate', async () => {
    await upload(a, 'private.txt', 'secret');
    await bucket(b);
    expect((await inTenant(b, () => listFiles(b.dbName, b.id, PROJECT, { bucketKey: 'docs' }))).items).toEqual([]);
    await expect(inTenant(b, () => downloadFile(b.dbName, b.id, PROJECT, 'docs', 'private.txt'))).rejects.toBeTruthy();

    // The provider listing of the other tenant's runtime holds nothing of the first tenant's.
    const ctxA = await inTenant(a, () => requireBucketContext(a.dbName, a.id, PROJECT, 'docs', 'read'));
    const ctxB = await inTenant(b, () => requireBucketContext(b.dbName, b.id, PROJECT, 'docs', 'read'));
    expect((await ctxA.runtime.listFiles({})).items.length).toBeGreaterThan(0);
    expect((await ctxB.runtime.listFiles({})).items).toEqual([]);

    await upload(b, 'private.txt', 'other');
    const tokenA = tenantStorageToken(a.id);
    const tokenB = tenantStorageToken(b.id);
    expect(tokenA).not.toBe(tokenB);
    const mine = await filesBelow(path.join(backendDir, tokenA));
    const theirs = await filesBelow(path.join(backendDir, tokenB));
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    const contents = async (token: string, files: string[]) => Promise.all(files.map((file) => readFile(path.join(backendDir, token, file), 'utf8')));
    expect(await contents(tokenA, mine)).toContain('secret');
    expect(await contents(tokenA, mine)).not.toContain('other');
    expect(await contents(tokenB, theirs)).toContain('other');
    expect(await contents(tokenB, theirs)).not.toContain('secret');
  });

  it('never lets a .. segment leave the root: a prefix with one is refused, a key with one is refused or neutralised', async () => {
    await expect(bucket(a, 'escape', { prefix: '../other' })).rejects.toBeTruthy();
    await expect(bucket(a, 'escape2', { prefix: 'ok/../../x' })).rejects.toBeTruthy();
    for (const attempt of [
      () => upload(a, 'x.txt', 'x', { keyHint: '../../outside.txt' }),
      () => upload(a, 'x.txt', 'x', { keyHint: 'a/../../outside.txt' }),
      () => upload(a, '../outside.txt', 'x'),
    ]) {
      const outcome = await attempt().then((result) => result, () => null);
      if (outcome) expect(outcome.record.key.split('/')).not.toContain('..');
    }
    // Whatever was stored is inside the tenant's token folder: nothing beside it, nothing above the backend root.
    expect(await readdir(backendDir)).toEqual(expect.arrayContaining([tenantStorageToken(a.id)]));
    for (const entry of await readdir(backendDir)) expect([tenantStorageToken(a.id), tenantStorageToken(b.id)]).toContain(entry);
    expect(await readdir(root)).toEqual(expect.arrayContaining(['backend', 'db']));
    expect((await readdir(root)).sort()).toEqual(['backend', 'db']);
    for (const file of await filesBelow(backendDir)) expect(file.split(path.sep)[0]).toMatch(/^t[0-9a-f]{16}$/);
  });
});

describe('where files live', () => {
  it('is not shown for a platform provider, and still is for the tenant\'s own', async () => {
    const providers = await inTenant(a, () => listFileProviderItems(a.dbName, a.id, PROJECT));
    const platform = providers.find((provider) => provider.key === PLATFORM_KEY)!;
    const own = providers.find((provider) => provider.key === S3_KEY)!;
    expect(platform.platform).toBe(true);
    expect(platform.storageLocationBase).toBeNull();
    expect(typeof own.storageLocationBase).toBe('string');
    expect(own.storageLocationBase).toContain('tenant-bucket');

    // Capabilities are the functional ones; nothing says the store is a disk, and the view holds no settings.
    expect(Object.keys(platform.driverCapabilities ?? {}).every((key) => ['supportsMarkdownConversion', 'supportsBulkListing'].includes(key))).toBe(true);
    expect(platform.settings).toEqual({});
    expect(JSON.stringify(platform)).not.toMatch(/local-filesystem|basePath|backend/i);
    expect(platform.providerHealth).toEqual({ state: 'builtin' });

    await bucket(a, 'where');
    const detail = await inTenant(a, () => getFileBucketDetail(a.dbName, a.id, PROJECT, 'where'));
    expect(detail.storageLocation).toBeNull();
    expect(detail.provider?.platform).toBe(true);
  });
});

describe('the plan storage on every upload', () => {
  const limitTo = (storageBytes: number) => {
    h.plan = { mode: 'on', limits: { concurrency: {}, monthly: {}, seats: {}, credits: {}, storageBytes } };
  };

  it('counts an overwrite by what it adds, and a delete frees the room at once', async () => {
    const t = await newTenant('quota');
    await bucket(t);
    limitTo(10);
    const first = await upload(t, 'f.txt', '12345678', { keyHint: 'f.txt' });
    // 8 stored: an overwrite of the same key with 9 bytes adds 1.
    await upload(t, 'f.txt', '123456789', { keyHint: 'f.txt' });
    await expect(upload(t, 'g.txt', '12345')).rejects.toMatchObject({ code: 'storage_quota_exceeded', status: 413 });
    await inTenant(t, () => deleteFile(t.dbName, t.id, PROJECT, 'docs', first.record.key, 'u1'));
    await expect(upload(t, 'g.txt', '12345')).resolves.toBeTruthy();
  });

  it('lets only as many parallel uploads pass as fit', async () => {
    const t = await newTenant('parallel');
    await bucket(t);
    limitTo(10);
    const outcomes = await Promise.allSettled([upload(t, 'a.txt', '123456'), upload(t, 'b.txt', '123456'), upload(t, 'c.txt', '123456')]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected')) {
      expect(outcome.reason).toMatchObject({ code: 'storage_quota_exceeded' });
    }
  });
});

describe('a platform provider the catalog no longer offers', () => {
  it('still reads and deletes through a cleanup-only route and a switched-off record, and refuses new writes', async () => {
    const c = await newTenant('gamma');
    await bucket(c);
    const kept = await upload(c, 'kept.txt', 'still here');
    const gone = await upload(c, 'gone.txt', 'remove me');
    await inTenant(c, async () => {
      const record = await sqlite.findProviderByKey(c.id, PLATFORM_KEY);
      await sqlite.updateProvider(String(record!._id), { status: 'disabled' });
    });
    registerManagedCreditsHost({
      isManagedProvider: (ref) => ref?.key === PLATFORM_KEY || ref?.platform === true,
      reserve: async () => { throw new Error('storage is never reserved'); },
      listRoutes: (query) => (query.providerKey === PLATFORM_KEY && query.kind === 'file'
        ? [{ id: 'route-1', connectionId: 'conn-1', driver: 'local-filesystem', settings: { cleanupOnly: true } }]
        : []),
      resolveConnection: () => null,
    });

    const downloaded = await inTenant(c, () => downloadFile(c.dbName, c.id, PROJECT, 'docs', kept.record.key));
    expect(Buffer.from(downloaded.data).toString()).toBe('still here');
    expect(await inTenant(c, () => deleteFile(c.dbName, c.id, PROJECT, 'docs', gone.record.key, 'u1'))).toBe(true);
    expect((await inTenant(c, () => listFiles(c.dbName, c.id, PROJECT, { bucketKey: 'docs' }))).items.map((item) => item.name)).toEqual(['kept.txt']);
    await expect(upload(c, 'new.txt', 'x')).rejects.toThrow('This provider is not available right now.');
    expect((await inTenant(c, () => listFiles(c.dbName, c.id, PROJECT, { bucketKey: 'docs' }))).items).toHaveLength(1);
  });
});

describe('a platform route that cannot serve', () => {
  it('refuses with the generic message when the host names no live route', async () => {
    await bucket(a, 'gone');
    registerManagedCreditsHost({
      isManagedProvider: (ref) => ref?.key === PLATFORM_KEY,
      reserve: async () => { throw new Error('never'); },
      listRoutes: () => [],
      resolveConnection: () => null,
    });
    await expect(upload(a, 'late.txt', 'x', { bucketKey: 'gone' })).rejects.toThrow('This provider is not available right now.');
  });
});
