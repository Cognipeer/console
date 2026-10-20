/**
 * The client Files API addresses a file by its key as ONE URL parameter (`/objects/:objectKey`). A key may be 1024
 * characters long, and a character outside ASCII takes up to nine of them in the URL (`%E6%97%A5`), so the router
 * of the server (`createFastifyInstance`) has to take a long parameter: Fastify's own default, 100 characters, refuses
 * anything longer (414) - a file stored through the Document Store could not be read back.
 */
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
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
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    withClientApiRequestContext: (handler: (...args: unknown[]) => unknown) =>
      (request: unknown, reply: unknown) => handler(request, reply, hoisted.auth),
    getApiTokenContextForRequest: async () => hoisted.auth,
  };
});
vi.mock('@/server/api/plugins/agent-session-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/plugins/agent-session-access')>();
  return { ...actual, refuseSessionLinked: vi.fn(async () => null) };
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
import { deleteFile, downloadFile, getFileRecord } from '@/lib/services/files';
import { clientFilesApiPlugin } from '@/server/api/plugins/client-files';
import { createFastifyInstance, MAX_URL_PARAM_LENGTH } from '@/server/app';
import { createMockDb } from '../helpers/db.mock';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const BASE = '/api/client/v1/files/buckets/docs/objects';

/** The route set of the client Files API on an instance built the way the server builds its own (or the plain default). */
async function appOn(instance: FastifyInstance): Promise<FastifyInstance> {
  await instance.register(cookie);
  instance.addHook('onRequest', async (request) => {
    request.apiRequestId = 'test-request';
    request.apiContextHeaders = { 'x-request-id': 'test-request' };
  });
  await instance.register(clientFilesApiPlugin, { prefix: '/api' });
  await instance.ready();
  return instance;
}

let app: FastifyInstance | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mockFn(getDatabase).mockResolvedValue(createMockDb({ switchToTenant: vi.fn() } as never));
  mockFn(getFileRecord).mockImplementation(async (_db: string, _tenant: string, _project: string, _bucket: string, key: string) => ({ id: 'f1', key, name: 'a.txt' }));
  mockFn(downloadFile).mockResolvedValue({ data: Buffer.from('hello'), contentType: 'text/plain', size: 5, fileName: 'a.txt' });
  mockFn(deleteFile).mockResolvedValue(undefined);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A key as the Document Store may store it: `/` is a character of the key, so a client writes it as `%2F`. */
const urlOf = (key: string) => encodeURIComponent(key);

describe('a key longer than Fastify\'s default parameter length', () => {
  const asciiKey = (length: number) => `${'folder/'.repeat(Math.floor((length - 8) / 7))}${'k'.repeat((length - 8) % 7)}file.txt`.slice(0, length);

  it('is read back through the server\'s own instance: the record, the download and the delete', async () => {
    app = await appOn(createFastifyInstance());
    const key = asciiKey(512);
    expect(key).toHaveLength(512);

    const record = await app.inject({ method: 'GET', url: `${BASE}/${urlOf(key)}` });
    expect(record.statusCode, record.body).toBe(200);
    expect(mockFn(getFileRecord).mock.calls[0]![4]).toBe(key);

    const download = await app.inject({ method: 'GET', url: `${BASE}/${urlOf(key)}/download` });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.body).toBe('hello');

    const removal = await app.inject({ method: 'DELETE', url: `${BASE}/${urlOf(key)}` });
    expect(removal.statusCode, removal.body).toBe(200);
    expect(mockFn(deleteFile).mock.calls[0]![4]).toBe(key);
  });

  it('is still found when it is the longest key there is, written in a script that takes nine characters per letter in the URL', async () => {
    app = await appOn(createFastifyInstance());
    const key = '日'.repeat(1024);
    const written = urlOf(key);
    expect(written.length).toBe(9 * 1024);

    const res = await app.inject({ method: 'GET', url: `${BASE}/${written}` });

    expect(res.statusCode, res.body).toBe(200);
    expect(mockFn(getFileRecord).mock.calls[0]![4]).toBe(key);
  });

  it('is found at the very limit of the router and refused one character past it', async () => {
    app = await appOn(createFastifyInstance());
    const atTheLimit = 'k'.repeat(MAX_URL_PARAM_LENGTH);
    const pastIt = 'k'.repeat(MAX_URL_PARAM_LENGTH + 1);

    expect((await app.inject({ method: 'GET', url: `${BASE}/${atTheLimit}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${BASE}/${pastIt}` })).statusCode).toBe(414);
  });

  it('is the reason for the server\'s option: a plain Fastify instance does not take a key of more than 100 characters', async () => {
    app = await appOn(Fastify({ logger: false }));

    expect((await app.inject({ method: 'GET', url: `${BASE}/${'k'.repeat(100)}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${BASE}/${'k'.repeat(101)}` })).statusCode).toBe(414);
  });
});

describe('createFastifyInstance', () => {
  it('keeps the options the server always had: the body limit and the proxy trust come from the configuration', async () => {
    app = createFastifyInstance({
      limits: { bodySize: '2kb' },
      network: { trustedProxies: ['10.0.0.0/8'] },
    } as never);
    app.post('/probe', async (request) => ({ ip: request.ip, length: String((request.body as { text?: string } | undefined)?.text ?? '').length }));
    await app.ready();

    const fits = await app.inject({ method: 'POST', url: '/probe', payload: { text: 'x'.repeat(100) }, remoteAddress: '10.0.0.5', headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(fits.statusCode).toBe(200);
    expect(JSON.parse(fits.body)).toEqual({ ip: '203.0.113.9', length: 100 });

    const spoofed = await app.inject({ method: 'POST', url: '/probe', payload: { text: 'x' }, remoteAddress: '192.0.2.10', headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(JSON.parse(spoofed.body).ip).toBe('192.0.2.10');

    const tooLarge = await app.inject({ method: 'POST', url: '/probe', payload: { text: 'x'.repeat(4096) } });
    expect(tooLarge.statusCode).toBe(413);
  });
});
