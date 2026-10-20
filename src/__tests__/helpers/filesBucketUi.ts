/**
 * Fixtures and a fake Files server for the bucket page's component tests. The server answers the dashboard routes
 * the page calls (`/api/files/...`, the saved-provider test, the session that carries the person's level) from
 * mutable state, so a test changes what the server holds and watches what the page does with it.
 *
 * It sits on `installApiMock` (see `iamCenterUi.ts`): every call is recorded, and `server.api.on(...)` replaces a
 * route for one test.
 */

import type { FileRecordView } from '@/lib/services/files';
import type {
  BucketDetail,
  FileProviderListItem,
  ProviderTestResult,
  FileLimits,
  ImportFromStorageResult,
} from '@/components/files/filesApi';
import { fileKindOf } from '@/components/files/shared/fileKind';
import { installApiMock, jsonResponse, type ApiMock, type RecordedCall } from './iamCenterUi';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const MIB = 1024 * 1024;
export const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  txt: 'text/plain',
  md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** A file record as the listing sends it: dates are ISO strings, not `Date`s. */
export function fileRecord(key: string, extra: Partial<FileRecordView> = {}): FileRecordView {
  const name = key.split('/').pop() ?? key;
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return {
    id: `id:${key}`,
    tenantId: 't1',
    providerKey: 'minio',
    bucketKey: 'docs',
    key,
    name,
    size: 2048,
    contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
    markdownStatus: 'skipped',
    createdBy: 'u1',
    createdAt: ago(5 * HOUR),
    updatedAt: ago(2 * HOUR),
    ...extra,
  } as unknown as FileRecordView;
}

export const MINIO = {
  _id: 'prov-minio',
  tenantId: 't1',
  key: 'minio',
  label: 'MinIO (on-prem)',
  driver: 'aws-s3-files',
  type: 'file',
  status: 'active',
  hasCredentials: true,
} as unknown as FileProviderListItem;

export const LOCAL_DISK = {
  _id: 'prov-local',
  tenantId: 't1',
  key: 'local',
  label: 'Local filesystem',
  driver: 'local-filesystem',
  type: 'file',
  status: 'active',
  hasCredentials: false,
} as unknown as FileProviderListItem;

export function bucketDetail(extra: Partial<BucketDetail> = {}): BucketDetail {
  return {
    id: 'b-docs',
    tenantId: 't1',
    key: 'docs',
    name: 'Docs',
    description: 'Contracts and reports',
    providerKey: 'minio',
    status: 'active',
    prefix: 'docs',
    createdBy: 'u1',
    createdAt: ago(40 * 24 * HOUR),
    updatedAt: ago(2 * HOUR),
    stats: { fileCount: 3, totalBytes: 6 * MIB },
    providerHealth: { state: 'ok', testedAt: ago(2 * HOUR) },
    provider: MINIO,
    usedBy: [],
    storageLocation: 's3://files/console/t1/minio/docs/',
    ...extra,
  } as unknown as BucketDetail;
}

/**
 * A bucket whose "delete with its files" job was asked for `askedAgoMs` ago: switched off, `deleting`, and touched
 * when the job was marked (so `updatedAt` says how long it has been running).
 */
export function deletingBucket(askedAgoMs: number, extra: Partial<BucketDetail> = {}): BucketDetail {
  return bucketDetail({ deleting: true, status: 'disabled', updatedAt: ago(askedAgoMs) as unknown as Date, ...extra });
}

/** A bucket whose last "delete with its files" run stopped: the reason is on the bucket, `deleting` is cleared. */
export function failedDeleteBucket(reason: string, extra: Partial<BucketDetail> = {}): BucketDetail {
  return bucketDetail({
    deleting: false,
    deleteError: reason,
    status: 'disabled',
    metadata: { deleteError: reason },
    ...extra,
  });
}

export const LIMITS: FileLimits = {
  maxFileBytes: 25 * MIB,
  maxRequestBytes: 30 * MIB,
  allowedMimeTypes: null,
  quota: { usedBytes: 6 * MIB, limitBytes: 100 * MIB, filesUsed: 3, filesLimit: 1000 },
};

/* ── The listing ─────────────────────────────────────────────────────────── */

/**
 * The objects listing of the server over `records`: one folder (`prefix`) with its sub-folders, or a flat list of
 * the matches for a search or a type; the purpose filter; and cursor paging (the cursor is an offset).
 */
export function listObjects(records: readonly FileRecordView[], query: Record<string, string>) {
  const prefix = query.prefix ?? '';
  const search = (query.search ?? '').toLowerCase();
  const flat = Boolean(search || query.type);
  const limit = Number(query.limit ?? '50');
  let matches = records.filter((record) => record.key.startsWith(prefix));
  if (search) matches = matches.filter((record) => record.name.toLowerCase().includes(search));
  if (query.type) matches = matches.filter((record) => fileKindOf(record) === query.type);
  if (query.purpose === 'conversation') matches = matches.filter((record) => record.purpose === 'conversation');
  if (query.purpose === 'other') matches = matches.filter((record) => record.purpose !== 'conversation');

  let folders: string[] = [];
  if (!flat) {
    const rest = (record: FileRecordView) => record.key.slice(prefix.length);
    folders = [...new Set(matches.filter((record) => rest(record).includes('/')).map((record) => `${prefix}${rest(record).split('/')[0]}/`))];
    matches = matches.filter((record) => !rest(record).includes('/'));
  }
  const start = query.cursor ? Number(query.cursor) : 0;
  const items = matches.slice(start, start + limit);
  const next = start + items.length < matches.length ? String(start + items.length) : undefined;
  return {
    items,
    folders: start === 0 ? folders : [],
    ...(flat ? {} : { prefix }),
    ...(next ? { nextCursor: next } : {}),
  };
}

