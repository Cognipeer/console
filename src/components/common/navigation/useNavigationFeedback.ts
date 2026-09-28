'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  useTransition,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  getPendingNavigationKey,
  isNavigationPendingFor,
  resolveIntentPrefetchKind,
  shouldUpgradeNavigationPrefetch,
  type PrefetchIntentKind,
} from '@/lib/navigation/navigationProgress';
import {
  navigationProgress,
  startNavigationProgress,
} from '@/lib/navigation/navigationProgressRuntime';

type AppRouter = ReturnType<typeof useRouter>;
type NavigateOptions = Parameters<AppRouter['push']>[1];
type RouterPrefetchOptions = NonNullable<Parameters<AppRouter['prefetch']>[1]>;

// `PrefetchKind` is not part of Next's public exports; its runtime values are
// these strings. `auto` mirrors a default <Link> (prefetch up to the nearest
// loading.tsx); `full` prefetches the whole route and reuses it for 5 minutes.
const PREFETCH_OPTIONS: Record<PrefetchIntentKind, RouterPrefetchOptions> = {
  auto: { kind: 'auto' } as unknown as RouterPrefetchOptions,
  full: { kind: 'full' } as unknown as RouterPrefetchOptions,
};

/** Best-effort `router.prefetch` with an explicit prefetch kind. */
export function requestRouterPrefetch(
  router: Pick<AppRouter, 'prefetch'>,
  href: string,
  kind: PrefetchIntentKind,
): void {
  try {
    router.prefetch(href, PREFETCH_OPTIONS[kind]);
  } catch {
    // Prefetching is best-effort.
  }
}

export interface NavigationFeedback {
  /** `router.push` that also drives the shell navigation progress feedback. */
  push: (href: string, options?: NavigateOptions) => void;
  /** `router.replace` that also drives the shell navigation progress feedback. */
  replace: (href: string, options?: NavigateOptions) => void;
  prefetch: (href: string) => void;
  /** True while a navigation started by this hook is in flight. */
  isPending: boolean;
}

/**
 * Imperative navigation (launcher selection, command palette, row clicks,
 * post-save redirects) with the same instant feedback as link clicks. Falls
 * back to a plain router navigation when no progress UI is mounted. Moves to
 * another dashboard page request a full prefetch first so the route commits in
 * one step (see `shouldUpgradeNavigationPrefetch`).
 */
export function useNavigationFeedback(): NavigationFeedback {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const pendingIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (isPending) return;
    const id = pendingIdRef.current;
    if (id === null) return;
    pendingIdRef.current = null;
    // The navigation transition settled; finish progress even if the URL did
    // not change (e.g. a redirect back to the current page).
    navigationProgress.settle(id);
  }, [isPending]);

  const navigate = useCallback(
    (method: 'push' | 'replace', href: string, options?: NavigateOptions) => {
      pendingIdRef.current = startNavigationProgress(href);
      const run = () =>
        startTransition(() => {
          if (method === 'replace') router.replace(href, options);
          else router.push(href, options);
        });
      if (shouldUpgradeNavigationPrefetch(href, window.location.href)) {
        requestRouterPrefetch(router, href, 'full');
        // Next swaps a cached partial prefetch for the full one a microtask
        // later; navigating after that commits the route in one step.
        queueMicrotask(run);
        return;
      }
      run();
    },
    [router],
  );

  const push = useCallback(
    (href: string, options?: NavigateOptions) => navigate('push', href, options),
    [navigate],
  );
  const replace = useCallback(
    (href: string, options?: NavigateOptions) => navigate('replace', href, options),
    [navigate],
  );
  const prefetch = useCallback(
    (href: string) => requestRouterPrefetch(router, href, 'auto'),
    [router],
  );

  return useMemo(
    () => ({ push, replace, prefetch, isPending }),
    [push, replace, prefetch, isPending],
  );
}

const getPendingKeySnapshot = () => getPendingNavigationKey(navigationProgress.getState());
const getServerPendingKey = () => null;
const subscribeNoop = () => () => {};

/**
 * `pathname + search` of the in-flight navigation target, if any. Pass
 * `enabled: false` to skip the subscription (always returns `null`).
 */
export function usePendingNavigationKey(enabled = true): string | null {
  return useSyncExternalStore(
    enabled ? navigationProgress.subscribe : subscribeNoop,
    enabled ? getPendingKeySnapshot : getServerPendingKey,
    getServerPendingKey,
  );
}

/** True while a navigation to `href` is in flight (pending affordance). */
export function useIsNavigationPending(href: string | null | undefined): boolean {
  const pendingKey = usePendingNavigationKey();
  if (!pendingKey || !href || typeof window === 'undefined') return false;
  return isNavigationPendingFor(pendingKey, href, window.location.href);
}

export interface IntentPrefetchOptions {
  /**
   * `auto` (default) behaves like a default `<Link>` prefetch (up to the
   * nearest `loading.tsx`). `full` prefetches the complete route so the click
   * commits it in one step instead of revealing it from the loading fallback;
   * it only applies between dashboard pages whose server render reads no user
   * data (see `resolveIntentPrefetchKind`). Other targets fall back to `auto`.
   */
  kind?: PrefetchIntentKind;
  /** Hover must last this long before prefetching (avoids sweep storms). */
  hoverDelayMs?: number;
}

export interface IntentPrefetchHandlers {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onPointerDown: () => void;
}

/**
 * Intent-based prefetch for primary navigation and long lists (table rows,
 * card grids) where a viewport prefetch per item would be wasteful or only
 * cover the loading state: prefetches on hover (after a short delay), keyboard
 * focus and pointer down. The current URL, other origins and `/api/*` are
 * never prefetched.
 */
export function useIntentPrefetch(options: IntentPrefetchOptions = {}) {
  const { kind = 'auto', hoverDelayMs = 80 } = options;
  const router = useRouter();
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  useEffect(() => cancel, [cancel]);

  const prefetch = useCallback(
    (href: string | null | undefined) => {
      if (!href || typeof window === 'undefined') return;
      const resolved = resolveIntentPrefetchKind(href, window.location.href, kind);
      if (resolved) requestRouterPrefetch(router, href, resolved);
    },
    [router, kind],
  );

  const getIntentProps = useCallback(
    (href: string | null | undefined): IntentPrefetchHandlers => ({
      onMouseEnter: () => {
        cancel();
        if (!href) return;
        hoverTimerRef.current = setTimeout(() => {
          hoverTimerRef.current = null;
          prefetch(href);
        }, hoverDelayMs);
      },
      onMouseLeave: cancel,
      onFocus: () => prefetch(href),
      onPointerDown: () => {
        cancel();
        prefetch(href);
      },
    }),
    [cancel, prefetch, hoverDelayMs],
  );

  return { prefetch, getIntentProps, cancel };
}
