/**
 * What the Document Store's screens read about buckets and providers, beyond the bare records.
 *
 * - a bucket in the list: how many files it holds and how many bytes they take, and how its provider is doing;
 * - a bucket's page: the same, plus the agents that keep session files in it and where its files physically are;
 * - the provider list: each provider's health and the base of its storage location.
 *
 * Everything here is read from the database; the storage provider is never called. Health is what the last
 * "Test connection" said, so a list of fifty buckets costs one grouped query for the numbers, not fifty calls.
 */

import { getDatabase, type DatabaseProvider } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { providerRegistry } from '@/lib/providers';
import { findAgentsUsingBucket } from '@/lib/services/agents/sessionFilesBucket';
import {
    getProviderConfigByKey,
    listProviderConfigs,
} from '@/lib/services/providers/providerService';
import { bucketDeleteError, isBucketDeleting } from './bucketRules';
import {
    attachDriverCapabilities,
    listFileProviders,
    requireBucketRecord,
    resolveBucketPrefix,
    serializeFileBucket,
} from './fileService';
import type {
    BucketDetail,
    BucketListItem,
    BucketStats,
    BucketUser,
    FileProviderView,
    ProviderHealth,
} from './types';

const logger = createLogger('files:reads');

type ProviderFilters = NonNullable<Parameters<typeof listFileProviders>[3]>;

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db;
}

const NO_FILES: BucketStats = { fileCount: 0, totalBytes: 0 };

/** The pair a bucket's files carry: file records name their bucket by provider key and bucket key. */
const statsKey = (providerKey: string, bucketKey: string) => `${providerKey}\u0000${bucketKey}`;

