/**
 * Who may touch Files, asked from inside the agents routes.
 *
 * Session files are ordinary Document Store files in a bucket the agent's owner
 * picks, so picking one is a Files decision about THAT bucket. The agents routes
 * themselves only ask for `agents`; these helpers add the Files check for exactly
 * the two actions that reach into the Document Store, and the policy engine answers
 * both (so a rule about one bucket applies, and the token's scope and the project's
 * own limits are what they are everywhere):
 *
 *   `requestHasFilesRead`        may the caller look at Files at all? (the bucket picker)
 *   `requestBucketOptions`       the buckets the caller may look at (`file-bucket.get`), each with whether
 *                                they may NAME it (`file-bucket.update`) - the picker disables the others
 *   `requestCanNameBucket`       choosing or changing `attachments.bucketKey` needs `file-bucket.update`
 *                                on that bucket
 *
 * `sessionHasFilesPermission` / `tokenHasFilesPermission` are the service-level questions asked
 * without an engine (kept for callers that have no request).
 */

import {
  SERVICE_PERMISSION_LEVELS,
  resolveCurrentServicePermission,
  type ServicePermissionLevel,
} from '@/lib/security/rbac';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import type { FastifyRequest } from 'fastify';
import type { AttachmentBucketOption } from '@/lib/services/agents/sessionFilesBucket';
import { getDatabase } from '@/lib/database';
import {
  authorizeResourceForRequest,
  resolveSessionRbacContext,
  serviceLevelForRequest,
  type ApiSessionContext,
} from '../fastify-utils';

function atLeast(level: ServicePermissionLevel, required: ServicePermissionLevel): boolean {
  return SERVICE_PERMISSION_LEVELS.indexOf(level) >= SERVICE_PERMISSION_LEVELS.indexOf(required);
}

/** Does the signed-in user have at least `required` on Files (role defaults, own grants, group grants)? */
export async function sessionHasFilesPermission(session: ApiSessionContext, required: 'read' | 'write'): Promise<boolean> {
  const { user, groupGrants } = await resolveSessionRbacContext(session);
  return atLeast(resolveCurrentServicePermission(user, 'files', groupGrants), required);
}

/** Does the token's owner have at least `required` on Files, within what the token's scope allows? */
export function tokenHasFilesPermission(ctx: ApiTokenContext, required: 'read' | 'write'): boolean {
  if (!ctx.user) return false;
  return atLeast(
    resolveCurrentServicePermission(ctx.user, 'files', [], ctx.tokenRecord.servicePermissions),
    required,
  );
}

/** Why a caller may not pick a bucket, for the 403 the Configure → Files section shows. */
export const FILES_WRITE_REQUIRED_MESSAGE =
  'Choosing where an agent keeps its files needs write access to that bucket in Files. '
  + 'Ask someone with access to the bucket to pick it, or keep the bucket that is already set.';

/** Why a caller may not list the buckets to pick from. */
export const FILES_READ_REQUIRED_MESSAGE =
  'Listing the buckets to keep an agent\'s files in needs read access to Files. '
  + 'Ask an administrator for Files access, or ask someone who has it to choose the bucket.';

// ── by the policy engine (the agents routes) ─────────────────────────────

/** May the caller look at Files at all? Quietly asked of the engine (the workspace's `files` service, the token's scope as a cap). */
export async function requestHasFilesRead(request: FastifyRequest): Promise<boolean> {
  return (await serviceLevelForRequest(request, 'files')) !== 'none';
}

type BucketAction = 'file-bucket.get' | 'file-bucket.update';

/** The registry entity of a bucket: what a rule that names one bucket is about. */
function bucketResource(bucket: { id: string; key: string }, projectId: string) {
  return {
    kind: 'resource' as const,
    type: 'file-bucket',
    id: bucket.id,
    service: 'files',
    projectId,
    key: bucket.key,
  };
}

async function askAboutBucket(
  request: FastifyRequest,
  action: BucketAction,
  bucket: { id: string; key: string },
  projectId: string,
  quiet: boolean,
): Promise<{ allowed: boolean; decisionId?: string }> {
  const result = await authorizeResourceForRequest(request, {
    action,
    resource: bucketResource(bucket, projectId),
    subject: { resourceName: bucket.key },
    projectId,
    ...(quiet ? { quiet: true } : {}),
  });
  return { allowed: result.allowed, ...(result.decisionId ? { decisionId: result.decisionId } : {}) };
}

/**
 * The buckets the caller may look at, each marked with whether they may name it in an agent's settings. One
 * quiet decision per action per bucket (a refusal here shapes the list, it is not a refusal of the request).
 * An outage is the engine's 503, never an empty list.
 */
export async function requestBucketOptions(
  request: FastifyRequest,
  projectId: string,
  options: readonly AttachmentBucketOption[],
): Promise<AttachmentBucketOption[]> {
  const out: AttachmentBucketOption[] = [];
  for (const option of options) {
    if (!option.id) {
      out.push(option);
      continue;
    }
    const bucket = { id: option.id, key: option.key };
    if (!(await askAboutBucket(request, 'file-bucket.get', bucket, projectId, true)).allowed) continue;
    const canChoose = (await askAboutBucket(request, 'file-bucket.update', bucket, projectId, true)).allowed;
    out.push({ ...option, canChoose });
  }
  return out;
}

/**
 * May the caller name this bucket (by key) in an agent's settings? `file-bucket.update` on that bucket. A key
 * that names no bucket of the project is not this question's business (the save is refused as a bad bucket
 * elsewhere) and is allowed here. Throws the engine's 503 when it cannot decide.
 */
export async function requestCanNameBucket(
  request: FastifyRequest,
  scope: { tenantDbName: string; tenantId: string; projectId: string },
  bucketKey: string,
): Promise<{ allowed: boolean; decisionId?: string }> {
  const db = await getDatabase();
  await db.switchToTenant(scope.tenantDbName);
  const record = await db.findFileBucketByKey(scope.tenantId, bucketKey, scope.projectId);
  if (!record) return { allowed: true };
  return askAboutBucket(request, 'file-bucket.update', { id: String(record._id), key: record.key }, scope.projectId, false);
}

