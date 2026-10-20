import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getDatabase, type DatabaseProvider, type FileMarkdownStatus, type IFileBucketRecord, type IFileRecord, type IProviderRecord } from '@/lib/database';
import { normalizeFolderPrefix } from '@/lib/database/fileEntryWalk';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import { runtimePool, hashRuntimeConfig } from '@/lib/core/runtimePool';
import { errorStatusCodes, isRetryable, withResilience, type ResilienceOptions } from '@/lib/core/resilience';
import {
    providerRegistry,
    type FileDownloadResult,
    type FileProviderRuntime,
    type FileObjectHandle,
    type ProviderCapabilityFlags,
} from '@/lib/providers';
import { hasLoneSurrogate, maxStorageDownloadBytes } from '@/lib/providers/contracts/storageLimits';
import {
    createProviderConfig,
    getProviderConfigByKey,
    listProviderConfigs,
    loadProviderRuntimeData,
    type CreateProviderConfigInput,
    type ProviderConfigView,
} from '@/lib/services/providers/providerService';
import {
    BUCKET_DELETE_ERROR_KEY,
    isBucketDeleting,
    bucketClosedError,
    bucketDeleteError,
    parseBucketDescription,
    parseBucketKey,
    parseBucketMetadata,
    parseBucketName,
    parseBucketPatch,
    parseBucketPrefix,
    parseBucketStatus,
    reservedBucketMetadata,
    withoutReservedBucketMetadata,
    type BucketFieldsPatch,
} from './bucketRules';
import { bucketDeletingError, bucketInactiveError, describeFailure, FileServiceError, hasObjectMissingCode } from './errors';
import { convertDocumentToMarkdown, DocumentConversionRefused } from './documentConversion';
import { publishConvertMarkdownJob, type ConvertMarkdownJobPayload } from './jobs/filesQueue';
import { isMarkdownConvertible } from './markdownSupport';
import { base64TextOf } from './payloadSize';
import { storedObjectReads } from './readBudget';
import type {
    FileBucketView,
    DownloadFileOptions,
    DownloadFileResult,
    FileProviderView,
    FileRecordListItem,
    FileRecordView,
    ListFilesRequest,
    ListFilesResponse,
    UploadFileRequest,
    UploadFileResponse,
    UpdateFileConversionPayload,
} from './types';


const FALLBACK_FILENAME = 'uploaded-file';

/** What the file service's runtimes are pooled under, in front of `<tenantId>:<providerKey>`. */
export const FILE_RUNTIME_POOL_PREFIX = 'file-runtime:';

interface CreateFileBucketInput {
    key: string;
    name: string;
    providerKey: string;
    description?: string;
    prefix?: string | null;
    metadata?: Record<string, unknown>;
    status?: 'active' | 'disabled';
    createdBy: string;
}

interface DeleteFileBucketOptions {
    /**
     * Remove the bucket although it holds files, or although it is marked as being deleted with its files. Only the
     * bucket goes: the files and their records stay where they are.
     */
    force?: boolean;
}

const logger = createLogger('files');

function createProviderLogger(scope: string) {
    return createLogger(`files:${scope}`);
}

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db;
}

export function attachDriverCapabilities(provider: ProviderConfigView): FileProviderView {
    try {
        const contract = providerRegistry.getContract(provider.driver);
        return {
            ...provider,
            driverCapabilities: contract.capabilities as ProviderCapabilityFlags | undefined,
        } satisfies FileProviderView;
    } catch (error) {
        logger.warn('File provider contract missing for driver', {
            driver: provider.driver,
            error: error instanceof Error ? error.message : error,
        });
    }

    return { ...provider };
}

export function serializeFileBucket(bucket: IFileBucketRecord): FileBucketView {
    const { _id, ...rest } = bucket;
    return {
        ...rest,
        id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
    } satisfies FileBucketView;
}

function normalizePrefix(input?: string | null): string | undefined {
    // A bucket stored before its prefix was validated may hold something else than text: it has no folder of its own.
    if (typeof input !== 'string') {
        return undefined;
    }

    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return '';
    }

    const withoutSlashes = trimmed.replace(/^\/+|\/+$/g, '');
    return withoutSlashes;
}

/** The folder a bucket's objects live in inside its provider: its own prefix, or its key when it has none. */
export function resolveBucketPrefix(bucket: Pick<IFileBucketRecord, 'key' | 'prefix'>): string {
    const normalized = normalizePrefix(bucket.prefix);
    if (normalized !== undefined) {
        return normalized;
    }

    // Read as it is stored: a key written before keys were validated need not be text either.
    const key: unknown = bucket.key;
    return typeof key === 'string' ? key : String(key ?? '');
}

/**
 * A folder the way the storage drivers read it, so that two spellings of one place compare as one: a backslash is a
 * slash, a run of dots is one dot (what the disk driver does to a key), and an empty or `.` segment is nothing
 * (`./docs`, `docs//archive`). It is coarser than any one driver on purpose: a bucket created before folders were
 * validated can carry such a spelling, and a wrong "shared" costs an import where a miss costs another bucket's files.
 */
function canonicalStorageFolder(folder: string): string {
    return folder
        .replace(/\\/g, '/')
        .replace(/\.{2,}/g, '.')
        .split('/')
        .filter((segment) => segment !== '' && segment !== '.')
        .join('/');
}

/**
 * Whether two folders of one provider overlap: they are the same folder, one of them is the provider's root (`''`),
 * or one lies inside the other. The folders are those of `resolveBucketPrefix`, compared as the drivers read them
 * (see `canonicalStorageFolder`), not as they are spelled.
 */
export function storageFoldersOverlap(a: string, b: string): boolean {
    const first = canonicalStorageFolder(a);
    const second = canonicalStorageFolder(b);
    if (first === second || first === '' || second === '') return true;
    return first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}

/**
 * The other buckets of the tenant that keep their files in the same place as this one: on the same provider, in a
 * folder that overlaps its folder (see `storageFoldersOverlap`). Buckets of every project and of every status count -
 * a switched-off bucket and one that is being deleted still own their files. Bucket keys are only unique within a
 * project and a provider can serve several, so two buckets with one key share a folder unless one was given another.
 *
 * What a bucket does to its own folder (importing what is in it, deleting everything in it) is only safe when nobody
 * else keeps files there: a location shared with another bucket cannot be imported from or emptied.
 */
export async function findBucketsSharingStorage(
    db: Pick<DatabaseProvider, 'listFileBuckets'>,
    tenantId: string,
    bucket: Pick<IFileBucketRecord, '_id' | 'projectId' | 'key' | 'providerKey' | 'prefix'>,
): Promise<IFileBucketRecord[]> {
    const folder = resolveBucketPrefix(bucket);
    const ownId = bucket._id === undefined || bucket._id === null ? undefined : String(bucket._id);
    const buckets = await db.listFileBuckets(tenantId);
    return buckets.filter((other) => {
        const otherId = other._id === undefined || other._id === null ? undefined : String(other._id);
        const sameBucket = ownId !== undefined && otherId !== undefined
            ? ownId === otherId
            : other.projectId === bucket.projectId && other.key === bucket.key;
        return !sameBucket
            && other.providerKey === bucket.providerKey
            && storageFoldersOverlap(folder, resolveBucketPrefix(other));
    });
}

