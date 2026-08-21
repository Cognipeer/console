/**
 * HTTP-level tests for the LIVE Knowledge Engine dashboard plugin.
 *
 * Every other `rag-*` test in this directory drives `src/server/api/routes/**`,
 * which is an unmounted duplicate — none of them can fail on a change to the
 * Fastify plugin that actually serves traffic. This one injects into the plugin
 * itself, over real SQLite.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SQLite + tmp dir BEFORE getDatabase() is imported.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-rag-plugin-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'rag_plugin_main';

// ragService pulls in to-markdown, whose file-type CJS import trips vitest's
// ESM resolver.
vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: async (input: string | Buffer) =>
    (typeof input === 'string' ? input : input.toString('utf8')),
}));

// Bypass project context lookup — the resolver needs a fully provisioned
// user + UserProject row, which is more setup than this test needs.
const FAKE_PROJECT_ID = 'test-project-1';
const OTHER_PROJECT_ID = 'test-project-2';

/** Flipped per-test: owner/admin reach across projects, a member does not. */
let currentUserRole: 'owner' | 'admin' | 'member' = 'owner';

vi.mock('@/lib/services/projects/projectContext', () => ({
  ProjectContextError: class extends Error {
    status = 400;
  },
  resolveProjectContext: vi.fn(async (ctx: { tenantDbName: string; tenantId: string; userId: string }) => ({
    projectId: FAKE_PROJECT_ID,
    project: {
      _id: FAKE_PROJECT_ID,
      tenantId: ctx.tenantId,
      name: 'Test',
      key: 'test',
      status: 'active',
    },
    user: {
      _id: ctx.userId,
      tenantId: ctx.tenantId,
      email: 'tester@example.com',
      role: currentUserRole,
      status: 'active',
    },
    userProject: null,
  })),
  requireProjectContext: vi.fn(),
}));

// Bypass RBAC enforcement — the runtime path tries to load a real user.
vi.mock('@/lib/security/rbac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security/rbac')>('@/lib/security/rbac');
  return {
    ...actual,
    getPermissionServiceForPath: () => null,
  };
});

/**
 * The re-index service is stubbed: starting a real run enqueues a background
 * job that would embed documents. What these routes owe the caller is the
 * scoping and the status codes, and both are decided here.
 */
const reindexState: {
  runs: Array<{ key: string; ragModuleKey: string; status: string; reason?: string }>;
  startFails?: Error;
  cancelFails?: Error;
} = { runs: [] };

vi.mock('@/lib/services/rag/ragReindexService', () => ({
  startRagReindex: vi.fn(async (
    _tenantDbName: string,
    _tenantId: string,
    _projectId: string | undefined,
    request: { ragModuleKey: string; reason?: string },
  ) => {
    if (reindexState.startFails) throw reindexState.startFails;
    const run = {
      key: `run-${reindexState.runs.length + 1}`,
      ragModuleKey: request.ragModuleKey,
      status: 'queued',
      reason: request.reason,
    };
    reindexState.runs.unshift(run);
    return run;
  }),
  listRagReindexRuns: vi.fn(async (_tenantDbName: string, ragModuleKey?: string) =>
    reindexState.runs.filter((run) => !ragModuleKey || run.ragModuleKey === ragModuleKey)),
  getRagReindexRun: vi.fn(async (_tenantDbName: string, key: string) =>
    reindexState.runs.find((run) => run.key === key) ?? null),
  cancelRagReindex: vi.fn(async (_tenantDbName: string, key: string) => {
    if (reindexState.cancelFails) throw reindexState.cancelFails;
    const run = reindexState.runs.find((entry) => entry.key === key)!;
    run.status = 'cancelled';
    return run;
  }),
}));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import { ragApiPlugin } from '@/server/api/plugins/rag';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'rag_plugin_tenant';
const TENANT_ID = 'tenant-rag-1';
const USER_ID = 'user-rag-1';
const MODULE_KEY = 'plugin-test-module';

