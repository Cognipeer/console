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
 * The view types are the server's own (`FileBucketView`, `BucketListItem`, `BucketDetail`, `FileRecordView`,
 * `FileProviderView`, `FileLimits`, ...): they are imported from the service as types and re-exported here, so a
 * field the server adds or drops changes this file's types with it. Only the request bodies, which the server does
 * not export as types, are declared here.
 * Nothing here talks to React: `useFilesQueries.ts` wraps these for components.
 */

import { ApiError } from '@/lib/api/client';
import type { FileTypeFilter } from '@/lib/database';
import type {
  BatchDeleteResult,
  BucketDetail,
  BucketListItem,
  BucketStats,
  BucketUser,
  FileBucketView,
  FileLimits,
  FileProviderView,
  FileRecordView,
  ImportFromStorageResult,
  ListFilesRequest,
  ListFilesResponse,
  ProviderHealth,
  ProviderHealthState,
} from '@/lib/services/files';
import type { ProviderTestResult } from '@/lib/services/providers/providerConnectionTest';

/* ── Errors ──────────────────────────────────────────────────────────────── */

/**
 * Every `code` the Files routes (and the provider routes they share) answer with next to `error`. The list is tied
 * to the server in `files-ui-client-real-stack.test.ts`: a code the file service has and this list lacks fails the
 * type check there, and a code named here that no server file defines fails the run. A call can still carry a code
 * that is not listed (a code is additive); `FilesApiError.code` is a plain string.
 */
export const FILES_ERROR_CODES = [
  // The file service's refusals (`FileServiceErrorCode`).
  'bucket_not_found',
  'file_not_found',
  'bucket_inactive',
  'bucket_deleting',
  'bucket_not_empty',
  'prefix_locked',
  'duplicate_key',
  'provider_missing',
  'provider_unassigned',
  'provider_inactive',
  'provider_invalid',
  'provider_mismatch',
  'markdown_unavailable',
  'conversion_unsupported',
  'conversion_too_large',
  'archive_too_large',
  'import_in_progress',
  'storage_location_shared',
  'object_too_large',
  'quota_exceeded',
  'queue_unavailable',
  'file_too_large',
  'content_type_not_allowed',
  'invalid_content_type',
  'invalid_request',
  'preview_unsupported',
  // The agents' check on a bucket they keep session files in (names the agents).
  'bucket_in_use',
  // A storage failure or outage, as the HTTP layer words it (`server/api/fileHttp.ts`).
  'storage_failure',
  'storage_unavailable',
  'storage_timeout',
  'internal_error',
  // A provider setting or endpoint the console refuses (provider create / update / test; names the form `field`).
  'provider_settings_invalid',
  'provider_endpoint_not_allowed',
] as const;

export type FilesErrorCode = (typeof FILES_ERROR_CODES)[number];

/** Thrown by every fetcher of this module. Extends `ApiError`, so `payload` holds the parsed body. */
export class FilesApiError extends ApiError {
  /**
   * The machine-readable `code` of the answer, when it had one. Some answers have none: a missing body field (400),
   * a quota or rate limit on an upload or a new bucket (429), a refusal for want of a permission (403), a missing
   * login (401) and Fastify's own errors. A screen switches on `status` for those.
   */
  readonly code?: string;
  /** The `reason` a few refusals add next to the code (`preview_unsupported`: `unsupported_type` or `too_large`). */
  readonly reason?: string;

