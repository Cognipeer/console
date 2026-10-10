/**
 * Where an agent's session files live: the bucket it names, and whether that
 * bucket can take a file right now.
 *
 * There is no built-in fallback storage. A session file is an ordinary
 * Document Store file in the bucket of `attachments.bucketKey`, so before a file
 * is stored (and when the setting is saved, and in the Studio picker) the bucket
 * is looked at the way the file service will use it: it exists in the agent's
 * project, is active, and its provider exists, is assigned to the project and
 * is active. One function answers that for all of them (`inspectFileBucket`),
 * so the picker, the save-time check and the upload cannot disagree.
 */

import type {
    DatabaseProvider,
    IAgent,
    IFileBucketRecord,
    IProviderRecord,
} from '@/lib/database';
import { getDatabase } from '@/lib/database';
import { AgentAttachmentError } from './agentErrors';

/** Why a bucket cannot take a file. Stable codes: the picker and clients switch on them. */
export type BucketIssue =
    | 'bucket_missing'
    | 'bucket_disabled'
    | 'provider_missing'
    | 'provider_unassigned'
    | 'provider_inactive'
    | 'provider_invalid';

export type BucketInspection =
    | { usable: true; bucket: IFileBucketRecord; provider: IProviderRecord }
    | {
        usable: false;
        issue: BucketIssue;
        /** What is wrong, naming the bucket — without any "what to do". */
        message: string;
        bucket?: IFileBucketRecord;
        provider?: IProviderRecord;
    };

export const LOCAL_DISK_DRIVER = 'local-filesystem';

/** What is wrong with a bucket, as one sentence that names it. */
export function describeBucketIssue(issue: BucketIssue, bucketKey: string, providerKey?: string): string {
    const provider = providerKey ? `"${providerKey}"` : 'its provider';
    switch (issue) {
        case 'bucket_missing':
            return `the bucket "${bucketKey}" does not exist in this project`;
        case 'bucket_disabled':
            return `the bucket "${bucketKey}" is disabled`;
        case 'provider_missing':
            return `the storage provider ${provider} of the bucket "${bucketKey}" no longer exists`;
        case 'provider_unassigned':
            return `the storage provider ${provider} of the bucket "${bucketKey}" is not assigned to this project`;
        case 'provider_inactive':
            return `the storage provider ${provider} of the bucket "${bucketKey}" is not active`;
        case 'provider_invalid':
            return `the provider ${provider} of the bucket "${bucketKey}" is not a file storage provider`;
    }
}

/**
 * The bucket as the file service will find it. `db` must already be bound to the
 * tenant. Does not call the provider: a reachable-looking bucket can still fail
 * on the wire, which the upload reports as it happens.
 */
export async function inspectFileBucket(
    db: DatabaseProvider,
    tenantId: string,
    projectId: string,
    bucketKey: string,
): Promise<BucketInspection> {
    const bucket = await db.findFileBucketByKey(tenantId, bucketKey, projectId);
    if (!bucket) {
        return { usable: false, issue: 'bucket_missing', message: describeBucketIssue('bucket_missing', bucketKey) };
    }
    if (bucket.status !== 'active') {
        return { usable: false, issue: 'bucket_disabled', message: describeBucketIssue('bucket_disabled', bucketKey), bucket };
    }
    const provider = await db.findProviderByKey(tenantId, bucket.providerKey, projectId);
    if (!provider) {
        // Providers are strictly project-scoped: "exists elsewhere" and "gone" call for different fixes.
        const elsewhere = await db.findProviderByKey(tenantId, bucket.providerKey);
        const issue: BucketIssue = elsewhere ? 'provider_unassigned' : 'provider_missing';
        return { usable: false, issue, message: describeBucketIssue(issue, bucketKey, bucket.providerKey), bucket };
    }
    if (provider.type !== 'file') {
        return { usable: false, issue: 'provider_invalid', message: describeBucketIssue('provider_invalid', bucketKey, bucket.providerKey), bucket, provider };
    }
    if (provider.status !== 'active') {
        return { usable: false, issue: 'provider_inactive', message: describeBucketIssue('provider_inactive', bucketKey, bucket.providerKey), bucket, provider };
    }
    return { usable: true, bucket, provider };
}

/** Same, for a caller that has a tenant database name rather than a bound provider. */
export async function inspectFileBucketForTenant(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bucketKey: string,
): Promise<BucketInspection> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return inspectFileBucket(db, tenantId, projectId, bucketKey);
}

/**
 * The unusable-bucket refusal for an upload or a delete: `409 storage_unavailable`,
 * telling the operator which bucket and what to do.
 */
export function storageUnavailableError(inspection: Extract<BucketInspection, { usable: false }>): AgentAttachmentError {
    return new AgentAttachmentError(
        409,
        'storage_unavailable',
        `This agent cannot store files right now: ${inspection.message}. Fix it in the Document Store or choose another bucket in the agent's Files settings.`,
    );
}

/** An agent switched files on without saying where they go (older data). */
export function storageNotConfiguredError(): AgentAttachmentError {
    return new AgentAttachmentError(
        409,
        'storage_not_configured',
        'This agent has files switched on but no bucket to keep them in. Choose a bucket in the agent\'s Files settings.',
    );
}