const REQUEST_HEADERS = {
  'x-tenant-db-name': TENANT_DB_NAME,
  'x-tenant-id': TENANT_ID,
  'x-tenant-slug': 'test',
  'x-user-id': USER_ID,
  'x-user-email': 'tester@example.com',
  'x-user-role': 'owner',
  'x-license-type': 'FREE',
};

const JSON_HEADERS = { ...REQUEST_HEADERS, 'content-type': 'application/json' };

/** Query text belonging to a same-key module in another project. */
const FOREIGN_PROJECT_QUERY = 'salary bands for the Berlin office';

const VALID_CHUNK_CONFIG = { strategy: 'recursive_character', chunkSize: 800, chunkOverlap: 100 };

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

function createModulePayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: 'Plugin Test Module',
    key: MODULE_KEY,
    embeddingModelKey: 'embed-model',
    vectorProviderKey: 'vec-provider',
    vectorIndexKey: 'vec-index',
    chunkConfig: VALID_CHUNK_CONFIG,
    ...overrides,
  });
}

beforeAll(async () => {
  reloadConfig();

  const db = await getDatabase();
  await db.createTenant({
    companyName: 'Rag Plugin Test',
    slug: 'rag-plugin-test',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: USER_ID,
  });
  await db.switchToTenant(TENANT_DB_NAME);

  app = await createFastifyApiTestApp(ragApiPlugin);
}, 30_000);

afterAll(async () => {
  await app.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('POST /api/rag/modules validates chunkConfig', () => {
  it('rejects an overlap at or above the chunk size, naming both numbers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/modules',
      headers: JSON_HEADERS,
      payload: createModulePayload({
        chunkConfig: { strategy: 'token', chunkSize: 512, chunkOverlap: 512 },
      }),
    });

    expect(res.statusCode).toBe(400);
    const { error } = parseJsonBody<{ error: string }>(res.body);
    expect(error).toContain('chunkOverlap');
    expect(error).toContain('512');
  });

  it('rejects an unknown strategy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/modules',
      headers: JSON_HEADERS,
      payload: createModulePayload({
        chunkConfig: { strategy: 'vibes', chunkSize: 800, chunkOverlap: 80 },
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toContain('strategy');
  });

  it('rejects a parent window smaller than the chunk it is meant to widen', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/modules',
      headers: JSON_HEADERS,
      payload: createModulePayload({
        chunkConfig: { ...VALID_CHUNK_CONFIG, parentWindowSize: 200 },
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toContain('parentWindowSize');
  });

  it('still reports the missing-field message when chunkConfig is absent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/modules',
      headers: JSON_HEADERS,
      payload: JSON.stringify({
        name: 'No chunk config',
        embeddingModelKey: 'embed-model',
        vectorProviderKey: 'vec-provider',
        vectorIndexKey: 'vec-index',
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toContain('chunkConfig are required');
  });

  it('creates the module with hybrid, isolateByModule and responseDetail', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/modules',
      headers: JSON_HEADERS,
      payload: createModulePayload({
        hybrid: { enabled: true, mode: 'weighted', alpha: 0.7 },
        isolateByModule: false,
        responseDetail: 'text',
      }),
    });

    expect(res.statusCode).toBe(201);
    const { module: ragModule } = parseJsonBody<{
      module: {
        key: string;
        hybrid?: { enabled: boolean; mode?: string; alpha?: number };
        isolateByModule?: boolean;
        responseDetail?: string;
      };
    }>(res.body);

    expect(ragModule.key).toBe(MODULE_KEY);
    expect(ragModule.hybrid).toMatchObject({ enabled: true, mode: 'weighted', alpha: 0.7 });
    expect(ragModule.isolateByModule).toBe(false);
    expect(ragModule.responseDetail).toBe('text');
  });

  it('rejects a hybrid weight outside 0..1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/modules',
      headers: JSON_HEADERS,
      payload: createModulePayload({ key: 'hybrid-reject', hybrid: { enabled: true, alpha: 4 } }),
    });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toContain('hybrid.alpha');
  });
});

