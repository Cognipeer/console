/**
 * The Document Store (Files) API as the dashboard calls it: every route, query
 * parameter and request/response type in one place, with typed fetchers on top.
 *
 * Routes live under `/api/files` (plus the saved-provider test of the Providers
 * API); the paths are built by `filesRoutes`, never by hand in a component. Errors
 * of every call are a `FilesApiError` built from the `{ error, code }` body, so a
 * screen branches on `status` / `code` and shows `filesErrorMessage(...)` (see
 * `shared/filesErrors.ts`).
 *
 * The view types extend the ones the server already exports (`FileBucketView`,
 * `FileRecordView`, `FileProviderView`) with the fields the overhauled routes add.
 * Nothing here talks to React: `useFilesQueries.ts` wraps these for components.
 */

import { ApiError } from '@/lib/api/client';
import type { FileBucketView, FileProviderView, FileRecordView } from '@/lib/services/files';

/* ── Errors ──────────────────────────────────────────────────────────────── */

/**
 * The `code` values the Files routes answer with next to `error`. A call can
 * carry other codes (a code is additive); `FilesApiError.code` is a plain string.
 */
export const FILES_ERROR_CODES = [
  'bucket_not_found',
  'bucket_inactive',
  'provider_inactive',
  'bucket_in_use',
  'prefix_locked',
  'file_too_large',
  'archive_too_large',
  'preview_unsupported',
  'conversion_unsupported',
  'storage_location_shared',
  'object_too_large',
] as const;

export type FilesErrorCode = (typeof FILES_ERROR_CODES)[number];

/** Thrown by every fetcher of this module. Extends `ApiError`, so `payload` holds the parsed body. */
export class FilesApiError extends ApiError {
  /** The machine-readable `code` of the answer, when it had one. */
  readonly code?: string;

  constructor(init: { message: string; status: number; code?: string; payload?: unknown }) {
    super(init.message, init.status, init.payload);
    this.name = 'FilesApiError';
    this.code = init.code;
  }

  /**
   * Builds the error of a failed answer. `body` is the parsed JSON (anything else is ignored);
   * `statusText` is the fallback message when the body says nothing.
   */
  static fromBody(status: number, body: unknown, statusText?: string): FilesApiError {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
    const fallback = statusText && statusText.trim() ? statusText.trim() : `HTTP ${status}`;
    let message: string | undefined;
    let code: string | undefined;

    if (record) {
      // Fastify's own errors read { statusCode, error: 'Bad Request', message: '<the reason>' }: the reason is `message`.
      const fastifyShape = typeof record.statusCode === 'number';
      const candidates = fastifyShape ? [record.message, record.error] : [record.error, record.message, record.detail];
      message = candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
      if (typeof record.code === 'string' && record.code.trim()) code = record.code.trim();
      // An envelope { error: { message, code } } (the client API's shape) is read too.
      if (!message && record.error && typeof record.error === 'object') {
        const inner = record.error as Record<string, unknown>;
        if (typeof inner.message === 'string' && inner.message.trim()) message = inner.message.trim();
        if (!code && typeof inner.code === 'string' && inner.code.trim()) code = inner.code.trim();
      }
    }

    return new FilesApiError({ message: message ?? fallback, status, code, payload: body });
  }

