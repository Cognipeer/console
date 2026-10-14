/**
 * The rule a portal's embed passes to `resolveDelegatedPrincipal` as its `accountGuard`: a host application's signed
 * statement never signs in as a workspace owner, nor as an administrator.
 *
 * "Administrator" is judged on the account's EFFECTIVE power, as the API's acting-for-a-user gate judges it
 * (`privilegeOf`): its own role, and the workspace role of every group it belongs to. A service permission does not count.
 * The resolver asks the guard with every account that already existed BEFORE anything is written for it (a link to the
 * statement's subject, its profile, its groups), so a refused call leaves the account exactly as it was. An account the call
 * creates has no roles, so the guard is not asked about it; the caller asks it once more with the account that comes back
 * (`refusePrivilegedPortalAccount`), which costs no read because the roles are cached by then.
 *
 * Unlike an API token's delegation, a portal has no "allow administrators" switch: the people of a host application use the
 * portal as people of the host application, and the console's owners and admins try it with a test session.
 */

import type { IUser } from '@/lib/database';
import { DelegatedAccountRefusal } from './delegatedIdentity';
import { privilegeOf } from './delegationGate';

export interface PortalIdentityScope {
  tenantDbName: string;
  tenantId: string;
}

/** Throws {@link DelegatedAccountRefusal} when the account is a workspace owner or administrator (by role or by a group). */
export async function refusePrivilegedPortalAccount(scope: PortalIdentityScope, account: IUser): Promise<void> {
  const level = await privilegeOf(account, scope.tenantDbName, scope.tenantId);
  if (level === 'owner') throw new DelegatedAccountRefusal('A portal embed cannot sign in as the workspace owner');
  if (level === 'admin') throw new DelegatedAccountRefusal('A portal embed cannot sign in as an administrator');
}

/** The `accountGuard` of `resolveDelegatedPrincipal` for a portal's embed. */
export function portalAccountGuard(scope: PortalIdentityScope): { key: string; check: (user: IUser) => Promise<void> } {
  return { key: 'portal-embed', check: (user) => refusePrivilegedPortalAccount(scope, user) };
}
