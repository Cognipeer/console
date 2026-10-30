'use client';

/**
 * What the signed-in person may do on a knowledge base, for the controls only:
 * admin views (permissions, the Access tab) are drawn for Knowledge Engine admins,
 * write controls for writers. A hint, never the enforcement: every route is
 * decided by the server, which refuses a call from a client that ignored it.
 */

import { useMemo } from 'react';
import { useEffectivePermissions, type EffectivePermissions } from '@/components/layout/useEffectivePermissions';
import type { ServicePermissionLevel } from '@/lib/security/rbac';

export interface RagAccessLevel {
  /** The engine's level for the Knowledge Engine in the active project; null = not known (loading, or no answer). */
  level: ServicePermissionLevel | null;
  /** Draw the write controls: true for `write` and `admin`, and while the level is not known (the server decides). */
  canWrite: boolean;
  /** Draw the admin views: only when the level is known to be `admin`. */
  canAdmin: boolean;
}

/** The mapping of `useRagAccessLevel` as a pure function. */
export function ragAccessLevelFromPermissions(permissions: EffectivePermissions | null | undefined): RagAccessLevel {
  const level = permissions?.rag ?? null;
  if (level === null) return { level: null, canWrite: true, canAdmin: false };
  return { level, canWrite: level === 'write' || level === 'admin', canAdmin: level === 'admin' };
}

/** Folders and placement change only for admins while access control is on; writers change them while it is off. */
export function canChangeRagStructure(access: RagAccessLevel, accessEnabled: boolean): boolean {
  return access.canWrite && (!accessEnabled || access.canAdmin);
}

export function useRagAccessLevel(): RagAccessLevel {
  const permissions = useEffectivePermissions();
  return useMemo(() => ragAccessLevelFromPermissions(permissions), [permissions]);
}