  /** Reads the body of a failed response (JSON or not) into an error. */
  static async fromResponse(response: Response): Promise<FilesApiError> {
    let body: unknown;
    try {
      const text = await response.text();
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return FilesApiError.fromBody(response.status, body, response.statusText);
  }

  /** The request never got an answer (offline, refused, reset). `status` is 0. */
  static network(cause: unknown): FilesApiError {
    const message = cause instanceof Error && cause.message ? cause.message : 'Network request failed';
    return new FilesApiError({ message, status: 0, code: 'network_error' });
  }
}

export function isFilesApiError(error: unknown): error is FilesApiError {
  return error instanceof FilesApiError;
}

/* ── Types ───────────────────────────────────────────────────────────────── */

/** The classes of the objects listing's `type` filter. */
export type FileTypeFilter = 'pdf' | 'image' | 'text' | 'office' | 'other';

export type ProviderHealthState = 'ok' | 'failed' | 'untested' | 'builtin' | 'inactive';

/** A provider's standing, from its status and the outcome of its last connection test. */
export interface ProviderHealth {
  state: ProviderHealthState;
  /** ISO time of the last test; absent when it was never tested. */
  testedAt?: string;
  /** Why the provider is in this state (the test's message, or the reason it is disabled). */
  message?: string;
}

/** Count and size of everything a bucket holds, session files included. */
export interface BucketStats {
  fileCount: number;
  /** Original sizes plus the Markdown copies. */
  totalBytes: number;
}

/** `GET /files/providers`: a file provider with its health and where it keeps files. */
export interface FileProviderListItem extends FileProviderView {
  providerHealth: ProviderHealth;
  /** Physical location up to and including `<providerKey>/`, so the create form can preview `${base}${prefix}`; null = this server's disk. */
  storageLocationBase: string | null;
}

/** `GET /files/buckets`: a bucket with its stats and its provider's health. */
export interface BucketListItem extends FileBucketView {
  stats: BucketStats;
  providerHealth: ProviderHealth;
  /** A delete-with-files job is running; the bucket is disabled meanwhile. */
  deleting?: boolean;
}

/** An agent whose Files settings name the bucket. */
export interface BucketUsedByAgent {
  agentId: string;
  agentKey: string;
  name: string;
}

/** `GET /files/buckets/:bucketKey`. */
export interface BucketDetail extends BucketListItem {
  usedBy: BucketUsedByAgent[];
  /** Human-readable physical location (no credentials, no server paths); null = this server's disk. */
  storageLocation: string | null;
}

export type ObjectPurposeFilter = 'conversation' | 'other';

/** The parameters of the objects listing. */
export interface ObjectsQuery {
  /**
   * The folder to list: `''` is the bucket root, otherwise no leading slash and one trailing slash.
   * Defined (even empty), the listing is that one folder: its files and its sub-folders (`folders`).
   */
  prefix?: string;
  /** A name search under `prefix`. A search is a FLAT listing: matches anywhere below, no `folders`. */
  search?: string;
  /** A class of file. Behaves like `search`: a flat listing of the matches anywhere below `prefix`. */
  type?: FileTypeFilter;
  /** Only session files (`conversation`) or only the others (`other`). */
  purpose?: ObjectPurposeFilter;
  cursor?: string;
  /** 1..200, default 50. */
  limit?: number;
}

/** One page of the objects listing. There is no total: session-file visibility would make it wrong. */
export interface ObjectsPage {
  items: FileRecordView[];
  /** Sub-folders of `prefix` (full paths ending in `/`); empty for a search or type listing. */
  folders: string[];
  /** The folder listed, normalised; only in the folder listing. */
  prefix?: string;
  nextCursor?: string;
}

/** `GET /files/limits`. */
export interface FilesLimits {
  /** The largest file one upload can carry: the configured limit, the per-request quota and what fits in the request body. */
  maxFileBytes: number;
  maxRequestBytes: number;
  /** null = any type. */
  allowedMimeTypes: string[] | null;
  quota: {
    usedBytes: number;
    /** null = unlimited. */
    limitBytes: number | null;
    filesUsed: number;
    /** null = unlimited. */
    filesLimit: number | null;
  };
}

export interface CreateBucketInput {
  key: string;
  name: string;
  providerKey: string;
  description?: string;
  /** Fixed once the bucket has files. */
  prefix?: string;
  status?: 'active' | 'disabled';
  metadata?: Record<string, unknown>;
}

export interface UpdateBucketInput {
  /** 1..120 characters. */
  name?: string;
  description?: string;
  status?: 'active' | 'disabled';
  /** Refused with `prefix_locked` (409) when the bucket has any file. */
  prefix?: string;
}

export interface DeleteBucketOptions {
  /** Also delete the bucket's files from the storage provider (a background job; the answer is 202). */
  deleteFiles?: boolean;
}

/** `deleted`: gone now. `deleting`: a job is removing the files first; the bucket reports `deleting` until it is gone. */
export interface DeleteBucketResult {
  status: 'deleted' | 'deleting';
}

export interface UploadObjectInput {
  fileName: string;
  contentType?: string;
  /** A data URL: `data:<mime>;base64,<payload>`. */
  data: string;
  /**
   * Convert to Markdown in the background (the record starts `pending`). Left out, the server converts (the default
   * is on): send `false` to keep only the original.
   */
  convertToMarkdown?: boolean;
  metadata?: Record<string, unknown>;
  /** Upload into this folder (`''`/absent = the bucket root). */
  folder?: string;
  /** The object's name inside the folder (or its whole key when no folder is given). */
  keyHint?: string;
}

/** How much of the request body has been sent. The file is stored when the call resolves, not when `fraction` reaches 1. */
export interface UploadProgress {
  loaded: number;
  total: number;
  fraction: number;
}

export interface UploadObjectOptions {
  signal?: AbortSignal;
  /** Called while the body goes out (needs `XMLHttpRequest`; without it the call simply has no progress). */
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadObjectResult {
  record: FileRecordView;
}

export interface BatchDeleteResult {
  deleted: string[];
  failed: Array<{ key: string; error: string }>;
}

export interface ImportInput {
  /** Pass back `nextCursor` to continue a scan. */
  cursor?: string;
  /** 1..500, default 200. */
  limit?: number;
}

/** "Import from storage": objects found under the bucket's prefix that got a file record. */
export interface ImportResult {
  scanned: number;
  imported: number;
  skipped: number;
  nextCursor?: string;
}

export type ObjectVariant = 'original' | 'markdown';

/** A body saved from a download; `fileName` is what the server named it, when it said. */
export interface DownloadedFile {
  blob: Blob;
  fileName: string | null;
  contentType: string | null;
}

export type FileProviderTestStepName = 'list' | 'write' | 'read' | 'delete';

export interface FileProviderTestStep {
  step: FileProviderTestStepName;
  ok: boolean;
  message?: string;
}

/** `POST /api/providers/:id/test` of a file provider. */
export interface FileProviderTestResult {
  /** null: the driver has no test. */
  ok: boolean | null;
  latencyMs: number;
  message: string;
  details?: { steps?: FileProviderTestStep[] };
}

interface CallOptions {
  signal?: AbortSignal;
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

const FILES_BASE = '/api/files';
const CLIENT_FILES_BASE = '/api/client/v1/files';

/** Each segment of an object key encoded, the slashes kept: the objects routes take the key as a wildcard path. */
export function encodeObjectKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function objectsQueryString(query: ObjectsQuery = {}): string {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.prefix !== undefined) params.set('prefix', query.prefix);
  const search = query.search?.trim();
  if (search) params.set('search', search);
  if (query.type) params.set('type', query.type);
  if (query.purpose) params.set('purpose', query.purpose);
  if (query.cursor) params.set('cursor', query.cursor);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** Every path of the dashboard Files API. */
export const filesRoutes = {
  /** `bucketKey` asks for the limits that apply to that bucket (its provider can carry its own); without it, the project's general ones. */
  limits: (bucketKey?: string): string => `${FILES_BASE}/limits${bucketKey ? `?bucketKey=${encodeURIComponent(bucketKey)}` : ''}`,
  providers: (): string => `${FILES_BASE}/providers`,
  buckets: (): string => `${FILES_BASE}/buckets`,
  bucket: (bucketKey: string): string => `${FILES_BASE}/buckets/${encodeURIComponent(bucketKey)}`,
  /** `?deleteFiles=true` is the only parameter of the bucket delete. */
  bucketDelete: (bucketKey: string, options: DeleteBucketOptions = {}): string =>
    `${FILES_BASE}/buckets/${encodeURIComponent(bucketKey)}${options.deleteFiles ? '?deleteFiles=true' : ''}`,
  objects: (bucketKey: string, query?: ObjectsQuery): string =>
    `${FILES_BASE}/buckets/${encodeURIComponent(bucketKey)}/objects${objectsQueryString(query)}`,
  object: (bucketKey: string, key: string): string =>
    `${FILES_BASE}/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeObjectKey(key)}`,
  batchDelete: (bucketKey: string): string =>
    `${FILES_BASE}/buckets/${encodeURIComponent(bucketKey)}/objects/batch-delete`,
  archive: (bucketKey: string): string =>
    `${FILES_BASE}/buckets/${encodeURIComponent(bucketKey)}/objects/archive`,
  convert: (bucketKey: string): string => `${FILES_BASE}/buckets/${encodeURIComponent(bucketKey)}/convert`,
  import: (bucketKey: string): string => `${FILES_BASE}/buckets/${encodeURIComponent(bucketKey)}/import`,
  /** The saved-provider test of the Providers API: `id` is the provider RECORD id (`provider._id`), not its key. */
  providerTest: (providerRecordId: string): string => `/api/providers/${encodeURIComponent(providerRecordId)}/test`,
} as const;

/**
 * Paths of the public client API (`/api/client/v1`), for the code samples a screen prints.
 * Unlike the dashboard routes, an object's key is ONE path segment here (slashes encoded).
 */
export const clientApiRoutes = {
  buckets: (): string => CLIENT_FILES_BASE + '/buckets',
  bucket: (bucketKey: string): string => `${CLIENT_FILES_BASE}/buckets/${encodeURIComponent(bucketKey)}`,
  objects: (bucketKey: string): string => `${CLIENT_FILES_BASE}/buckets/${encodeURIComponent(bucketKey)}/objects`,
  object: (bucketKey: string, key: string): string =>
    `${CLIENT_FILES_BASE}/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(key)}`,
  download: (bucketKey: string, key: string, variant: ObjectVariant = 'original'): string =>
    `${clientApiRoutes.object(bucketKey, key)}/download${variant === 'markdown' ? '?variant=markdown' : ''}`,
} as const;

/** Inline content of a file for an `<img>`, an `<iframe>` or a text fetch: safe types only, up to 10 MB (see `previewKindOf`). */
export function objectPreviewUrl(bucketKey: string, key: string, variant: ObjectVariant = 'original'): string {
  const base = filesRoutes.object(bucketKey, key);
  return variant === 'markdown' ? `${base}?variant=markdown&preview=1` : `${base}?preview=1`;
}

/** The attachment download of a file (or of its Markdown copy). */
export function objectDownloadUrl(bucketKey: string, key: string, variant: ObjectVariant = 'original'): string {
  const params = new URLSearchParams();
  params.set('download', variant);
  params.set('variant', variant);
  return `${filesRoutes.object(bucketKey, key)}?${params.toString()}`;
}

/* ── Transport ───────────────────────────────────────────────────────────── */

function isAbortError(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';
}

function unreadableAnswer(status: number): FilesApiError {
  return new FilesApiError({ message: 'The server sent an answer that could not be read.', status, code: 'invalid_response' });
}

/** `fetch` with the failures normalised: a refused/lost request is a `FilesApiError` with status 0, an abort stays an abort. */
async function send(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', ...init });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw FilesApiError.network(error);
  }
  if (!response.ok) throw await FilesApiError.fromResponse(response);
  return response;
}

function jsonInit(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    signal,
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  };
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw unreadableAnswer(response.status);
  }
}

