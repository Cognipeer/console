/**
 * Who an evaluation run reads a knowledge base as, from the route that starts it to the worker that executes it, at
 * the REAL routes, the REAL gate, the REAL access decision and a real SQLite provider. A run started through the client
 * API executes as its API token, never as the token's owner: in the request (`wait: true`), from the queue
 * (`wait: false`) and when the job is published again after a restart. A run started in the dashboard executes as the
 * person. Polling a run through a token shows what that token started, not what a person's run drew on.
 *
 * The knowledge base has access control on (without the admin exception) and two documents: one only its owner is
 * granted, and one open to everyone. Retrieval is stubbed at `queryRag` and hands on a document's passage only when the
 * real `resolveRagAccess` lets the caller it was given read the document, marking the work the way retrieval does.
 * The queue is a recorder: a test hands a published job to the real worker entry point.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  requireApiToken: vi.fn(),
  published: [] as Array<Record<string, unknown>>,
  callers: [] as unknown[],
  db: null as unknown,
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
vi.mock('@/lib/quota/serviceQuota', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/quota/serviceQuota')>()),
  enforceServiceQuota: vi.fn(async () => undefined),
}));
vi.mock('@/lib/core/queue', () => ({
  getQueue: async () => ({
    name: 'memory',
    publish: async (_queue: string, _job: string, payload: Record<string, unknown>) => {
      // What a queue hands its consumer: the payload as it serialises.
      hoisted.published.push(JSON.parse(JSON.stringify(payload)));
    },
  }),
}));
vi.mock('@/lib/services/rag/ragService', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { resolveRagAccess } = await import('@/lib/services/rag/access/scope');
  const { noteRestrictedDocuments } = await import('@/lib/services/rag/access/restricted');
  return {
    ...actual,
    queryRag: async (
      tenantDbName: string,
      tenantId: string,
      projectId: string | undefined,
      request: { ragModuleKey: string },
      options: { caller: import('@/lib/services/rag/access/caller').KbCaller },
    ) => {
      hoisted.callers.push(options.caller);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = hoisted.db as any;
      const ragModule = await db.runWithTenant(tenantDbName, () => db.findRagModuleByKey(request.ragModuleKey, projectId ?? ''));
      const documents = await db.runWithTenant(tenantDbName, () => db.listRagDocuments(request.ragModuleKey, { projectId }));
      const scope = await resolveRagAccess({ tenantDbName, tenantId, module: ragModule, caller: options.caller });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handedOn = (documents as any[]).filter((doc) => scope.canReadDocument(doc));
      await noteRestrictedDocuments({ tenantDbName, tenantId, module: ragModule, documents: handedOn });
      return {
        matches: handedOn.map((doc, index) => ({
          id: `chunk-${index}`,
          score: 0.9 - index * 0.1,
          content: doc.fileName === 'salaries.txt' ? SECRET : 'The office is closed on public holidays.',
          documentId: String(doc._id),
          fileName: doc.fileName,
          chunkIndex: 0,
        })),
        latencyMs: 1,
      };
    },
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
import { formatPrincipal } from '@/lib/services/rag/access/principals';
import { createDataset, createSuite, createTarget } from '@/lib/services/evaluation/service';
import { runSuiteJob, type EvaluationRunJobPayload } from '@/lib/services/evaluation/evaluationRunJob';
import { reconcileOrphanedEvaluationRuns } from '@/lib/services/evaluation/evaluationRunReconciler';
import { clientEvaluationsApiPlugin } from '@/server/api/plugins/client-evaluations';
import { evaluationsApiPlugin } from '@/server/api/plugins/evaluations';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const SECRET = 'Salary band E7 is 9,400 a month.';
const TOKEN_ID = 'tok-1';
const dbName = 'tenant_eval_run_caller';

let db: SQLiteProvider;
let tmpDir: string;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let tenantId: string;
let p1: string;
let owner: IUser;
let suiteKey: string;
let targetKey: string;
let datasetKey: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: { body: string }) => parseJsonBody<any>(res.body);
const ownerSession = () => ({
  'x-tenant-db-name': dbName,
  'x-tenant-id': tenantId,
  'x-tenant-slug': 'eval-run-caller',
  'x-user-id': String(owner._id),
  'x-user-role': String(owner.role),
  'x-user-email': String(owner.email),
  'x-license-type': 'FREE',
  cookie: `active_project_id=${p1}`,
});
const viaToken = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({
  method,
  url: `/api${url}`,
  headers: { authorization: 'Bearer tok', ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
});

/** The one job the last request published, as the worker receives it. */
function takePublished(): EvaluationRunJobPayload {
  expect(hoisted.published).toHaveLength(1);
  return hoisted.published.splice(0)[0] as unknown as EvaluationRunJobPayload;
}

