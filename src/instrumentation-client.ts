/**
 * Next.js client instrumentation (runs before the app hydrates).
 *
 * `onRouterTransitionStart` fires for every App Router navigation — `next/link`
 * clicks, `router.push/replace` from any page (including enterprise overlay
 * pages) and back/forward — and feeds the dashboard navigation progress bar.
 */

import {
  handleRouterTransitionStart,
  markRouterTransitionHookInstalled,
  type RouterNavigationType,
} from '@/lib/navigation/navigationProgressRuntime';

markRouterTransitionHookInstalled();

export function onRouterTransitionStart(url: string, navigationType: RouterNavigationType) {
  handleRouterTransitionStart(url, navigationType);
}