describe('PATCH /api/rag/modules/{key} whitelists the body', () => {
  it('applies the known fields and ignores everything else', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/rag/modules/${MODULE_KEY}`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({
        name: 'Renamed Module',
        isolateByModule: true,
        // None of these may reach the record: they identify or account for it.
        tenantId: 'someone-elses-tenant',
        key: 'stolen-key',
        totalChunks: 999_999,
        createdBy: 'attacker',
      }),
    });

    expect(res.statusCode).toBe(200);
    const { module: ragModule } = parseJsonBody<{
      module: {
        key: string;
        name: string;
        tenantId: string;
        totalChunks?: number;
        createdBy: string;
        isolateByModule?: boolean;
      };
    }>(res.body);

    expect(ragModule.name).toBe('Renamed Module');
    expect(ragModule.isolateByModule).toBe(true);
    expect(ragModule.key).toBe(MODULE_KEY);
    expect(ragModule.tenantId).toBe(TENANT_ID);
    expect(ragModule.totalChunks).toBe(0);
    expect(ragModule.createdBy).toBe(USER_ID);
  });

  it('rejects an invalid chunkConfig with 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/rag/modules/${MODULE_KEY}`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({
        chunkConfig: { strategy: 'recursive_character', chunkSize: 100, chunkOverlap: 400 },
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toContain('chunkOverlap');
  });

  /**
   * The exact request the edit form sends for an emptied description: an
   * explicit `null`. It used to fail the whole PATCH with 400, so nothing on
   * the form saved — not the description, not the fields beside it.
   */
  it('clears the description when the edit form sends null', async () => {
    const seed = await app.inject({
      method: 'PATCH',
      url: `/api/rag/modules/${MODULE_KEY}`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ description: 'Support FAQ corpus' }),
    });
    expect(seed.statusCode).toBe(200);
    expect(parseJsonBody<{ module: { description?: string } }>(seed.body).module.description)
      .toBe('Support FAQ corpus');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/rag/modules/${MODULE_KEY}`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ name: 'Renamed Module', description: null }),
    });

    expect(res.statusCode).toBe(200);
    const { module: ragModule } = parseJsonBody<{
      module: { description?: string; name: string };
    }>(res.body);
    expect(ragModule.description ?? '').toBe('');
    // The rest of the form still had to save.
    expect(ragModule.name).toBe('Renamed Module');
  });

  it('rejects a null name — an identifying field has no cleared state', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/rag/modules/${MODULE_KEY}`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ name: null }),
    });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toContain('name');
  });

  it('rejects a responseDetail outside the enum', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/rag/modules/${MODULE_KEY}`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ responseDetail: 'summary' }),
    });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toContain('responseDetail');
  });
});

describe('POST /api/rag/modules/{key}/documents validates the per-document chunkConfig', () => {
  it('rejects it before any ingest work happens', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/rag/modules/${MODULE_KEY}/documents`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({
        fileName: 'faq.txt',
        content: 'hello',
        chunkConfig: { strategy: 'sentence', chunkSize: 300, chunkOverlap: 300 },
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toContain('chunkOverlap');
  });
});

