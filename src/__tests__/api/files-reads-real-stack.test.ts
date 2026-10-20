/**
 * The Document Store's read routes through the REAL plugin over a real SQLite database and the real local-disk
 * driver: what the screens call to draw the bucket list, a bucket's page, the provider list, the upload dialog and
 * the file table (type filter, preview). The route tests pin each decision with mocks; this proves the routes hand
 * the services the right arguments and send back what they computed - and that a switched-off bucket stays
 * readable end to end while every write to it is refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

import { drainPendingTasks } from '@/lib/core/asyncTask';
import { encryptObject } from '@/lib/utils/crypto';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { resetResourceAuthzThrottleForTests } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { filesApiPlugin } from '@/server/api/plugins/files';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const DB_NAME = 'tenant_files_reads';
const SECRET = encryptObject({ marker: 'CREDENTIAL-MUST-NOT-LEAK' });

let db: SQLiteProvider;
let tmpDir: string;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let tenantId: string;
let projectId: string;
let userId: string;
let bucketId: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: { body: string }) => parseJsonBody<any>(res.body);
const get = (url: string) => app.inject({
  method: 'GET',
  url: `/api${url}`,
  headers: {
    'x-tenant-db-name': DB_NAME,
    'x-tenant-id': tenantId,
    'x-tenant-slug': 'files-reads',
    'x-user-id': userId,
    'x-user-role': 'user',
    'x-user-email': 'member@x.io',
    'x-license-type': 'FREE',
    cookie: `active_project_id=${projectId}`,
  },
});
const send = (method: 'POST' | 'DELETE' | 'PATCH', url: string, payload?: unknown) => app.inject({
  method,
  url: `/api${url}`,
  headers: {
    'x-tenant-db-name': DB_NAME,
    'x-tenant-id': tenantId,
    'x-tenant-slug': 'files-reads',
    'x-user-id': userId,
    'x-user-role': 'user',
    'x-user-email': 'member@x.io',
    'x-license-type': 'FREE',
    cookie: `active_project_id=${projectId}`,
    ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
  },
  ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
});

/** A file of the bucket: its record, and its bytes where the local disk driver keeps them. */
function putFile(key: string, content: string, contentType: string, over: Record<string, unknown> = {}) {
  const stored = path.join(tmpDir, tenantId, 'local', 'docs', ...key.split('/'));
  mkdirSync(path.dirname(stored), { recursive: true });
  writeFileSync(stored, content);
  return db.createFileRecord({
    tenantId, projectId, providerKey: 'local', bucketKey: 'docs', key, name: key.split('/').pop()!,
    size: content.length, contentType, markdownStatus: 'skipped', createdBy: userId, ...over,
  } as never);
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'files-reads-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  resetProjectNarrowingCachesForTests();
  resetEnforceStatsForTests();
  resetResourceAuthzThrottleForTests();
  resetResourceAuthzStatsForTests();
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });

  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-files-reads', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(DB_NAME);
  projectId = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'x' }))._id);
  const user = await db.createUser({ tenantId, email: 'member@x.io', name: 'A Member', password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [] });
  userId = String(user._id);
  await db.upsertUserProject({ tenantId, userId, projectId, role: 'member' } as never);

  await db.createProvider({ tenantId, projectId, key: 'local', type: 'file', driver: 'local-filesystem', label: 'Server disk', status: 'active', credentialsEnc: SECRET, settings: { basePath: tmpDir }, createdBy: 'x' });
  await db.createProvider({ tenantId, projectId, key: 'grid', type: 'file', driver: 'mongodb-gridfs-files', label: 'GridFS', status: 'active', credentialsEnc: SECRET, settings: { bucketName: 'uploads' }, createdBy: 'x' });
  bucketId = String((await db.createFileBucket({ tenantId, projectId, key: 'docs', name: 'Documents', providerKey: 'local', status: 'active', createdBy: 'x' } as never))._id);
  await db.createFileBucket({ tenantId, projectId, key: 'empty', name: 'Empty one', providerKey: 'grid', status: 'active', prefix: 'e', createdBy: 'x' } as never);

  await db.createAgent({ tenantId, projectId, key: 'support', name: 'Support', config: { modelKey: 'm', attachments: { enabled: true, bucketKey: 'docs' } }, status: 'active', createdBy: 'x' } as never);

  app = await createFastifyApiTestApp(filesApiPlugin);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await drainPendingTasks();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /files/providers', () => {
  it('lists the providers with their health and the base of their storage location - and no credential', async () => {
    const res = await get('/files/providers');
    expect(res.statusCode).toBe(200);
    const byKey = Object.fromEntries((json(res).providers as Array<Record<string, any>>).map((provider) => [provider.key, provider])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(byKey.local).toMatchObject({ driver: 'local-filesystem', hasCredentials: true, providerHealth: { state: 'builtin' }, storageLocationBase: null });
    expect(byKey.grid).toMatchObject({ driver: 'mongodb-gridfs-files', providerHealth: { state: 'untested' }, storageLocationBase: `MongoDB GridFS · uploads/${tenantId}/grid/` });
    expect(res.body).not.toContain('credentialsEnc');
    expect(res.body).not.toContain(SECRET);
  });
});