/** The boot pass republishes runs created before it started: let the clock move past the ones just written. */
const clockMoves = () => new Promise((resolve) => setTimeout(resolve, 5));

const lastCaller = () => hoisted.callers[hoisted.callers.length - 1];
const storedRun = (id: string) => db.runWithTenant(dbName, () => db.findEvaluationRunById(id));
const outputsOf = async (id: string) => ((await storedRun(id))?.items ?? []).map((item) => item.output?.text ?? '');

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.published.length = 0;
  hoisted.callers.length = 0;
  tmpDir = mkdtempSync(path.join(tmpdir(), 'eval-run-caller-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.db = db;
  hoisted.getDatabase.mockResolvedValue(db);
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  resetProjectNarrowingCachesForTests();
  resetEnforceStatsForTests();
  resetResourceAuthzThrottleForTests();
  resetResourceAuthzStatsForTests();
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });

  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'eval-run-caller', dbName, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  p1 = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'x' }))._id);
  owner = await db.createUser({
    tenantId, email: 'owner@x.io', name: 'Owner', password: '$2b$10$x', role: 'owner', licenseId: 'FREE', features: [],
  } as never);
  const ownerId = String(owner._id);

  // Access control on, and no admin exception: each caller reads what it is granted, the owner included.
  await db.createRagModule({
    tenantId, projectId: p1, key: 'handbook', name: 'Handbook', embeddingModelKey: 'embed', vectorProviderKey: 'qdrant', vectorIndexKey: 'idx',
    chunkConfig: { strategy: 'recursive_character', chunkSize: 1000, chunkOverlap: 200 }, status: 'active', createdBy: ownerId,
    access: { enabled: true, adminBypass: false },
  } as never);
  const secret = await db.createRagDocument({
    tenantId, projectId: p1, ragModuleKey: 'handbook', fileName: 'salaries.txt', status: 'indexed', chunkCount: 1, aclMode: 'own', createdBy: ownerId,
  } as never);
  await db.replaceRagAclEntries('handbook', { type: 'document', id: String(secret._id) }, [
    { tenantId, projectId: p1, principal: formatPrincipal({ kind: 'user', id: ownerId })! },
  ], p1);
  await db.createRagDocument({
    tenantId, projectId: p1, ragModuleKey: 'handbook', fileName: 'holidays.txt', status: 'indexed', chunkCount: 1, createdBy: ownerId,
  } as never);

  const target = await createTarget(dbName, tenantId, ownerId, { name: 'Handbook retrieval', kind: 'rag', ragModuleKey: 'handbook', projectId: p1 });
  const dataset = await createDataset(dbName, tenantId, ownerId, {
    name: 'Pay questions',
    projectId: p1,
    items: [{ id: 'q1', input: [{ role: 'user', content: 'What are the salary bands?' }], expected: { mustContain: ['band'] } }],
  });
  targetKey = target.key;
  datasetKey = dataset.key;
  suiteKey = (await createSuite(dbName, tenantId, ownerId, {
    name: 'Pay suite', projectId: p1, targetKey, datasetKey, scorers: [{ type: 'assertion' }],
  })).key;

  hoisted.requireApiToken.mockResolvedValue({
    token: 'tok',
    tokenRecord: { _id: TOKEN_ID, userId: ownerId, servicePermissions: null },
    tenant: { licenseType: 'FREE' },
    tenantId,
    tenantSlug: 'eval-run-caller',
    tenantDbName: dbName,
    projectId: p1,
    user: owner,
  });

  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(evaluationsApiPlugin);
    await instance.register(clientEvaluationsApiPlugin);
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await drainPendingTasks();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('the setup', () => {
  it('lets the owner read the owner-only document: a run the owner starts in the dashboard hands it on', async () => {
    const started = await app.inject({ method: 'POST', url: `/api/evaluation/suites/${suiteKey}/run`, headers: ownerSession() });
    expect(started.statusCode, started.body).toBe(202);
    const job = takePublished();
    expect(job).toMatchObject({ actorType: 'user', createdBy: String(owner._id) });
    expect(job.apiTokenId).toBeUndefined();

    await runSuiteJob(job);

    expect(lastCaller()).toMatchObject({ kind: 'person', userId: String(owner._id) });
    expect((await outputsOf(job.runId)).join('\n')).toContain(SECRET);
    const run = await storedRun(job.runId);
    expect(run).toMatchObject({ status: 'completed', actorType: 'user' });
    expect(run?.items[0]?.kbRestricted).toEqual(expect.arrayContaining([expect.stringContaining('handbook')]));
  });
});