async function requestJson<T>(url: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return readJson<T>(await send(url, jsonInit(method, body, signal)));
}

/** The file name a `Content-Disposition` header carries: `filename*` (RFC 5987) first, then `filename`. */
export function parseContentDispositionFileName(header: string | null | undefined): string | null {
  if (!header) return null;
  const extended = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/i.exec(header);
  if (extended) {
    const parts = /^[\w-]+'[^']*'(.*)$/.exec(extended[1]!.trim());
    if (parts) {
      try {
        const decoded = decodeURIComponent(parts[1]!);
        if (decoded) return decoded;
      } catch {
        /* a malformed escape: fall back to the plain parameter */
      }
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]+)/i.exec(header);
  if (!plain) return null;
  const raw = plain[1]!.trim();
  const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw;
  return value || null;
}

async function requestBlob(url: string, init: RequestInit): Promise<DownloadedFile> {
  const response = await send(url, init);
  return {
    blob: await response.blob(),
    fileName: parseContentDispositionFileName(response.headers.get('content-disposition')),
    contentType: response.headers.get('content-type'),
  };
}

/** A JSON POST through `XMLHttpRequest`, the only way to learn how much of a large body has gone out. */
function postJsonWithProgress<T>(url: string, body: unknown, options: UploadObjectOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const { signal, onProgress } = options;
    if (signal?.aborted) {
      reject(new DOMException('The upload was aborted.', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.responseType = 'text';

    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => signal?.removeEventListener('abort', onAbort);

    xhr.upload.onprogress = (event) => {
      if (!onProgress || !event.lengthComputable || event.total <= 0) return;
      onProgress({ loaded: event.loaded, total: event.total, fraction: Math.min(1, event.loaded / event.total) });
    };
    xhr.onload = () => {
      done();
      let parsed: unknown;
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        parsed = undefined;
        if (xhr.status >= 200 && xhr.status < 300) {
          reject(unreadableAnswer(xhr.status));
          return;
        }
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(parsed as T);
      else reject(FilesApiError.fromBody(xhr.status, parsed, xhr.statusText));
    };
    xhr.onerror = () => {
      done();
      reject(FilesApiError.network(undefined));
    };
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => {
      done();
      reject(new DOMException('The upload was aborted.', 'AbortError'));
    };
    xhr.send(JSON.stringify(body));
  });
}

/* ── Fetchers ────────────────────────────────────────────────────────────── */

/** What an upload may weigh and be, and the project's storage quota. Pass the bucket you are about to upload into. */
export async function getFilesLimits(options: CallOptions & { bucketKey?: string } = {}): Promise<FilesLimits> {
  return requestJson<FilesLimits>(filesRoutes.limits(options.bucketKey), 'GET', undefined, options.signal);
}

export async function listFileProviders(options: CallOptions = {}): Promise<FileProviderListItem[]> {
  const body = await requestJson<{ providers?: FileProviderListItem[] }>(filesRoutes.providers(), 'GET', undefined, options.signal);
  return Array.isArray(body?.providers) ? body.providers : [];
}

export async function listBuckets(options: CallOptions = {}): Promise<BucketListItem[]> {
  const body = await requestJson<{ buckets?: BucketListItem[] }>(filesRoutes.buckets(), 'GET', undefined, options.signal);
  return Array.isArray(body?.buckets) ? body.buckets : [];
}

export async function getBucket(bucketKey: string, options: CallOptions = {}): Promise<BucketDetail> {
  const body = await requestJson<{ bucket?: BucketDetail }>(filesRoutes.bucket(bucketKey), 'GET', undefined, options.signal);
  if (!body?.bucket) throw unreadableAnswer(200);
  return body.bucket;
}

export async function createBucket(input: CreateBucketInput, options: CallOptions = {}): Promise<FileBucketView> {
  const body = await requestJson<{ bucket?: FileBucketView }>(filesRoutes.buckets(), 'POST', input, options.signal);
  if (!body?.bucket) throw unreadableAnswer(201);
  return body.bucket;
}

export async function updateBucket(
  bucketKey: string,
  patch: UpdateBucketInput,
  options: CallOptions = {},
): Promise<FileBucketView> {
  const body = await requestJson<{ bucket?: FileBucketView }>(filesRoutes.bucket(bucketKey), 'PATCH', patch, options.signal);
  if (!body?.bucket) throw unreadableAnswer(200);
  return body.bucket;
}

/** 200 -> `deleted`; 202 (a delete-with-files job started) -> `deleting`. A bucket an agent uses answers 409 `bucket_in_use`. */
export async function deleteBucket(
  bucketKey: string,
  deleteOptions: DeleteBucketOptions = {},
  options: CallOptions = {},
): Promise<DeleteBucketResult> {
  const response = await send(filesRoutes.bucketDelete(bucketKey, deleteOptions), jsonInit('DELETE', undefined, options.signal));
  const answer = await readJson<{ status?: unknown } | undefined>(response).catch(() => undefined);
  return { status: response.status === 202 || answer?.status === 'deleting' ? 'deleting' : 'deleted' };
}

export async function listObjects(bucketKey: string, query: ObjectsQuery = {}, options: CallOptions = {}): Promise<ObjectsPage> {
  const body = await requestJson<Partial<ObjectsPage>>(filesRoutes.objects(bucketKey, query), 'GET', undefined, options.signal);
  return {
    items: Array.isArray(body?.items) ? body.items : [],
    folders: Array.isArray(body?.folders) ? body.folders : [],
    ...(typeof body?.prefix === 'string' ? { prefix: body.prefix } : {}),
    ...(body?.nextCursor ? { nextCursor: body.nextCursor } : {}),
  };
}

/** One file's record (with the uploader's name and, for a session file, the agent's id). */
export async function getObject(bucketKey: string, key: string, options: CallOptions = {}): Promise<FileRecordView> {
  const body = await requestJson<{ record?: FileRecordView }>(filesRoutes.object(bucketKey, key), 'GET', undefined, options.signal);
  if (!body?.record) throw unreadableAnswer(200);
  return body.record;
}

/**
 * Uploads one file (base64 in JSON). 413 `file_too_large`, 415 (type not allowed), 429 (a quota) and 409
 * `bucket_inactive` are the expected refusals. With `onProgress` the body goes out through `XMLHttpRequest`.
 */
export async function uploadObject(
  bucketKey: string,
  input: UploadObjectInput,
  options: UploadObjectOptions = {},
): Promise<UploadObjectResult> {
  const url = filesRoutes.objects(bucketKey);
  const body =
    options.onProgress && typeof XMLHttpRequest !== 'undefined'
      ? await postJsonWithProgress<{ record?: FileRecordView }>(url, input, options)
      : await requestJson<{ record?: FileRecordView }>(url, 'POST', input, options.signal);
  if (!body?.record) throw unreadableAnswer(201);
  return { record: body.record };
}

/** Reads a file as a data URL (`data:<mime>;base64,...`), the way an upload carries it. */
export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new FilesApiError({ message: 'The file could not be read.', status: 0, code: 'read_failed' }));
    };
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.readAsDataURL(file);
  });
}

