/**
 * What an upload may be, and how much of the project's room is used: the numbers the upload dialog shows
 * before anything is sent.
 *
 * It resolves the quota the same way the upload routes do (`resolveEffectiveLimits` is the policy lookup under
 * `checkPerRequestLimits` and `checkResourceQuota`) but only reads: no rate-limit counter is touched, so
 * opening the dialog costs the caller nothing.
 */

import { getDatabase } from '@/lib/database';
import { getConfig } from '@/lib/core/config';
import { resolveEffectiveLimits, type QuotaContext } from '@/lib/quota/quotaGuard';
import { requireBucketRecord } from './fileService';
import { fileBytesFitting, uploadBodyLimit, uploadMaxBytes } from './uploadLimits';
import type { FileLimits } from './types';

/** A quota value of `-1` (or none) is "unlimited". */
function limitOrNull(value: number | undefined): number | null {
    return value === undefined || value === -1 ? null : value;
}

export interface FileLimitsInput {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    userId?: string;
    /** Resolve the quota for uploads to this bucket (a policy can be scoped to a provider or a bucket). */
    bucketKey?: string;
}

export async function getFileLimits(input: FileLimitsInput): Promise<FileLimits> {
    const bucket = input.bucketKey
        ? await requireBucketRecord(input.tenantDbName, input.tenantId, input.projectId, input.bucketKey)
        : undefined;

    const context: QuotaContext = {
        domain: 'file',
        projectId: input.projectId,
        tenantDbName: input.tenantDbName,
        tenantId: input.tenantId,
        userId: input.userId,
        ...(bucket ? { providerKey: bucket.providerKey, resourceKey: bucket.key } : {}),
    };
    const effective = await resolveEffectiveLimits(context);

    const db = await getDatabase();
    await db.switchToTenant(input.tenantDbName);
    const [usedBytes, filesUsed] = await Promise.all([
        db.sumFileRecordBytes({ projectId: input.projectId }),
        db.countFileRecords({ projectId: input.projectId }),
    ]);

    const maxRequestBytes = uploadBodyLimit();
    const perFile = limitOrNull(effective.perRequest?.maxFileSize);
    const allowed = getConfig().limits.fileUploadAllowedMimeTypes;

    return {
        maxFileBytes: Math.min(uploadMaxBytes(), fileBytesFitting(maxRequestBytes), ...(perFile === null ? [] : [perFile])),
        maxRequestBytes,
        allowedMimeTypes: allowed.length > 0 ? [...allowed] : null,
        quota: {
            usedBytes,
            limitBytes: limitOrNull(effective.quotas?.maxStorageBytes),
            filesUsed,
            filesLimit: limitOrNull(effective.quotas?.maxFilesTotal),
        },
    };
}
