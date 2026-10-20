'use client';

/**
 * What the signed-in person may do in the Document Store, for the controls only: write buttons are not drawn for
 * someone who can only read. A hint, never the enforcement - every route is decided by the server, which also
 * refuses a write from a client that ignored the hint.
 */

import { useMemo } from 'react';
import { useEffectivePermissions, type EffectivePermissions } from '@/components/layout/useEffectivePermissions';
import type { ServicePermissionLevel } from '@/lib/security/rbac';

export interface FilesAccess {
  /** The engine's level for Files in the active project; null = not known (still loading, or no answer). */
  level: ServicePermissionLevel | null;
  /**
   * Draw the write controls (upload, delete, edit, enable/disable, create). true for `write` and `admin`, and
   * also while the level is not known: then the server decides and answers 403 if it must.
   */
  canWrite: boolean;
}

/** The mapping of `useFilesAccess` as a pure function. */
export function filesAccessFromPermissions(permissions: EffectivePermissions | null | undefined): FilesAccess {
  const level = permissions?.files ?? null;
  if (level === null) return { level: null, canWrite: true };
  return { level, canWrite: level === 'write' || level === 'admin' };
}

export function useFilesAccess(): FilesAccess {
  const permissions = useEffectivePermissions();
  return useMemo(() => filesAccessFromPermissions(permissions), [permissions]);
}