function isoOrUndefined(value: Date | string | null | undefined): string | undefined {
    if (!value) return undefined;
    const at = value instanceof Date ? value : new Date(value);
    return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/**
 * How a provider is doing, from what is stored about it. `provider` is absent when the bucket's provider no
 * longer exists or was never given to this project: it cannot take a file either way.
 */
export function describeProviderHealth(
    provider: Pick<FileProviderView, 'status' | 'lastTest' | 'driverCapabilities'> | undefined,
): ProviderHealth {
    if (!provider) {
        return { state: 'inactive', message: 'The storage provider no longer exists or is not available to this project.' };
    }
    if (provider.status !== 'active') {
        return {
            state: 'inactive',
            message: provider.status === 'errored' ? 'The storage provider is in an error state.' : 'The storage provider is switched off.',
        };
    }
    // Storage that needs no connection test: the server's own disk.
    if (provider.driverCapabilities?.builtin === true) {
        return { state: 'builtin' };
    }

    const test = provider.lastTest;
    const testedAt = isoOrUndefined(test?.at);
    // `ok: null` = the driver has no test: nothing was learned.
    if (!test || test.ok === null || test.ok === undefined) {
        return { state: 'untested', ...(testedAt ? { testedAt } : {}) };
    }
    return {
        state: test.ok ? 'ok' : 'failed',
        ...(testedAt ? { testedAt } : {}),
        ...(test.message ? { message: test.message.slice(0, 500) } : {}),
    };
}

/** Where a provider keeps its files: the path a bucket prefix is added to, and what the driver shows after it. */
interface ProviderLocation {
    /** Up to and including `<providerKey>/`; always ends with a slash. */
    base: string;
    /** " · <host>" when the driver names the server after the path (a custom S3 endpoint), else empty. */
    decoration: string;
}

/** A path, then " · " and a host: the S3 drivers' way of telling two servers with the same bucket name apart. */
const DECORATED_LOCATION = /^(.*\/) \u00b7 ([^/\s]+)$/;

function locationOf(
    provider: Pick<FileProviderView, 'driver' | 'key' | 'settings'>,
    tenantId: string,
): ProviderLocation | null {
    try {
        const contract = providerRegistry.getContract(provider.driver);
        const location = contract.describeStorageLocation?.({
            settings: provider.settings ?? {},
            tenantId,
            providerKey: provider.key,
        });
        if (!location) return null;
        const decorated = DECORATED_LOCATION.exec(location);
        if (decorated) return { base: decorated[1]!, decoration: ` \u00b7 ${decorated[2]}` };
        return { base: location.endsWith('/') ? location : `${location}/`, decoration: '' };
    } catch (error) {
        logger.warn('Could not describe the storage location of a file provider', {
            driver: provider.driver,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

/**
 * Where a provider keeps its files, up to and including `<providerKey>/` (what the driver's contract says),
 * with a trailing slash, so a form can show `${base}${bucketPrefix}/`; `null` when it is not shown (the server's
 * own disk) or the driver does not say.
 */
export function storageLocationBaseOf(
    provider: Pick<FileProviderView, 'driver' | 'key' | 'settings'>,
    tenantId: string,
): string | null {
    return locationOf(provider, tenantId)?.base ?? null;
}

/** A bucket's physical location: the provider's base plus the bucket's own prefix. */
export function describeBucketLocation(
    base: string | null,
    bucket: { key: string; prefix?: string | null },
): string | null {
    if (!base) return null;
    const prefix = resolveBucketPrefix({ key: bucket.key, prefix: bucket.prefix ?? undefined });
    return prefix ? `${base}${prefix}/` : base;
}

/** The providers of a project as the Document Store lists them: with their health and storage location base. */
export async function listFileProviderItems(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    filters?: ProviderFilters,
): Promise<FileProviderView[]> {
    const providers = await listFileProviders(tenantDbName, tenantId, projectId, filters);
    return providers.map((provider) => ({
        ...provider,
        providerHealth: describeProviderHealth(provider),
        storageLocationBase: storageLocationBaseOf(provider, tenantId),
    }));
}

/** The project's buckets with their numbers and their provider's health: one grouped read for all the numbers. */
export async function listFileBucketItems(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
): Promise<BucketListItem[]> {
    const db = await withTenantDb(tenantDbName);
    const buckets = await db.listFileBuckets(tenantId, projectId);
    const [providers, statRows] = await Promise.all([
        listProviderConfigs(tenantDbName, tenantId, { type: 'file', projectId }),
        db.listFileBucketStats({
            projectId,
            buckets: buckets.map((bucket) => ({ providerKey: bucket.providerKey, bucketKey: bucket.key })),
        }),
    ]);

    const providerByKey = new Map<string, FileProviderView>(
        providers.map((provider) => [provider.key, attachDriverCapabilities(provider)]),
    );
    const statsByBucket = new Map<string, BucketStats>(
        statRows.map((row) => [statsKey(row.providerKey, row.bucketKey), { fileCount: row.fileCount, totalBytes: row.totalBytes }]),
    );

    return buckets.map((bucket) => bucketListItem(bucket, providerByKey.get(bucket.providerKey), statsByBucket.get(statsKey(bucket.providerKey, bucket.key))));
}

function bucketListItem(
    bucket: Parameters<typeof serializeFileBucket>[0],
    provider: FileProviderView | undefined,
    stats: BucketStats | undefined,
): BucketListItem {
    const view = serializeFileBucket(bucket);
    return {
        ...view,
        ...(provider ? { provider } : {}),
        stats: stats ?? { ...NO_FILES },
        providerHealth: describeProviderHealth(provider),
        // Kept by the "delete the bucket with its files" job: set while it runs, and why it stopped when it failed.
        ...(isBucketDeleting(bucket) ? { deleting: true } : {}),
        ...(bucketDeleteError(bucket) ? { deleteError: bucketDeleteError(bucket) } : {}),
    };
}

/** The agents of the project whose Files settings name this bucket, with the id their page is addressed by. */
async function listBucketUsers(
    db: DatabaseProvider,
    tenantDbName: string,
    projectId: string,
    bucketKey: string,
): Promise<BucketUser[]> {
    const uses = await findAgentsUsingBucket(tenantDbName, projectId, bucketKey);
    const users = await Promise.all(uses.map(async (use): Promise<BucketUser | null> => {
        const agent = await db.findAgentByKey(use.key, projectId);
        return agent ? { agentId: String(agent._id), agentKey: use.key, name: use.name } : null;
    }));
    return users.filter((user): user is BucketUser => user !== null);
}

/** Where one bucket's files are, in words: the provider's path, the bucket's prefix, and the server a driver names after them. */
function bucketStorageLocation(
    provider: FileProviderView | undefined,
    tenantId: string,
    bucket: { key: string; prefix?: string | null },
): string | null {
    const location = provider ? locationOf(provider, tenantId) : null;
    const path = describeBucketLocation(location?.base ?? null, bucket);
    return path === null ? null : `${path}${location?.decoration ?? ''}`;
}

/** One bucket for its page: the list's row, who uses it, and where its files are. */
export async function getFileBucketDetail(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
): Promise<BucketDetail> {
    const record = await requireBucketRecord(tenantDbName, tenantId, projectId, bucketKey);
    const db = await withTenantDb(tenantDbName);
    const [provider, statRows, usedBy] = await Promise.all([
        getProviderConfigByKey(tenantDbName, tenantId, record.providerKey, projectId),
        db.listFileBucketStats({ projectId, buckets: [{ providerKey: record.providerKey, bucketKey: record.key }] }),
        listBucketUsers(db, tenantDbName, projectId, record.key),
    ]);

    const providerView = provider ? attachDriverCapabilities(provider) : undefined;
    const row = statRows[0];
    return {
        ...bucketListItem(record, providerView, row ? { fileCount: row.fileCount, totalBytes: row.totalBytes } : undefined),
        usedBy,
        usedByCount: usedBy.length,
        storageLocation: bucketStorageLocation(providerView, tenantId, record),
    };
}
