/**
 * The Document Store (`plugins/files.ts`) and the objects a knowledge base keeps in its bucket: the stored originals and
 * extracted text of its documents (`knowledge-engine/<module>/...`, stamped with `ragModuleKey`).
 *
 * With access control on for the module they are read through the knowledge base, where each document is checked, so a
 * caller who does not skip the checks (administers the module, with the admin exception on) does not find them: not in a
 * listing, and by key the record, the download, the Markdown copy, the preview, the archive and the conversion answer as for
 * a file that is not there. A module without access control, and a file of no module, are served as before.
 *
 * Who skips the checks is `ragAccessForRequest`'s answer (its own tests have the engine behind it); here it is one the
 * test chooses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const hoisted = vi.hoisted(() => ({ ragAccessForRequest: vi.fn() }));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    requireProjectContextForRequest: vi.fn(),
    sendProjectContextError: vi.fn().mockReturnValue(null),
    serviceLevelForRequest: vi.fn(async () => 'write'),
  };
});
// Who may see which session file is the session access module's question; the default caller sees every session.
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
  createFileBucket: vi.fn(),
  createFileProvider: vi.fn(),
  deleteFile: vi.fn(),
  deleteFileBucket: vi.fn(),
  downloadFile: vi.fn(),
  getFileBucket: vi.fn(),
  getFileRecord: vi.fn(),
  listFileBuckets: vi.fn(),
  listFiles: vi.fn(),
  updateFileBucket: vi.fn(),
  uploadFile: vi.fn(),
}));
vi.mock('@/lib/services/files/fileReads', () => ({
  getFileBucketDetail: vi.fn(),
  listFileBucketItems: vi.fn(),
  listFileProviderItems: vi.fn(),
}));
vi.mock('@/lib/services/files/fileLimits', () => ({ getFileLimits: vi.fn() }));
vi.mock('@/lib/services/files/fileBatch', () => ({
  BATCH_MAX_KEYS: 100,
  deleteFileRecords: vi.fn(),
  findFileRecordsByKeys: vi.fn(),
}));
vi.mock('@/lib/services/files/archive', () => ({
  ARCHIVE_MAX_FILES: 100,
  createFilesArchive: vi.fn(),
}));
vi.mock('@/lib/services/files/jobs/markdownConversion', () => ({ queueMarkdownConversion: vi.fn() }));
vi.mock('@/lib/services/agents/sessionFilesBucket', () => ({
  bucketInUseBody: vi.fn(),
  findAgentsUsingBucket: vi.fn(async () => []),
}));
vi.mock('@/lib/services/users/userDisplayNames', () => ({
  withUploaderNames: async (_tenantDbName: string, rows: unknown[]) => rows,
}));

import { getDatabase } from '@/lib/database';
import { requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { downloadFile, getFileRecord, listFiles } from '@/lib/services/files';
import { createFilesArchive } from '@/lib/services/files/archive';
import { FileServiceError } from '@/lib/services/files/errors';
import { findFileRecordsByKeys } from '@/lib/services/files/fileBatch';
import { queueMarkdownConversion } from '@/lib/services/files/jobs/markdownConversion';
import { filesApiPlugin } from '@/server/api/plugins/files';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const headers = { authorization: 'Bearer t' };
const CTX = {
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'admin' },
  userProject: { role: 'project_admin' },
  session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1', licenseType: 'STARTER' },
};
const BASE = '/api/files/buckets/docs/objects';
const json = <T = Record<string, unknown>>(res: { body: string }) => parseJsonBody<T>(res.body);

type Scope = { enabled: boolean; manage: boolean; bypass: boolean };
const NO_ACCESS_CONTROL: Scope = { enabled: false, manage: false, bypass: false };
const KEPT_OUT: Scope = { enabled: true, manage: false, bypass: false };
const ADMINISTRATOR: Scope = { enabled: true, manage: true, bypass: true };
const ADMINISTRATOR_WITHOUT_EXCEPTION: Scope = { enabled: true, manage: true, bypass: false };
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
    caller: { kind: 'person', userId: 'user-1' },
    scope: scopes.get(input.ragModuleKey),
  }));
  mockFn(requireProjectContextForRequest).mockResolvedValue(CTX);
  mockFn(getDatabase).mockResolvedValue(createMockDb({ switchToTenant: vi.fn() } as never));
  mockFn(getFileRecord).mockResolvedValue(hrRecord);
  mockFn(downloadFile).mockResolvedValue({ fileName: 'handbook.pdf', data: Buffer.from('%PDF-'), contentType: 'application/pdf' });
  app = await createFastifyApiTestApp(filesApiPlugin);
});

afterEach(async () => {
  await app.close();
});

const read = (key: string, query = '') => app.inject({ method: 'GET', url: `${BASE}/${key}${query ? `?${query}` : ''}`, headers });

describe('an object of a knowledge base with access control, read by key', () => {
  it('is not there for a caller who does not skip the checks: the record, the download, the Markdown copy and the preview', async () => {
    for (const query of ['', 'download=1', 'download=markdown', 'variant=markdown&download=1', 'preview=1', 'preview=true&variant=markdown']) {
      const res = await read(HR_KEY, query);
      expect(res.statusCode, query).toBe(404);
      expect(json(res), query).toEqual({ error: 'File not found', code: 'file_not_found' });
    }
    expect(downloadFile).not.toHaveBeenCalled();
    expect(hoisted.ragAccessForRequest).toHaveBeenCalledWith(expect.anything(), {
      tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', ragModuleKey: 'hr',
    });
  });

  it('is answered exactly as a key with no record is', async () => {
    const hidden = await read(HR_KEY, 'download=1');
    mockFn(getFileRecord).mockRejectedValue(new FileServiceError('file_not_found', 404, 'File record not found.'));
    const missing = await read(HR_KEY, 'download=1');

    expect(hidden.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(missing.statusCode);
    expect(hidden.body).toBe(missing.body);
    expect(hidden.headers['content-type']).toBe(missing.headers['content-type']);
    expect(hidden.headers['content-length']).toBe(missing.headers['content-length']);
  });

  it('is not there when only its key names the module, or only its metadata does', async () => {
    mockFn(getFileRecord).mockResolvedValue({ ...hrRecord, metadata: undefined });
    expect((await read(HR_KEY)).statusCode).toBe(404);

    mockFn(getFileRecord).mockResolvedValue({ ...hrRecord, key: 'docs/handbook.pdf' });
    expect((await read('docs/handbook.pdf')).statusCode).toBe(404);
  });

  it('is served to an administrator of the knowledge base', async () => {
    scopes.set('hr', ADMINISTRATOR);

    const record = await read(HR_KEY);
    expect(record.statusCode).toBe(200);
    expect(json<{ record: { id: string } }>(record).record.id).toBe('f-hr');

    const download = await read(HR_KEY, 'download=1');
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.toString()).toBe('%PDF-');
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it('is not served to an administrator whose knowledge base turned the admin exception off', async () => {
    scopes.set('hr', ADMINISTRATOR_WITHOUT_EXCEPTION);

    expect((await read(HR_KEY, 'download=1')).statusCode).toBe(404);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('is served as before when the knowledge base has no access control, or is not there', async () => {
    scopes.set('hr', NO_ACCESS_CONTROL);
    expect((await read(HR_KEY, 'download=1')).statusCode).toBe(200);

    scopes.delete('hr');
    expect((await read(HR_KEY)).statusCode).toBe(200);
  });

  it('leaves a file of no knowledge base alone, without a single question to the access service', async () => {
    mockFn(getFileRecord).mockResolvedValue(plainRecord);

    expect((await read('reports/a.pdf')).statusCode).toBe(200);
    expect((await read('reports/a.pdf', 'download=1')).statusCode).toBe(200);
    expect(hoisted.ragAccessForRequest).not.toHaveBeenCalled();
  });
});

describe('a listing', () => {
  it('leaves the objects of a knowledge base with access control out, filling the page from the following read', async () => {
    mockFn(listFiles)
      .mockResolvedValueOnce({ items: [plain('a'), hr('h1'), hr('h2')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [plain('b')] });

    const res = await app.inject({ method: 'GET', url: BASE, headers });

    expect(res.statusCode).toBe(200);
    const body = json<{ items: Array<{ id: string }>; nextCursor?: string }>(res);
    expect(body.items.map((item) => item.id)).toEqual(['plain-a', 'plain-b']);
    expect(body).not.toHaveProperty('nextCursor');
    expect(mockFn(listFiles).mock.calls.map((call) => [call[3].cursor, call[3].limit])).toEqual([[undefined, 50], ['c1', 49]]);
    // Two objects of one module cost one question.
    expect(hoisted.ragAccessForRequest).toHaveBeenCalledTimes(1);
  });

  it('comes back short, with the cursor to go on from, when everything it read was left out', async () => {
    mockFn(listFiles).mockResolvedValue({ items: [hr('h1')], nextCursor: 'more' });

    const res = await app.inject({ method: 'GET', url: `${BASE}?limit=2`, headers });

    expect(res.statusCode).toBe(200);
    const body = json<{ items: unknown[]; nextCursor?: string }>(res);
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBe('more');
  });

  it('shows an administrator of the knowledge base everything in one plain read', async () => {
    scopes.set('hr', ADMINISTRATOR);
    mockFn(listFiles).mockResolvedValue({ items: [plain('a'), hr('h1')], nextCursor: 'c1' });

    const res = await app.inject({ method: 'GET', url: BASE, headers });

    const body = json<{ items: Array<{ id: string }>; nextCursor?: string }>(res);
    expect(body.items.map((item) => item.id)).toEqual(['plain-a', 'hr-h1']);
    expect(body.nextCursor).toBe('c1');
    expect(listFiles).toHaveBeenCalledTimes(1);
  });

  it('is one plain read, and no question, when no object names a module', async () => {
    mockFn(listFiles).mockResolvedValue({ items: [plain('a'), plain('b')], nextCursor: 'c1' });

    const res = await app.inject({ method: 'GET', url: BASE, headers });

    expect(json<{ items: unknown[] }>(res).items).toHaveLength(2);
    expect(listFiles).toHaveBeenCalledTimes(1);
    expect(hoisted.ragAccessForRequest).not.toHaveBeenCalled();
  });
});

describe('an archive', () => {
  const archive = (keys: string[]) => app.inject({ method: 'POST', url: `${BASE}/archive`, headers, payload: { keys } });

  it('has no object of a knowledge base the caller may not read: it is named among the keys that were not found', async () => {
    mockFn(findFileRecordsByKeys).mockResolvedValue({ found: [plainRecord, hrRecord], missing: ['gone.txt'], duplicates: [] });

    const res = await archive(['gone.txt', HR_KEY, 'reports/a.pdf']);

    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: 'File not found', code: 'file_not_found', keys: ['gone.txt', HR_KEY] });
    expect(createFilesArchive).not.toHaveBeenCalled();
  });

  it('answers for a hidden object as for a key that has no record', async () => {
    mockFn(findFileRecordsByKeys).mockResolvedValue({ found: [hrRecord], missing: [], duplicates: [] });
    const hidden = await archive([HR_KEY]);
    mockFn(findFileRecordsByKeys).mockResolvedValue({ found: [], missing: [HR_KEY], duplicates: [] });
    const missing = await archive([HR_KEY]);

    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toBe(missing.body);
  });

  it('counts every record of a key: the one that stands for it may not be the one that names the module', async () => {
    mockFn(findFileRecordsByKeys).mockResolvedValue({
      found: [{ ...plainRecord, key: 'docs/handbook.pdf' }],
      missing: [],
      duplicates: [{ ...hrRecord, key: 'docs/handbook.pdf' }],
    });

    const res = await archive(['docs/handbook.pdf']);

    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: 'File not found', code: 'file_not_found', keys: ['docs/handbook.pdf'] });
    expect(createFilesArchive).not.toHaveBeenCalled();
  });

  it('puts the object of an administrator of the knowledge base in the archive', async () => {
    scopes.set('hr', ADMINISTRATOR);
    mockFn(findFileRecordsByKeys).mockResolvedValue({ found: [hrRecord], missing: [], duplicates: [] });
    mockFn(createFilesArchive).mockResolvedValue({ fileName: 'files.zip', stream: Readable.from([Buffer.from('zip')]) });

    const res = await archive([HR_KEY]);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(createFilesArchive).toHaveBeenCalledTimes(1);
  });

  it('keeps a missing key a missing key, with no question to the access service', async () => {
    mockFn(findFileRecordsByKeys).mockResolvedValue({ found: [plainRecord], missing: ['gone.txt'], duplicates: [] });

    const res = await archive(['gone.txt', 'reports/a.pdf']);

    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: 'File not found', code: 'file_not_found', keys: ['gone.txt'] });
    expect(hoisted.ragAccessForRequest).not.toHaveBeenCalled();
  });
});

describe('a conversion to Markdown', () => {
  const convert = (key: string) => app.inject({ method: 'POST', url: '/api/files/buckets/docs/convert', headers, payload: { key } });

  it('is not started for an object of a knowledge base the caller may not read: it is not there', async () => {
    const res = await convert(HR_KEY);

    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: 'File not found', code: 'file_not_found' });
    expect(queueMarkdownConversion).not.toHaveBeenCalled();
  });

  it('is started for an administrator of the knowledge base', async () => {
    scopes.set('hr', ADMINISTRATOR);
    mockFn(queueMarkdownConversion).mockResolvedValue({ ...hrRecord, markdownStatus: 'pending' });

    const res = await convert(HR_KEY);

    expect(res.statusCode).toBe(202);
    expect(queueMarkdownConversion).toHaveBeenCalledTimes(1);
  });

  it('is started for a file of no knowledge base', async () => {
    mockFn(getFileRecord).mockResolvedValue(plainRecord);
    mockFn(queueMarkdownConversion).mockResolvedValue({ ...plainRecord, markdownStatus: 'pending' });

    const res = await convert('reports/a.pdf');

    expect(res.statusCode).toBe(202);
    expect(hoisted.ragAccessForRequest).not.toHaveBeenCalled();
  });
});