// ── Object layout ───────────────────────────────────────────────────────────

/** A path segment made of the characters a folder name may hold. */
function safeSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^\.+/, '').replace(/^-+|-+$/g, '') || 'x';
}

/**
 * Where a session file goes inside its bucket: `<folder>/<agentKey>/<sessionId>/<uniqueName>`.
 * The file service puts the bucket's own prefix in front.
 */
export function sessionFileObjectKey(input: {
    folder: string;
    agentKey: string;
    conversationId: string;
    uniqueName: string;
}): string {
    return [input.folder, safeSegment(input.agentKey), safeSegment(input.conversationId), input.uniqueName]
        .filter((part) => part.length > 0)
        .join('/');
}

// ── Who points at a bucket ──────────────────────────────────────────────────

export interface BucketAgentUse {
    key: string;
    name: string;
}

/** The agents of a project whose `attachments.bucketKey` names this bucket. */
export async function findAgentsUsingBucket(
    tenantDbName: string,
    projectId: string,
    bucketKey: string,
): Promise<BucketAgentUse[]> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const agents: IAgent[] = await db.listAgents({ projectId });
    // By name, then key: agents created in the same instant come back in no fixed order from the
    // database, and the 409 message names them in this order.
    return agents
        .filter((agent) => agent.config?.attachments?.bucketKey?.trim() === bucketKey)
        .map((agent) => ({ key: agent.key, name: agent.name }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** The 409 body for deleting or disabling a bucket that agents still keep session files in. */
export function bucketInUseBody(bucketKey: string, agents: BucketAgentUse[], action: 'delete' | 'disable') {
    const names = agents.map((agent) => agent.name || agent.key).join(', ');
    return {
        error: `The bucket "${bucketKey}" is where ${agents.length === 1 ? 'this agent keeps' : 'these agents keep'} session files: ${names}. `
            + `Choose another bucket in ${agents.length === 1 ? 'its' : 'their'} Files settings before you ${action} it.`,
        type: 'bucket_in_use',
        code: 'bucket_in_use',
        agents,
    };
}

// ── The picker ──────────────────────────────────────────────────────────────

/** `the bucket "x" is disabled` → `The bucket "x" is disabled.` */
function sentence(message: string): string {
    return `${message.charAt(0).toUpperCase()}${message.slice(1)}.`;
}

/** One bucket as the agent Files picker shows it. */
export interface AttachmentBucketOption {
    key: string;
    name: string;
    providerKey: string;
    providerLabel: string;
    driver: string;
    bucketStatus: IFileBucketRecord['status'];
    providerStatus: IProviderRecord['status'] | 'missing';
    /** Can take a file right now. */
    usable: boolean;
    /** Why not (a sentence naming the bucket), when `usable` is false. */
    reason?: string;
    /** Stable code behind `reason`, for clients that localise it. */
    reasonCode?: BucketIssue;
    /** The bucket keeps its files on the server's own disk (the `local-filesystem` driver). */
    localDisk: boolean;
}

/** The project's buckets, each with what the picker needs to enable or disable it. */
export async function listAttachmentBuckets(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
): Promise<AttachmentBucketOption[]> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const [buckets, assigned] = await Promise.all([
        db.listFileBuckets(tenantId, projectId),
        db.listProviders(tenantId, { type: 'file', projectId }),
    ]);
    const providers = new Map(assigned.map((provider) => [provider.key, provider]));

    const options: AttachmentBucketOption[] = [];
    for (const bucket of buckets) {
        const provider = providers.get(bucket.providerKey);
        let inspection: BucketInspection;
        if (bucket.status !== 'active') {
            inspection = { usable: false, issue: 'bucket_disabled', message: describeBucketIssue('bucket_disabled', bucket.key), bucket };
        } else if (!provider) {
            const elsewhere = await db.findProviderByKey(tenantId, bucket.providerKey);
            const issue: BucketIssue = elsewhere ? 'provider_unassigned' : 'provider_missing';
            inspection = { usable: false, issue, message: describeBucketIssue(issue, bucket.key, bucket.providerKey), bucket };
        } else if (provider.status !== 'active') {
            inspection = { usable: false, issue: 'provider_inactive', message: describeBucketIssue('provider_inactive', bucket.key, bucket.providerKey), bucket, provider };
        } else {
            inspection = { usable: true, bucket, provider };
        }
        options.push({
            key: bucket.key,
            name: bucket.name,
            providerKey: bucket.providerKey,
            providerLabel: provider?.label ?? bucket.providerKey,
            driver: provider?.driver ?? '',
            bucketStatus: bucket.status,
            providerStatus: provider?.status ?? 'missing',
            usable: inspection.usable,
            ...(inspection.usable ? {} : { reason: sentence(inspection.message), reasonCode: inspection.issue }),
            localDisk: provider?.driver === LOCAL_DISK_DRIVER,
        });
    }
    return options.sort((a, b) => a.name.localeCompare(b.name));
}