describe('a run started through the client API', () => {
  it('queued (wait: false): the job and the run carry the token, and the worker reads as the token', async () => {
    const started = await viaToken('POST', `/client/v1/evaluation/suites/${suiteKey}/run`, { wait: false });
    expect(started.statusCode, started.body).toBe(202);
    const job = takePublished();
    expect(job).toMatchObject({ actorType: 'api_token', apiTokenId: TOKEN_ID, createdBy: String(owner._id) });
    expect(await storedRun(job.runId)).toMatchObject({ status: 'pending', actorType: 'api_token', apiTokenId: TOKEN_ID });

    await runSuiteJob(job);

    expect(lastCaller()).toMatchObject({ kind: 'token', tokenId: TOKEN_ID });
    const outputs = (await outputsOf(job.runId)).join('\n');
    expect(outputs).not.toContain(SECRET);
    expect(outputs).toContain('public holidays');
    expect(await storedRun(job.runId)).toMatchObject({ status: 'completed' });
  });

  it('in the request (wait: true): reads as the token', async () => {
    const res = await viaToken('POST', `/client/v1/evaluation/suites/${suiteKey}/run`);
    expect(res.statusCode, res.body).toBe(201);
    expect(hoisted.published).toHaveLength(0);
    expect(lastCaller()).toMatchObject({ kind: 'token', tokenId: TOKEN_ID });
    expect(res.body).not.toContain(SECRET);
    expect(await storedRun(json(res).run.id)).toMatchObject({ actorType: 'api_token', apiTokenId: TOKEN_ID });
  });

  it('published again at boot (its job lost with the process): still reads as the token', async () => {
    const started = await viaToken('POST', `/client/v1/evaluation/suites/${suiteKey}/run`, { wait: false });
    expect(started.statusCode, started.body).toBe(202);
    const lost = takePublished();
    await clockMoves();

    const sweep = await reconcileOrphanedEvaluationRuns();
    expect(sweep.requeuedPending).toBe(1);
    const job = takePublished();
    expect(job).toMatchObject({ runId: lost.runId, actorType: 'api_token', apiTokenId: TOKEN_ID, createdBy: String(owner._id) });

    await runSuiteJob(job);

    expect(lastCaller()).toMatchObject({ kind: 'token', tokenId: TOKEN_ID });
    expect((await outputsOf(job.runId)).join('\n')).not.toContain(SECRET);
  });

  it('a job that names another caller than its run is failed, and nothing is read', async () => {
    const started = await viaToken('POST', `/client/v1/evaluation/suites/${suiteKey}/run`, { wait: false });
    expect(started.statusCode, started.body).toBe(202);
    const job = takePublished();
    const { apiTokenId: _dropped, ...withoutToken } = job;
    void _dropped;

    await expect(runSuiteJob({ ...withoutToken, actorType: 'user' })).rejects.toThrow(/does not name the caller/);

    expect(hoisted.callers).toHaveLength(0);
    expect(await storedRun(job.runId)).toMatchObject({ status: 'failed' });
  });
});

describe('a pending run that does not record who started it (queued before runs did)', () => {
  it('is failed by its worker after a restart, not run as the person it names', async () => {
    const legacy = await db.runWithTenant(dbName, () => db.createEvaluationRun({
      tenantId, projectId: p1, suiteKey, targetKey, datasetKey, status: 'pending', mode: 'async',
      progress: { total: 1, completed: 0, failed: 0 }, items: [], createdBy: String(owner._id),
    }));
    await clockMoves();

    await reconcileOrphanedEvaluationRuns();
    const job = takePublished();
    expect(job.runId).toBe(String(legacy._id));
    expect(job.actorType).toBeUndefined();

    await expect(runSuiteJob(job)).rejects.toThrow(/does not record who started it/);

    expect(hoisted.callers).toHaveLength(0);
    const run = await storedRun(String(legacy._id));
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/start the run again/);
  });
});

describe('polling a run through a token', () => {
  it('shows what a person\'s run drew on from a restricted document as restricted, without its output', async () => {
    await app.inject({ method: 'POST', url: `/api/evaluation/suites/${suiteKey}/run`, headers: ownerSession() });
    const job = takePublished();
    await runSuiteJob(job);

    const res = await viaToken('GET', `/client/v1/evaluation/runs/${job.runId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(json(res).run.items[0]).toMatchObject({ item_id: 'q1', restricted: true });
    expect(json(res).run.items[0].output_text).toBeUndefined();

    // The person who started it still reads it whole in the dashboard.
    const own = await app.inject({ method: 'GET', url: `/api/evaluation/runs/${job.runId}`, headers: ownerSession() });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.body).toContain(SECRET);
  });

  it('shows the token the runs it started', async () => {
    await viaToken('POST', `/client/v1/evaluation/suites/${suiteKey}/run`, { wait: false });
    const job = takePublished();
    await runSuiteJob(job);

    const res = await viaToken('GET', `/client/v1/evaluation/runs/${job.runId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res).run.items[0].restricted).toBeUndefined();
    expect(json(res).run.items[0].output_text).toContain('public holidays');
  });
});
