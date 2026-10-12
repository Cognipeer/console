/**
 * What the signed-in user may do with agents, asked from inside the agents
 * routes that serve more than one kind of reader (the Feedback tab shows counts
 * to everyone who can read agents, but the words people wrote only to those who
 * can change them).
 */

import {
  SERVICE_PERMISSION_LEVELS,
  resolveCurrentServicePermission,
  type ServicePermissionLevel,
} from '@/lib/security/rbac';
import { resolveSessionRbacContext, type ApiSessionContext } from '../fastify-utils';

/** Does the signed-in user have at least `required` on Agents (role defaults, own grants, group grants)? */
export async function sessionHasAgentsPermission(session: ApiSessionContext, required: 'read' | 'write'): Promise<boolean> {
  const { user, groupGrants } = await resolveSessionRbacContext(session);
  const level: ServicePermissionLevel = resolveCurrentServicePermission(user, 'agents', groupGrants);
  return SERVICE_PERMISSION_LEVELS.indexOf(level) >= SERVICE_PERMISSION_LEVELS.indexOf(required);
}
