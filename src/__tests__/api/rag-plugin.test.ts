/**
 * HTTP-level tests for the LIVE Knowledge Engine dashboard plugin.
 *
 * Every other `rag-*` test in this directory drove the removed `src/server/api/routes/**`,
 * which is an unmounted duplicate — none of them can fail on a change to the
 * Fastify plugin that actually serves traffic. This one injects into the plugin
 * itself, over real SQLite.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

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

/** Flipped per-test: the caller's role (the active project decides for every role). */
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

/**
 * An imported document is indexed later by a queued job. Publishing it is
 * stubbed for the same reason: the test needs no queue, and can see the job.
 */
const ingestJobs = vi.hoisted(() => ({ publishRagIngestJob: vi.fn(async () => undefined) }));
vi.mock('@/lib/services/rag/ragIngestJob', () => ingestJobs);

/**
 * An OCR model reference is checked against the project's models at save time. The check itself is covered with the
 * engine's own tests; here a key is usable unless it starts with `missing-`.
 */
const ocrModels = vi.hoisted(() => ({
  validate: vi.fn(async (_scope: unknown, modelKey: string) =>
    (modelKey.startsWith('missing-') ? `The OCR model "${modelKey}" was not found in this project.` : undefined)),
  /** Set by a test to answer the extraction itself; otherwise the real engine runs. */
  extract: undefined as undefined | ((request: unknown) => Promise<unknown>),
}));
vi.mock('@/lib/services/extraction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/extraction')>();
  return {
    ...actual,
    validateOcrModelRef: ocrModels.validate,
    extractDocument: (request: Parameters<typeof actual.extractDocument>[0]) =>
      (ocrModels.extract ? ocrModels.extract(request) : actual.extractDocument(request)),
  };
});

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import { RAG_IMPORT_MAX_DOCUMENTS } from '@/lib/services/rag/ragTransfer';
import { ragApiPlugin } from '@/server/api/plugins/rag';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'rag_plugin_tenant';
const TENANT_ID = 'tenant-rag-1';
// The id of the workspace owner created in beforeAll: the authorization engine
// decides every request from the user row, so the caller has to exist.
let USER_ID = 'pending';
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
    ownerId: 'pending',
  });
  await db.switchToTenant(TENANT_DB_NAME);
  const owner = await db.createUser({
    tenantId: TENANT_ID,
    email: 'tester@example.com',
    name: 'Tester',
    password: '$2b$10$x',
    role: 'owner',
    licenseId: 'FREE',
    features: [],
  });
  USER_ID = String(owner._id);
  REQUEST_HEADERS['x-user-id'] = USER_ID;
  JSON_HEADERS['x-user-id'] = USER_ID;

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

