'use client';

/**
 * What the signed-in user may do in the IAM center: everyone who reaches the
 * page can read (the route needs `iam` read); changing anything needs `iam`
 * admin. The page decides once and hands `canManage` to every tab.
 *
 * The UI hides controls the user cannot use; it is a courtesy, never the
 * enforcement: every write is checked again by the server.
 */

import { useEffect, useState } from 'react';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import { getEffectiveServicePermission, type UserServicePermissions } from '@/lib/security/rbac';
import { iamApi, iamLookupApi } from './api';

export interface IamCapabilities {
  canManage: boolean;
  /** True until the first definitive answer (the role-based guess is shown meanwhile). */
  resolving: boolean;
  /**
   * Safe to render the tabs: either the answer is final, or the guess is already
   * "can manage" (owners and admins; at worst a rare override lowers it later).
   * A guess of "cannot" is NOT trusted yet: a group may still grant admin, and a
   * deep link into the policy editor must not be judged on a guess.
   */
  ready: boolean;
}

/** Level of the `iam` service from the role and the user's own overrides (groups are checked separately). */
export function iamLevelFromSession(role: string, servicePermissions: Record<string, string>): string {
  return getEffectiveServicePermission(
    { role, servicePermissions: servicePermissions as UserServicePermissions },
    'iam',
  );
}

export function useIamCapabilities(): IamCapabilities {
  const shellUser = useDashboardUser();
  const roleGuess = shellUser?.role === 'owner' || shellUser?.role === 'admin';
  const [state, setState] = useState<Omit<IamCapabilities, 'ready'>>({ canManage: roleGuess, resolving: true });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await iamLookupApi.getSession();
        if (iamLevelFromSession(session.role, session.servicePermissions) === 'admin') {
          if (!cancelled) setState({ canManage: true, resolving: false });
          return;
        }
        // A group can raise the level above the user's own: the principal view has the effective figure.
        let viaGroups = false;
        if (session.userId) {
          try {
            const detail = await iamApi.getPrincipal('user', session.userId);
            viaGroups = detail.effective.some((e) => e.service === 'iam' && e.level === 'admin');
          } catch {
            /* keep the session-based answer */
          }
        }
        if (!cancelled) setState({ canManage: viaGroups, resolving: false });
      } catch {
        // No session answer: keep the role-based guess; the server still decides on every write.
        if (!cancelled) setState({ canManage: roleGuess, resolving: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roleGuess]);

  return { ...state, ready: !state.resolving || state.canManage };
}
