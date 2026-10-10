/**
 * Who may touch Files, asked from inside the agents routes.
 *
 * Session files are ordinary Document Store files in a bucket the agent's owner
 * picks, so picking one is a Files decision: choosing or changing
 * `attachments.bucketKey` needs write access to Files (RBAC service `files`),
 * and so does reading the list of buckets to pick from. The agents routes
 * themselves only ask for `agents`; these helpers add the Files check for
 * exactly those two actions.
 *
 * Token callers are capped by the token's own scope, like every other route.
 */

import {
  SERVICE_PERMISSION_LEVELS,
  resolveCurrentServicePermission,
  type ServicePermissionLevel,
} from '@/lib/security/rbac';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { resolveSessionRbacContext, type ApiSessionContext } from '../fastify-utils';

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
  'Choosing where an agent keeps its files needs write access to Files. '
  + 'Ask someone with Files access to pick the bucket, or keep the bucket that is already set.';

/** Why a caller may not list the buckets to pick from. */
export const FILES_READ_REQUIRED_MESSAGE =
  'Listing the buckets to keep an agent\'s files in needs read access to Files. '
  + 'Ask an administrator for Files access, or ask someone who has it to choose the bucket.';