describe('POST /api/rag/modules/{key}/answer', () => {
  it('refuses to synthesize an answer without a model to synthesize it with', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/rag/modules/${MODULE_KEY}/answer`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ question: 'where are the docs?' }),
    });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toContain('answerModelKey');
  });
});

describe('re-index routes', () => {
  it('starts a run, lists it, and cancels it', async () => {
    const startRes = await app.inject({
      method: 'POST',
      url: `/api/rag/modules/${MODULE_KEY}/reindex`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ reason: 'chunk-config' }),
    });
    expect(startRes.statusCode).toBe(201);
    const { run } = parseJsonBody<{ run: { key: string; status: string; reason?: string } }>(startRes.body);
    expect(run.key).toBeTruthy();
    expect(run.reason).toBe('chunk-config');

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/reindex`,
      headers: REQUEST_HEADERS,
    });
    expect(listRes.statusCode).toBe(200);
    const { runs } = parseJsonBody<{ runs: Array<{ key: string }> }>(listRes.body);
    expect(runs.map((entry) => entry.key)).toContain(run.key);

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/rag/modules/${MODULE_KEY}/reindex/${run.key}/cancel`,
      headers: REQUEST_HEADERS,
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(parseJsonBody<{ run: { status: string } }>(cancelRes.body).run.status).toBe('cancelled');
  });

  it('answers 409 when a run is already in flight', async () => {
    reindexState.startFails = new Error('A re-index is already running for this module.');
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/rag/modules/${MODULE_KEY}/reindex`,
        headers: JSON_HEADERS,
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(409);
      expect(parseJsonBody<{ error: string }>(res.body).error).toContain('already running');
    } finally {
      reindexState.startFails = undefined;
    }
  });

  it('rejects an unknown reason', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/rag/modules/${MODULE_KEY}/reindex`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ reason: 'because' }),
    });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toContain('reason');
  });

  it('404s a run key that belongs to another module', async () => {
    reindexState.runs.push({ key: 'foreign-run', ragModuleKey: 'someone-elses-module', status: 'running' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/rag/modules/${MODULE_KEY}/reindex/foreign-run/cancel`,
      headers: REQUEST_HEADERS,
    });

    expect(res.statusCode).toBe(404);
  });

  it('404s an unknown module', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/rag/modules/no-such-module/reindex',
      headers: REQUEST_HEADERS,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('zero-result insight routes', () => {
  beforeAll(async () => {
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);

    // A hit, a true content gap, and a query the score threshold emptied out.
    await db.createRagQueryLog({
      tenantId: TENANT_ID,
      projectId: FAKE_PROJECT_ID,
      ragModuleKey: MODULE_KEY,
      query: 'how do I reset my password',
      topK: 5,
      matchCount: 3,
      preFilterMatchCount: 5,
      topScore: 0.82,
      avgScore: 0.71,
      minScoreApplied: 0.5,
      latencyMs: 120,
    });
    await db.createRagQueryLog({
      tenantId: TENANT_ID,
      projectId: FAKE_PROJECT_ID,
      ragModuleKey: MODULE_KEY,
      query: 'what is the refund policy in Norway',
      topK: 5,
      matchCount: 0,
      preFilterMatchCount: 0,
      topScore: 0,
      latencyMs: 80,
    });
    await db.createRagQueryLog({
      tenantId: TENANT_ID,
      projectId: FAKE_PROJECT_ID,
      ragModuleKey: MODULE_KEY,
      query: 'sso saml metadata url',
      topK: 5,
      matchCount: 0,
      preFilterMatchCount: 4,
      topScore: 0.31,
      minScoreApplied: 0.5,
      latencyMs: 95,
    });

    // Same module key, different project. Keys are unique per project only, so
    // this row is what used to bleed into another project's counters, feed and
    // histogram — verbatim query text included.
    await db.createRagQueryLog({
      tenantId: TENANT_ID,
      projectId: OTHER_PROJECT_ID,
      ragModuleKey: MODULE_KEY,
      query: FOREIGN_PROJECT_QUERY,
      topK: 5,
      matchCount: 1,
      preFilterMatchCount: 1,
      topScore: 0.95,
      avgScore: 0.95,
      latencyMs: 40,
    });
  });

  it('GET /usage reports full-set totals alongside the log page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/usage?limit=1`,
      headers: REQUEST_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{
      logs: unknown[];
      total: number;
      avgLatencyMs: number;
      zeroMatchCount: number;
      minScoreFilteredCount: number;
    }>(res.body);

    // The page is capped; the counters are not.
    expect(body.logs).toHaveLength(1);
    expect(body.total).toBe(3);
    expect(body.zeroMatchCount).toBe(2);
    expect(body.minScoreFilteredCount).toBe(1);
  });

  it('GET /queries?zeroOnly=true returns only the queries that matched nothing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/queries?zeroOnly=true`,
      headers: REQUEST_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const { logs } = parseJsonBody<{ logs: Array<{ query: string; matchCount: number }> }>(res.body);
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      expect(log.matchCount).toBe(0);
    }
    expect(logs.map((log) => log.query)).toContain('what is the refund policy in Norway');
  });

  it('GET /queries without zeroOnly returns the whole feed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/queries`,
      headers: REQUEST_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ logs: unknown[] }>(res.body).logs).toHaveLength(3);
  });

  it('keeps a same-key module in another project out of the feed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/queries`,
      headers: REQUEST_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const { logs } = parseJsonBody<{ logs: Array<{ query: string }> }>(res.body);
    expect(logs.map((log) => log.query)).not.toContain(FOREIGN_PROJECT_QUERY);
  });

  it('GET /score-distribution buckets the best score per query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/score-distribution`,
      headers: REQUEST_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const { buckets } = parseJsonBody<{ buckets: Array<{ bucket: string; count: number }> }>(res.body);
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.reduce((sum, entry) => sum + entry.count, 0)).toBe(3);
  });

  it('404s the insight routes for an unknown module', async () => {
    const queriesRes = await app.inject({
      method: 'GET',
      url: '/api/rag/modules/no-such-module/queries',
      headers: REQUEST_HEADERS,
    });
    expect(queriesRes.statusCode).toBe(404);

    const scoreRes = await app.inject({
      method: 'GET',
      url: '/api/rag/modules/no-such-module/score-distribution',
      headers: REQUEST_HEADERS,
    });
    expect(scoreRes.statusCode).toBe(404);
  });
});

