/**
 * Who is signed in, as the server-rendered pages need to know it.
 *
 * The middleware writes the session's claims into request headers, including the
 * role the account had when the session was issued. A role can be changed
 * afterwards, so a layout that gates a page on the role must not trust that
 * header: `getCurrentIdentity()` answers with the role the database holds now (the
 * same cached read the API uses, 30 s at most, dropped when the row changes) and is
 * memoised for the duration of one render.
 *
 * Server components and layouts only: it reads the request's headers.
 */

import { cache } from 'react';
import { headers } from 'next/headers';
import { runWithTenantScope } from '@/lib/database';
import { loadGroupGrants } from '@/lib/iam/groupGrants';
import type { TenantRole } from '@/lib/iam/identity';
import {
  getEffectiveServicePermissionWithGroups,
  SERVICE_PERMISSION_LEVELS,
  type ServicePermissionLevel,
} from '@/lib/security/rbac';
import { getUserIdentity, type UserAuthState } from '@/lib/services/users/userAuthState';

export interface CurrentIdentity {
  tenantDbName: string;
  tenantId: string;
  userId: string;
  email: string;
  /** `active`, or why the account no longer is (`disabled`, `missing`). */
  state: UserAuthState;
  /** The role the account has now; null when it is missing or its role is not a known one. */
  role: TenantRole | null;
}

/** The signed-in account of this request, or null when the request carries no session. */
export const getCurrentIdentity = cache(async (): Promise<CurrentIdentity | null> => {
  const requestHeaders = await headers();
  const tenantDbName = requestHeaders.get('x-tenant-db-name');
  const tenantId = requestHeaders.get('x-tenant-id');
  const userId = requestHeaders.get('x-user-id');
  if (!tenantDbName || !tenantId || !userId) return null;

  const identity = await getUserIdentity(tenantDbName, tenantId, userId);
  return {
    tenantDbName,
    tenantId,
    userId,
    email: requestHeaders.get('x-user-email') ?? '',
    ...identity,
  };
});

const LEVEL_ORDER: readonly ServicePermissionLevel[] = SERVICE_PERMISSION_LEVELS;

/**
 * Whether this person may open the Authorization center: owners and admins, and
 * anyone whose effective `iam` permission reaches `read` (their role, their own
 * overrides, their groups' grants). A coarse check for the page shell - the API
 * gate decides every request on its own.
 */
export async function canOpenIamCenter(identity: CurrentIdentity | null): Promise<boolean> {
  if (!identity || identity.state !== 'active' || !identity.role) return false;
  if (identity.role === 'owner' || identity.role === 'admin') return true;

  const { user, groupGrants } = await runWithTenantScope(identity.tenantDbName, async (db) => ({
    user: await db.findUserById(identity.userId),
    groupGrants: await loadGroupGrants(db, identity.userId, identity.tenantId),
  }));
  if (!user) return false;
  const level = getEffectiveServicePermissionWithGroups(
    { role: identity.role, servicePermissions: user.servicePermissions },
    groupGrants,
    'iam',
  );
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf('read');
}
