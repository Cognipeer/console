/**
 * The upload route of the client Files API (`plugins/client-files.ts`), in the order it asks its questions:
 *  - the body: `metadata` is an object (or absent), and an empty `data` is a legitimate empty file;
 *  - the session gate: bytes written under the key of a file an agent session holds are the session's to allow, asked
 *    of the token's owner like any other route that changes the file, before a quota is spent or a byte is stored;
 *  - the quotas, asked about the bytes `data` decodes to - not about what a text with a `base64,` in it claims.
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
  refuseSessionLinked: vi.fn(),
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
// Who may change which session is the session access module's question (api/agent-session-access-routes.test.ts has the
// real engine behind it); what the upload route does with the answer is what is checked here.
vi.mock('@/server/api/plugins/agent-session-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/plugins/agent-session-access')>();
  return { ...actual, refuseSessionLinked: hoisted.refuseSessionLinked };
});
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
}));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkPerRequestLimits: vi.fn(async () => ({ allowed: true, effectiveLimits: {} })),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  checkResourceQuota: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('@/lib/services/files', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/files/fileService')>('@/lib/services/files/fileService');
  return {
    chooseRelativeFileKey: actual.chooseRelativeFileKey,
    composeUploadKeyHint: actual.composeUploadKeyHint,
    createFileProvider: vi.fn(),
    deleteFile: vi.fn(),
    downloadFile: vi.fn(),
    getFileBucket: vi.fn(),
    getFileRecord: vi.fn(),
    listFileBuckets: vi.fn(),
    listFileProviders: vi.fn(),
    listFiles: vi.fn(),
    uploadFile: vi.fn(),
  };
});

import { getDatabase } from '@/lib/database';
import { checkPerRequestLimits, checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';
import { getFileBucket, uploadFile } from '@/lib/services/files';
import { clientFilesApiPlugin } from '@/server/api/plugins/client-files';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const UPLOAD_URL = '/api/client/v1/files/buckets/docs/objects';
const DATA = Buffer.from('hello').toString('base64');

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let listFileRecordsByKeys: ReturnType<typeof vi.fn>;
let sumFileRecordBytes: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  listFileRecordsByKeys = vi.fn(async () => []);
  sumFileRecordBytes = vi.fn(async () => 0);
  mockFn(getDatabase).mockResolvedValue(createMockDb({
    switchToTenant: vi.fn(),
    countFileRecords: vi.fn(async () => 0),
    sumFileRecordBytes,
    listFileRecordsByKeys,
  } as never));
  mockFn(getFileBucket).mockResolvedValue({ id: 'b1', key: 'docs', status: 'active', providerKey: 'disk' });
  mockFn(uploadFile).mockResolvedValue({ record: { id: 'f1', key: 'stored.txt' } });
  hoisted.refuseSessionLinked.mockResolvedValue(null);
  app = await createFastifyApiTestApp(clientFilesApiPlugin);
});

afterEach(async () => {
  await app.close();
});

const upload = (payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: UPLOAD_URL, payload: { fileName: 'report.txt', data: DATA, ...payload } as never });
const json = <T = Record<string, unknown>>(res: { body: string }) => parseJsonBody<T>(res.body);
const nothingSpent = () => {
  expect(uploadFile).not.toHaveBeenCalled();
  expect(checkPerRequestLimits).not.toHaveBeenCalled();
  expect(checkRateLimit).not.toHaveBeenCalled();
  expect(checkResourceQuota).not.toHaveBeenCalled();
};

describe('upload metadata', () => {
  it.each([
    ['a text', 'a note'],
    ['a list', ['a']],
    ['a number', 5],
    ['zero', 0],
    ['a boolean', true],
    ['false', false],
  ])('refuses %s (400): the metadata is a set of named values', async (_name, metadata) => {
    const res = await upload({ metadata });
    expect(res.statusCode).toBe(400);
    expect(json(res)).toEqual({ error: 'metadata must be an object' });
    expect(getFileBucket).not.toHaveBeenCalled();
    nothingSpent();
  });

  it.each([
    ['none', {}, undefined],
    ['null', { metadata: null }, undefined],
    ['an empty object', { metadata: {} }, {}],
    ['named values', { metadata: { team: 'finance', 'cost centre': 42, nested: { a: [1, 2] } } }, { team: 'finance', 'cost centre': 42, nested: { a: [1, 2] } }],
  ])('accepts %s', async (_name, payload, expected) => {
    const res = await upload(payload);
    expect(res.statusCode).toBe(201);
    const input = mockFn(uploadFile).mock.calls[0]![3] as { metadata?: unknown };
    expect(input.metadata).toEqual(expected);
  });
});

describe('an empty file', () => {
  it('is accepted: zero bytes are a legitimate file, and the quotas are asked about zero', async () => {
    const res = await upload({ data: '' });
    expect(res.statusCode).toBe(201);
    expect(mockFn(uploadFile).mock.calls[0]![3]).toMatchObject({ data: '', fileName: 'report.txt' });
    expect(mockFn(checkPerRequestLimits).mock.calls[0]![1]).toEqual({ fileSize: 0, filesPerRequest: 1 });
  });

  it('is accepted as an empty data URL too', async () => {
    const res = await upload({ data: 'data:text/plain;base64,' });
    expect(res.statusCode).toBe(201);
    expect(mockFn(checkPerRequestLimits).mock.calls[0]![1]).toEqual({ fileSize: 0, filesPerRequest: 1 });
  });
});

describe('the session gate of an upload', () => {
  const OWNER = { tenantDbName: 'tenant_acme', projectId: 'proj-1', userId: 'user-1' };
  const holding = (key: string, conversationId: string) => ({ key, purpose: 'conversation', conversationId });
  const refuse403 = { ok: false, status: 403, reason: 'forbidden', need: 'manage' };

  it('refuses an upload under the key of a session file the token\'s owner may not manage (403), before any quota or byte', async () => {
    listFileRecordsByKeys.mockResolvedValue([holding('chats/agent/s1/report.txt', 'conv-1')]);
    hoisted.refuseSessionLinked.mockResolvedValue(refuse403);

    const res = await upload({ keyHint: 'chats/agent/s1/report.txt' });

    expect(res.statusCode).toBe(403);
    expect(json<{ error: { code: string; type: string } }>(res).error).toMatchObject({ code: 'session_forbidden', type: 'permission_error' });
    nothingSpent();
    expect(sumFileRecordBytes).not.toHaveBeenCalled();
  });

  it('asks about the session as the token\'s owner, for a change (manage)', async () => {
    listFileRecordsByKeys.mockResolvedValue([holding('chats/report.txt', 'conv-1')]);

    const res = await upload({ keyHint: 'chats/report.txt' });

    expect(res.statusCode).toBe(201);
    expect(hoisted.refuseSessionLinked).toHaveBeenCalledTimes(1);
    const [, conversationId, need, options] = hoisted.refuseSessionLinked.mock.calls[0]!;
    expect(conversationId).toBe('conv-1');
    expect(need).toBe('manage');
    expect(options).toEqual({ actor: OWNER });
  });

  it('looks for the file under the key the object lands on, in this bucket and project', async () => {
    await upload({ keyHint: '  chats//a\\b.txt  ' });
    expect(listFileRecordsByKeys).toHaveBeenCalledTimes(1);
    expect(listFileRecordsByKeys).toHaveBeenCalledWith({
      providerKey: 'disk',
      bucketKey: 'docs',
      projectId: 'proj-1',
      keys: ['chats/a/b.txt'],
    });
  });

  it('lets the upload through when the token\'s owner may manage the session', async () => {
    listFileRecordsByKeys.mockResolvedValue([holding('chats/report.txt', 'conv-1')]);
    hoisted.refuseSessionLinked.mockResolvedValue(null);

    const res = await upload({ keyHint: 'chats/report.txt' });

    expect(res.statusCode).toBe(201);
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it('answers 503 when the session cannot be checked (never an allow), before any quota or byte', async () => {
    listFileRecordsByKeys.mockResolvedValue([holding('chats/report.txt', 'conv-1')]);
    hoisted.refuseSessionLinked.mockResolvedValue({ ok: false, status: 503, reason: 'unavailable', need: 'manage' });

    const res = await upload({ keyHint: 'chats/report.txt' });

    expect(res.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('authorization_unavailable');
    nothingSpent();
  });

  it('refuses when any of the sessions holding that key is refused', async () => {
    // A legacy duplicate: two records of one key, of two sessions.
    listFileRecordsByKeys.mockResolvedValue([holding('shared.txt', 'conv-mine'), holding('shared.txt', 'conv-theirs')]);
    hoisted.refuseSessionLinked.mockImplementation(async (_request: unknown, conversationId: string) => (conversationId === 'conv-theirs' ? refuse403 : null));

    const res = await upload({ keyHint: 'shared.txt' });

    expect(res.statusCode).toBe(403);
    expect(hoisted.refuseSessionLinked).toHaveBeenCalledTimes(2);
    nothingSpent();
  });

  it.each([
    ['a file that no session holds', [{ key: 'plain.txt', purpose: 'attachment' }]],
    ['a file with no purpose', [{ key: 'plain.txt' }]],
    ['a key with nothing under it', []],
  ])('does not ask about a session for %s', async (_name, occupants) => {
    listFileRecordsByKeys.mockResolvedValue(occupants);
    const res = await upload({ keyHint: 'plain.txt' });
    expect(res.statusCode).toBe(201);
    expect(hoisted.refuseSessionLinked).not.toHaveBeenCalled();
  });

  it.each([
    ['no hint (the file gets a generated name of its own)', {}],
    ['an empty hint', { keyHint: '' }],
    ['a folder', { keyHint: 'chats/agent/s1/' }],
  ])('looks nothing up for %s: there is no file to write over', async (_name, payload) => {
    const res = await upload(payload);
    expect(res.statusCode).toBe(201);
    expect(listFileRecordsByKeys).not.toHaveBeenCalled();
    expect(hoisted.refuseSessionLinked).not.toHaveBeenCalled();
  });

  it('is asked after the bucket: a missing or switched-off bucket is answered first', async () => {
    mockFn(getFileBucket).mockResolvedValue({ id: 'b1', key: 'docs', status: 'inactive', providerKey: 'disk' });
    listFileRecordsByKeys.mockResolvedValue([holding('chats/report.txt', 'conv-1')]);
    hoisted.refuseSessionLinked.mockResolvedValue(refuse403);

    const res = await upload({ keyHint: 'chats/report.txt' });

    expect(res.statusCode).toBe(409);
    expect(listFileRecordsByKeys).not.toHaveBeenCalled();
  });
});

describe('the quotas of an upload are asked about the bytes that will be stored', () => {
  const fileSizeLimit = (limit: number) => mockFn(checkPerRequestLimits).mockImplementation(async (_context: unknown, request: { fileSize?: number }) => (
    (request.fileSize ?? 0) > limit
      ? { allowed: false, reason: `File size ${request.fileSize} exceeds the per-file limit of ${limit} bytes` }
      : { allowed: true, effectiveLimits: {} }
  ));

  it('counts the decoded bytes of plain base64', async () => {
    fileSizeLimit(1000);
    expect((await upload({ data: Buffer.alloc(1000, 1).toString('base64') })).statusCode).toBe(201);
    expect((await upload({ data: Buffer.alloc(1001, 1).toString('base64') })).statusCode).toBe(429);
  });

  it('counts the decoded bytes of a data URL without its head', async () => {
    fileSizeLimit(1000);
    expect((await upload({ data: `data:application/octet-stream;base64,${Buffer.alloc(1000, 1).toString('base64')}` })).statusCode).toBe(201);
    expect((await upload({ data: `data:application/octet-stream;base64,${Buffer.alloc(1001, 1).toString('base64')}` })).statusCode).toBe(429);
  });

  it('does not take a "base64," inside the text for the start of the payload', async () => {
    fileSizeLimit(1000);
    // The service decodes all of this text (what is not base64 is skipped), so that is what the quota counts: about
    // 2000 bytes, not the 1 byte after the last "base64,".
    const crafted = `${'A'.repeat(2668)}base64,AA`;
    expect(Buffer.from(crafted, 'base64').length).toBeGreaterThan(1000);

    const res = await upload({ data: crafted });

    expect(res.statusCode).toBe(429);
    expect(json<{ error: string }>(res).error).toMatch(/exceeds the per-file limit of 1000 bytes/);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('counts the decoded bytes when the text has line breaks, spaces and characters outside the alphabet', async () => {
    fileSizeLimit(1000);
    const body = Buffer.alloc(1200, 7).toString('base64').replace(/(.{76})/g, '$1\n').replace(/A/g, 'A ,');
    expect(Buffer.from(body, 'base64').length).toBe(1200);
    expect((await upload({ data: body })).statusCode).toBe(429);
  });

  it('asks the rate limit and the storage projection about the same number', async () => {
    mockFn(checkPerRequestLimits).mockResolvedValue({ allowed: true, effectiveLimits: { quotas: { maxStorageBytes: 1000 } } });
    sumFileRecordBytes.mockResolvedValue(500);
    const crafted = `${'A'.repeat(800)}base64,AA`;
    const decoded = Buffer.from(crafted, 'base64').length;
    expect(decoded).toBeGreaterThan(500);

    const res = await upload({ data: crafted });

    expect(mockFn(checkRateLimit).mock.calls[0]![1]).toEqual({ files: 1, requests: 1, storageBytes: decoded });
    expect(res.statusCode).toBe(429);
    expect(json<{ error: string }>(res).error).toBe(`storageBytes limit exceeded (${500 + decoded}/1000)`);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('lets an upload through that fits the storage quota', async () => {
    mockFn(checkPerRequestLimits).mockResolvedValue({ allowed: true, effectiveLimits: { quotas: { maxStorageBytes: 1000 } } });
    sumFileRecordBytes.mockResolvedValue(500);

    const res = await upload({ data: Buffer.alloc(500, 1).toString('base64') });

    expect(res.statusCode).toBe(201);
    expect(mockFn(checkRateLimit).mock.calls[0]![1]).toEqual({ files: 1, requests: 1, storageBytes: 500 });
  });
});
