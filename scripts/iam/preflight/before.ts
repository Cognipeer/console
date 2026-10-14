/**
 * "Before": the decision the previous release took, from stored data alone.
 *
 * The previous release gated a request with the workspace-level arithmetic of
 * rbac.ts and nothing else:
 *
 *  - a signed-in person: their role, their own service permissions and the
 *    tenant-level grants of their groups (highest wins);
 *  - an API token: only its owner's OWN workspace level (no group grants),
 *    capped by the token's scope;
 *  - never a project-level permission.
 *
 * That arithmetic is still `authorizeService` in rbac.ts, unchanged, so the
 * report calls the very same function instead of keeping a copy of it.
 */

import {
  authorizeService,
  type GroupTenantGrant,
  type PermissionService,
  type RbacUserLike,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import { CHECKS, type Checks } from './model';

export interface BeforeInput {
  user: RbacUserLike;
  /** Tenant-level grants of the groups whose grants apply: a person's groups, `[]` for a token (the previous release gave tokens none). */
  groupGrants: readonly GroupTenantGrant[];
  /** The token scope (a cap); undefined / null = a person, or an unscoped token. */
  tokenScope?: UserServicePermissions | null;
}

/** The three answers (read / write / admin) of the previous release for one service. */
export function previousAnswers(input: BeforeInput, service: PermissionService): Checks {
  const out: Checks = { read: false, write: false, admin: false };
  for (const check of CHECKS) {
    out[check.id] = authorizeService(
      input.user,
      check.method,
      service,
      [...input.groupGrants],
      input.tokenScope,
      check.level,
    ).allowed;
  }
  return out;
}
