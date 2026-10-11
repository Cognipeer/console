/**
 * The live Files API (`plugins/files.ts`): a bucket that agents keep session
 * files in cannot be deleted or disabled from under them, and the objects listing
 * can show one folder of a bucket (`?prefix=`) and filter session files.
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
vi.mock('@/lib/services/files', () => ({
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
}));
vi.mock('@/lib/services/agents/sessionFilesBucket', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/agents/sessionFilesBucket')>('@/lib/services/agents/sessionFilesBucket');
  return { ...actual, findAgentsUsingBucket: vi.fn() };
});

import { requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { getDatabase } from '@/lib/database';
import { deleteFileBucket, getFileBucket, listFiles, updateFileBucket } from '@/lib/services/files';
import { findAgentsUsingBucket } from '@/lib/services/agents/sessionFilesBucket';
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

beforeEach(async () => {
  vi.clearAllMocks();
  mockFn(requireProjectContextForRequest).mockResolvedValue(CTX);
  mockFn(getDatabase).mockResolvedValue(createMockDb());
  mockFn(getFileBucket).mockResolvedValue({ id: 'b1', key: 'docs' });
  mockFn(findAgentsUsingBucket).mockResolvedValue([]);
  app = await createFastifyApiTestApp(filesApiPlugin);
});

afterEach(async () => {
  await app.close();
});

describe('deleting or disabling a bucket agents keep session files in', () => {
  const inUse = [{ key: 'support', name: 'Support bot' }, { key: 'sales', name: 'Sales bot' }];

  it('refuses to delete it (409, naming the agents) — force or not', async () => {
    mockFn(findAgentsUsingBucket).mockResolvedValue(inUse);
    for (const url of ['/api/files/buckets/docs', '/api/files/buckets/docs?force=true']) {
      const res = await app.inject({ method: 'DELETE', url, headers });
      expect(res.statusCode, url).toBe(409);
      const body = parseJsonBody<{ error: string; code: string; agents: unknown[] }>(res.body);
      expect(body.code).toBe('bucket_in_use');
      expect(body.error).toContain('"docs"');
      expect(body.error).toContain('Support bot, Sales bot');
      expect(body.agents).toEqual(inUse);
    }
    expect(findAgentsUsingBucket).toHaveBeenCalledWith('tenant_acme', 'proj-1', 'docs');
    expect(deleteFileBucket).not.toHaveBeenCalled();
  });

  it('refuses to disable it, but allows everything else about it', async () => {
    mockFn(findAgentsUsingBucket).mockResolvedValue(inUse);
    const disable = await app.inject({ method: 'PATCH', url: '/api/files/buckets/docs', headers, payload: { status: 'disabled' } });
    expect(disable.statusCode).toBe(409);
    expect(parseJsonBody<{ code: string; error: string }>(disable.body)).toMatchObject({ code: 'bucket_in_use', error: expect.stringContaining('before you disable it') });
    expect(updateFileBucket).not.toHaveBeenCalled();

    mockFn(updateFileBucket).mockResolvedValue({ id: 'b1', key: 'docs', name: 'Renamed' });
    for (const payload of [{ name: 'Renamed' }, { status: 'active' }, { description: 'x' }]) {
      const ok = await app.inject({ method: 'PATCH', url: '/api/files/buckets/docs', headers, payload });
      expect(ok.statusCode, JSON.stringify(payload)).toBe(200);
    }
  });

  it('a bucket no agent points at is deleted and disabled as before', async () => {
    mockFn(deleteFileBucket).mockResolvedValue(true);
    mockFn(updateFileBucket).mockResolvedValue({ id: 'b1', key: 'docs', status: 'disabled' });
    expect((await app.inject({ method: 'DELETE', url: '/api/files/buckets/docs', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: '/api/files/buckets/docs', headers, payload: { status: 'disabled' } })).statusCode).toBe(200);
  });

  it('a bucket that does not exist is a 404, not an agent-in-use 409', async () => {
    mockFn(getFileBucket).mockRejectedValue(new Error('File bucket not found.'));
    mockFn(findAgentsUsingBucket).mockResolvedValue(inUse); // a stale reference
    mockFn(deleteFileBucket).mockResolvedValue(false);
    mockFn(updateFileBucket).mockRejectedValue(new Error('File bucket not found.'));
    expect((await app.inject({ method: 'DELETE', url: '/api/files/buckets/gone', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: '/api/files/buckets/gone', headers, payload: { status: 'disabled' } })).statusCode).toBe(404);
  });
});

describe('listing a bucket by folder', () => {
  it('without ?prefix the listing is the flat one it always was', async () => {
    mockFn(listFiles).mockResolvedValue({ items: [{ id: 'f1' }], nextCursor: 'c2' });
    const res = await app.inject({ method: 'GET', url: '/api/files/buckets/docs/objects', headers });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toEqual({ items: [{ id: 'f1' }], nextCursor: 'c2' });
    expect(mockFn(listFiles).mock.calls[0]![3]).not.toHaveProperty('prefix');
    expect(mockFn(listFiles).mock.calls[0]![3]).not.toHaveProperty('purpose');
  });

  it('?prefix= (even empty) lists one folder: its files and its sub-folders', async () => {
    mockFn(listFiles).mockResolvedValue({ items: [{ id: 'f1' }], folders: ['agent-sessions/bot-a/'], prefix: 'agent-sessions/', nextCursor: undefined });
    const res = await app.inject({ method: 'GET', url: '/api/files/buckets/docs/objects?prefix=agent-sessions/&limit=20', headers });
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toEqual({ items: [{ id: 'f1' }], folders: ['agent-sessions/bot-a/'], prefix: 'agent-sessions/' });
    expect(mockFn(listFiles).mock.calls[0]![3]).toMatchObject({ bucketKey: 'docs', prefix: 'agent-sessions/', limit: 20 });

    await app.inject({ method: 'GET', url: '/api/files/buckets/docs/objects?prefix=', headers });
    expect(mockFn(listFiles).mock.calls[1]![3]).toMatchObject({ prefix: '' });
  });

  it('?purpose=conversation|other filters to session files or the rest; anything else is ignored', async () => {
    mockFn(listFiles).mockResolvedValue({ items: [] });
    await app.inject({ method: 'GET', url: '/api/files/buckets/docs/objects?purpose=conversation', headers });
    await app.inject({ method: 'GET', url: '/api/files/buckets/docs/objects?purpose=other', headers });
    await app.inject({ method: 'GET', url: '/api/files/buckets/docs/objects?purpose=bogus', headers });
    expect(mockFn(listFiles).mock.calls[0]![3]).toMatchObject({ purpose: 'conversation' });
    expect(mockFn(listFiles).mock.calls[1]![3]).toMatchObject({ purpose: 'other' });
    expect(mockFn(listFiles).mock.calls[2]![3]).not.toHaveProperty('purpose');
  });
});