export interface UploadFileOptions extends UploadObjectOptions {
  /** The stored name; defaults to the file's own. */
  name?: string;
  /** Overrides the file's own type; an empty type is sent as `application/octet-stream`. */
  contentType?: string;
  /** Left out, the server converts (the default is on): send `false` to keep only the original. */
  convertToMarkdown?: boolean;
  folder?: string;
}

/** Reads `file` and uploads it: the call the upload screen makes for each queued file. */
export async function uploadFile(bucketKey: string, file: File, options: UploadFileOptions = {}): Promise<UploadObjectResult> {
  const { name, contentType, convertToMarkdown, folder, ...rest } = options;
  const data = await fileToDataUrl(file);
  return uploadObject(
    bucketKey,
    {
      fileName: (name ?? file.name).trim() || file.name,
      contentType: contentType?.trim() || file.type || 'application/octet-stream',
      data,
      ...(convertToMarkdown !== undefined ? { convertToMarkdown } : {}),
      ...(folder ? { folder } : {}),
    },
    rest,
  );
}

export async function deleteObject(bucketKey: string, key: string, options: CallOptions = {}): Promise<void> {
  await requestJson<unknown>(filesRoutes.object(bucketKey, key), 'DELETE', undefined, options.signal);
}

/** 1..100 keys. Each key succeeds or fails on its own; a refused one is listed in `failed`. */
export async function batchDeleteObjects(bucketKey: string, keys: string[], options: CallOptions = {}): Promise<BatchDeleteResult> {
  const body = await requestJson<Partial<BatchDeleteResult>>(filesRoutes.batchDelete(bucketKey), 'POST', { keys }, options.signal);
  return {
    deleted: Array.isArray(body?.deleted) ? body.deleted : [],
    failed: Array.isArray(body?.failed) ? body.failed : [],
  };
}

