/**
 * The client Files API (`plugins/client-files.ts`) and the objects a knowledge base keeps in its bucket: the stored
 * originals and extracted text of its documents (`knowledge-engine/<module>/...`, stamped with `ragModuleKey`).
 *
 * With access control on for the module they are read through the knowledge base, where each document is checked. An API
 * token does not administer a knowledge base, so for a client those objects are not there: not in a listing, and by key the
 * record and the download answer as for a file that is not there. A module without access control, and a file of no
 * module, are served as before.
 *
 * That a token never skips the checks is `ragAccessForRequest`'s answer (its own tests have the engine behind it); here
 * it is one the test chooses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  auth: {
    token: 'tok',
    tokenRecord: { _id: 'tok-1', userId: 'user-1' },
    tenant: { licenseType: 'STARTER' },
    tenantId: 'tenant-1',
    tenantDbName: 'tenant_acme',
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'owner' },
  },
  ragAccessForRequest: vi.fn(),
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    // The token gate is covered by the rbac / route-declaration tests; the handlers are under test here.
    withClientApiRequestContext: (handler: (...args: unknown[]) => unknown) =>
      (request: unknown, reply: unknown) => handler(request, reply, hoisted.auth),
    getApiTokenContextForRequest: async () => hoisted.auth,
  };
});
// Who may see which session file is the session access module's question; here the default caller sees every session.
vi.mock('@/server/api/plugins/agent-session-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/plugins/agent-session-access')>();
  return {
    ...actual,
    refuseSessionLinked: vi.fn(async () => null),
    pageOfVisibleRows: async (_request: unknown, input: { start: unknown; limit: number; fetchPage: (position: unknown, size: number) => Promise<{ rows: unknown[]; after: (consumed: number) => unknown }> }) => {
      const page = await input.fetchPage(input.start, input.limit);
      return { restricted: false, rows: page.rows, next: page.after(page.rows.length) };
    },
  };
});
vi.mock('@/server/api/ragAccessRequest', () => ({ ragAccessForRequest: hoisted.ragAccessForRequest }));
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
}));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkPerRequestLimits: vi.fn(async () => ({ allowed: true, effectiveLimits: {} })),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  checkResourceQuota: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('@/lib/services/files', () => ({
  composeUploadKeyHint: vi.fn(() => ({})),
  createFileProvider: vi.fn(),
  deleteFile: vi.fn(),
  downloadFile: vi.fn(),
  getFileBucket: vi.fn(),
  getFileRecord: vi.fn(),
  listFileBuckets: vi.fn(),
  listFileProviders: vi.fn(),
  listFiles: vi.fn(),
  uploadFile: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { downloadFile, getFileRecord, listFiles } from '@/lib/services/files';
import { FileServiceError } from '@/lib/services/files/errors';
import { clientFilesApiPlugin } from '@/server/api/plugins/client-files';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const BASE = '/api/client/v1/files/buckets/docs/objects';
const json = <T = Record<string, unknown>>(res: { body: string }) => parseJsonBody<T>(res.body);

type Scope = { enabled: boolean; manage: boolean; bypass: boolean };
const NO_ACCESS_CONTROL: Scope = { enabled: false, manage: false, bypass: false };
const KEPT_OUT: Scope = { enabled: true, manage: false, bypass: false };
const scopes = new Map<string, Scope>();

const HR_KEY = 'knowledge-engine/hr/9b1c-handbook.pdf';
const hrRecord = { id: 'f-hr', key: HR_KEY, name: 'handbook.pdf', size: 5, contentType: 'application/pdf', metadata: { ragModuleKey: 'hr' } };
const plainRecord = { id: 'f-plain', key: 'reports/a.pdf', name: 'a.pdf', size: 5, contentType: 'application/pdf' };
const plain = (name: string) => ({ id: `plain-${name}`, key: `reports/${name}.pdf`, name: `${name}.pdf`, size: 5 });
const hr = (name: string) => ({ id: `hr-${name}`, key: `knowledge-engine/hr/${name}.pdf`, name: `${name}.pdf`, size: 5, metadata: { ragModuleKey: 'hr' } });

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  scopes.clear();
  scopes.set('hr', KEPT_OUT);
  mockFn(hoisted.ragAccessForRequest).mockImplementation(async (_request: unknown, input: { ragModuleKey: string }) => ({
    module: null,
    caller: { kind: 'token', tokenId: 'tok-1' },
    scope: scopes.get(input.ragModuleKey),
  }));
  mockFn(getDatabase).mockResolvedValue(createMockDb({ switchToTenant: vi.fn() } as never));
  mockFn(getFileRecord).mockResolvedValue(hrRecord);
  mockFn(downloadFile).mockResolvedValue({ fileName: 'handbook.pdf', data: Buffer.from('%PDF-'), contentType: 'application/pdf', size: 5 });
  app = await createFastifyApiTestApp(clientFilesApiPlugin);
});

afterEach(async () => {
  await app.close();
});

/** A key as the Document Store stores it: `/` is a character of the key, so a client writes it as `%2F`. */
const urlOf = (key: string) => encodeURIComponent(key);
const record = (key: string) => app.inject({ method: 'GET', url: `${BASE}/${urlOf(key)}` });
const download = (key: string, query = '') => app.inject({ method: 'GET', url: `${BASE}/${urlOf(key)}/download${query}` });

