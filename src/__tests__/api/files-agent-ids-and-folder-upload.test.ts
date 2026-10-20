/**
 * The Document Store routes (`plugins/files.ts`) for session files: a row that
 * belongs to an agent's session carries the agent's `_id` (`agentId`, so the
 * Session link can be built), and an upload can name the folder it goes into.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    requireProjectContextForRequest: vi.fn(),
    sendProjectContextError: vi.fn().mockReturnValue(null),
  };
});
// Who may see which session file is the session access module's question (api/agent-session-access-routes.test.ts has the
// real engine behind it); these tests are about the listing's parameters, so the default caller - who sees every
// session - stands in: one plain read of the unfiltered list.
vi.mock('@/server/api/plugins/agent-session-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/plugins/agent-session-access')>();
  return {
    ...actual,
    pageOfVisibleRows: async (_request: unknown, input: { start: unknown; limit: number; fetchPage: (position: unknown, size: number) => Promise<{ rows: unknown[]; after: (consumed: number) => unknown }> }) => {
      const page = await input.fetchPage(input.start, input.limit);
      return { restricted: false, rows: page.rows, next: page.after(page.rows.length) };
    },
  };
});
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  // The gate reads the caller (and the engine its policies) through the tenant scope.
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
    createFileBucket: vi.fn(),
    createFileProvider: vi.fn(),
    deleteFile: vi.fn(),
    deleteFileBucket: vi.fn(),
    downloadFile: vi.fn(),
    getFileBucket: vi.fn(),
    getFileRecord: vi.fn(),
    listFileBuckets: vi.fn(),
    listFileProviders: vi.fn(),
    listFiles: vi.fn(),
    updateFileBucket: vi.fn(),
    uploadFile: vi.fn(),
  };
});

import { getDatabase } from '@/lib/database';
import { requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { getFileBucket, getFileRecord, listFiles, uploadFile } from '@/lib/services/files';
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

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let findAgentByKey: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  mockFn(requireProjectContextForRequest).mockResolvedValue(CTX);
  mockFn(getFileBucket).mockResolvedValue({ id: 'b1', key: 'docs', status: 'active', providerKey: 'disk' });
  findAgentByKey = vi.fn(async (key: string) => (key === 'support' ? { _id: 'agent-77', key } : null));
  mockFn(getDatabase).mockResolvedValue(createMockDb({ switchToTenant: vi.fn(), findAgentByKey, countFileRecords: vi.fn(async () => 0), sumFileRecordBytes: vi.fn(async () => 0), listFileRecordsByKeys: vi.fn(async () => []) } as never));
  app = await createFastifyApiTestApp(filesApiPlugin);
});

afterEach(async () => {
  await app.close();
});

describe('session files carry their agent’s _id', () => {
  const sessionFile = (id: string, agentKey: string) => ({ id, name: `${id}.txt`, purpose: 'conversation', conversationId: 'c1', agentKey });

  it('in a listing: only session rows get one, each agent is looked up once, a vanished agent leaves the row as it was', async () => {
    mockFn(listFiles).mockResolvedValue({
      items: [sessionFile('a', 'support'), sessionFile('b', 'support'), sessionFile('c', 'deleted-agent'), { id: 'd', name: 'plain.txt' }],
      folders: ['agent-sessions/'], prefix: '',
    });
    const res = await app.inject({ method: 'GET', url: '/api/files/buckets/docs/objects?prefix=', headers });

    const items = parseJsonBody<{ items: Array<Record<string, unknown>> }>(res.body).items;
    expect(items.map((item) => item.agentId)).toEqual(['agent-77', 'agent-77', undefined, undefined]);
    expect(items[3]).toEqual({ id: 'd', name: 'plain.txt' });
    expect(findAgentByKey.mock.calls.map((call) => call[0]).sort()).toEqual(['deleted-agent', 'support']);
    expect(findAgentByKey).toHaveBeenCalledWith('support', 'proj-1');
  });

  it('a listing without session files does not look anything up', async () => {
    mockFn(listFiles).mockResolvedValue({ items: [{ id: 'd', name: 'plain.txt' }] });
    await app.inject({ method: 'GET', url: '/api/files/buckets/docs/objects', headers });
    expect(findAgentByKey).not.toHaveBeenCalled();
  });

  it('a failing lookup never fails the listing', async () => {
    findAgentByKey.mockRejectedValue(new Error('db down'));
    mockFn(listFiles).mockResolvedValue({ items: [sessionFile('a', 'support')] });
    const res = await app.inject({ method: 'GET', url: '/api/files/buckets/docs/objects', headers });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ items: Array<Record<string, unknown>> }>(res.body).items[0]).not.toHaveProperty('agentId');
  });

  it('on the single-record read too', async () => {
    mockFn(getFileRecord).mockResolvedValue(sessionFile('a', 'support'));
    const res = await app.inject({ method: 'GET', url: '/api/files/buckets/docs/objects/agent-sessions/support/c1/a.txt', headers });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ record: Record<string, unknown> }>(res.body).record).toMatchObject({ id: 'a', agentId: 'agent-77' });
  });
});

describe('uploading into a folder', () => {
  const upload = (payload: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/api/files/buckets/docs/objects', headers,
    payload: { fileName: 'notes.txt', data: Buffer.from('hello').toString('base64'), ...payload },
  });
  beforeEach(() => {
    mockFn(uploadFile).mockResolvedValue({ record: { id: 'f1' } });
  });
  const hint = () => mockFn(uploadFile).mock.calls[0]![3].keyHint as string | undefined;

  it('`folder` puts the file in it under a generated name; `prefix` is the same', async () => {
    expect((await upload({ folder: 'reports/2026' })).statusCode).toBe(201);
    expect(hint()).toBe('reports/2026/');
    mockFn(uploadFile).mockClear();
    await upload({ prefix: '/reports//q1/' });
    expect(hint()).toBe('reports/q1/');
  });

  it('`folder` with a `keyHint` makes the hint the file’s name inside the folder', async () => {
    await upload({ folder: 'reports/', keyHint: 'q1.txt' });
    expect(hint()).toBe('reports/q1.txt');
  });

  it('without a folder it is what it always was: no hint, or the hint as given', async () => {
    await upload({});
    expect(mockFn(uploadFile).mock.calls[0]![3]).not.toHaveProperty('keyHint');
    await upload({ keyHint: 'archive/' });
    expect(mockFn(uploadFile).mock.calls[1]![3].keyHint).toBe('archive/');
    await upload({ folder: '' });
    expect(mockFn(uploadFile).mock.calls[2]![3]).not.toHaveProperty('keyHint');
  });

  it('a folder that climbs out of the bucket, or is not text, is a 400 and nothing is stored', async () => {
    for (const folder of ['../etc', 'a/../../b', 'a/./b', 12, ['x']]) {
      const res = await upload({ folder });
      expect(res.statusCode, JSON.stringify(folder)).toBe(400);
    }
    expect((await upload({ folder: 'ok', keyHint: '../x' })).statusCode).toBe(400);
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
