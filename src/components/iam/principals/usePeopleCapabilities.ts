'use client';

/**
 * What the signed-in person may do in the people-and-access screens. The server
 * decides every write again; this only hides controls that cannot work and says
 * why a disabled one is disabled.
 *
 * The first paint uses the shell's role (owner and admin may manage people), so
 * the toolbar does not flicker; `GET /api/iam/capabilities` then gives the
 * engine's own answer (a custom policy can forbid what the role allows).
 */

import { useEffect, useState } from 'react';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import { isAbortError } from './client';
import { DirectoryApiError, directoryApi, NO_CAPABILITIES, type DirectoryCapabilities } from './directoryApi';

export const ALL_ASSIGNABLE_ROLES = ['admin', 'project_admin', 'user'] as const;

export interface PeopleCapabilities extends DirectoryCapabilities {
  /** True once the server has answered (before that, the role-based guess is shown). */
  ready: boolean;
  /** The server refused the capabilities request (the viewer cannot read the IAM center at all). */
  forbidden: boolean;
}

export function guessCapabilities(role: string | undefined): DirectoryCapabilities {
  const privileged = role === 'owner' || role === 'admin';
  return {
    ...NO_CAPABILITIES,
    peopleManage: privileged,
    grantAdmin: privileged,
    assignableRoles: privileged ? [...ALL_ASSIGNABLE_ROLES] : [],
    tokensManageOthers: privileged,
  };
}

export function usePeopleCapabilities(): PeopleCapabilities {
  const shellUser = useDashboardUser();
  const role = shellUser?.role;
  const [state, setState] = useState<PeopleCapabilities>(() => ({
    ...guessCapabilities(role),
    ready: false,
    forbidden: false,
  }));

  useEffect(() => {
    const controller = new AbortController();
    directoryApi
      .capabilities(controller.signal)
      .then((capabilities) => {
        if (!controller.signal.aborted) setState({ ...capabilities, ready: true, forbidden: false });
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        // No answer: keep the guess for the controls; the server still decides every write.
        setState((s) => ({
          ...s,
          ready: true,
          forbidden: error instanceof DirectoryApiError && error.status === 403 && error.code !== 'authorization_unavailable',
        }));
      });
    return () => controller.abort();
  }, []);

  return state;
}