/** The name the server gives the zip of `archiveObjects` (`Content-Disposition`); save the blob under it. */
export function archiveFileName(bucketKey: string): string {
  return `${bucketKey}-files.zip`;
}

/** 1..50 keys as one zip (a Blob; `archiveFileName(bucketKey)` is its name). 413 `archive_too_large` when the originals add up to more than 200 MB. */
export async function archiveObjects(bucketKey: string, keys: string[], options: CallOptions = {}): Promise<Blob> {
  const archive = await requestBlob(filesRoutes.archive(bucketKey), jsonInit('POST', { keys }, options.signal));
  return archive.blob;
}

/** (Re)starts the Markdown conversion: 202, the record comes back `pending`. 415 `conversion_unsupported` for types the converter cannot read. */
export async function convertObject(bucketKey: string, key: string, options: CallOptions = {}): Promise<FileRecordView> {
  const body = await requestJson<{ record?: FileRecordView }>(filesRoutes.convert(bucketKey), 'POST', { key }, options.signal);
  if (!body?.record) throw unreadableAnswer(202);
  return body.record;
}

/** Registers the objects already in the provider under the bucket's prefix as file records (never changes an object). 409 for a disabled bucket. */
export async function importFromStorage(bucketKey: string, input: ImportInput = {}, options: CallOptions = {}): Promise<ImportResult> {
  const body = await requestJson<Partial<ImportResult>>(filesRoutes.import(bucketKey), 'POST', input, options.signal);
  return {
    scanned: body?.scanned ?? 0,
    imported: body?.imported ?? 0,
    skipped: body?.skipped ?? 0,
    ...(body?.nextCursor ? { nextCursor: body.nextCursor } : {}),
  };
}

/** The file (or its Markdown copy) as a blob. */
export async function downloadObject(
  bucketKey: string,
  key: string,
  options: CallOptions & { variant?: ObjectVariant } = {},
): Promise<DownloadedFile> {
  return requestBlob(objectDownloadUrl(bucketKey, key, options.variant), { method: 'GET', signal: options.signal });
}

/** The inline text of a file or its Markdown copy (text types only). 415 `preview_unsupported` for anything else. */
export async function fetchObjectText(
  bucketKey: string,
  key: string,
  options: CallOptions & { variant?: ObjectVariant } = {},
): Promise<string> {
  const response = await send(objectPreviewUrl(bucketKey, key, options.variant), { method: 'GET', signal: options.signal });
  return response.text();
}

/**
 * Tests a saved file provider (list, write, read, delete) and keeps the outcome on its record. Needs provider
 * access: anybody else gets 403. `providerRecordId` is `provider._id`.
 */
export async function testFileProvider(providerRecordId: string, options: CallOptions = {}): Promise<FileProviderTestResult> {
  return requestJson<FileProviderTestResult>(filesRoutes.providerTest(providerRecordId), 'POST', {}, options.signal);
}