/** The key an object has in the provider: the bucket's prefix in front of the key the record carries. */
export function composeProviderObjectKey(
    bucket: Pick<IFileBucketRecord, 'key' | 'prefix'>,
    relativeKey: string,
): string {
    const cleanedRelative = relativeKey.replace(/^\/+/, '').replace(/\/+$/, '');
    const prefix = resolveBucketPrefix(bucket);

    if (!prefix) {
        return cleanedRelative;
    }

    return `${prefix}/${cleanedRelative}`;
}

/** The inverse of `composeProviderObjectKey`: the key a record carries for an object the provider names. */
export function stripBucketPrefix(
    bucket: Pick<IFileBucketRecord, 'key' | 'prefix'>,
    providerObjectKey: string,
): string {
    const normalized = providerObjectKey.replace(/^\/+/, '');
    const prefix = resolveBucketPrefix(bucket);

    if (!prefix) {
        return normalized;
    }

    const expectedPrefix = `${prefix}/`;
    if (normalized.startsWith(expectedPrefix)) {
        return normalized.slice(expectedPrefix.length);
    }

    return normalized;
}

/** A switched-off bucket keeps its files readable but takes nothing new: every write goes through this check. */
export function ensureFileBucketActive(bucket: Pick<IFileBucketRecord, 'status'>) {
    if (bucket.status !== 'active') {
        throw bucketInactiveError();
    }
}

/**
 * The bucket as the database has it, whatever its status and whatever state its provider is in: what listing,
 * metadata and every other read that never touches the provider stand on.
 */
export async function requireBucketRecord(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
): Promise<IFileBucketRecord> {
    const db = await withTenantDb(tenantDbName);
    const bucket = await db.findFileBucketByKey(tenantId, bucketKey, projectId);

    if (!bucket) {
        throw new FileServiceError('bucket_not_found', 404, 'File bucket not found.');
    }

    return bucket;
}

/** `read`: the bucket may be switched off (its files can still be downloaded). `write`: it must be active. */
export type BucketAccess = 'read' | 'write';

/** The bucket together with a runtime for its provider: what a call that reads or writes the objects stands on. */
export async function requireBucketContext(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
    access: BucketAccess = 'write',
): Promise<{
    bucket: IFileBucketRecord;
    provider: IProviderRecord;
    runtime: FileProviderRuntime;
}> {
    const bucket = await requireBucketRecord(tenantDbName, tenantId, projectId, bucketKey);

    if (access === 'write') {
        ensureFileBucketActive(bucket);
    }

    const { runtime, record: provider } = await buildRuntimeContext(
        tenantDbName,
        tenantId,
        bucket.providerKey,
        projectId,
    );

    return {
        bucket,
        provider,
        runtime,
    };
}

function ensureFileProvider(record: IProviderRecord): void {
    if (record.type !== 'file') {
        throw new FileServiceError('provider_invalid', 409, 'Provider configuration is not a file provider.');
    }

    if (record.status !== 'active') {
        throw new FileServiceError('provider_inactive', 409, 'File provider is not active.');
    }
}

/**
 * Whether a failed storage call says the storage itself is unwell. It is the circuit breaker's
 * `countFailure` for file I/O: only an outage should cut a tenant's uploads off, not a request that
 * can never succeed. A rejected key (403), a missing bucket or object (404, ENOENT), an oversized upload
 * (413), a header value Node refuses to write or a setting the endpoint policy refuses is the caller's
 * to fix and no evidence about the next request.
 *
 * Transient (true): timeouts, network failures, 408, 429, 5xx and anything unclassified.
 * Not transient (false): an error that declares `retryable: false` (the settings / endpoint-policy
 * refusals do), anything the retry rules call hopeless (`isRetryable`: the same request fails the same
 * way, so it is no sign of an outage either), and any other 4xx. An error that declares
 * `retryable: true` (a resolver that is down) is transient; the flag wins over the status, as it does
 * for retries.
 *
 * The retry rules are asked rather than copied: a verdict added there (a new status, a new Node error
 * code) reaches the breaker without a second list to keep in step.
 */
export function isTransientStorageError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return true;
    }

    const { retryable } = error as { retryable?: unknown };
    if (retryable === false) return false;
    if (retryable === true) return true;
    if (!isRetryable(error)) return false;

    return !errorStatusCodes(error).some(
        (status) => status >= 400 && status < 500 && status !== 408 && status !== 429,
    );
}

export type FileOperation = 'upload' | 'download' | 'delete' | 'list';

/**
 * `withResilience` options for one file I/O call. The breaker key carries the tenant: a provider key is
 * only unique inside its tenant, so each tenant's provider gets a circuit of its own.
 */
export function fileResilience(operation: FileOperation, tenantId: string, providerKey: string): ResilienceOptions {
    return {
        key: `file-${operation}:${tenantId}:${providerKey}`,
        countFailure: isTransientStorageError,
    };
}

/**
 * Reads one stored object into memory: as a download (its own circuit and retries), and as one of the reads this
 * process runs together (`storedObjectReads`, which keeps a burst of large downloads from adding up to more memory
 * than the process has). `size` is what the record says the object weighs.
 */
export function readStoredObject(
    runtime: FileProviderRuntime,
    objectKey: string,
    source: { tenantId: string; providerKey: string; size?: number | null },
): Promise<FileDownloadResult> {
    return storedObjectReads.run(source.size, () => withResilience(
        () => runtime.downloadFile(objectKey),
        fileResilience('download', source.tenantId, source.providerKey),
    ));
}

/**
 * The provider service answers a bucket whose provider is gone, or was never given to this project, with a plain
 * error. Both are the bucket's configuration to fix, not a failure of the storage: they are told apart here.
 */
function explainProviderLookupFailure(error: unknown, providerKey: string): unknown {
    const message = error instanceof Error ? error.message : '';
    if (/ exists but is not assigned to project /.test(message)) {
        return new FileServiceError('provider_unassigned', 409, message, { cause: error });
    }
    if (/^Provider configuration ".*" not found\.$/.test(message)) {
        return new FileServiceError('provider_missing', 409, `The storage provider "${providerKey}" of this bucket no longer exists.`, { cause: error });
    }
    return error;
}

async function buildRuntimeContext(
    tenantDbName: string,
    tenantId: string,
    providerKey: string,
    projectId: string,
): Promise<{ runtime: FileProviderRuntime; record: IProviderRecord }> {
    const { record, credentials } = await loadProviderRuntimeData(
        tenantDbName,
        {
            tenantId,
            key: providerKey,
            projectId,
        },
    ).catch((error: unknown) => {
        throw explainProviderLookupFailure(error, providerKey);
    });

    ensureFileProvider(record);

    // The file service's own pool namespace: another caller that pools a runtime of the same provider (the sandbox
    // volumes do, under `file:<tenant>:<key>`) hashes it differently, and two callers that share a pool key but not
    // a hash evict each other's runtime on every alternation.
    const cacheKey = `${FILE_RUNTIME_POOL_PREFIX}${tenantId}:${record.key}`;
    // The settings (bucket, endpoint, auth method, ...) shape the runtime as much as the credentials do: without
    // them an edited setting would go unseen until the pooled runtime expired.
    const configHash = hashRuntimeConfig({ driver: record.driver, credentials, settings: record.settings ?? {} });

    const runtime = await runtimePool.getOrCreate<FileProviderRuntime>(
        cacheKey,
        configHash,
        async () => {
            const providerLog = createProviderLogger(record.key);
            return providerRegistry.createRuntime<FileProviderRuntime>(
                record.driver,
                {
                    tenantId,
                    projectId,
                    providerKey: record.key,
                    credentials,
                    settings: record.settings ?? {},
                    metadata: record.metadata ?? {},
                    logger: providerLog,
                },
            );
        },
    );

    return { runtime, record };
}

