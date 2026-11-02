/**
 * HTTP-level tests: a crawler's OCR options (model, mode, page limit, images) survive the schema and are stored, and a
 * model that cannot read documents is refused at save time (create, update, ad-hoc run).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-crawler-ocr-routes-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'crawler_ocr_routes_main';

const { validateOcrModelRef } = vi.hoisted(() => ({ validateOcrModelRef: vi.fn() }));
vi.mock('@/lib/services/extraction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/extraction')>()),
  validateOcrModelRef,
}));
vi.mock('@/lib/services/rag', () => ({ ingestDocument: vi.fn() }));
vi.mock('@cognipeer/to-markdown', () => ({ convertToMarkdown: async () => '' }));

const FAKE_PROJECT_ID = 'test-project-ocr';
vi.mock('@/lib/services/projects/projectContext', async () => ({
  ProjectContextError: class extends Error {
    status = 400;
  },
  resolveProjectContext: vi.fn(async (ctx: { tenantDbName: string; tenantId: string }) => ({
    projectId: FAKE_PROJECT_ID,
    project: { _id: FAKE_PROJECT_ID, tenantId: ctx.tenantId, name: 'Test', key: 'test', status: 'active' },
    userProject: null,
  })),
  requireProjectContext: vi.fn(),
}));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import { crawlerApiPlugin } from '@/server/api/plugins/crawler';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'crawler_ocr_routes_tenant';
const TENANT_ID = 'tenant-ocr-routes-1';
const HEADERS: Record<string, string> = {
  'x-tenant-db-name': TENANT_DB_NAME,
  'x-tenant-id': TENANT_ID,
  'x-tenant-slug': 'test',
  'x-user-id': 'pending',
  'x-user-email': 'tester@example.com',
  'x-user-role': 'owner',
  'x-license-type': 'FREE',
  'content-type': 'application/json',
};

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.createTenant({
    companyName: 'OCR Routes Test',
    slug: 'ocr-routes-test',
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
  HEADERS['x-user-id'] = String(owner._id);
  app = await createFastifyApiTestApp(crawlerApiPlugin);
}, 30_000);

afterAll(async () => {
  await app.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  validateOcrModelRef.mockReset().mockResolvedValue(undefined);
});

type CrawlerBody = { crawler: { key: string; markdownOptions?: { ocr?: Record<string, unknown> } } };

async function create(markdownOptions: unknown, name = 'OCR crawler') {
  return app.inject({
    method: 'POST',
    url: '/api/crawler/crawlers',
    headers: HEADERS,
    payload: JSON.stringify({ name, engine: 'axios', markdownOptions }),
  });
}

describe('crawler OCR options over HTTP', () => {
  it('keeps modelKey, mode, maxPages and images, and checks the model in the project', async () => {
    const ocr = { enabled: true, languages: ['tur', 'eng'], modelKey: 'ocr-1', mode: 'always', maxPages: 12, images: true };
    const res = await create({ ocr });
    expect(res.statusCode).toBe(201);
    const { crawler } = parseJsonBody<CrawlerBody>(res.body);
    expect(crawler.markdownOptions?.ocr).toEqual(ocr);
    expect(validateOcrModelRef).toHaveBeenCalledWith(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: FAKE_PROJECT_ID },
      'ocr-1',
    );

    const got = await app.inject({ method: 'GET', url: `/api/crawler/crawlers/${crawler.key}`, headers: HEADERS });
    expect(parseJsonBody<CrawlerBody>(got.body).crawler.markdownOptions?.ocr).toEqual(ocr);
  });

  it('still takes the old shape, without a model check', async () => {
    const res = await create({ ocr: { enabled: true, languages: ['eng'] } }, 'Old shape');
    expect(res.statusCode).toBe(201);
    expect(parseJsonBody<CrawlerBody>(res.body).crawler.markdownOptions?.ocr).toEqual({ enabled: true, languages: ['eng'] });
    expect(validateOcrModelRef).not.toHaveBeenCalled();
  });

  it('refuses a model that is not usable, on create, on update and on an ad-hoc run', async () => {
    validateOcrModelRef.mockResolvedValue('Model "nope" was not found in this project');

    const created = await create({ ocr: { enabled: true, modelKey: 'nope' } }, 'Bad model');
    expect(created.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(created.body).error).toMatch(/Invalid OCR model.*nope/);

    validateOcrModelRef.mockResolvedValue(undefined);
    const ok = parseJsonBody<CrawlerBody>((await create({ ocr: { enabled: false } }, 'Fine')).body).crawler;
    validateOcrModelRef.mockResolvedValue('Model "nope" cannot read documents');
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/crawler/crawlers/${ok.key}`,
      headers: HEADERS,
      payload: JSON.stringify({ markdownOptions: { ocr: { enabled: true, modelKey: 'nope' } } }),
    });
    expect(updated.statusCode).toBe(400);

    const adhoc = await app.inject({
      method: 'POST',
      url: '/api/crawler/run',
      headers: HEADERS,
      payload: JSON.stringify({ seeds: ['https://example.com/'], markdownOptions: { ocr: { enabled: true, modelKey: 'nope' } } }),
    });
    expect(adhoc.statusCode).toBe(400);
  });

  it('rejects malformed OCR options', async () => {
    expect((await create({ ocr: { enabled: true, mode: 'sometimes' } }, 'Bad mode')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await create({ ocr: { enabled: true, maxPages: 0 } }, 'Bad pages')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await create({ ocr: { enabled: true, modelKey: '' } }, 'Empty key')).statusCode).toBeGreaterThanOrEqual(400);
  });
});
