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
    type FileProviderRuntime,
    type FileObjectHandle,
    type ProviderCapabilityFlags,
} from '@/lib/providers';
import {
    createProviderConfig,
    getProviderConfigByKey,
    listProviderConfigs,
    loadProviderRuntimeData,
    type CreateProviderConfigInput,
    type ProviderConfigView,
} from '@/lib/services/providers/providerService';
import { convertToMarkdown } from '@cognipeer/to-markdown';
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

function attachDriverCapabilities(provider: ProviderConfigView): FileProviderView {
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

function serializeFileBucket(bucket: IFileBucketRecord): FileBucketView {
    const { _id, ...rest } = bucket;
    return {
        ...rest,
        id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
    } satisfies FileBucketView;
}

function normalizePrefix(input?: string | null): string | undefined {
    if (input === undefined || input === null) {
        return undefined;
    }

    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return '';
    }

    const withoutSlashes = trimmed.replace(/^\/+|\/+$/g, '');
    return withoutSlashes;
}

function resolveBucketPrefix(bucket: IFileBucketRecord): string {
    const normalized = normalizePrefix(bucket.prefix);
    if (normalized !== undefined) {
        return normalized;
    }

    return bucket.key;
}

function composeProviderObjectKey(
    bucket: IFileBucketRecord,
    relativeKey: string,
): string {
    const cleanedRelative = relativeKey.replace(/^\/+/, '').replace(/\/+$/, '');
    const prefix = resolveBucketPrefix(bucket);

    if (!prefix) {
        return cleanedRelative;
    }

    return `${prefix}/${cleanedRelative}`;
}

