'use client';

import { useUserDirectoryQuery, type UserDirectory } from '@/lib/api/queries/alerts';

/**
 * Who the ids on an incident are. Incidents and events store raw user ids; this resolves them for
 * display: the signed-in user (`GET /auth/me`, any role) and, when the viewer may list people
 * (`GET /users`, administrators), everyone else. A viewer who cannot list users sees a short id for
 * other people. One lookup is shared by every consumer.
 */

export type { UserDirectory };

const EMPTY: UserDirectory = { meId: null, meName: null, names: {} };

export function useUserDirectory(): UserDirectory {
  return useUserDirectoryQuery().data ?? EMPTY;
}

export interface UserLabels {
  you: string;
  system: string;
}

/**
 * `You`, `System`, a name, or a short id. `serverName` is the name the server resolved for the id (incident
 * `acknowledgedByName` and friends): it works for viewers who cannot list users, so it wins over the directory.
 */
export function userLabel(
  id: string | null | undefined,
  directory: UserDirectory,
  labels: UserLabels,
  serverName?: string | null,
): string {
  if (!id) return '—';
  if (id === 'system') return labels.system;
  if (directory.meId && id === directory.meId) return labels.you;
  if (serverName) return serverName;
  return directory.names[id] ?? (id.length > 10 ? `${id.slice(0, 8)}…` : id);
}
