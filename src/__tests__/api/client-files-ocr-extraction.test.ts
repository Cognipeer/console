/**
 * The client Files API's optional OCR settings (`plugins/client-files.ts`): an upload's `ocr` and `images` are checked
 * before any quota is spent (400 with a sentence) and handed to the file service as `extraction`; an upload without
 * them reaches the service exactly as before.
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
  validateModel: vi.fn(),
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
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
}));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkPerRequestLimits: vi.fn(async () => ({ allowed: true, effectiveLimits: {} })),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  checkResourceQuota: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('@/lib/services/extraction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/extraction')>();
  return { ...actual, validateOcrModelRef: hoisted.validateModel };
});
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
import { checkPerRequestLimits } from '@/lib/quota/quotaGuard';
import { getFileBucket, uploadFile } from '@/lib/services/files';
import { clientFilesApiPlugin } from '@/server/api/plugins/client-files';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const UPLOAD_URL = '/api/client/v1/files/buckets/docs/objects';
const DATA = Buffer.from('hello').toString('base64');

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.validateModel.mockResolvedValue(undefined);
  mockFn(getDatabase).mockResolvedValue(createMockDb({
    switchToTenant: vi.fn(),
    countFileRecords: vi.fn(async () => 0),
    sumFileRecordBytes: vi.fn(async () => 0),
  } as never));
  mockFn(getFileBucket).mockResolvedValue({ id: 'b1', key: 'docs', status: 'active', providerKey: 'disk' });
  mockFn(uploadFile).mockResolvedValue({ record: { id: 'f1', key: 'stored.pdf' } });
  app = await createFastifyApiTestApp(clientFilesApiPlugin);
});

afterEach(async () => {
  await app.close();
});

const upload = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: UPLOAD_URL, payload: { fileName: 'scan.pdf', data: DATA, ...payload } as never });
const serviceInput = () => mockFn(uploadFile).mock.calls[0]![3] as Record<string, unknown>;

describe('upload ocr / images', () => {
  it('hands a valid setting to the service as extraction, compact and normalized', async () => {
    const res = await upload({ convertToMarkdown: true, ocr: { mode: 'auto', languages: ['TUR', 'en', 'tr'], modelKey: ' mistral ' }, images: 'omit' });

    expect(res.statusCode).toBe(201);
    expect(serviceInput()).toMatchObject({
      convertToMarkdown: true,
      extraction: { ocr: { mode: 'auto', modelKey: 'mistral', languages: ['tr', 'en'] }, images: 'omit' },
    });
    expect(hoisted.validateModel).toHaveBeenCalledWith({ tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' }, 'mistral');
  });

  it('reaches the service without extraction when the request has no OCR settings, or has OCR off', async () => {
    expect((await upload({})).statusCode).toBe(201);
    expect('extraction' in serviceInput()).toBe(false);

    mockFn(uploadFile).mockClear();
    expect((await upload({ ocr: { mode: 'off' }, images: 'inline' })).statusCode).toBe(201);
    expect('extraction' in serviceInput()).toBe(false);

    mockFn(uploadFile).mockClear();
    expect((await upload({ ocr: null })).statusCode).toBe(201);
    expect('extraction' in serviceInput()).toBe(false);
    expect(hoisted.validateModel).not.toHaveBeenCalled();
  });

  it.each([
    ['ocr as a string', { ocr: 'auto' }, 'ocr must be an object'],
    ['a missing mode', { ocr: {} }, "ocr.mode must be one of 'off', 'auto', 'always'"],
    ['an unknown key', { ocr: { mode: 'auto', dpi: 300 } }, 'ocr.dpi is not a known setting'],
    ['too many languages', { ocr: { mode: 'auto', languages: Array.from({ length: 9 }, () => 'en') } }, 'at most 8 languages'],
    ['images that is no policy', { images: true }, "images must be one of 'inline', 'placeholder', 'omit'"],
  ])('answers 400 for %s before any quota is spent', async (_label, payload, message) => {
    const res = await upload(payload);

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toContain(message);
    expect(checkPerRequestLimits).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('answers 400 with the reason when the OCR model is not usable', async () => {
    hoisted.validateModel.mockResolvedValue('The model "chat-1" cannot read documents: it must be an OCR model or a vision model.');

    const res = await upload({ ocr: { mode: 'always', modelKey: 'chat-1' } });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toContain('cannot read documents');
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