export function serializeFileRecord(record: IFileRecord): FileRecordView {
    const { _id, ...rest } = record;
    return {
        ...rest,
        id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
    } satisfies FileRecordView;
}

function normalizeFileName(fileName?: string | null): string {
    if (!fileName || fileName.trim().length === 0) {
        return `${FALLBACK_FILENAME}-${randomUUID().slice(0, 8)}`;
    }
    // Strip path components and control chars (including NUL) to prevent
    // path traversal and injection through filenames downstream.
    const stripped = path
        .basename(fileName.trim())
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/^\.+/, '')
        .slice(0, 255);
    if (stripped.length === 0) {
        return `${FALLBACK_FILENAME}-${randomUUID().slice(0, 8)}`;
    }
    return stripped;
}

const FILE_UPLOAD_SAFE_MIME_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

function normalizeMimeType(raw: string): string {
    // Drop parameters like ";charset=utf-8" and lowercase the type/subtype.
    return raw.split(';')[0]!.trim().toLowerCase();
}

function isMimeTypeAllowed(contentType: string | undefined, allowed: string[]): boolean {
    if (allowed.length === 0) return true; // allowlist disabled
    if (!contentType) return false;
    const mime = normalizeMimeType(contentType);
    return allowed.some((entry) => {
        const norm = normalizeMimeType(entry);
        if (norm.endsWith('/*')) {
            const prefix = norm.slice(0, -1); // "image/"
            return mime.startsWith(prefix);
        }
        return norm === mime;
    });
}

/**
 * A content type that is blank (an empty string, white space only) is no content type: a browser that does not
 * know a file's type sends one, and a form that was never filled in sends the other. It is dropped before
 * anything is validated, so the file is stored without a type rather than refused as "invalid".
 */
export function cleanContentType<T>(value: T): T | undefined {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return (trimmed === '' ? undefined : trimmed) as T | undefined;
}

function assertUploadAllowed(request: UploadFileRequest, fileBuffer: Buffer): void {
    const cfg = getConfig();
    const maxBytes = Math.max(1, cfg.limits.fileUploadMaxMb) * 1024 * 1024;
    if (fileBuffer.length > maxBytes) {
        throw new FileServiceError(
            'file_too_large',
            413,
            `File exceeds maximum allowed size of ${cfg.limits.fileUploadMaxMb} MB (got ${Math.ceil(fileBuffer.length / (1024 * 1024))} MB).`,
        );
    }
    if (request.contentType !== undefined && request.contentType !== null) {
        if (typeof request.contentType !== 'string' || !FILE_UPLOAD_SAFE_MIME_RE.test(request.contentType.split(';')[0]!.trim())) {
            throw new FileServiceError('invalid_content_type', 400, 'Invalid content-type header for upload.');
        }
    }
    if (!isMimeTypeAllowed(request.contentType, cfg.limits.fileUploadAllowedMimeTypes)) {
        throw new FileServiceError(
            'content_type_not_allowed',
            415,
            `Content type "${request.contentType ?? 'unknown'}" is not in the FILE_UPLOAD_ALLOWED_MIME_TYPES allowlist.`,
        );
    }
}

/**
 * The longest name (the last path segment) a key the console generates may have, in UTF-8 bytes. A store such as MinIO
 * takes 255 bytes in a segment and so does the file system under the local-disk driver, which writes a sidecar
 * (`<name>.meta.json`) beside each file: 200 leaves room for it. (The whole key has a limit of its own, which depends on
 * the store, and a key a caller names is the caller's to keep within it.) The Upload screen holds the same numbers
 * (`keyStem`), and a test holds the two together.
 */
const MAX_GENERATED_NAME_BYTES = 200;

/** The most of a file's extension a generated key keeps: the name is stem + unique part + extension. */
const MAX_KEY_EXTENSION_BYTES = 32;

/** A UTF-16 surrogate with no partner (text that has no UTF-8 form). */
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** The first characters of `text` that fit in `maxBytes` of UTF-8, cut between characters. */
function truncateUtf8(text: string, maxBytes: number): string {
    let bytes = 0;
    let kept = '';
    for (const character of text) {
        const size = Buffer.byteLength(character);
        if (bytes + size > maxBytes) break;
        kept += character;
        bytes += size;
    }
    return kept;
}