function stripBucketPrefix(
    bucket: IFileBucketRecord,
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

function ensureFileBucketActive(bucket: IFileBucketRecord) {
    if (bucket.status !== 'active') {
        throw new Error('File bucket is not active.');
    }
}

async function requireBucketContext(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
): Promise<{
    bucket: IFileBucketRecord;
    provider: IProviderRecord;
    runtime: FileProviderRuntime;
}> {
    const db = await withTenantDb(tenantDbName);
    const bucket = await db.findFileBucketByKey(tenantId, bucketKey, projectId);

    if (!bucket) {
        throw new Error('File bucket not found.');
    }

    ensureFileBucketActive(bucket);

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
        throw new Error('Provider configuration is not a file provider.');
    }

    if (record.status !== 'active') {
        throw new Error('File provider is not active.');
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

type FileOperation = 'upload' | 'download' | 'delete';

/**
 * `withResilience` options for one file I/O call. The breaker key carries the tenant: a provider key is
 * only unique inside its tenant, so each tenant's provider gets a circuit of its own.
 */
function fileResilience(operation: FileOperation, tenantId: string, providerKey: string): ResilienceOptions {
    return {
        key: `file-${operation}:${tenantId}:${providerKey}`,
        countFailure: isTransientStorageError,
    };
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
    );

    ensureFileProvider(record);

    const cacheKey = `file:${tenantId}:${record.key}`;
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

function serializeFileRecord(record: IFileRecord): FileRecordView {
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

function assertUploadAllowed(request: UploadFileRequest, fileBuffer: Buffer): void {
    const cfg = getConfig();
    const maxBytes = Math.max(1, cfg.limits.fileUploadMaxMb) * 1024 * 1024;
    if (fileBuffer.length > maxBytes) {
        throw new Error(
            `File exceeds maximum allowed size of ${cfg.limits.fileUploadMaxMb} MB (got ${Math.ceil(fileBuffer.length / (1024 * 1024))} MB).`,
        );
    }
    if (request.contentType !== undefined && request.contentType !== null) {
        if (typeof request.contentType !== 'string' || !FILE_UPLOAD_SAFE_MIME_RE.test(request.contentType.split(';')[0]!.trim())) {
            throw new Error('Invalid content-type header for upload.');
        }
    }
    if (!isMimeTypeAllowed(request.contentType, cfg.limits.fileUploadAllowedMimeTypes)) {
        throw new Error(
            `Content type "${request.contentType ?? 'unknown'}" is not in the FILE_UPLOAD_ALLOWED_MIME_TYPES allowlist.`,
        );
    }
}

/** A unique object key (relative to the bucket) for a file name: `<slug>-<timestamp>-<id>.<ext>`. */
export function generateFileRelativeKey(fileName: string): string {
    const normalized = normalizeFileName(fileName);
    const extension = path.extname(normalized);
    const baseName = normalized.slice(0, normalized.length - extension.length) || 'file';
    const safeBase = baseName
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'file';
    return `${safeBase}-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`;
}

/**
 * The object key (relative to the bucket) an upload is stored under. No hint =
 * a generated unique name. A hint that ends with `/` names a folder: the file
 * lands in it under the generated name (the Document Store uploads from inside a
 * folder this way). Any other hint is the whole key.
 */
export function chooseRelativeFileKey(keyHint: string | undefined, fileName: string): string {
    const hint = keyHint?.trim().replace(/^\/+/, '');
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
        if (/[\u0000-\u001f]/.test(slashed)) return { error: `${field} cannot contain control characters.` };
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

    const trimmed = payload.trim();

    const dataUrlMatch = trimmed.match(/^data:.*?;base64,(.*)$/);
    if (dataUrlMatch) {
        return Buffer.from(dataUrlMatch[1], 'base64');
    }

    try {
        return Buffer.from(trimmed, 'base64');
    } catch (error) {
        logger.warn('Failed to decode base64 payload, falling back to utf-8 buffer', { error });
        return Buffer.from(trimmed, 'utf8');
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
    const db = await withTenantDb(tenantDbName);

    const existing = await db.findFileBucketByKey(tenantId, payload.key, projectId);
    if (existing) {
        throw new Error(`Bucket with key "${payload.key}" already exists.`);
    }

    const provider = await getProviderConfigByKey(
        tenantDbName,
        tenantId,
        payload.providerKey,
        projectId,
    );

    if (!provider) {
        throw new Error('Associated file provider not found.');
    }

    if (provider.status !== 'active') {
        throw new Error('Provider must be active to create a bucket.');
    }

    const prefix = normalizePrefix(payload.prefix) ?? payload.key;

    const record = await db.createFileBucket({
        tenantId,
        projectId,
        key: payload.key,
        name: payload.name,
        providerKey: payload.providerKey,
        description: payload.description,
        prefix,
        metadata: payload.metadata,
        status: payload.status ?? 'active',
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
    const db = await withTenantDb(tenantDbName);
    const record = await db.findFileBucketByKey(tenantId, bucketKey, projectId);

    if (!record) {
        throw new Error('File bucket not found.');
    }

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

    if (!options?.force) {
        const { items } = await db.listFileRecords({
            providerKey: record.providerKey,
            bucketKey: record.key,
            projectId,
            limit: 1,
        });

        if (items.length > 0) {
            throw new Error('Bucket contains files. Remove files or use force delete.');
        }
    }

    const bucketId = record._id?.toString();
    if (!bucketId) {
        throw new Error('Bucket identifier missing.');
    }

    return db.deleteFileBucket(bucketId);
}

export interface UpdateFileBucketInput {
    name?: string;
    description?: string;
    status?: 'active' | 'disabled';
    prefix?: string;
    metadata?: Record<string, unknown>;
    updatedBy?: string;
}

export async function updateFileBucket(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
    updates: UpdateFileBucketInput,
): Promise<FileBucketView> {
    const db = await withTenantDb(tenantDbName);
    const record = await db.findFileBucketByKey(tenantId, bucketKey, projectId);

    if (!record) {
        throw new Error('File bucket not found.');
    }

    const bucketId = record._id?.toString();
    if (!bucketId) {
        throw new Error('Bucket identifier missing.');
    }

    const updated = await db.updateFileBucket(bucketId, updates);
    if (!updated) {
        throw new Error('File bucket not found.');
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
    const { bucket } = await requireBucketContext(
        tenantDbName,
        tenantId,
        projectId,
        request.bucketKey,
    );

    if (request.providerKey && bucket.providerKey !== request.providerKey) {
        throw new Error('Bucket is not associated with the requested provider.');
    }

    const db = await withTenantDb(tenantDbName);

    // A folder, not a search: its files and its sub-folders, derived from the keys.
    if (request.prefix !== undefined && !request.search) {
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

async function applyMarkdownConversion(
    runtime: FileProviderRuntime,
    bucket: IFileBucketRecord,
    record: FileRecordView,
    request: UploadFileRequest,
    fileBuffer: Buffer,
): Promise<UpdateFileConversionPayload> {
    try {

        const conversion = await convertToMarkdown(fileBuffer, {
            fileName: request.fileName,
        });

        const markdownContent = extractMarkdownContent(conversion);
        if (!markdownContent) {
            return {
                markdownStatus: 'skipped',
                markdownError: 'Conversion output missing markdown content.',
            };
        }

        const markdownBuffer = Buffer.from(markdownContent, 'utf8');
        const relativeMarkdownKey = deriveMarkdownKey(record.key);
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

        const handle = upload.handle;
        const storedRelativeKey = stripBucketPrefix(
            bucket,
            handle.key ?? providerMarkdownKey,
        );

        return {
            markdownStatus: 'succeeded',
            markdownKey: storedRelativeKey,
            markdownSize: handle.size ?? markdownBuffer.length,
            markdownContentType: handle.contentType ?? 'text/markdown',
        } satisfies UpdateFileConversionPayload;
    } catch (error) {
        logger.error('Markdown conversion failed', { error });
        return {
            markdownStatus: 'failed',
            markdownError: truncateError(error),
        } satisfies UpdateFileConversionPayload;
    }
}

export async function uploadFile(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    request: UploadFileRequest,
): Promise<UploadFileResponse> {
    const { bucket, runtime } = await requireBucketContext(
        tenantDbName,
        tenantId,
        projectId,
        request.bucketKey,
    );

    if (request.providerKey && bucket.providerKey !== request.providerKey) {
        throw new Error('Bucket is not associated with the provided provider key.');
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

    const conversionRequested = request.convertToMarkdown ?? true;
    const initialStatus: FileMarkdownStatus = conversionRequested ? 'pending' : 'skipped';

    const record = await persistRecord(
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

    if (!conversionRequested) {
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
    );

    await db.updateFileRecord(record.id, {
        markdownStatus: conversion.markdownStatus,
        markdownKey: conversion.markdownKey,
        markdownSize: conversion.markdownSize,
        markdownContentType: conversion.markdownContentType,
        markdownError: conversion.markdownError,
        updatedBy: request.createdBy,
    });

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
    const { bucket, runtime, record } = await requireFileRecord(tenantDbName, tenantId, projectId, bucketKey, key);
    const request: UploadFileRequest = {
        bucketKey,
        fileName: record.name,
        contentType: record.contentType,
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
        : await applyMarkdownConversion(runtime, bucket, record, request, input.data);
    const updated = await db.updateFileRecord(record.id, {
        size: upload.handle.size ?? input.data.length,
        checksum: upload.handle.checksum,
        etag: upload.handle.etag,
        ...conversion,
        updatedBy: input.updatedBy,
    });
    return serializeFileRecord(updated ?? { ...record, size: input.data.length });
}

async function requireFileRecord(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
    key: string,
): Promise<{
    bucket: IFileBucketRecord;
    provider: IProviderRecord;
    runtime: FileProviderRuntime;
    record: FileRecordView;
}> {
    const { bucket, provider, runtime } = await requireBucketContext(
        tenantDbName,
        tenantId,
        projectId,
        bucketKey,
    );

    const db = await withTenantDb(tenantDbName);
    const record = await db.findFileRecordByKey(
        bucket.providerKey,
        bucket.key,
        key,
        projectId,
    );

    if (!record) {
        throw new Error('File record not found.');
    }

    return {
        bucket,
        provider,
        runtime,
        record: serializeFileRecord(record),
    };
}

export async function downloadFile(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
    key: string,
    options?: DownloadFileOptions,
): Promise<DownloadFileResult> {
    const { bucket, runtime, record } = await requireFileRecord(
        tenantDbName,
        tenantId,
        projectId,
        bucketKey,
        key,
    );

    const variant = options?.variant ?? 'original';
    const providerObjectKey = variant === 'markdown'
        ? (() => {
            if (!record.markdownKey) {
                throw new Error('Markdown conversion not available for this file.');
            }
            return composeProviderObjectKey(bucket, record.markdownKey);
        })()
        : composeProviderObjectKey(bucket, record.key);

    const result = await withResilience(
        () => runtime.downloadFile(providerObjectKey),
        fileResilience('download', tenantId, bucket.providerKey),
    );
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
    );

    await withResilience(
        () => runtime.deleteFile(
            composeProviderObjectKey(bucket, record.key),
        ),
        fileResilience('delete', tenantId, bucket.providerKey),
    );

    if (record.markdownKey) {
        try {
            await runtime.deleteFile(
                composeProviderObjectKey(bucket, record.markdownKey),
            );
        } catch (error) {
            logger.warn('Failed to delete markdown file', { key: record.markdownKey, error });
        }
    }

    const db = await withTenantDb(tenantDbName);
    await db.updateFileRecord(record.id, {
        updatedBy: deletedBy,
    });

    return db.deleteFileRecord(record.id);
}

export async function getFileRecord(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
    key: string,
): Promise<FileRecordView> {
    const { record } = await requireFileRecord(
        tenantDbName,
        tenantId,
        projectId,
        bucketKey,
        key,
    );

    return record;
}
