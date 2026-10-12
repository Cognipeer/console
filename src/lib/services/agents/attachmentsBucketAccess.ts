/**
 * Who may name the bucket an agent keeps its session files in.
 *
 * The files an agent takes land in a Document Store bucket, so choosing or changing
 * `config.attachments.bucketKey` is a Files decision about THAT bucket, not only an edit of the
 * agent. Every writer of an agent config asks it - create, update, and the manifest import in
 * both its forms - through the one function below, so a new way to write a config cannot forget it:
 * `AgentConfigWriteScope.canNameBucket` (the routes) and `applyAgentManifest`'s required
 * `canNameBucket` option both carry the question, and this module is the only place that knows
 * when it has to be asked.
 */

import type { IAgentConfig } from '@/lib/database';

/** The policy engine's answer to "may the caller name this bucket (by key) in an agent's settings?". */
export type CanNameBucket = (bucketKey: string) => Promise<{ allowed: boolean; decisionId?: string }>;

/** A config write that names a bucket its caller may not name. */
export interface BucketNamingRefusal {
    /** The bucket the write named. */
    bucketKey: string;
    /** The engine's decision, quoted in the 403. */
    decisionId?: string;
}

/**
 * The refusal for a config that picks or changes the bucket session files go to without the right to name it,
 * else null. Re-saving the bucket already stored (any other edit of the agent) asks nothing of Files. An
 * engine that cannot decide throws its 503 (never an allow).
 */
export async function bucketNamingRefusal(
    next: Pick<IAgentConfig, 'attachments'> | undefined,
    previous: Pick<IAgentConfig, 'attachments'> | undefined,
    canNameBucket: CanNameBucket,
): Promise<BucketNamingRefusal | null> {
    const wanted = typeof next?.attachments?.bucketKey === 'string' ? next.attachments.bucketKey.trim() : '';
    if (!wanted) return null;
    const current = typeof previous?.attachments?.bucketKey === 'string' ? previous.attachments.bucketKey.trim() : '';
    if (wanted === current) return null;
    const verdict = await canNameBucket(wanted);
    if (verdict.allowed) return null;
    return { bucketKey: wanted, ...(verdict.decisionId ? { decisionId: verdict.decisionId } : {}) };
}

/** Thrown by a writer that is not a route (the manifest import) when its config names a bucket the caller may not name. */
export class BucketNamingForbiddenError extends Error {
    readonly bucketKey: string;
    readonly decisionId?: string;

    constructor(refusal: BucketNamingRefusal) {
        super('Choosing where an agent keeps its files needs write access to that bucket in Files.');
        this.name = 'BucketNamingForbiddenError';
        this.bucketKey = refusal.bucketKey;
        if (refusal.decisionId) this.decisionId = refusal.decisionId;
    }
}

/** `bucketNamingRefusal`, thrown as `BucketNamingForbiddenError`. */
export async function assertMayNameBucket(
    next: Pick<IAgentConfig, 'attachments'> | undefined,
    previous: Pick<IAgentConfig, 'attachments'> | undefined,
    canNameBucket: CanNameBucket,
): Promise<void> {
    const refusal = await bucketNamingRefusal(next, previous, canNameBucket);
    if (refusal) throw new BucketNamingForbiddenError(refusal);
}
