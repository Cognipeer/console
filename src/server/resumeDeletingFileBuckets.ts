/**
 * Buckets a restart left "being deleted".
 *
 * Deleting a bucket together with its files marks the bucket (`metadata.deleting`, switched off) and then queues the
 * job that does the work (`lib/services/files/jobs/bucketDeletion.ts`). The memory queue keeps its jobs in the
 * process, so a restart between the two, or while the job runs, loses the job and leaves the bucket marked for good:
 * nothing writes to it and nothing ends the deletion, and the screen only says "deleting".
 *
 * This sweep runs at boot, after the files consumer is registered, and queues the job again for every bucket that is
 * still marked. The job can be run again at any point (an object that is gone is no failure, a record that is gone is
 * skipped, a bucket that is gone ends the run), so a bucket whose job the queue did keep is not harmed by a second
 * one. The job key keeps the nodes of a cluster that boot together from queueing a bucket once each.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue } from '@/lib/core/queue';
import { getDatabase, runWithTenantScope } from '@/lib/database';
import { isBucketDeleting } from '@/lib/services/files/bucketRules';
import { DELETE_BUCKET_JOB, FILES_QUEUE, type DeleteBucketJobPayload } from '@/lib/services/files/jobs/filesQueue';

const logger = createLogger('files:resume-bucket-deletions');

/**
 * Buckets queued again by one boot sweep. A deployment with a great many buckets stuck at once would otherwise turn
 * every startup into a burst of jobs that talk to the storage providers; the buckets this leaves out stay marked, and
 * the next boot (or asking for the deletion again) picks them up.
 */
const BOOT_RESUME_MAX = 100;

/** Queues the deletion of every bucket still marked as being deleted. Returns how many were queued. */
export async function resumeDeletingFileBuckets(): Promise<number> {
  const mainDb = await getDatabase();
  const tenants = await mainDb.listTenants();
  const queue = await getQueue();
  let resumed = 0;

  for (const tenant of tenants) {
    if (resumed >= BOOT_RESUME_MAX) break;
    if (!tenant.dbName || !tenant._id) continue;
    const tenantDbName = tenant.dbName;
    const tenantId = String(tenant._id);

    try {
      const buckets = await runWithTenantScope(tenantDbName, (db) => db.listFileBuckets(tenantId));

      for (const bucket of buckets) {
        if (resumed >= BOOT_RESUME_MAX) break;
        // A bucket is marked only by a request inside a project, so one without a project is not one to resume.
        if (!isBucketDeleting(bucket) || !bucket.projectId) continue;

        const payload: DeleteBucketJobPayload = {
          tenantDbName,
          tenantId,
          projectId: bucket.projectId,
          bucketKey: bucket.key,
          // What the run writes as `updatedBy` if it has to stop: the person whose request marked the bucket.
          actor: bucket.updatedBy ?? bucket.createdBy,
        };
        await queue.publish(FILES_QUEUE, DELETE_BUCKET_JOB, payload, {
          // The same single attempt as a deletion asked for from a screen: a run that stops writes why onto the bucket.
          attempts: 1,
          dedupKey: `delete-bucket:${tenantDbName}:${bucket.projectId}:${bucket.key}`,
        });
        resumed += 1;
      }
    } catch (error) {
      logger.warn('Failed to resume bucket deletions for tenant', {
        tenant: tenant.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (resumed > 0) logger.info('Resumed bucket deletions', { resumed });
  return resumed;
}