describe('an object of a knowledge base with access control, read by key', () => {
  it('is not there for a client: the record, the download and the Markdown copy', async () => {
    const asRecord = await record(HR_KEY);
    expect(asRecord.statusCode).toBe(404);
    expect(json(asRecord)).toEqual({ error: 'File not found', code: 'file_not_found' });

    for (const query of ['', '?variant=original', '?variant=markdown']) {
      const res = await download(HR_KEY, query);
      expect(res.statusCode, query).toBe(404);
      expect(json(res), query).toEqual({ error: 'File not found', code: 'file_not_found' });
    }
    expect(downloadFile).not.toHaveBeenCalled();
    expect(hoisted.ragAccessForRequest).toHaveBeenCalledWith(expect.anything(), {
      tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', ragModuleKey: 'hr',
    });
  });

  it('is answered exactly as a key with no record is', async () => {
    const hidden = await download(HR_KEY);
    mockFn(getFileRecord).mockRejectedValue(new FileServiceError('file_not_found', 404, 'File record not found.'));
    const missing = await download(HR_KEY);

    expect(hidden.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(missing.statusCode);
    expect(hidden.body).toBe(missing.body);
    expect(hidden.headers['content-type']).toBe(missing.headers['content-type']);
    expect(hidden.headers['content-length']).toBe(missing.headers['content-length']);
  });

  it('is not there when only its key names the module, or only its metadata does', async () => {
    mockFn(getFileRecord).mockResolvedValue({ ...hrRecord, metadata: undefined });
    expect((await record(HR_KEY)).statusCode).toBe(404);

    mockFn(getFileRecord).mockResolvedValue({ ...hrRecord, key: 'docs/handbook.pdf' });
    expect((await download('docs/handbook.pdf')).statusCode).toBe(404);
  });

  it('is served as before when the knowledge base has no access control, or is not there', async () => {
    scopes.set('hr', NO_ACCESS_CONTROL);
    expect((await record(HR_KEY)).statusCode).toBe(200);
    const served = await download(HR_KEY);
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.toString()).toBe('%PDF-');

    scopes.delete('hr');
    expect((await record(HR_KEY)).statusCode).toBe(200);
  });

  it('leaves a file of no knowledge base alone, without a single question to the access service', async () => {
    mockFn(getFileRecord).mockResolvedValue(plainRecord);

    expect((await record('reports/a.pdf')).statusCode).toBe(200);
    expect((await download('reports/a.pdf')).statusCode).toBe(200);
    expect(hoisted.ragAccessForRequest).not.toHaveBeenCalled();
  });
});

describe('a listing', () => {
  it('leaves the objects of a knowledge base with access control out, filling the page from the following read', async () => {
    mockFn(listFiles)
      .mockResolvedValueOnce({ items: [plain('a'), hr('h1'), hr('h2')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [plain('b')] });

    const res = await app.inject({ method: 'GET', url: BASE });

    expect(res.statusCode).toBe(200);
    const body = json<{ count: number; files: Array<{ id: string }>; nextCursor?: string }>(res);
    expect(body.files.map((file) => file.id)).toEqual(['plain-a', 'plain-b']);
    expect(body.count).toBe(2);
    expect(body).not.toHaveProperty('nextCursor');
    expect(mockFn(listFiles).mock.calls.map((call) => [call[3].cursor, call[3].limit])).toEqual([[undefined, 50], ['c1', 49]]);
    // Two objects of one module cost one question.
    expect(hoisted.ragAccessForRequest).toHaveBeenCalledTimes(1);
  });

  it('lists the objects of a knowledge base without access control as before', async () => {
    scopes.set('hr', NO_ACCESS_CONTROL);
    const first = { items: [plain('a'), hr('h1')], nextCursor: 'c1' };
    mockFn(listFiles).mockResolvedValue(first);

    const res = await app.inject({ method: 'GET', url: BASE });

    const body = json<{ count: number; files: Array<{ id: string }>; nextCursor?: string }>(res);
    expect(body.files.map((file) => file.id)).toEqual(['plain-a', 'hr-h1']);
    expect(body.nextCursor).toBe('c1');
    expect(listFiles).toHaveBeenCalledTimes(1);
  });

  it('is one plain read, and no question, when no object names a module', async () => {
    mockFn(listFiles).mockResolvedValue({ items: [plain('a'), plain('b')], nextCursor: 'c1' });

    const res = await app.inject({ method: 'GET', url: BASE });

    expect(json<{ files: unknown[] }>(res).files).toHaveLength(2);
    expect(listFiles).toHaveBeenCalledTimes(1);
    expect(hoisted.ragAccessForRequest).not.toHaveBeenCalled();
  });
});
