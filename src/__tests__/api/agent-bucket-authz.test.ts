/**
 * Where an agent keeps its session files is a Files decision about THAT bucket, taken by the policy
 * engine with the request's own principal (a person, or a token's owner within the token's scope):
 *
 *   `requestBucketOptions`   the picker lists the buckets the caller may look at (`file-bucket.get`), each
 *                            marked with whether they may name it (`file-bucket.update`)
 *   `requestCanNameBucket`   choosing or changing `attachments.bucketKey` needs `file-bucket.update`
 *   `requestHasFilesRead`    the picker itself needs read access to Files
 *
 * Real gate, real engine, real SQLite provider; probe routes stand in for the handlers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn(), requireApiToken: vi.fn(), engineDown: { value: false } }));

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
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;

    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: hoisted.requireApiToken };
});
vi.mock('@/lib/iam/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/engine')>();
  return {
    ...actual,
    authorize: (input: Parameters<typeof actual.authorize>[0]) => (hoisted.engineDown.value && input.action.startsWith('file-bucket.')
      ? Promise.resolve({ allowed: false, reasons: [], errors: ['the engine is down'], obligations: {}, durationUs: 0, failed: true } as Awaited<ReturnType<typeof actual.authorize>>)
      : actual.authorize(input)),
  };
});

import { drainPendingTasks } from '@/lib/core/asyncTask';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { resetResourceAuthzThrottleForTests } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { compileSpec } from '@/lib/iam/policySpec';
import { createPolicy } from '@/lib/iam/store';
import { authorizationRefusalOf, withApiRequestContext, withClientApiRequestContext } from '@/server/api/fastify-utils';
import { requestBucketOptions, requestCanNameBucket, requestHasFilesRead } from '@/server/api/plugins/files-permission';
import { listAttachmentBuckets } from '@/lib/services/agents/sessionFilesBucket';
import { encryptObject } from '@/lib/utils/crypto';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

let db: SQLiteProvider;
let tmpDir: string;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let tenantId: string;
let p1: string;
const dbName = 'tenant_bucket_authz';
const users = {} as Record<'admin' | 'writer' | 'reader' | 'nofiles', IUser>;
const buckets = {} as Record<'docs' | 'secret', { id: string; key: string }>;

const sessionHeaders = (who: keyof typeof users) => ({
  'x-tenant-db-name': dbName,
  'x-tenant-id': tenantId,
  'x-tenant-slug': 'bucket-authz',
  'x-user-id': String(users[who]._id),
  'x-user-role': String(users[who].role),
  'x-user-email': String(users[who].email),
  'x-license-type': 'FREE',
  cookie: `active_project_id=${p1}`,
});

async function tokenOf(who: keyof typeof users, scope: Record<string, string> | null = null) {
  const owner = (await db.findUserById(String(users[who]._id)))!;
  hoisted.requireApiToken.mockResolvedValue({
    token: 'tok',
    tokenRecord: { _id: 'tok-1', userId: String(owner._id), servicePermissions: scope },
    tenant: { licenseType: 'FREE' },
    tenantId,
    tenantSlug: 'bucket-authz',
    tenantDbName: dbName,
    projectId: p1,
    user: owner,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: { body: string }) => parseJsonBody<any>(res.body);
const asUser = (who: keyof typeof users, url: string) => app.inject({ method: 'GET', url: `/api${url}`, headers: sessionHeaders(who) });
const asToken = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer tok' } });

async function deny(action: 'file-bucket.get' | 'file-bucket.update', who: keyof typeof users, bucket?: keyof typeof buckets) {
  const compiled = await compileSpec({
    effect: 'forbid',
    principals: { users: [String(users[who]._id)] },
    actions: [action],
    resources: bucket ? { resources: [{ type: 'file-bucket', id: buckets[bucket].id }] } : { any: true },
  });
  expect(compiled.errors, JSON.stringify(compiled.errors)).toEqual([]);
  await createPolicy(dbName, { policyId: `deny-${action}-${who}-${bucket ?? 'all'}`, name: `${who} may not (${action})`, cedar: compiled.cedar, spec: compiled.spec }, 'tester');
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
}

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.engineDown.value = false;
  tmpDir = mkdtempSync(path.join(tmpdir(), 'bucket-authz-'));
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

  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-bucket-authz', dbName, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  p1 = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'x' }))._id);
  const mk = async (key: keyof typeof users, role: 'admin' | 'user', servicePermissions?: Record<string, string>) => {
    users[key] = await db.createUser({
      tenantId, email: `${key}@x.io`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...(servicePermissions ? { servicePermissions } : {}),
    } as never);
    await db.upsertUserProject({ tenantId, userId: String(users[key]._id), projectId: p1, role: 'member' } as never);
  };
  await mk('admin', 'admin');
  await mk('writer', 'user', { files: 'write', agents: 'write' });
  await mk('reader', 'user', { files: 'read', agents: 'write' });
  await mk('nofiles', 'user', { files: 'none', agents: 'write' });
  await db.createProvider({ tenantId, projectId: p1, key: 'local', type: 'file', driver: 'local-filesystem', label: 'Local', status: 'active', credentialsEnc: encryptObject({}), settings: {}, createdBy: 'x' });
  for (const key of ['docs', 'secret'] as const) {
    const bucket = await db.createFileBucket({ tenantId, projectId: p1, key, name: key, providerKey: 'local', status: 'active', createdBy: 'x' } as never);
    buckets[key] = { id: String(bucket._id), key };
  }

  app = await createFastifyApiTestApp(async (instance) => {
    instance.get('/agents/probe/read', withApiRequestContext(async (request, reply) => reply.send({ read: await requestHasFilesRead(request) })));
    instance.get('/agents/probe/options', withApiRequestContext(async (request, reply) => {
      const all = await listAttachmentBuckets(dbName, tenantId, p1);
      return reply.send({ buckets: (await requestBucketOptions(request, p1, all)).map((b) => ({ key: b.key, canChoose: b.canChoose })) });
    }));
    instance.get('/agents/probe/name/:key', withApiRequestContext(async (request, reply) => {
      try {
        return reply.send(await requestCanNameBucket(request, { tenantDbName: dbName, tenantId, projectId: p1 }, (request.params as { key: string }).key));
      } catch (error) {
        const refusal = authorizationRefusalOf(error);
        if (refusal) return reply.code(refusal.status).send(refusal);
        throw error;
      }
    }));
    instance.get('/client/v1/agents/probe/options', withClientApiRequestContext((async (request: any, reply: any) => {
      const all = await listAttachmentBuckets(dbName, tenantId, p1);
      return reply.send({ buckets: (await requestBucketOptions(request, p1, all)).map((b) => ({ key: b.key, canChoose: b.canChoose })) });
    }) as never));
    instance.get('/client/v1/agents/probe/name/:key', withClientApiRequestContext((async (request: any, reply: any) => (
      reply.send(await requestCanNameBucket(request, { tenantDbName: dbName, tenantId, projectId: p1 }, request.params.key))
    )) as never));
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await drainPendingTasks();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('who may look at Files at all', () => {
  it('follows the Files service level of the caller (and the token\'s scope)', async () => {
    expect(json(await asUser('admin', '/agents/probe/read')).read).toBe(true);
    expect(json(await asUser('reader', '/agents/probe/read')).read).toBe(true);
    expect(json(await asUser('nofiles', '/agents/probe/read')).read).toBe(false);
    await tokenOf('writer', { agents: 'write' }); // files is not in the token's scope
    expect(json(await asToken('/api/client/v1/agents/probe/options')).buckets).toEqual([]);
  });
});

describe('the buckets of the picker', () => {
  it('by default lists every bucket of the project, each choosable by someone with write access to Files', async () => {
    expect(json(await asUser('writer', '/agents/probe/options')).buckets).toEqual([
      { key: 'docs', canChoose: true }, { key: 'secret', canChoose: true },
    ]);
  });

  it('somebody with only Read on Files looks at the buckets but cannot name one', async () => {
    expect(json(await asUser('reader', '/agents/probe/options')).buckets).toEqual([
      { key: 'docs', canChoose: false }, { key: 'secret', canChoose: false },
    ]);
  });

  it('a rule about ONE bucket hides it from the picker (read) or marks it not choosable (write) - for that person only', async () => {
    await deny('file-bucket.get', 'writer', 'secret');
    expect(json(await asUser('writer', '/agents/probe/options')).buckets).toEqual([{ key: 'docs', canChoose: true }]);
    expect(json(await asUser('admin', '/agents/probe/options')).buckets.map((b: { key: string }) => b.key)).toEqual(['docs', 'secret']);

    await deny('file-bucket.update', 'admin', 'docs');
    expect(json(await asUser('admin', '/agents/probe/options')).buckets).toEqual([
      { key: 'docs', canChoose: false }, { key: 'secret', canChoose: true },
    ]);
  });

  it('a "no" shapes the list, it is not a refusal: nothing is audited', async () => {
    await deny('file-bucket.get', 'writer');
    expect(json(await asUser('writer', '/agents/probe/options')).buckets).toEqual([]);
    await drainPendingTasks();
    expect((await db.iamListAuditEvents({ tenantId, outcome: 'denied', limit: 5 })).items).toHaveLength(0);
  });

  it('is decided as the token\'s owner within the token\'s scope', async () => {
    await tokenOf('writer', { files: 'read', agents: 'write' });
    expect(json(await asToken('/api/client/v1/agents/probe/options')).buckets).toEqual([
      { key: 'docs', canChoose: false }, { key: 'secret', canChoose: false },
    ]);
    await tokenOf('writer');
    expect(json(await asToken('/api/client/v1/agents/probe/options')).buckets).toEqual([
      { key: 'docs', canChoose: true }, { key: 'secret', canChoose: true },
    ]);
  });
});

describe('naming a bucket in an agent\'s settings', () => {
  it('needs write access to that bucket: a writer may, a reader may not - the refusal has a decision id and an audit row', async () => {
    expect(json(await asUser('writer', '/agents/probe/name/docs'))).toEqual({ allowed: true });
    const refused = json(await asUser('reader', '/agents/probe/name/docs'));
    expect(refused).toMatchObject({ allowed: false, decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await drainPendingTasks();
    const [row] = (await db.iamListAuditEvents({ tenantId, outcome: 'denied', limit: 5 })).items;
    expect(row).toMatchObject({
      service: 'files', action: 'write', event: 'file-bucket.update', resourceType: 'file-bucket', resourceId: buckets.docs.id,
      metadata: expect.objectContaining({ decisionId: refused.decisionId, resourceName: 'docs', contextProjectId: p1 }),
    });
  });

  it('a rule about one bucket stops that bucket only, and a deny names the policy', async () => {
    await deny('file-bucket.update', 'writer', 'secret');
    expect(json(await asUser('writer', '/agents/probe/name/docs'))).toEqual({ allowed: true });
    const refused = json(await asUser('writer', '/agents/probe/name/secret'));
    expect(refused.allowed).toBe(false);
  });

  it('a key that names no bucket of the project is not this question\'s business', async () => {
    expect(json(await asUser('reader', '/agents/probe/name/does-not-exist'))).toEqual({ allowed: true });
  });

  it('a token is capped by its scope: Files read only cannot name', async () => {
    await tokenOf('writer', { files: 'read', agents: 'write' });
    expect(json(await asToken('/api/client/v1/agents/probe/name/docs')).allowed).toBe(false);
    await tokenOf('writer');
    expect(json(await asToken('/api/client/v1/agents/probe/name/docs'))).toEqual({ allowed: true });
  });

  it('fails closed: an engine that cannot decide is the 503, never an allow', async () => {
    hoisted.engineDown.value = true;
    const down = await asUser('writer', '/agents/probe/name/docs');
    expect(down.statusCode).toBe(503);
    expect(json(down)).toMatchObject({ status: 503, decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });
});

describe('the denials feed words a refusal about a bucket', () => {
  it('names the bucket and the policy that stopped the person', async () => {
    await deny('file-bucket.update', 'reader', 'docs');
    // (reader has only Read, so the rule is not what refuses first: the managed Write permit is absent - a default deny)
    expect(json(await asUser('reader', '/agents/probe/name/docs')).allowed).toBe(false);
    await drainPendingTasks();
    const { listAuditFeed } = await import('@/lib/iam/auditFeed');
    const feed = await listAuditFeed({ tenantId, tenantDbName: dbName }, { kind: 'denials', limit: 10, offset: 0 });
    const item = feed.items.find((i) => i.action === 'file-bucket.update');
    expect(item).toBeDefined();
    expect(item!.summary).toMatch(/choosing bucket "docs" for an agent's files/);
    expect(item!.text?.key).toMatch(/^denied\.bucketName/);
  });
});