describe('Knowledge Engine OCR settings (extraction) on the module routes', () => {
  const patchModule = (payload: Record<string, unknown>) => app.inject({
    method: 'PATCH', url: `/api/rag/modules/${MODULE_KEY}`, headers: JSON_HEADERS, payload: JSON.stringify(payload),
  });
  const extractionOf = (body: string) => parseJsonBody<{ module: { extraction?: unknown } }>(body).module.extraction;

  it('stores a validated, compact setting, and PATCH null clears it', async () => {
    const saved = await patchModule({ extraction: { ocr: { mode: 'auto', languages: ['TUR', 'en', 'tr'], maxPages: 50, modelKey: 'mistral-ocr' } } });
    expect(saved.statusCode).toBe(200);
    expect(extractionOf(saved.body)).toEqual({ ocr: { mode: 'auto', modelKey: 'mistral-ocr', languages: ['tr', 'en'], maxPages: 50 } });
    expect(ocrModels.validate).toHaveBeenCalledWith(expect.objectContaining({ tenantDbName: TENANT_DB_NAME }), 'mistral-ocr');

    // It survives an unrelated edit...
    const renamed = await patchModule({ description: 'with OCR' });
    expect(extractionOf(renamed.body)).toMatchObject({ ocr: { mode: 'auto' } });

    // ...and `null` clears it (a missing or null value reads as no OCR).
    const cleared = await patchModule({ extraction: null });
    expect(cleared.statusCode).toBe(200);
    expect(extractionOf(cleared.body) ?? null).toBeNull();
    const reread = await app.inject({ method: 'GET', url: `/api/rag/modules/${MODULE_KEY}`, headers: REQUEST_HEADERS });
    expect(parseJsonBody<{ module: { extraction?: unknown } }>(reread.body).module.extraction ?? null).toBeNull();
  });

  it('does not flag a re-index: OCR only applies to what is uploaded from now on', async () => {
    const res = await patchModule({ extraction: { ocr: { mode: 'always' } } });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ module: { reindexRequired?: boolean } }>(res.body).module.reindexRequired).not.toBe(true);
    await patchModule({ extraction: null });
  });

  it.each([
    [{ extraction: { ocr: { mode: 'sometimes' } } }, 'ocr.mode'],
    [{ extraction: { ocr: { mode: 'auto', maxPages: 0 } } }, 'maxPages'],
    [{ extraction: { ocr: { mode: 'auto', languages: ['not a language'] } } }, 'languages'],
    [{ extraction: { ocr: { mode: 'auto', tesseract: true } } }, 'ocr.tesseract'],
    [{ extraction: { engine: 'x' } }, 'extraction.engine'],
    [{ extraction: 'on' }, 'extraction must be an object'],
  ])('rejects %j with a 400 naming the problem', async (payload, expected) => {
    const res = await patchModule(payload);
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toContain(expected);
  });

  it('rejects a model the project does not have, on update and on create', async () => {
    const patched = await patchModule({ extraction: { ocr: { mode: 'auto', modelKey: 'missing-ocr' } } });
    expect(patched.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(patched.body).error).toContain('missing-ocr');

    const created = await app.inject({
      method: 'POST', url: '/api/rag/modules', headers: JSON_HEADERS,
      payload: createModulePayload({ key: 'ocr-create-module', extraction: { ocr: { mode: 'auto', modelKey: 'missing-ocr' } } }),
    });
    expect(created.statusCode).toBe(400);
    const gone = await app.inject({ method: 'GET', url: '/api/rag/modules/ocr-create-module', headers: REQUEST_HEADERS });
    expect(gone.statusCode).toBe(404);
  });

  it('does not check a model for a setting that is off', async () => {
    ocrModels.validate.mockClear();
    const res = await patchModule({ extraction: { ocr: { mode: 'off', modelKey: 'missing-ocr' } } });
    expect(res.statusCode).toBe(200);
    expect(ocrModels.validate).not.toHaveBeenCalled();
    await patchModule({ extraction: null });
  });

  it('creates a module with extraction', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/rag/modules', headers: JSON_HEADERS,
      payload: createModulePayload({ key: 'ocr-created-module', extraction: { ocr: { mode: 'auto', images: true } } }),
    });
    expect(created.statusCode).toBe(201);
    expect(parseJsonBody<{ module: { extraction: unknown } }>(created.body).module.extraction).toEqual({ ocr: { mode: 'auto', images: true } });
  });

  it('rejects a bad per-upload extraction before any ingest work happens, and an unusable model', async () => {
    const post = (extraction: unknown, extra: Record<string, unknown> = {}) => app.inject({
      method: 'POST', url: `/api/rag/modules/${MODULE_KEY}/documents`, headers: JSON_HEADERS,
      payload: JSON.stringify({ fileName: 'scan.pdf', data: Buffer.from('%PDF').toString('base64'), extraction, ...extra }),
    });

    const badMode = await post({ ocr: { mode: 'x' } });
    expect(badMode.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(badMode.body).error).toContain('extraction.ocr.mode');

    const unknownKey = await post({ ocrr: {} });
    expect(unknownKey.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(unknownKey.body).error).toContain('extraction.ocrr');

    const noModel = await post({ ocr: { mode: 'auto', modelKey: 'missing-ocr' } });
    expect(noModel.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(noModel.body).error).toContain('missing-ocr');
  });

  it('answers 422 with the ocr_incomplete code when OCR could not read a scan', async () => {
    ocrModels.extract = async () => ({ raw: '', text: '', report: { sourceType: 'converted', warnings: ['ocr_timeout: The document was not read within 120 s'] } });
    try {
      const res = await app.inject({
        method: 'POST', url: `/api/rag/modules/${MODULE_KEY}/documents`, headers: JSON_HEADERS,
        payload: JSON.stringify({ fileName: 'scan.pdf', data: Buffer.from('%PDF').toString('base64'), extraction: { ocr: { mode: 'auto' } } }),
      });
      expect(res.statusCode).toBe(422);
      expect(parseJsonBody<{ error: string; code: string }>(res.body)).toEqual({
        error: 'Failed to convert "scan.pdf" to text. OCR could not read it: it ran out of time.',
        code: 'ocr_incomplete',
      });
    } finally {
      ocrModels.extract = undefined;
    }
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

  it('404s another project\'s document for everyone, an owner too', async () => {
    currentUserRole = 'member';
    const memberRes = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/documents/${otherProjectDocumentId}`,
      headers: { ...REQUEST_HEADERS, 'x-user-role': 'member' },
    });
    expect(memberRes.statusCode).toBe(404);

    // The active project decides for an owner too: they reach another project by switching to it.
    currentUserRole = 'owner';
    const ownerRes = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/documents/${otherProjectDocumentId}`,
      headers: REQUEST_HEADERS,
    });
    expect(ownerRes.statusCode).toBe(404);
  });

  it('/content returns the whole stored source text', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/documents/${ownDocumentId}/content`,
      headers: REQUEST_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ fileName: string; text: string; truncated: boolean }>(res.body);
    expect(body.fileName).toBe('contract.pdf');
    expect(body.text).toBe(SECRET_SOURCE);
    expect(body.truncated).toBe(false);
  });

  it('/content 404s a document id that belongs to another module', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/documents/${otherModuleDocumentId}/content`,
      headers: REQUEST_HEADERS,
    });

    expect(res.statusCode).toBe(404);
  });

  it('/lines returns a line-numbered range and pages past it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/documents/${ownDocumentId}/lines?limit=1`,
      headers: REQUEST_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{
      totalLines: number; startLine: number; endLine: number; hasMore: boolean; lines: string;
    }>(res.body);
    expect(body.totalLines).toBe(1);
    expect(body.startLine).toBe(1);
    expect(body.endLine).toBe(1);
    expect(body.hasMore).toBe(false);
    expect(body.lines).toBe(`1\t${SECRET_SOURCE}`);
  });

  it('/lines 404s a document id that belongs to another module', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rag/modules/${MODULE_KEY}/documents/${otherModuleDocumentId}/lines`,
      headers: REQUEST_HEADERS,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('export and import routes move a module as zipped JSONL parts', () => {
  const SOURCE_KEY = 'transfer-source';
  const TARGET_KEY = 'transfer-target';
  /** Multi-line and quoted: what one JSONL line has to carry intact. */
  const REFUND_TEXT = 'Q: how long does a refund take?\nA: "14" days from the request.';

  /** The export ZIP's only part: these modules hold fewer documents than one part. */
  async function exportedText(res: { rawPayload: Buffer }, key: string): Promise<string> {
    const zip = await JSZip.loadAsync(res.rawPayload);
    expect(Object.keys(zip.files)).toEqual([`${key}.part-001.rag.jsonl`]);
    return zip.file(`${key}.part-001.rag.jsonl`)!.async('string');
  }

  function exportLines(text: string): Array<Record<string, unknown>> {
    return text.trimEnd().split('\n').map((line) => parseJsonBody<Record<string, unknown>>(line));
  }

  async function exportModule(key: string) {
    return app.inject({
      method: 'GET',
      url: `/api/rag/modules/${key}/export`,
      headers: REQUEST_HEADERS,
    });
  }

  async function importInto(key: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/rag/modules/${key}/import`,
      headers: JSON_HEADERS,
      payload: JSON.stringify(payload),
    });
  }

  beforeAll(async () => {
    for (const key of [SOURCE_KEY, TARGET_KEY]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rag/modules',
        headers: JSON_HEADERS,
        payload: createModulePayload({ key, name: key }),
      });
      expect(res.statusCode).toBe(201);
    }

    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);

    // Stored the way ingest stores a source this short: inline, no bucket object.
    await db.createRagDocument({
      tenantId: TENANT_ID,
      projectId: FAKE_PROJECT_ID,
      ragModuleKey: SOURCE_KEY,
      fileName: 'refunds.md',
      contentType: 'text/markdown',
      metadata: { lang: 'en' },
      status: 'indexed',
      sourceText: REFUND_TEXT,
      createdBy: USER_ID,
    });

    // Same module key, another project.
    await db.createRagDocument({
      tenantId: TENANT_ID,
      projectId: OTHER_PROJECT_ID,
      ragModuleKey: SOURCE_KEY,
      fileName: 'their-notes.md',
      status: 'indexed',
      sourceText: FOREIGN_PROJECT_QUERY,
      createdBy: 'someone-else',
    });

    // A module that is switched off.
    await db.createRagModule({
      tenantId: TENANT_ID,
      projectId: FAKE_PROJECT_ID,
      key: 'disabled-module',
      name: 'Disabled Module',
      embeddingModelKey: 'embed-model',
      vectorProviderKey: 'vec-provider',
      vectorIndexKey: 'vec-index',
      chunkConfig: { strategy: 'recursive_character', chunkSize: 800, chunkOverlap: 100 },
      status: 'disabled',
      createdBy: USER_ID,
    });

    // A module that only another project has.
    await db.createRagModule({
      tenantId: TENANT_ID,
      projectId: OTHER_PROJECT_ID,
      key: 'their-module',
      name: 'Their Module',
      embeddingModelKey: 'embed-model',
      vectorProviderKey: 'vec-provider',
      vectorIndexKey: 'vec-index',
      chunkConfig: { strategy: 'recursive_character', chunkSize: 800, chunkOverlap: 100 },
      status: 'active',
      createdBy: 'someone-else',
    });
  });

  it('GET /export answers a ZIP whose part has a header line, then each document with its full text', async () => {
    const res = await exportModule(SOURCE_KEY);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${SOURCE_KEY}.rag.zip"`);

    const text = await exportedText(res, SOURCE_KEY);
    const [header, ...documents] = exportLines(text);
    expect(header).toMatchObject({
      format: 'cognipeer.rag-module',
      version: 1,
      module: { key: SOURCE_KEY },
      documentCount: 1,
      skippedDocuments: 0,
      part: { index: 1, count: 1, documentCount: 1 },
    });
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      type: 'document',
      fileName: 'refunds.md',
      contentType: 'text/markdown',
      metadata: { lang: 'en' },
      content: REFUND_TEXT,
    });
    // The same-key module of another project stays out.
    expect(text).not.toContain(FOREIGN_PROJECT_QUERY);
  });

  it('GET /export 404s an unknown module and one that only another project has', async () => {
    expect((await exportModule('no-such-module')).statusCode).toBe(404);
    expect((await exportModule('their-module')).statusCode).toBe(404);
  });

  it('POST /import re-ingests an export into another module, queued for indexing', async () => {
    const exported = await exportedText(await exportModule(SOURCE_KEY), SOURCE_KEY);

    const res = await importInto(TARGET_KEY, { data: exported });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toEqual({ total: 1, imported: 1, failed: 0, errors: [] });

    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);
    const documents = await db.listRagDocuments(TARGET_KEY, { projectId: FAKE_PROJECT_ID });
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      fileName: 'refunds.md',
      status: 'pending',
      metadata: { lang: 'en' },
      sourceText: REFUND_TEXT,
      createdBy: USER_ID,
    });
    expect(ingestJobs.publishRagIngestJob).toHaveBeenCalledWith(expect.objectContaining({
      tenantDbName: TENANT_DB_NAME,
      ragModuleKey: TARGET_KEY,
      documentId: String(documents[0]._id),
    }));

    // And it comes back out the same.
    const [, ...roundTripped] = exportLines(await exportedText(await exportModule(TARGET_KEY), TARGET_KEY));
    expect(roundTripped).toEqual(exportLines(exported).slice(1));
  });

  it('POST /import takes a line whose optional fields are null, as older exports from Mongo wrote them', async () => {
    const line = JSON.stringify({
      type: 'document',
      fileName: 'null-fields.md',
      contentType: null,
      metadata: null,
      chunkConfig: null,
      content: 'stored with nulls',
    });

    const res = await importInto(TARGET_KEY, { data: line });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toEqual({ total: 1, imported: 1, failed: 0, errors: [] });
  });

  it('POST /import rejects a body without a JSONL string', async () => {
    for (const payload of [{}, { data: ' \n ' }, { data: 42 }]) {
      const res = await importInto(TARGET_KEY, payload);
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ error: string }>(res.body).error).toContain('"data"');
    }
  });

  it('POST /import answers 400 for a module it cannot import into and for a file it will not read', async () => {
    const line = JSON.stringify({ fileName: 'note.md', content: 'note' });

    for (const key of ['no-such-module', 'their-module']) {
      const res = await importInto(key, { data: line });
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ error: string }>(res.body).error).toContain('not found');
    }

    const disabledRes = await importInto('disabled-module', { data: line });
    expect(disabledRes.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(disabledRes.body).error).toContain('not active');

    const nextVersion = JSON.stringify({ format: 'cognipeer.rag-module', version: 2 });
    const versionRes = await importInto(TARGET_KEY, { data: `${nextVersion}\n${line}` });
    expect(versionRes.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(versionRes.body).error).toContain('Unsupported export version');

    const tooMany = Array.from({ length: RAG_IMPORT_MAX_DOCUMENTS + 1 }, () => line).join('\n');
    const capRes = await importInto(TARGET_KEY, { data: tooMany });
    expect(capRes.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(capRes.body).error).toContain('at most');
  });
});