/* ── The server ──────────────────────────────────────────────────────────── */

export interface BucketServerOptions {
  /** The person's level for Files (`GET /api/auth/session`); `write` by default. */
  level?: 'read' | 'write' | 'admin';
  bucket?: BucketDetail;
  records?: FileRecordView[];
  limits?: FileLimits;
}

export interface BucketServer {
  api: ApiMock;
  bucket: BucketDetail;
  records: FileRecordView[];
  limits: FileLimits;
  /** key -> why a batch delete refuses it. */
  refuse: Map<string, string>;
  /** What the bucket DELETE answers: gone, a job started, or a refusal. It sees the request (`query` says which kind). */
  deleteAnswer: (call: RecordedCall) => Response;
  /** What the provider test answers. */
  testAnswer: () => Response;
  /** The answers of the import scan, one per request; the last repeats. */
  importPages: ImportFromStorageResult[];
  /** Make the next calls of a route fail with this answer until cleared. */
  fail: { bucket?: Response; objects?: Response; limits?: Response; patch?: Response };
}

const errorResponse = (status: number, body: Record<string, unknown>) => jsonResponse(body, status);

/** The bucket without the reason its last delete stopped (the bucket view and its metadata both carry it). */
function withoutDeleteError(bucket: BucketDetail): BucketDetail {
  const cleared: Record<string, unknown> = { ...bucket };
  delete cleared.deleteError;
  if (bucket.metadata) {
    const metadata: Record<string, unknown> = { ...bucket.metadata };
    delete metadata.deleteError;
    cleared.metadata = metadata;
  }
  return cleared as unknown as BucketDetail;
}

export function installBucketServer(options: BucketServerOptions = {}): BucketServer {
  const server: BucketServer = {
    api: undefined as unknown as ApiMock,
    bucket: options.bucket ?? bucketDetail(),
    records: options.records ?? [],
    limits: options.limits ?? LIMITS,
    refuse: new Map(),
    deleteAnswer: () => jsonResponse({ success: true }),
    testAnswer: () =>
      jsonResponse({
        ok: true,
        latencyMs: 12,
        message: 'Connection OK',
        details: {
          steps: [
            { step: 'list', ok: true },
            { step: 'write', ok: true },
            { step: 'read', ok: true },
            { step: 'delete', ok: true },
          ],
        } satisfies ProviderTestResult['details'],
      }),
    importPages: [{ scanned: 3, imported: 2, skipped: 1 }],
    fail: {},
  };
  const level = options.level ?? 'write';
  let importCalls = 0;

  server.api = installApiMock([
    ['GET', '/api/auth/session', () => ({ effectivePermissions: { files: level } })],
    ['GET', /^\/api\/files\/buckets\/[^/]+$/, () => server.fail.bucket?.clone() ?? { bucket: server.bucket }],
    ['GET', /^\/api\/files\/buckets\/[^/]+\/objects$/, (call: RecordedCall) => server.fail.objects?.clone() ?? listObjects(server.records, call.query)],
    ['GET', '/api/files/limits', () => server.fail.limits?.clone() ?? server.limits],
    [
      'PATCH',
      /^\/api\/files\/buckets\/[^/]+$/,
      (call: RecordedCall) => {
        if (server.fail.patch) return server.fail.patch.clone();
        const patch = call.body as Record<string, unknown>;
        // Switching a bucket on again is how the server forgets why its last delete stopped.
        server.bucket = { ...(patch.status === 'active' ? withoutDeleteError(server.bucket) : server.bucket), ...patch } as BucketDetail;
        return { bucket: server.bucket };
      },
    ],
    [
      'POST',
      /^\/api\/files\/buckets\/[^/]+\/objects\/batch-delete$/,
      (call: RecordedCall) => {
        const keys = (call.body as { keys: string[] }).keys;
        const deleted = keys.filter((key) => !server.refuse.has(key));
        const failed = keys.filter((key) => server.refuse.has(key)).map((key) => ({ key, error: server.refuse.get(key)! }));
        server.records = server.records.filter((record) => !deleted.includes(record.key));
        return { deleted, failed };
      },
    ],
    [
      'POST',
      /^\/api\/files\/buckets\/[^/]+\/objects\/archive$/,
      () => new Response('zip-bytes', { status: 200, headers: { 'Content-Type': 'application/zip' } }),
    ],
    [
      'GET',
      /^\/api\/files\/buckets\/[^/]+\/objects\/.+$/,
      () => new Response('file-bytes', { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
    ],
    ['DELETE', /^\/api\/files\/buckets\/[^/]+$/, (call: RecordedCall) => server.deleteAnswer(call)],
    [
      'POST',
      /^\/api\/files\/buckets\/[^/]+\/import$/,
      () => {
        const page = server.importPages[Math.min(importCalls, server.importPages.length - 1)]!;
        importCalls += 1;
        return page;
      },
    ],
    ['POST', /^\/api\/providers\/[^/]+\/test$/, () => server.testAnswer()],
  ]);
  return server;
}

/** A refusal in the server's own shape: `{ error, code }`. */
export const refusal = (status: number, error: string, code?: string, extra: Record<string, unknown> = {}) =>
  errorResponse(status, { error, ...(code ? { code } : {}), ...extra });
