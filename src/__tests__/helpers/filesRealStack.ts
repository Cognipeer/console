/**
 * The Document Store's REAL write path for a test: the real `filesApiPlugin` over a real SQLite database and the real
 * local-disk driver, with the real queue (in memory) behind the background jobs.
 *
 * A test file mocks `@/lib/database` itself (its factory has to be hoisted into that file) so the plugin, the file
 * service and the job runners all read the one database this builds:
 *
 *   const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
 *   vi.mock('@/lib/database', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('@/lib/database')>()),
 *     getDatabase: hoisted.getDatabase,
 *     runWithTenantScope: async (_name: string, fn: (db: any) => unknown) => { const db = await hoisted.getDatabase(); return db.runWithTenant(_name, () => fn(db)); },
 *   }));
 *   vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
 *   ...
 *   const stack = await createFilesStack(hoisted.getDatabase);
 *
 * Objects sit where the local driver keeps them: `<dir>/<tenantId>/local/<bucket prefix>/<key>`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import type { Mock } from 'vitest';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { destroyQueue } from '@/lib/core/queue';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { IFileRecord } from '@/lib/database/provider.interface';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { resetResourceAuthzThrottleForTests } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { encryptObject } from '@/lib/utils/crypto';
import { filesApiPlugin } from '@/server/api/plugins/files';
import { createFastifyApiTestApp, parseJsonBody } from './fastify-api';

export const FILES_DB_NAME = 'tenant_files_writes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface FilesStack {
  db: SQLiteProvider;
  app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  dir: string;
  tenantId: string;
  projectId: string;
  userId: string;
  otherUserId: string;
  /** Sends a request as the signed-in member (or as `as`). */
  request: (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, as?: string) => Promise<LightMyRequestResponse>;
  /** Sends a request whose body is exactly this text (not necessarily JSON) as the signed-in member. */
  requestRaw: (method: 'POST' | 'PATCH', url: string, body: string) => Promise<LightMyRequestResponse>;
  /** The JSON of a response. */
  json: (res: { body: string }) => Json;
  /** Where the driver keeps an object. */
  objectPath: (bucketPrefix: string, key: string) => string;
  /** An object put straight into the provider, as another tool would: no record. */
  putObject: (bucketPrefix: string, key: string, content: string | Buffer) => string;
  /** Puts a folder where an object is, so that removing the object fails (the disk driver cannot delete a folder). */
  blockObject: (bucketPrefix: string, key: string) => string;
  /** A file of a bucket: its object (under the bucket key as prefix) and its record. */
  putFile: (bucketKey: string, key: string, content: string, over?: Partial<Omit<IFileRecord, '_id' | 'createdAt' | 'updatedAt'>>) => Promise<IFileRecord>;
  createBucket: (key: string, over?: Record<string, unknown>) => Promise<{ _id?: string | unknown; key: string }>;
  bucket: (key: string) => Promise<Awaited<ReturnType<SQLiteProvider['findFileBucketByKey']>>>;
  record: (bucketKey: string, key: string) => Promise<IFileRecord | null>;
  records: (bucketKey: string) => Promise<IFileRecord[]>;
  close: () => Promise<void>;
}

export async function createFilesStack(getDatabase: Mock): Promise<FilesStack> {
  const dir = mkdtempSync(path.join(tmpdir(), 'files-writes-'));
  const db = new SQLiteProvider(dir, 'test_main');
  await db.connect();
  getDatabase.mockResolvedValue(db);
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  resetProjectNarrowingCachesForTests();
  resetEnforceStatsForTests();
  resetResourceAuthzThrottleForTests();
  resetResourceAuthzStatsForTests();
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });

  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-files-writes', dbName: FILES_DB_NAME, licenseType: 'FREE', ownerId: 'owner-1' });
  const tenantId = String(tenant._id);
  await db.switchToTenant(FILES_DB_NAME);
  const projectId = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'x' }))._id);
  const member = async (email: string, name: string) => {
    const user = await db.createUser({ tenantId, email, name, password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [] });
    await db.upsertUserProject({ tenantId, userId: String(user._id), projectId, role: 'member' } as never);
    return String(user._id);
  };
  const userId = await member('member@x.io', 'A Member');
  const otherUserId = await member('other@x.io', 'Another Member');

  await db.createProvider({
    tenantId, projectId, key: 'local', type: 'file', driver: 'local-filesystem', label: 'Server disk', status: 'active',
    credentialsEnc: encryptObject({ marker: 'CREDENTIAL-MUST-NOT-LEAK' }), settings: { basePath: dir }, createdBy: 'x',
  });

  const app = await createFastifyApiTestApp(filesApiPlugin);
  await app.ready();

  const objectPath = (bucketPrefix: string, key: string) => path.join(dir, tenantId, 'local', ...bucketPrefix.split('/').filter(Boolean), ...key.split('/'));
  const putObject = (bucketPrefix: string, key: string, content: string | Buffer) => {
    const target = objectPath(bucketPrefix, key);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    return target;
  };

  const headersOf = (as: string) => ({
    'x-tenant-db-name': FILES_DB_NAME,
    'x-tenant-id': tenantId,
    'x-tenant-slug': 'files-writes',
    'x-user-id': as,
    'x-user-role': 'user',
    'x-user-email': 'member@x.io',
    'x-license-type': 'FREE',
    cookie: `active_project_id=${projectId}`,
  });

  return {
    db, app, dir, tenantId, projectId, userId, otherUserId,
    request: (method, url, payload, as = userId) => app.inject({
      method,
      url: `/api${url}`,
      headers: { ...headersOf(as), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    }),
    requestRaw: (method, url, body) => app.inject({
      method,
      url: `/api${url}`,
      headers: { ...headersOf(userId), 'content-type': 'application/json' },
      payload: body,
    }),
    json: (res) => parseJsonBody<Json>(res.body),
    objectPath,
    putObject,
    blockObject: (bucketPrefix, key) => {
      const target = objectPath(bucketPrefix, key);
      rmSync(target, { force: true, recursive: true });
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, 'inside.txt'), 'x');
      return target;
    },
    putFile: (bucketKey, key, content, over = {}) => {
      putObject(bucketKey, key, content);
      return db.createFileRecord({
        tenantId, projectId, providerKey: 'local', bucketKey, key, name: key.split('/').pop()!, size: Buffer.byteLength(content),
        contentType: 'text/plain', markdownStatus: 'skipped', createdBy: userId, ...over,
      });
    },
    createBucket: (key, over = {}) => db.createFileBucket({
      tenantId, projectId, key, name: key[0]!.toUpperCase() + key.slice(1), providerKey: 'local', status: 'active', createdBy: 'x', ...over,
    } as never),
    bucket: (key) => db.findFileBucketByKey(tenantId, key, projectId),
    record: (bucketKey, key) => db.findFileRecordByKey('local', bucketKey, key, projectId),
    records: async (bucketKey) => (await db.listFileRecords({ providerKey: 'local', bucketKey, projectId, limit: 200 })).items,
    close: async () => {
      await destroyQueue();
      await app.close();
      await drainPendingTasks();
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