describe('document routes are project-scoped and never answer with the source text', () => {
  const SECRET_SOURCE = 'CONFIDENTIAL: the extracted markdown of the whole contract';
  let ownDocumentId = '';
  let otherModuleDocumentId = '';
  let otherProjectDocumentId = '';

  beforeAll(async () => {
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);

    const own = await db.createRagDocument({
      tenantId: TENANT_ID,
      projectId: FAKE_PROJECT_ID,
      ragModuleKey: MODULE_KEY,
      fileName: 'contract.pdf',
      status: 'indexed',
      chunkCount: 4,
      sourceText: SECRET_SOURCE,
      createdBy: USER_ID,
    });
    ownDocumentId = String(own._id);

    const otherModule = await db.createRagDocument({
      tenantId: TENANT_ID,
      projectId: FAKE_PROJECT_ID,
      ragModuleKey: 'a-different-module',
      fileName: 'elsewhere.pdf',
      status: 'indexed',
      createdBy: USER_ID,
    });
    otherModuleDocumentId = String(otherModule._id);

    const otherProject = await db.createRagDocument({
      tenantId: TENANT_ID,
      projectId: OTHER_PROJECT_ID,
      ragModuleKey: MODULE_KEY,
      fileName: 'their-contract.pdf',
      status: 'indexed',
      createdBy: 'someone-else',
    });
    otherProjectDocumentId = String(otherProject._id);
  });

  afterAll(() => {
    currentUserRole = 'owner';
  });

  it('returns the document without its stored source text', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/documents/${ownDocumentId}`,
      headers: REQUEST_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const { document } = parseJsonBody<{ document: Record<string, unknown> }>(res.body);
    expect(document.fileName).toBe('contract.pdf');
    expect(document).not.toHaveProperty('sourceText');
    expect(res.body).not.toContain(SECRET_SOURCE);
  });

  it('404s a document id that belongs to another module', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/documents/${otherModuleDocumentId}`,
      headers: REQUEST_HEADERS,
    });

    expect(res.statusCode).toBe(404);
  });

  it('404s another project\'s document for a member, and still serves it to an owner', async () => {
    currentUserRole = 'member';
    const memberRes = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/documents/${otherProjectDocumentId}`,
      headers: { ...REQUEST_HEADERS, 'x-user-role': 'member' },
    });
    expect(memberRes.statusCode).toBe(404);

    // Owners/admins keep the tenant-wide reach resolveProjectContext grants.
    currentUserRole = 'owner';
    const ownerRes = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/documents/${otherProjectDocumentId}`,
      headers: REQUEST_HEADERS,
    });
    expect(ownerRes.statusCode).toBe(200);
  });
});
