/**
 * Browser-side singleton for navigation progress.
 *
 * Shared by `src/instrumentation-client.ts` (Next's `onRouterTransitionStart`
 * hook, which sees every App Router navigation — links, `router.push/replace`
 * from any page and back/forward) and the dashboard's `NavigationProgress`
 * component (document click listener + commit watcher). Keep this module tiny:
 * it is loaded before the app hydrates.
 */

import {
  createNavigationProgressController,
  toNavigationKey,
} from './navigationProgress';

export type RouterNavigationType = 'push' | 'replace' | 'traverse';

export const navigationProgress = createNavigationProgressController();

let routerTransitionHookInstalled = false;
let routerTransitionStartCount = 0;

/** Called once by `instrumentation-client.ts` when the router hook is wired. */
export function markRouterTransitionHookInstalled(): void {
  routerTransitionHookInstalled = true;
}

export function isRouterTransitionHookInstalled(): boolean {
  return routerTransitionHookInstalled;
}

/** Monotonic counter used to detect clicks that did not start a navigation. */
export function getRouterTransitionStartCount(): number {
  return routerTransitionStartCount;
}

/**
 * Starts progress for an in-app navigation to `href`. Returns the navigation
 * id, or `null` when nothing is tracked (no progress UI mounted, external or
 * same-URL target).
 */
export function startNavigationProgress(href: string): number | null {
  if (typeof window === 'undefined') return null;
  const key = toNavigationKey(href, window.location.href);
  if (!key) return null;
  return navigationProgress.start(key);
}

export function handleRouterTransitionStart(
  url: string,
  navigationType: RouterNavigationType,
): void {
  routerTransitionStartCount += 1;
  if (typeof window === 'undefined') return;
  const key = toNavigationKey(
    navigationType === 'traverse' ? window.location.href : url,
    window.location.href,
  );
  if (key) navigationProgress.start(key);
}