/** Letters that do not decompose into a base letter and marks, spelled the way a reader would type them in ASCII. */
const ASCII_SPELLING: Record<string, string> = { ı: 'i', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th' };

/** Lower-case text with its accents dropped (`Şirket Özeti` -> `sirket ozeti`), so a generated key stays readable. */
function foldToAscii(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .replace(/[ıßæœøłđðþ]/g, (char) => ASCII_SPELLING[char] ?? char);
}

/**
 * A unique object key (relative to the bucket) for a file name: `<slug>-<timestamp>-<id>.<ext>`.
 *
 * The name (the last path segment) is kept within what a store takes (`MAX_GENERATED_NAME_BYTES`): the stem is
 * shortened - the unique part, which keeps two uploads apart, never is - and the extension is cut after 32 bytes and
 * has no character without a UTF-8 form, so a file with a very long name is stored under a shorter one instead of
 * being refused by the store. The Upload screen shows this key (`keyStem` mirrors this function, and a test holds the
 * two together).
 */
export function generateFileRelativeKey(fileName: string): string {
    const normalized = normalizeFileName(fileName);
    const fullExtension = path.extname(normalized);
    const baseName = normalized.slice(0, normalized.length - fullExtension.length) || 'file';
    const stem = foldToAscii(baseName)
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'file';
    const unique = `-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const extension = truncateUtf8(fullExtension.replace(LONE_SURROGATES, ''), MAX_KEY_EXTENSION_BYTES);
    const room = MAX_GENERATED_NAME_BYTES - Buffer.byteLength(unique) - Buffer.byteLength(extension);
    // The stem is ASCII (see above), so a character is a byte.
    const kept = stem.slice(0, room).replace(/-+$/g, '') || 'file';
    return `${kept}${unique}${extension}`;
}

/** A `keyHint` the way an upload reads it: without surrounding space and without a leading `/`. */
function readKeyHint(keyHint: string | undefined): string {
    return keyHint?.trim().replace(/^\/+/, '') ?? '';
}

/**
 * Whether a hint is the whole key of the file (an address of its own), as opposed to no hint or a folder (which get a
 * generated name). Only an upload to a whole key can meet a file that already has that key.
 */
export function namesWholeKey(keyHint: string | undefined): boolean {
    const hint = readKeyHint(keyHint);
    return hint !== '' && !hint.endsWith('/');
}

/**
 * The object key (relative to the bucket) an upload is stored under. No hint =
 * a generated unique name. A hint that ends with `/` names a folder: the file
 * lands in it under the generated name (the Document Store uploads from inside a
 * folder this way). Any other hint is the whole key.
 */
export function chooseRelativeFileKey(keyHint: string | undefined, fileName: string): string {
    const hint = readKeyHint(keyHint);
    if (!hint) return generateFileRelativeKey(fileName);
    if (!hint.endsWith('/')) return hint;
    return `${hint.replace(/\/{2,}/g, '/')}${generateFileRelativeKey(fileName)}`;
}

/**
 * The `keyHint` for an upload that names a destination folder (`folder`, or its
 * alias `prefix`): the Document Store uploads from inside the folder it is
 * showing. With a folder alone the file lands in it under a generated unique name;
 * with a `keyHint` too, the hint is the file's name inside the folder. A segment
 * that climbs out (`..`) or a path that is not text is refused. Neither given =
 * no hint (a generated name at the bucket root, as before).
 */
export function composeUploadKeyHint(input: { folder?: unknown; keyHint?: unknown }): { keyHint?: string } | { error: string } {
    const MAX = 512;
    const clean = (value: unknown, field: string): { value: string } | { error: string } => {
        if (typeof value !== 'string') return { error: `${field} must be text.` };
        const slashed = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
        if (slashed.length > MAX) return { error: `${field} must be at most ${MAX} characters.` };
        if (slashed.split('/').some((segment) => segment === '..' || segment === '.')) {
            return { error: `${field} cannot contain "." or ".." segments.` };
        }
        if (/[\u0000-\u001f\u007f]/.test(slashed)) return { error: `${field} cannot contain control characters.` };
        if (hasLoneSurrogate(slashed)) return { error: `${field} cannot contain unpaired surrogate characters.` };
        return { value: slashed };
    };
    const hasFolder = input.folder !== undefined && input.folder !== null && input.folder !== '';
    const hasHint = input.keyHint !== undefined && input.keyHint !== null && input.keyHint !== '';
    if (!hasFolder) {
        if (!hasHint) return {};
        const hint = clean(input.keyHint, 'keyHint');
        return 'error' in hint ? hint : { keyHint: hint.value };
    }
    const folder = clean(input.folder, 'folder');
    if ('error' in folder) return folder;
    const root = normalizeFolderPrefix(folder.value);
    if (!hasHint) return root ? { keyHint: root } : {};
    const hint = clean(input.keyHint, 'keyHint');
    if ('error' in hint) return hint;
    return { keyHint: `${root}${hint.value.replace(/^\/+/, '')}` };
}

function decodeData(payload: Buffer | string): Buffer {
    if (Buffer.isBuffer(payload)) {
        return payload;
    }

    // The text the quotas were asked about (`decodedByteLength`): a data URL's payload, else everything.
    const text = base64TextOf(payload);

    try {
        return Buffer.from(text, 'base64');
    } catch (error) {
        logger.warn('Failed to decode base64 payload, falling back to utf-8 buffer', { error });
        return Buffer.from(text, 'utf8');
    }
}

function deriveMarkdownKey(originalKey: string): string {
    if (originalKey.includes('.')) {
        const ext = path.extname(originalKey);
        // A markdown original must keep its own object: its text version lives beside it, never over it.
        if (ext && ext.toLowerCase() !== '.md') {
            return `${originalKey.slice(0, originalKey.length - ext.length)}.md`;
        }
    }
    return `${originalKey}.md`;
}

function extractMarkdownContent(conversion: unknown): string | undefined {
    if (!conversion) {
        return undefined;
    }

    if (typeof conversion === 'string') {
        return conversion;
    }

    if (typeof conversion === 'object') {
        const candidate = conversion as Record<string, unknown>;
        if (typeof candidate.markdown === 'string') {
            return candidate.markdown;
        }
        if (typeof candidate.content === 'string') {
            return candidate.content;
        }
        if (typeof candidate.result === 'string') {
            return candidate.result;
        }
    }

    return undefined;
}

function truncateError(error: unknown): string {
    if (error instanceof Error) {
        return error.message.slice(0, 500);
    }
    return String(error).slice(0, 500);
}

export async function listFileDrivers() {
    return providerRegistry.listDescriptors('file');
}

type ProviderFilters = NonNullable<Parameters<typeof listProviderConfigs>[2]>;
type FileProviderFilters = Omit<ProviderFilters, 'type'>;
type CreateFileProviderInput = Omit<CreateProviderConfigInput, 'type'>;

export async function listFileProviders(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    filters?: FileProviderFilters,
): Promise<FileProviderView[]> {
    const providers = await listProviderConfigs(tenantDbName, tenantId, {
        ...(filters ?? {}),
        type: 'file',
        projectId,
    });
    return providers.map((provider) => attachDriverCapabilities(provider));
}

export async function createFileProvider(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    payload: CreateFileProviderInput,
): Promise<FileProviderView> {
    const provider = await createProviderConfig(tenantDbName, tenantId, {
        ...payload,
        type: 'file',
        projectId,
    });
    return attachDriverCapabilities(provider);
}

export async function listFileBuckets(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
): Promise<FileBucketView[]> {
    const db = await withTenantDb(tenantDbName);
    const [buckets, providers] = await Promise.all([
        db.listFileBuckets(tenantId, projectId),
        listProviderConfigs(tenantDbName, tenantId, { type: 'file', projectId }),
    ]);

    const providerMap = new Map<string, FileProviderView>(
        providers.map((provider) => [provider.key, attachDriverCapabilities(provider)]),
    );

    return buckets.map((bucket) => {
        const view = serializeFileBucket(bucket);
        const provider = providerMap.get(bucket.providerKey);
        return provider ? { ...view, provider } : view;
    });
}

export async function createFileBucket(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    payload: CreateFileBucketInput,
): Promise<FileBucketView> {
    // The same rules as an update (bucketRules), checked before anything is read.
    const key = parseBucketKey(payload.key);
    const name = parseBucketName(payload.name);
    const description = payload.description == null ? undefined : parseBucketDescription(payload.description);
    const status = payload.status == null ? 'active' : parseBucketStatus(payload.status);
    const prefix = payload.prefix == null ? key : parseBucketPrefix(payload.prefix);
    const metadata = payload.metadata == null ? undefined : parseBucketMetadata(payload.metadata);

    const db = await withTenantDb(tenantDbName);

    const existing = await db.findFileBucketByKey(tenantId, key, projectId);
    if (existing) {
        throw new FileServiceError('duplicate_key', 409, `Bucket with key "${key}" already exists.`);
    }

    const provider = await getProviderConfigByKey(
        tenantDbName,
        tenantId,
        payload.providerKey,
        projectId,
    );

    if (!provider) {
        throw new FileServiceError('provider_missing', 400, 'Associated file provider not found.');
    }

    if (provider.status !== 'active') {
        throw new FileServiceError('provider_inactive', 409, 'Provider must be active to create a bucket.');
    }

    const record = await db.createFileBucket({
        tenantId,
        projectId,
        key,
        name,
        providerKey: payload.providerKey,
        description,
        prefix,
        metadata,
        status,
        createdBy: payload.createdBy,
    });

    return {
        ...serializeFileBucket(record),
        provider: attachDriverCapabilities(provider),
    } satisfies FileBucketView;
}

export async function getFileBucket(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
): Promise<FileBucketView> {
    const record = await requireBucketRecord(tenantDbName, tenantId, projectId, bucketKey);

    const provider = await getProviderConfigByKey(
        tenantDbName,
        tenantId,
        record.providerKey,
        projectId,
    );

    const view = serializeFileBucket(record);
    return provider ? { ...view, provider: attachDriverCapabilities(provider) } : view;
}

export async function deleteFileBucket(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
    options?: DeleteFileBucketOptions,
): Promise<boolean> {
    const db = await withTenantDb(tenantDbName);
    const record = await db.findFileBucketByKey(tenantId, bucketKey, projectId);

    if (!record) {
        return false;
    }

    // The job that deletes the bucket with its files owns the bucket until it ends. Only `force` goes past it: a job the
    // queue lost (a restart) leaves the bucket marked for good, and when its storage location is shared the deletion
    // cannot be asked for again - removing the bucket record, with the files left where they are, is the way out.
    if (isBucketDeleting(record) && !options?.force) {
        throw bucketDeletingError();
    }

    if (!options?.force) {
        const { items } = await db.listFileRecords({
            providerKey: record.providerKey,
            bucketKey: record.key,
            projectId,
            limit: 1,
        });

        if (items.length > 0) {
            throw new FileServiceError('bucket_not_empty', 409, 'Bucket contains files. Remove files or use force delete.');
        }
    }

    const bucketId = record._id?.toString();
    if (!bucketId) {
        throw new Error('Bucket identifier missing.');
    }

    return db.deleteFileBucket(bucketId);
}

export interface UpdateFileBucketInput extends BucketFieldsPatch {
    updatedBy?: string;
}

export async function updateFileBucket(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
    updates: UpdateFileBucketInput,
): Promise<FileBucketView> {
    // A route has parsed the body already; any other caller gets the same rules here.
    const { updatedBy, ...fields } = updates;
    const patch = parseBucketPatch(fields);

    const db = await withTenantDb(tenantDbName);
    const record = await requireBucketRecord(tenantDbName, tenantId, projectId, bucketKey);

    const bucketId = record._id?.toString();
    if (!bucketId) {
        throw new Error('Bucket identifier missing.');
    }

    // The job that deletes the bucket owns it until it ends.
    if (isBucketDeleting(record)) {
        throw bucketDeletingError();
    }

    // Stored objects are addressed through the prefix: moving it would leave every record pointing at nothing.
    if (patch.prefix !== undefined && patch.prefix !== resolveBucketPrefix(record)) {
        const { items } = await db.listFileRecords({
            providerKey: record.providerKey,
            bucketKey: record.key,
            projectId,
            limit: 1,
        });
        if (items.length > 0) {
            throw new FileServiceError('prefix_locked', 409, 'The prefix cannot change while the bucket holds files.');
        }
    }

    const data: Parameters<DatabaseProvider['updateFileBucket']>[1] = { ...patch, ...(updatedBy ? { updatedBy } : {}) };

    // The metadata a caller sends replaces the stored one, except for the keys the service keeps for itself. A bucket
    // that is switched on again is no longer one whose deletion failed.
    const clearsDeleteError = patch.status === 'active' && bucketDeleteError(record) !== undefined;
    if (patch.metadata !== undefined || clearsDeleteError) {
        const kept = reservedBucketMetadata(record.metadata);
        if (clearsDeleteError) delete kept[BUCKET_DELETE_ERROR_KEY];
        data.metadata = { ...(patch.metadata ?? withoutReservedBucketMetadata(record.metadata ?? {})), ...kept };
    }

    const updated = await db.updateFileBucket(bucketId, data);
    if (!updated) {
        throw new FileServiceError('bucket_not_found', 404, 'File bucket not found.');
    }

    const provider = await getProviderConfigByKey(
        tenantDbName,
        tenantId,
        updated.providerKey,
        projectId,
    );

    const view = serializeFileBucket(updated);
    return provider ? { ...view, provider: attachDriverCapabilities(provider) } : view;
}

export async function listFiles(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    request: ListFilesRequest,
): Promise<ListFilesResponse> {
    // The listing reads the database only: a switched-off bucket and a provider that cannot be reached still list.
    const bucket = await requireBucketRecord(
        tenantDbName,
        tenantId,
        projectId,
        request.bucketKey,
    );

    if (request.providerKey && bucket.providerKey !== request.providerKey) {
        throw new FileServiceError('provider_mismatch', 400, 'Bucket is not associated with the requested provider.');
    }

    const db = await withTenantDb(tenantDbName);

    // A folder, not a search or a filter: its files and its sub-folders, derived from the keys.
    if (request.prefix !== undefined && !request.search && !request.type) {
        const prefix = normalizeFolderPrefix(request.prefix);
        const page = await db.listFileEntries({
            providerKey: bucket.providerKey,
            bucketKey: bucket.key,
            projectId,
            prefix,
            purpose: request.purpose,
            limit: request.limit,
            cursor: request.cursor,
        });
        return {
            items: page.items.map(serializeFileRecord) as FileRecordListItem[],
            folders: page.folders,
            prefix,
            nextCursor: page.nextCursor,
        };
    }

    const { items, nextCursor } = await db.listFileRecords({
        providerKey: bucket.providerKey,
        bucketKey: bucket.key,
        projectId,
        search: request.search,
        ...(request.prefix ? { prefix: normalizeFolderPrefix(request.prefix) } : {}),
        purpose: request.purpose,
        ...(request.type ? { type: request.type } : {}),
        limit: request.limit,
        cursor: request.cursor,
    });

    return {
        items: items.map(serializeFileRecord) as FileRecordListItem[],
        nextCursor,
    };
}

async function persistRecord(
    db: DatabaseProvider,
    tenantId: string,
    projectId: string,
    providerKey: string,
    bucketKey: string,
    relativeKey: string,
    handle: FileObjectHandle,
    request: UploadFileRequest,
    fileSize: number,
    markdownStatus: FileMarkdownStatus,
): Promise<FileRecordView> {
    const created = await db.createFileRecord({
        tenantId,
        projectId,
        providerKey,
        bucketKey,
        key: relativeKey,
        name: handle.name ?? normalizeFileName(request.fileName),
        size: handle.size ?? fileSize,
        contentType: handle.contentType ?? request.contentType,
        checksum: handle.checksum,
        etag: handle.etag,
        metadata: handle.metadata ?? request.metadata,
        markdownStatus,
        ...(request.recordExtras ?? {}),
        createdBy: request.createdBy,
    });

    return serializeFileRecord(created);
}

/**
 * The record of an upload that came to a key a file already has: that file is replaced - the same record (and id), now
 * describing the new bytes, its metadata the new upload's. The Markdown copy belongs to the old bytes: the record lets
 * go of it and its object is removed, so a conversion of the new bytes takes the name again. What the record says about
 * its place in the bucket (who first uploaded it, the session it belongs to, when it expires) is left as it is.
 *
 * `null` when the record is gone by now (deleted between the lookup and this write): the caller creates one instead.
 */
async function replaceRecord(
    db: DatabaseProvider,
    runtime: FileProviderRuntime,
    bucket: IFileBucketRecord,
    existing: IFileRecord,
    handle: FileObjectHandle,
    request: UploadFileRequest,
    fileSize: number,
    markdownStatus: FileMarkdownStatus,
): Promise<FileRecordView | null> {
    const id = idOfRecord(existing);
    if (!id) return null;
    const updated = await db.updateFileRecord(id, {
        name: handle.name ?? normalizeFileName(request.fileName),
        size: handle.size ?? fileSize,
        contentType: handle.contentType ?? request.contentType ?? null,
        checksum: handle.checksum ?? null,
        etag: handle.etag ?? null,
        metadata: handle.metadata ?? request.metadata ?? {},
        markdownStatus,
        markdownKey: null,
        markdownSize: null,
        markdownContentType: null,
        markdownError: null,
        updatedBy: request.createdBy,
    });
    if (!updated) return null;

    if (existing.markdownKey) {
        try {
            await runtime.deleteFile(composeProviderObjectKey(bucket, existing.markdownKey));
        } catch (error) {
            if (!hasObjectMissingCode(error)) {
                logger.warn('Could not remove the Markdown copy of the bytes an upload replaced', {
                    bucketKey: bucket.key,
                    key: existing.markdownKey,
                    error: describeFailure(error),
                });
            }
        }
    }
    return serializeFileRecord(updated);
}

/** The file a Markdown copy is made for, as the conversion needs to know it: a stored record or the view of one. */
interface ConvertedFile {
    key: string;
    /** The `id` of a record view, or the `_id` of a stored record. */
    id?: string;
    _id?: unknown;
    projectId?: string;
    /** The copy the file already has: the one a new copy may replace. */
    markdownKey?: string;
}

function idOfRecord(record: { id?: string; _id?: unknown }): string | undefined {
    if (record.id) return record.id;
    return record._id === undefined || record._id === null ? undefined : String(record._id);
}

/**
 * Whether a name in the bucket is not free for the Markdown copy of `record`: another file has it as its key or as
 * its own copy, or an object nobody registered (put there by another tool, not imported yet) sits there. The file's
 * own earlier copy is the one thing that may be written over.
 */
async function markdownKeyIsTaken(
    db: DatabaseProvider,
    runtime: FileProviderRuntime,
    bucket: IFileBucketRecord,
    record: ConvertedFile,
    name: string,
): Promise<boolean> {
    const recordId = idOfRecord(record);
    const lookup = {
        providerKey: bucket.providerKey,
        bucketKey: bucket.key,
        ...(record.projectId ? { projectId: record.projectId } : {}),
        keys: [name],
    };
    const [named, copies] = await Promise.all([
        db.listFileRecordsByKeys(lookup),
        db.listFileRecordsByKeys({ ...lookup, field: 'markdownKey' }),
    ]);
    const isAnother = (other: IFileRecord) => idOfRecord(other) !== recordId;
    if (named.some(isAnother) || copies.some(isAnother)) return true;
    if (record.markdownKey === name) return false;
    return (await runtime.getFileMetadata(composeProviderObjectKey(bucket, name))) !== null;
}

/**
 * Runs `work` once the earlier work for the same `lane` (a tenant's provider) has finished. A copy's name is chosen
 * by looking at what is already stored, so two conversions that both look before either has written would choose
 * one name and one copy would take the other's place - a folder upload of `nda.pdf` and `nda.docx` converts both at
 * the same moment. Only choosing the name and writing the copy take turns, never the conversion itself. This keeps
 * the conversions of one process apart; the conversions of two nodes are apart but for the time of one write.
 */
const lanes = new Map<string, Promise<void>>();

export async function oneAtATime<T>(lane: string, work: () => Promise<T>): Promise<T> {
    const turn = (lanes.get(lane) ?? Promise.resolve()).then(work);
    const done = turn.then(() => undefined, () => undefined);
    lanes.set(lane, done);
    try {
        return await turn;
    } finally {
        if (lanes.get(lane) === done) lanes.delete(lane);
    }
}

/**
 * The key the Markdown copy of a file is stored under. The copy sits beside its original, named like it with the
 * extension replaced (`notes.txt` -> `notes.md`); when that name is not free (see `markdownKeyIsTaken`) the copy is
 * named `<key>.md` (`notes.txt.md`) instead. `undefined`: both names are taken, and nothing is written.
 */
async function chooseMarkdownKey(
    db: DatabaseProvider,
    runtime: FileProviderRuntime,
    bucket: IFileBucketRecord,
    record: ConvertedFile,
): Promise<string | undefined> {
    const names = [...new Set([deriveMarkdownKey(record.key), `${record.key}.md`])];
    for (const name of names) {
        if (!(await markdownKeyIsTaken(db, runtime, bucket, record, name))) return name;
    }
    return undefined;
}

/**
 * Converts the bytes of a file to Markdown and stores the copy beside the original. Never throws: a conversion that
 * cannot be done is the returned status (`skipped` when it produced no text, `failed` with the reason), so the
 * caller records it on the file instead of failing an upload that already succeeded.
 *
 * A copy never takes the place of another file: see `chooseMarkdownKey`. A document that unpacks to more than the
 * converter may open (`documentConversion`) is `failed` with a sentence that says so.
 */
export async function applyMarkdownConversion(
    runtime: FileProviderRuntime,
    bucket: IFileBucketRecord,
    record: ConvertedFile,
    request: Pick<UploadFileRequest, 'fileName'>,
    fileBuffer: Buffer,
    db: DatabaseProvider,
): Promise<UpdateFileConversionPayload> {
    let markdownContent: string | undefined;
    try {
        const conversion = await convertDocumentToMarkdown(fileBuffer, request.fileName);
        markdownContent = extractMarkdownContent(conversion);
    } catch (error) {
        if (error instanceof DocumentConversionRefused) {
            return {
                markdownStatus: 'failed',
                markdownError: error.message,
            } satisfies UpdateFileConversionPayload;
        }
        logger.error('Markdown conversion failed', { error });
        return {
            markdownStatus: 'failed',
            markdownError: truncateError(error),
        } satisfies UpdateFileConversionPayload;
    }

    if (!markdownContent) {
        return {
            markdownStatus: 'skipped',
            markdownError: 'Conversion output missing markdown content.',
        };
    }

    try {
        const markdownBuffer = Buffer.from(markdownContent, 'utf8');
        // Choosing the name and writing under it are one step: see `oneAtATime`.
        const stored = await oneAtATime(`${bucket.tenantId}:${bucket.providerKey}`, async () => {
            const relativeMarkdownKey = await chooseMarkdownKey(db, runtime, bucket, record);
            if (!relativeMarkdownKey) return undefined;
            const providerMarkdownKey = composeProviderObjectKey(
                bucket,
                relativeMarkdownKey,
            );
            const upload = await withResilience(
                () => runtime.uploadFile({
                    key: providerMarkdownKey,
                    name: `${normalizeFileName(request.fileName)}.md`,
                    contentType: 'text/markdown',
                    data: markdownBuffer,
                    metadata: {
                        sourceKey: record.key,
                        converter: '@cognipeer/to-markdown',
                    },
                }),
                fileResilience('upload', bucket.tenantId, bucket.providerKey),
            );
            return { handle: upload.handle, providerMarkdownKey };
        });
        if (!stored) {
            return {
                markdownStatus: 'failed',
                markdownError: 'The Markdown copy was not stored: the names it would take belong to other files of the bucket.',
            } satisfies UpdateFileConversionPayload;
        }

        const handle = stored.handle;
        const storedRelativeKey = stripBucketPrefix(
            bucket,
            handle.key ?? stored.providerMarkdownKey,
        );

        return {
            markdownStatus: 'succeeded',
            markdownKey: storedRelativeKey,
            markdownSize: handle.size ?? markdownBuffer.length,
            markdownContentType: handle.contentType ?? 'text/markdown',
        } satisfies UpdateFileConversionPayload;
    } catch (error) {
        logger.error('Storing the Markdown copy failed', { error });
        return {
            markdownStatus: 'failed',
            // What the provider's SDK says can carry a request URL or a path: only a sentence made for people is kept.
            markdownError: describeFailure(error),
        } satisfies UpdateFileConversionPayload;
    }
}

/**
 * The object an upload wrote has no record to carry it (saving the record failed): nobody could list or delete
 * it later, so it is removed again. Best effort - the error worth reporting is the one that got us here.
 *
 * An upload may have written over the object of a file that already exists (a caller can name the whole key).
 * That object is that file's: it is only removed when the database confirms that no record names the key.
 */
async function discardUploadedObject(
    db: DatabaseProvider,
    runtime: FileProviderRuntime,
    bucket: IFileBucketRecord,
    projectId: string,
    relativeKey: string,
): Promise<void> {
    try {
        const owner = await db.findFileRecordByKey(bucket.providerKey, bucket.key, relativeKey, projectId);
        if (owner) return;
        await runtime.deleteFile(composeProviderObjectKey(bucket, relativeKey));
    } catch (cleanupError) {
        logger.warn('Could not remove an uploaded object after saving its record failed', {
            bucketKey: bucket.key,
            key: relativeKey,
            error: cleanupError,
        });
    }
}

/**
 * An upload writes the object and then its record. A bucket that began to be deleted (or was switched off) in
 * between must keep neither: the deletion lists the bucket's files once and would never see them. Called once the
 * record exists, this reads the bucket again and, when it no longer takes files, withdraws the record and the
 * object and refuses the upload as a write to that bucket would have been refused. A bucket that cannot be read
 * again leaves the upload as it is.
 */
async function withdrawIfBucketClosed(
    db: DatabaseProvider,
    runtime: FileProviderRuntime,
    bucket: IFileBucketRecord,
    projectId: string,
    record: FileRecordView,
    /** The upload replaced a file that was there before: its record is that file's, and stays (it describes the object). */
    replaced = false,
): Promise<void> {
    let current: IFileBucketRecord | null;
    try {
        current = await db.findFileBucketByKey(bucket.tenantId, bucket.key, projectId);
    } catch (error) {
        logger.warn('Could not check that a bucket still takes files after an upload', { bucketKey: bucket.key, error });
        return;
    }
    const closed = bucketClosedError(current);
    if (!closed) return;

    if (!replaced) {
        await db.deleteFileRecord(record.id).catch(() => undefined);
        await discardUploadedObject(db, runtime, bucket, projectId, record.key);
    }
    throw closed;
}

/** The Markdown copy of a file that was deleted while it was converted has no record to carry it. */
async function discardOrphanedCopy(
    runtime: FileProviderRuntime,
    bucket: IFileBucketRecord,
    conversion: UpdateFileConversionPayload,
): Promise<void> {
    if (!conversion.markdownKey) return;
    await runtime.deleteFile(composeProviderObjectKey(bucket, conversion.markdownKey)).catch(() => undefined);
}

/**
 * Hands a `pending` record to the background conversion. The upload has succeeded whatever happens here, so a job
 * that cannot be queued is not an error of the call: the record says `failed`, with why, and can be converted again.
 */
async function handOverToConversionJob(
    db: DatabaseProvider,
    record: FileRecordView,
    job: ConvertMarkdownJobPayload,
): Promise<FileRecordView> {
    try {
        await publishConvertMarkdownJob(job);
        return record;
    } catch (error) {
        const markdownError = describeFailure(error);
        const failed = await db.updateFileRecord(record.id, {
            markdownStatus: 'failed',
            markdownError,
            updatedBy: job.actor,
        });
        return failed ? serializeFileRecord(failed) : { ...record, markdownStatus: 'failed', markdownError };
    }
}

export async function uploadFile(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    input: UploadFileRequest,
): Promise<UploadFileResponse> {
    const request: UploadFileRequest = { ...input, contentType: cleanContentType(input.contentType) };
    const { bucket, runtime } = await requireBucketContext(
        tenantDbName,
        tenantId,
        projectId,
        request.bucketKey,
    );

    if (request.providerKey && bucket.providerKey !== request.providerKey) {
        throw new FileServiceError('provider_mismatch', 400, 'Bucket is not associated with the provided provider key.');
    }

    const db = await withTenantDb(tenantDbName);

    const fileBuffer = decodeData(request.data);
    assertUploadAllowed(request, fileBuffer);
    const fileName = normalizeFileName(request.fileName);
    const chosenRelativeKey = chooseRelativeFileKey(request.keyHint, fileName);

    const providerObjectKey = composeProviderObjectKey(
        bucket,
        chosenRelativeKey,
    );

    const conversionRequested = request.convertToMarkdown ?? true;
    // `queued`: a background job makes the copy, and only for the formats it can read (markdownSupport): a file of
    // any other kind has nothing to wait for. The default (`sync`) converts before the call returns.
    const convertLater = conversionRequested && request.markdown === 'queued' && isMarkdownConvertible(fileName);
    const convertNow = conversionRequested && request.markdown !== 'queued';
    const initialStatus: FileMarkdownStatus = convertNow || convertLater ? 'pending' : 'skipped';
    const wholeKey = namesWholeKey(request.keyHint);

    // The object, then the record that carries it. An upload to a whole key writes over the file that has that key,
    // when there is one, so the two steps are one for the uploads to that key (see `oneAtATime`): two that wrote
    // their bytes and then looked for the record would each find none, and the one object would have two records.
    const store = async (): Promise<{ record: FileRecordView; replaced: boolean; storedRelativeKey: string }> => {
        const upload = await withResilience(
            () => runtime.uploadFile({
                key: providerObjectKey,
                name: fileName,
                contentType: request.contentType,
                data: fileBuffer,
                metadata: request.metadata,
            }),
            fileResilience('upload', tenantId, bucket.providerKey),
        );

        const storedRelativeKey = stripBucketPrefix(
            bucket,
            upload.handle.key ?? providerObjectKey,
        );

        const adjustedHandle: FileObjectHandle = {
            ...upload.handle,
            key: storedRelativeKey,
            name: upload.handle.name ?? fileName,
            contentType: upload.handle.contentType ?? request.contentType,
        };

        try {
            const existing = wholeKey
                ? await db.findFileRecordByKey(bucket.providerKey, bucket.key, storedRelativeKey, projectId)
                : null;
            const replacement = existing
                ? await replaceRecord(db, runtime, bucket, existing, adjustedHandle, request, fileBuffer.length, initialStatus)
                : null;
            if (replacement) return { record: replacement, replaced: true, storedRelativeKey };
            const created = await persistRecord(
                db,
                tenantId,
                projectId,
                bucket.providerKey,
                bucket.key,
                storedRelativeKey,
                adjustedHandle,
                request,
                fileBuffer.length,
                initialStatus,
            );
            return { record: created, replaced: false, storedRelativeKey };
        } catch (error) {
            await discardUploadedObject(db, runtime, bucket, projectId, storedRelativeKey);
            throw error;
        }
    };
    const { record, replaced, storedRelativeKey } = wholeKey
        ? await oneAtATime(`upload:${tenantId}:${bucket.providerKey}:${bucket.key}:${chosenRelativeKey}`, store)
        : await store();

    await withdrawIfBucketClosed(db, runtime, bucket, projectId, record, replaced);

    if (convertLater) {
        return {
            record: await handOverToConversionJob(db, record, {
                tenantDbName,
                tenantId,
                projectId,
                bucketKey: bucket.key,
                key: storedRelativeKey,
                recordId: record.id,
                actor: request.createdBy,
            }),
        };
    }

    if (!convertNow) {
        return {
            record,
        };
    }

    const conversion = await applyMarkdownConversion(
        runtime,
        bucket,
        record,
        request,
        fileBuffer,
        db,
    );

    const settled = await db.updateFileRecord(record.id, {
        markdownStatus: conversion.markdownStatus,
        markdownKey: conversion.markdownKey,
        markdownSize: conversion.markdownSize,
        markdownContentType: conversion.markdownContentType,
        markdownError: conversion.markdownError,
        updatedBy: request.createdBy,
    });
    if (!settled) {
        // The bucket's deletion took the file while it was converted.
        await discardOrphanedCopy(runtime, bucket, conversion);
        throw bucketDeletingError();
    }

    const updated = await db.findFileRecordById(record.id);
    const view = updated ? serializeFileRecord(updated) : record;

    return {
        record: view,
    };
}

/**
 * Writes new bytes under an existing file's key (same record, same id) and converts them to
 * markdown again. For a file that grows after it was stored; the object providers replace an
 * object written under the same key.
 */
export async function replaceFileContent(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
    key: string,
    input: { data: Buffer; updatedBy: string; /** false = keep the bytes as the only version (no text copy). Default true. */ convertToMarkdown?: boolean },
): Promise<FileRecordView> {
    const { bucket, runtime, record } = await requireFileRecord(tenantDbName, tenantId, projectId, bucketKey, key, 'write');
    const request: UploadFileRequest = {
        bucketKey,
        fileName: record.name,
        contentType: cleanContentType(record.contentType),
        data: input.data,
        createdBy: input.updatedBy,
    };
    assertUploadAllowed(request, input.data);

    const upload = await withResilience(
        () => runtime.uploadFile({
            key: composeProviderObjectKey(bucket, record.key),
            name: record.name,
            contentType: record.contentType,
            data: input.data,
            metadata: record.metadata,
        }),
        fileResilience('upload', tenantId, bucket.providerKey),
    );

    const db = await withTenantDb(tenantDbName);
    const conversion: UpdateFileConversionPayload = input.convertToMarkdown === false
        ? { markdownStatus: 'skipped' }
        : await applyMarkdownConversion(runtime, bucket, record, request, input.data, db);
    const updated = await db.updateFileRecord(record.id, {
        size: upload.handle.size ?? input.data.length,
        checksum: upload.handle.checksum,
        etag: upload.handle.etag,
        ...conversion,
        updatedBy: input.updatedBy,
    });
    if (!updated) {
        // The file was deleted (its bucket with it) while the new content was written: the object and the copy have no record.
        await discardUploadedObject(db, runtime, bucket, projectId, record.key);
        await discardOrphanedCopy(runtime, bucket, conversion);
        throw new FileServiceError('file_not_found', 404, 'File record not found.');
    }
    return serializeFileRecord(updated);
}

async function requireFileRecord(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
    key: string,
    access: BucketAccess,
): Promise<{
    bucket: IFileBucketRecord;
    provider: IProviderRecord;
    runtime: FileProviderRuntime;
    record: FileRecordView;
}> {
    // The record first: a file that is not there is a 404 whatever state the provider is in, and no runtime is built for it.
    const bucket = await requireBucketRecord(tenantDbName, tenantId, projectId, bucketKey);
    if (access === 'write') {
        ensureFileBucketActive(bucket);
    }
    const record = await findFileRecord(tenantDbName, projectId, bucket, key);

    const { runtime, record: provider } = await buildRuntimeContext(
        tenantDbName,
        tenantId,
        bucket.providerKey,
        projectId,
    );

    return {
        bucket,
        provider,
        runtime,
        record: serializeFileRecord(record),
    };
}

export async function findFileRecord(
    tenantDbName: string,
    projectId: string,
    bucket: IFileBucketRecord,
    key: string,
): Promise<IFileRecord> {
    const db = await withTenantDb(tenantDbName);
    const record = await db.findFileRecordByKey(
        bucket.providerKey,
        bucket.key,
        key,
        projectId,
    );

    if (!record) {
        throw new FileServiceError('file_not_found', 404, 'File record not found.');
    }

    return record;
}

/**
 * Refuses, before anything is read, a stored object that is larger than the server holds in memory at once
 * (`maxStorageDownloadBytes`): an object put in the folder by another tool, then imported, can be of any size. The
 * drivers refuse the same object when they read it; this is the answer in the request's own words (413).
 */
export function assertWithinReadCeiling(size: number | undefined | null): void {
    const limit = maxStorageDownloadBytes();
    if (typeof size === 'number' && size > limit) {
        throw new FileServiceError(
            'object_too_large',
            413,
            `The file is larger than the ${Math.round(limit / (1024 * 1024))} MB this server reads into memory at once.`,
            { details: { limitBytes: limit } },
        );
    }
}

export async function downloadFile(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
    key: string,
    options?: DownloadFileOptions,
): Promise<DownloadFileResult> {
    // A switched-off bucket still gives its files back: only writes are refused.
    const { bucket, runtime, record } = await requireFileRecord(
        tenantDbName,
        tenantId,
        projectId,
        bucketKey,
        key,
        'read',
    );

    const variant = options?.variant ?? 'original';
    assertWithinReadCeiling(variant === 'markdown' ? record.markdownSize : record.size);
    const providerObjectKey = variant === 'markdown'
        ? (() => {
            if (!record.markdownKey) {
                throw new FileServiceError('markdown_unavailable', 409, 'Markdown conversion not available for this file.');
            }
            return composeProviderObjectKey(bucket, record.markdownKey);
        })()
        : composeProviderObjectKey(bucket, record.key);

    const result = await readStoredObject(runtime, providerObjectKey, {
        tenantId,
        providerKey: bucket.providerKey,
        size: variant === 'markdown' ? record.markdownSize : record.size,
    });
    const fileName = variant === 'markdown'
        ? deriveMarkdownKey(record.name)
        : record.name;

    return {
        fileName,
        data: result.data,
        contentType: result.contentType,
        size: result.size,
        etag: result.etag,
        metadata: result.metadata,
    };
}

/**
 * Removes a file's objects from its provider: the original, then its Markdown copy.
 *
 * An object that is already gone (the driver says so by its code) is no failure - it is what the caller wants, and a
 * record whose object was removed by another tool could not be deleted otherwise. A failure to remove the original always throws. One to remove the
 * Markdown copy only throws with `markdownCopy: 'strict'`; by default it is logged and the copy is left behind, as a
 * delete of one file always did.
 */
export async function removeStoredObjects(
    runtime: FileProviderRuntime,
    bucket: IFileBucketRecord,
    record: Pick<IFileRecord, 'key' | 'markdownKey'>,
    options: { markdownCopy?: 'lenient' | 'strict' } = {},
): Promise<void> {
    const remove = async (relativeKey: string): Promise<void> => {
        try {
            await withResilience(
                () => runtime.deleteFile(composeProviderObjectKey(bucket, relativeKey)),
                fileResilience('delete', bucket.tenantId, bucket.providerKey),
            );
        } catch (error) {
            if (!hasObjectMissingCode(error)) throw error;
        }
    };

    await remove(record.key);

    if (record.markdownKey) {
        try {
            await remove(record.markdownKey);
        } catch (error) {
            if (options.markdownCopy === 'strict') throw error;
            logger.warn('Failed to delete markdown file', { key: record.markdownKey, error });
        }
    }
}

export async function deleteFile(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
    key: string,
    deletedBy: string,
): Promise<boolean> {
    const { bucket, runtime, record } = await requireFileRecord(
        tenantDbName,
        tenantId,
        projectId,
        bucketKey,
        key,
        'write',
    );

    await removeStoredObjects(runtime, bucket, record);

    const db = await withTenantDb(tenantDbName);
    logger.debug('Deleting file record', { bucketKey: bucket.key, key: record.key, deletedBy });
    return db.deleteFileRecord(record.id);
}

export async function getFileRecord(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
    key: string,
): Promise<FileRecordView> {
    // Metadata is the database's: it reads whatever the bucket's status and the provider's state.
    const bucket = await requireBucketRecord(tenantDbName, tenantId, projectId, bucketKey);
    return serializeFileRecord(await findFileRecord(tenantDbName, projectId, bucket, key));
}
