import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getDatabase, type DatabaseProvider, type FileMarkdownStatus, type IFileBucketRecord, type IFileRecord, type IProviderRecord } from '@/lib/database';
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

function createLogger(scope: string) {
    const prefix = `[files:${scope}]`;
    return {
        debug: (...args: unknown[]) => console.debug(prefix, ...args),
        info: (...args: unknown[]) => console.info(prefix, ...args),
        warn: (...args: unknown[]) => console.warn(prefix, ...args),
        error: (...args: unknown[]) => console.error(prefix, ...args),
    };
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
        console.warn(
            'File provider contract missing for driver',
            provider.driver,
            error instanceof Error ? error.message : error,
        );
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

    const logger = createLogger(`${record.key}`);

    const runtime = await providerRegistry.createRuntime<FileProviderRuntime>(
        record.driver,
        {
            tenantId,
            projectId,
            providerKey: record.key,
            credentials,
            settings: record.settings ?? {},
            metadata: record.metadata ?? {},
            logger,
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
    return fileName.trim();
}

function generateRelativeKey(fileName: string): string {
    const normalized = normalizeFileName(fileName);
    const extension = path.extname(normalized);
    const baseName = normalized.slice(0, normalized.length - extension.length) || 'file';
    const safeBase = baseName
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'file';
    return `${safeBase}-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`;
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
        console.warn('Failed to decode base64 payload, falling back to utf-8 buffer', error);
        return Buffer.from(trimmed, 'utf8');
    }
}

function deriveMarkdownKey(originalKey: string): string {
    if (originalKey.includes('.')) {
        const ext = path.extname(originalKey);
        if (ext) {
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
    const { items, nextCursor } = await db.listFileRecords({
        providerKey: bucket.providerKey,
        bucketKey: bucket.key,
        projectId,
        search: request.search,
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

        const upload = await runtime.uploadFile({
            key: providerMarkdownKey,
            name: `${normalizeFileName(request.fileName)}.md`,
            contentType: 'text/markdown',
            data: markdownBuffer,
            metadata: {
                sourceKey: record.key,
                converter: '@cognipeer/to-markdown',
            },
        });

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
        console.error('Markdown conversion failed', error);
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
    const fileName = normalizeFileName(request.fileName);
    const relativeKeyHint = request.keyHint?.trim().replace(/^\/+/, '');
    const chosenRelativeKey = relativeKeyHint && relativeKeyHint.length > 0
        ? relativeKeyHint
        : generateRelativeKey(fileName);

    const providerObjectKey = composeProviderObjectKey(
        bucket,
        chosenRelativeKey,
    );

    const upload = await runtime.uploadFile({
        key: providerObjectKey,
        name: fileName,
        contentType: request.contentType,
        data: fileBuffer,
        metadata: request.metadata,
    });

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

    const result = await runtime.downloadFile(providerObjectKey);
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

    await runtime.deleteFile(
        composeProviderObjectKey(bucket, record.key),
    );

    if (record.markdownKey) {
        try {
            await runtime.deleteFile(
                composeProviderObjectKey(bucket, record.markdownKey),
            );
        } catch (error) {
            console.warn('Failed to delete markdown file', record.markdownKey, error);
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
