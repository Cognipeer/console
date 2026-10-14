'use client';

/**
 * What the policy engine allows the signed-in person per service in the ACTIVE
 * project (`GET /api/auth/session` -> `effectivePermissions`): roles, group
 * grants, custom policies and project limits all included. The navigation uses
 * it so a service that is narrowed to "none" in this project disappears instead
 * of answering 403 on click.
 *
 * It is a hint for the menu, never the enforcement: the gates decide every
 * request on their own. While the answer is loading, or when the engine could
 * not give one, the menu falls back to the role-based view.
 */

import { useEffect, useState } from 'react';
import type { ServicePermissionLevel } from '@/lib/security/rbac';

export type EffectivePermissions = Record<string, ServicePermissionLevel>;

/** Dispatched after the active project changed without a page reload. */
export const ACTIVE_PROJECT_CHANGED_EVENT = 'cognipeer:active-project-changed';

export function notifyActiveProjectChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(ACTIVE_PROJECT_CHANGED_EVENT));
}

const LEVELS: readonly string[] = ['none', 'read', 'write', 'admin'];

/** The `effectivePermissions` of a session payload; `null` when absent or not a level map. */
export function parseEffectivePermissions(body: unknown): EffectivePermissions | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as { effectivePermissions?: unknown }).effectivePermissions;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: EffectivePermissions = {};
  for (const [service, level] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof level === 'string' && LEVELS.includes(level)) out[service] = level as ServicePermissionLevel;
  }
  return out;
}

export function useEffectivePermissions(): EffectivePermissions | null {
  const [levels, setLevels] = useState<EffectivePermissions | null>(null);

  useEffect(() => {
    let controller: AbortController | null = null;
    let lastLoaded = 0;

    const load = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin', signal: current.signal })
        .then(async (res) => {
          if (!res.ok) return null;
          return parseEffectivePermissions(await res.json());
        })
        .then((parsed) => {
          if (current.signal.aborted) return;
          lastLoaded = Date.now();
          // No answer (engine unavailable, signed out): keep what is known; the menu stays role-based until one arrives.
          if (parsed) setLevels(parsed);
        })
        .catch(() => {
          /* the menu keeps the role-based view */
        });
    };

    load();
    const onProjectChanged = () => load();
    // Coming back to the tab after a while: levels may have changed (a role, a group, a policy).
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoaded > 60_000) load();
    };
    window.addEventListener(ACTIVE_PROJECT_CHANGED_EVENT, onProjectChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller?.abort();
      window.removeEventListener(ACTIVE_PROJECT_CHANGED_EVENT, onProjectChanged);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return levels;
}