  constructor(init: { message: string; status: number; code?: string; reason?: string; payload?: unknown }) {
    super(init.message, init.status, init.payload);
    this.name = 'FilesApiError';
    this.code = init.code;
    this.reason = init.reason;
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
    let reason: string | undefined;

    if (record) {
      // Fastify's own errors read { statusCode, error: 'Bad Request', message: '<the reason>' }: the reason is `message`.
      const fastifyShape = typeof record.statusCode === 'number';
      const candidates = fastifyShape ? [record.message, record.error] : [record.error, record.message, record.detail];
      message = candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
      if (typeof record.code === 'string' && record.code.trim()) code = record.code.trim();
      if (typeof record.reason === 'string' && record.reason.trim()) reason = record.reason.trim();
      // An envelope { error: { message, code } } (the client API's shape) is read too.
      if (!message && record.error && typeof record.error === 'object') {
        const inner = record.error as Record<string, unknown>;
        if (typeof inner.message === 'string' && inner.message.trim()) message = inner.message.trim();
        if (!code && typeof inner.code === 'string' && inner.code.trim()) code = inner.code.trim();
      }
    }

    return new FilesApiError({ message: message ?? fallback, status, code, reason, payload: body });
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

// The view types the routes answer with are the server's own, re-exported under the names the screens use.
export type {
  BatchDeleteResult,
  BucketDetail,
  BucketListItem,
  BucketStats,
  BucketUser,
  FileLimits,
  FileProviderView,
  FileTypeFilter,
  ImportFromStorageResult,
  ProviderHealth,
  ProviderHealthState,
  ProviderTestResult,
};

/**
 * `GET /files/providers`: a file provider with its health and where it keeps files. The other provider answers
 * (create, update) leave `providerHealth` and `storageLocationBase` out; the listing always sets them.
 * `storageLocationBase` is the physical location up to and including `<providerKey>/`, so the create form can
 * preview `${base}${prefix}`; `null` when the driver does not say (this server's disk, or settings that name no
 * bucket yet): tell the two apart by `driver`, not by the base.
 */
export type FileProviderListItem = FileProviderView & Required<Pick<FileProviderView, 'providerHealth' | 'storageLocationBase'>>;

/** The parameters of the objects listing: the server's `ListFilesRequest` minus the two that the path names. */
export type ObjectsQuery = Omit<ListFilesRequest, 'bucketKey' | 'providerKey'>;

/**
 * One page of the objects listing, as the screens read it: `folders` is always an array (the server leaves it out of
 * a search or type listing). There is no total: session-file visibility would make it wrong.
 */
export type ObjectsPage = Omit<ListFilesResponse, 'folders'> & { folders: string[] };

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
  /** Up to 1000 characters; `''` or `null` clears it. */
  description?: string | null;
  /**
   * `active` also clears the note a failed "delete with files" left on the bucket (`deleteError`): switching the bucket
   * back on is how a person keeps it after all.
   */
  status?: 'active' | 'disabled';
  /** Refused with `prefix_locked` (409) when the bucket has any file. */
  prefix?: string;
}

/** Which kind of delete `DELETE /files/buckets/:bucketKey` is asked for. Left empty, it is the plain one. */
export interface DeleteBucketOptions {
  /**
   * Also delete the bucket's files from the storage provider (a background job; the answer is 202 `deleting`). Asked
   * again for a bucket that is already being deleted, it queues the job anew: the way back when a run was lost.
   */
  deleteFiles?: boolean;
  /**
   * Delete only the bucket (`?force=true`): its files stay in the storage provider and their records stay behind, so
   * they still count toward the project's storage. Without it a bucket that holds files answers 409 `bucket_not_empty`.
   * Ignored together with `deleteFiles`. It is also accepted for a bucket that is being deleted, which a plain delete
   * is not: the way out when the run was lost and another bucket now uses the storage location, where the run cannot
   * be asked for again (`storage_location_shared`).
   */
  force?: boolean;
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

export interface ImportInput {
  /** Pass back `nextCursor` to continue a scan. */
  cursor?: string;
  /** 1..500, default 200. */
  limit?: number;
}

export type ObjectVariant = 'original' | 'markdown';

/** A body saved from a download; `fileName` is what the server named it, when it said. */
export interface DownloadedFile {
  blob: Blob;
  fileName: string | null;
  contentType: string | null;
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
  /**
   * The bucket delete: plain (only an empty bucket goes), `?deleteFiles=true` (a job removes the files first) or
   * `?force=true` (only the bucket goes; its files stay). With both options the files are deleted.
   */
  bucketDelete: (bucketKey: string, options: DeleteBucketOptions = {}): string => {
    const base = `${FILES_BASE}/buckets/${encodeURIComponent(bucketKey)}`;
    if (options.deleteFiles) return `${base}?deleteFiles=true`;
    return options.force ? `${base}?force=true` : base;
  },
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
export async function getFilesLimits(options: CallOptions & { bucketKey?: string } = {}): Promise<FileLimits> {
  return requestJson<FileLimits>(filesRoutes.limits(options.bucketKey), 'GET', undefined, options.signal);
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

/**
 * 200 -> `deleted`; 202 (a delete-with-files job started) -> `deleting`. The refusals: 409 `bucket_in_use` (an agent
 * keeps session files in it; in every form), 409 `bucket_not_empty` (a plain delete of a bucket with files), 409
 * `bucket_deleting` (a plain delete while the job runs; `force` is accepted then and removes the bucket alone), 409
 * `storage_location_shared` (`deleteFiles` while another bucket keeps files in the same location), 403 (`deleteFiles`
 * with sessions of somebody else) and 503 `queue_unavailable` (`deleteFiles`; the bucket keeps a note of it in
 * `deleteError`).
 */
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

/**
 * (Re)starts the Markdown conversion, whatever the record's status is (the way back for a job that was lost): 202, the
 * record comes back `pending`. The refusals: 415 `conversion_unsupported` (a type the converter cannot read), 413
 * `conversion_too_large`, 409 `bucket_inactive` / `bucket_deleting`, 503 `queue_unavailable` (the record is left
 * `failed` with why).
 */
export async function convertObject(bucketKey: string, key: string, options: CallOptions = {}): Promise<FileRecordView> {
  const body = await requestJson<{ record?: FileRecordView }>(filesRoutes.convert(bucketKey), 'POST', { key }, options.signal);
  if (!body?.record) throw unreadableAnswer(202);
  return body.record;
}

/**
 * Registers the objects already in the provider under the bucket's prefix as file records (never changes an object).
 * The refusals: 409 `bucket_inactive` (disabled bucket), 409 `storage_location_shared` (another bucket keeps files
 * in the same location), 409 `import_in_progress` (a scan of this bucket is running), 429 `quota_exceeded`.
 */
export async function importFromStorage(
  bucketKey: string,
  input: ImportInput = {},
  options: CallOptions = {},
): Promise<ImportFromStorageResult> {
  const body = await requestJson<Partial<ImportFromStorageResult>>(filesRoutes.import(bucketKey), 'POST', input, options.signal);
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
 * Tests a saved file provider (list, write, read, delete) and keeps the outcome on its record. Owners and admins
 * only: anybody else gets 403. `providerRecordId` is `provider._id`, not its key. An empty body is the plain re-test;
 * `{ credentials?, settings? }` would test unsaved values and keep nothing. A broken setting answers 400 with its
 * `code` (`provider_settings_invalid`, `provider_endpoint_not_allowed`) and the form `field`.
 */
export async function testFileProvider(providerRecordId: string, options: CallOptions = {}): Promise<ProviderTestResult> {
  return requestJson<ProviderTestResult>(filesRoutes.providerTest(providerRecordId), 'POST', {}, options.signal);
}
