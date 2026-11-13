'use client';

/**
 * The active project as React Query keys see it.
 *
 * The browser cannot read the active project (its cookie is httpOnly), so every project-scoped query key carries a
 * marker that changes whenever the app announces a project switch (`ACTIVE_PROJECT_CHANGED_EVENT`): queries of the
 * project that was left are never shown for the new one. Keys are `[resource, marker, ...]`, which makes
 * `[resource, marker]` a prefix every invalidation can use.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ACTIVE_PROJECT_CHANGED_EVENT } from '@/components/layout/useEffectivePermissions';

let projectGeneration = 0;
const projectListeners = new Set<() => void>();

function announceProjectChange(): void {
  projectGeneration += 1;
  projectListeners.forEach((listener) => listener());
}

// Registered when the module loads (browser only), so a switch made while no screen of a resource is mounted still
// retires what an earlier visit cached.
if (typeof window !== 'undefined') {
  window.addEventListener(ACTIVE_PROJECT_CHANGED_EVENT, announceProjectChange);
}

function subscribeToProject(listener: () => void): () => void {
  projectListeners.add(listener);
  return () => {
    projectListeners.delete(listener);
  };
}

/** The marker of the project the app is in right now (changes when the app announces a project switch). */
export function getProjectScope(): string {
  return `project:${projectGeneration}`;
}

/** The marker as a hook: components re-render when the project changes. Prefer `useResourceKey` in query hooks. */
export function useProjectScope(): string {
  return useSyncExternalStore(subscribeToProject, getProjectScope, () => 'project:0');
}

/**
 * `[resource, marker]`, the start of every key of `resource`. Queries of an earlier project that nothing observes
 * any more are dropped, so a resource's cache does not grow with every project switch.
 */
export function useResourceKey<R extends string>(resource: R): readonly [R, string] {
  const queryClient = useQueryClient();
  const project = useProjectScope();

  useEffect(() => {
    queryClient.removeQueries({
      queryKey: [resource],
      type: 'inactive',
      predicate: (query) => query.queryKey[1] !== project,
    });
  }, [project, queryClient, resource]);

  return useMemo(() => [resource, project] as const, [resource, project]);
}