describe('GET /files/buckets and /files/buckets/:bucketKey', () => {
  it('lists each bucket with its numbers and its provider\'s health', async () => {
    await putFile('a.txt', 'hello', 'text/plain');
    await putFile('b.pdf', '%PDF-1.4', 'application/pdf', { markdownStatus: 'succeeded', markdownKey: 'b.md', markdownSize: 20 });
    const res = await get('/files/buckets');
    expect(res.statusCode).toBe(200);
    const byKey = Object.fromEntries((json(res).buckets as Array<Record<string, any>>).map((bucket) => [bucket.key, bucket])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(Object.keys(byKey).sort()).toEqual(['docs', 'empty']);
    expect(byKey.docs).toMatchObject({
      id: bucketId, name: 'Documents', providerKey: 'local', status: 'active',
      stats: { fileCount: 2, totalBytes: 5 + 8 + 20 },
      providerHealth: { state: 'builtin' },
      provider: { key: 'local', label: 'Server disk' },
    });
    expect(byKey.empty).toMatchObject({ stats: { fileCount: 0, totalBytes: 0 }, providerHealth: { state: 'untested' } });
    expect(res.body).not.toContain('credentialsEnc');
  });

  it('gives a bucket\'s page: the same row, the agents that keep session files there, and where its files are', async () => {
    const res = await get('/files/buckets/docs');
    expect(res.statusCode).toBe(200);
    expect(json(res).bucket).toMatchObject({
      key: 'docs', status: 'active', stats: { fileCount: 0, totalBytes: 0 },
      usedBy: [{ agentId: expect.any(String), agentKey: 'support', name: 'Support' }],
      storageLocation: null,
    });
    const other = await get('/files/buckets/empty');
    expect(json(other).bucket).toMatchObject({ usedBy: [], storageLocation: `MongoDB GridFS · uploads/${tenantId}/grid/e/` });
  });

  it('answers a bucket that does not exist with 404', async () => {
    const res = await get('/files/buckets/nobody');
    expect(res.statusCode).toBe(404);
    expect(json(res)).toMatchObject({ code: 'bucket_not_found' });
  });
});

describe('GET /files/limits', () => {
  it('tells the upload dialog what an upload may be and how much of the project\'s room is used', async () => {
    await putFile('a.txt', 'hello', 'text/plain');
    await putFile('b.pdf', '%PDF-1.4', 'application/pdf', { markdownStatus: 'succeeded', markdownKey: 'b.md', markdownSize: 20 });
    const res = await get('/files/limits?bucketKey=docs');
    expect(res.statusCode).toBe(200);
    const limits = json(res);
    expect(limits.maxFileBytes).toBeGreaterThan(0);
    expect(limits.maxFileBytes).toBeLessThanOrEqual(limits.maxRequestBytes);
    expect(limits.allowedMimeTypes === null || Array.isArray(limits.allowedMimeTypes)).toBe(true);
    expect(limits.quota).toMatchObject({ usedBytes: 5 + 8 + 20, filesUsed: 2 });
    for (const bound of [limits.quota.limitBytes, limits.quota.filesLimit]) expect(bound === null || typeof bound === 'number').toBe(true);
  });

  it('works without a bucket, and answers an unknown bucket with 404', async () => {
    expect((await get('/files/limits')).statusCode).toBe(200);
    const missing = await get('/files/limits?bucketKey=nobody');
    expect(missing.statusCode).toBe(404);
    expect(json(missing)).toMatchObject({ code: 'bucket_not_found' });
  });
});

describe('GET /files/buckets/:bucketKey/objects with a type', () => {
  beforeEach(async () => {
    await putFile('report.pdf', '%PDF-1.4', 'application/pdf');
    await putFile('deep/photo.png', 'PNG', 'image/png');
    await putFile('notes.txt', 'hello', 'text/plain');
    await putFile('deck.pptx', 'PK', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    await putFile('data.zip', 'PK', 'application/zip');
  });

  const keysOf = async (query: string) => {
    const res = await get(`/files/buckets/docs/objects${query}`);
    expect(res.statusCode, query).toBe(200);
    return (json(res).items as Array<{ key: string }>).map((item) => item.key).sort();
  };

  it('lists the files of one kind, flat, wherever they are under the folder', async () => {
    expect(await keysOf('?type=pdf')).toEqual(['report.pdf']);
    expect(await keysOf('?type=image')).toEqual(['deep/photo.png']);
    expect(await keysOf('?type=text')).toEqual(['notes.txt']);
    expect(await keysOf('?type=office')).toEqual(['deck.pptx']);
    expect(await keysOf('?type=other')).toEqual(['data.zip']);
    const flat = json(await get('/files/buckets/docs/objects?type=image'));
    expect(flat).not.toHaveProperty('folders');
  });

  it('ignores a kind it does not know', async () => {
    expect(await keysOf('?type=bogus')).toEqual(['data.zip', 'deck.pptx', 'deep/photo.png', 'notes.txt', 'report.pdf']);
  });

  it('narrows a kind by the folder it is asked under', async () => {
    expect(await keysOf('?type=image&prefix=deep')).toEqual(['deep/photo.png']);
    expect(await keysOf('?type=image&prefix=other')).toEqual([]);
  });
});

describe('GET /files/buckets/:bucketKey/objects/* with preview', () => {
  beforeEach(async () => {
    await putFile('report.pdf', '%PDF-1.4', 'application/pdf');
    await putFile('notes.txt', 'hello', 'text/plain');
    await putFile('page.html', '<script>alert(1)</script>', 'text/html');
    await putFile('data.zip', 'PK', 'application/zip');
    await putFile('with-copy.pdf', '%PDF-1.4', 'application/pdf', { markdownStatus: 'succeeded', markdownKey: 'with-copy.md', markdownSize: 6, markdownContentType: 'text/markdown' });
    const copy = path.join(tmpDir, tenantId, 'local', 'docs', 'with-copy.md');
    writeFileSync(copy, '# Copy');
  });

  it('shows a safe type inline, in a sandbox, and as the type it is', async () => {
    const res = await get('/files/buckets/docs/objects/report.pdf?preview=1');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(String(res.headers['content-disposition'])).toMatch(/^inline;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.body).toBe('%PDF-1.4');
  });

  it('serves text as plain text, whatever it was uploaded as', async () => {
    const res = await get('/files/buckets/docs/objects/notes.txt?preview=1');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.body).toBe('hello');
  });

  it('refuses a type that could run in the page (HTML) or that no browser shows (a zip)', async () => {
    for (const key of ['page.html', 'data.zip']) {
      const res = await get(`/files/buckets/docs/objects/${key}?preview=1`);
      expect(res.statusCode, key).toBe(415);
      expect(json(res), key).toMatchObject({ code: 'preview_unsupported' });
    }
  });

  it('previews the Markdown copy as plain text', async () => {
    const res = await get('/files/buckets/docs/objects/with-copy.pdf?variant=markdown&preview=1');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.body).toBe('# Copy');
  });

  it('is still the record without a preview, and a download as before', async () => {
    const record = await get('/files/buckets/docs/objects/notes.txt');
    expect(record.statusCode).toBe(200);
    expect(json(record).record).toMatchObject({ key: 'notes.txt', contentType: 'text/plain' });
    const download = await get('/files/buckets/docs/objects/notes.txt?download=1');
    expect(download.statusCode).toBe(200);
    expect(String(download.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(download.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('a switched-off bucket', () => {
  beforeEach(async () => {
    await putFile('notes.txt', 'hello', 'text/plain');
    await db.updateFileBucket(bucketId, { status: 'disabled' });
  });

  it('stays readable: listed, opened, its files listed, shown and downloaded', async () => {
    const list = await get('/files/buckets');
    expect(list.statusCode).toBe(200);
    expect((json(list).buckets as Array<{ key: string; status: string; stats: { fileCount: number } }>).find((bucket) => bucket.key === 'docs'))
      .toMatchObject({ status: 'disabled', stats: { fileCount: 1 } });
    expect((await get('/files/buckets/docs')).statusCode).toBe(200);
    expect((await get('/files/buckets/docs/objects')).statusCode).toBe(200);
    expect((await get('/files/buckets/docs/objects/notes.txt')).statusCode).toBe(200);
    expect((await get('/files/buckets/docs/objects/notes.txt?preview=1')).body).toBe('hello');
    expect((await get('/files/buckets/docs/objects/notes.txt?download=1')).statusCode).toBe(200);
    expect((await get('/files/limits?bucketKey=docs')).statusCode).toBe(200);
  });

  it('takes nothing new and gives nothing up: upload and delete answer 409 bucket_inactive', async () => {
    const upload = await send('POST', '/files/buckets/docs/objects', { fileName: 'new.txt', data: Buffer.from('hi').toString('base64'), convertToMarkdown: false });
    expect(upload.statusCode).toBe(409);
    expect(json(upload)).toMatchObject({ code: 'bucket_inactive' });
    const removal = await send('DELETE', '/files/buckets/docs/objects/notes.txt');
    expect(removal.statusCode).toBe(409);
    expect(json(removal)).toMatchObject({ code: 'bucket_inactive' });
    // Nothing was written or removed.
    expect((await get('/files/buckets/docs/objects/notes.txt?download=1')).statusCode).toBe(200);
  });
});
