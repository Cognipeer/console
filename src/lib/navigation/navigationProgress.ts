/**
 * Framework-agnostic navigation progress logic.
 *
 * Powers the dashboard's thin top progress bar and the pending affordance on
 * navigation items. Everything in this module is pure (no DOM / React access)
 * so the click filtering and the progress state machine can be unit tested in
 * the node test environment. The browser wiring lives in
 * `navigationProgressRuntime.ts` and `components/common/navigation`.
 */

/** Attribute that opts an element (and its descendants) out of tracking. */
export const NAVIGATION_PROGRESS_OPT_OUT_ATTRIBUTE = 'data-nav-progress';
export const NAVIGATION_PROGRESS_OPT_OUT_VALUE = 'off';

/** The bar only appears when a navigation is still pending after this delay. */
export const NAVIGATION_PROGRESS_SHOW_DELAY_MS = 150;
/** Duration of the "complete" animation before the bar is removed. */
export const NAVIGATION_PROGRESS_COMPLETE_MS = 260;
/** A navigation that never commits is abandoned after this long. */
export const NAVIGATION_PROGRESS_SAFETY_TIMEOUT_MS = 10_000;

export type NavigationProgressPhase = 'idle' | 'pending' | 'visible' | 'completing';

export interface NavigationProgressState {
  readonly phase: NavigationProgressPhase;
  /** Incremented for every tracked navigation start. */
  readonly id: number;
  /** `pathname + search` of the navigation target while pending. */
  readonly targetKey: string | null;
  /** `pathname + search` of the last committed (rendered) URL. */
  readonly committedKey: string | null;
}

export const INITIAL_NAVIGATION_PROGRESS_STATE: NavigationProgressState = Object.freeze({
  phase: 'idle',
  id: 0,
  targetKey: null,
  committedKey: null,
});

export type NavigationProgressEvent =
  | { type: 'start'; targetKey: string }
  | { type: 'reveal' }
  | { type: 'commit'; key: string }
  | { type: 'settle'; id: number }
  | { type: 'cancel'; id: number }
  | { type: 'timeout'; id: number }
  | { type: 'finish'; id: number }
  | { type: 'reset'; committedKey?: string | null };

function endNavigation(state: NavigationProgressState): NavigationProgressState {
  if (state.phase === 'pending') {
    // Never became visible: drop it silently so fast navigations don't flash.
    return { ...state, phase: 'idle', targetKey: null };
  }
  if (state.phase === 'visible') {
    return { ...state, phase: 'completing' };
  }
  return state;
}

export function reduceNavigationProgress(
  state: NavigationProgressState,
  event: NavigationProgressEvent,
): NavigationProgressState {
  switch (event.type) {
    case 'start': {
      if (state.committedKey !== null && event.targetKey === state.committedKey) {
        // Same-URL navigation (or returning to the current page while another
        // navigation is pending): the URL won't change, so nothing will commit.
        return endNavigation(state);
      }
      const inFlight = state.phase === 'pending' || state.phase === 'visible';
      if (inFlight && state.targetKey === event.targetKey) {
        return state;
      }
      const id = state.id + 1;
      if (state.phase === 'visible' || state.phase === 'completing') {
        return { ...state, phase: 'visible', id, targetKey: event.targetKey };
      }
      return { ...state, phase: 'pending', id, targetKey: event.targetKey };
    }
    case 'reveal':
      return state.phase === 'pending' ? { ...state, phase: 'visible' } : state;
    case 'commit': {
      if (event.key === state.committedKey) return state;
      return endNavigation({ ...state, committedKey: event.key });
    }
    case 'settle':
    case 'cancel':
    case 'timeout':
      return state.id === event.id ? endNavigation(state) : state;
    case 'finish':
      return state.phase === 'completing' && state.id === event.id
        ? { ...state, phase: 'idle', targetKey: null }
        : state;
    case 'reset': {
      const committedKey =
        event.committedKey === undefined ? state.committedKey : event.committedKey;
      if (state.phase === 'idle' && state.committedKey === committedKey) return state;
      return { ...INITIAL_NAVIGATION_PROGRESS_STATE, id: state.id, committedKey };
    }
    default:
      return state;
  }
}

/** Target of the navigation that is currently in flight, if any. */
export function getPendingNavigationKey(state: NavigationProgressState): string | null {
  return state.phase === 'pending' || state.phase === 'visible' ? state.targetKey : null;
}

// ─── URL helpers ────────────────────────────────────────────────────────────

export interface LocationLike {
  readonly href: string;
}

function parseUrl(href: string, base: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

/**
 * Resolves `href` against `baseHref` and returns its `pathname + search`
 * when it points to an http(s) URL on the same origin; otherwise `null`.
 */
export function toNavigationKey(href: string, baseHref: string): string | null {
  const base = parseUrl(baseHref, 'http://localhost');
  if (!base) return null;
  const url = parseUrl(href, base.href);
  if (!url) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin !== base.origin) return null;
  return `${url.pathname}${url.search}`;
}

/** `pathname + search` of an absolute URL (e.g. `window.location.href`). */
export function getLocationKey(location: LocationLike): string | null {
  return toNavigationKey(location.href, location.href);
}

/** Pathname portion of a navigation key. */
export function getKeyPathname(key: string): string {
  const queryIndex = key.indexOf('?');
  return queryIndex === -1 ? key : key.slice(0, queryIndex);
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/** True when `href` is the target of the in-flight navigation. */
export function isNavigationPendingFor(
  pendingKey: string | null,
  href: string | null | undefined,
  baseHref: string,
): boolean {
  if (!pendingKey || !href) return false;
  return toNavigationKey(href, baseHref) === pendingKey;
}

// ─── Click filtering ────────────────────────────────────────────────────────

export interface NavigationClickInput {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly defaultPrevented: boolean;
}

export interface NavigationAnchorInput {
  /** Raw `href` attribute (may be relative). `null` when absent. */
  readonly href: string | null;
  /** Raw `target` attribute. */
  readonly target: string | null;
  readonly hasDownload: boolean;
  /** Element or an ancestor carries `data-nav-progress="off"`. */
  readonly optedOut: boolean;
}

/**
 * Decides whether an anchor click starts an in-app navigation that should show
 * progress. Returns the target `pathname + search`, or `null` for clicks the
 * browser/Next handles differently: modifier / non-primary clicks (new tab or
 * window), `target` other than `_self`, downloads, non-http(s) schemes,
 * other origins, `/api/*` endpoints, hash-only changes and same-URL clicks.
 */
export function getTrackableNavigationKey(
  click: NavigationClickInput,
  anchor: NavigationAnchorInput,
  currentHref: string,
): string | null {
  if (click.defaultPrevented) return null;
  if (click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (anchor.optedOut || anchor.hasDownload) return null;
  const target = anchor.target?.trim().toLowerCase();
  if (target && target !== '_self') return null;
  const rawHref = anchor.href?.trim();
  if (!rawHref || rawHref.startsWith('#')) return null;

  const key = toNavigationKey(rawHref, currentHref);
  if (!key) return null;
  if (isApiPath(getKeyPathname(key))) return null;
  if (key === getLocationKey({ href: currentHref })) return null;
  return key;
}

// ─── Prefetch policy ────────────────────────────────────────────────────────

/** Mirrors Next's `PrefetchKind` values used by `router.prefetch`. */
export type PrefetchIntentKind = 'auto' | 'full';

/**
 * Dashboard subtrees whose server layouts decide per user whether the page may
 * render: `projects/[projectId]` checks project membership in the tenant
 * database, and `members`, `providers` and `tenant-settings` check the session
 * role. A full prefetch renders that decision into a payload that Next reuses
 * for its static stale time (5 minutes by default), so a user who has lost
 * access, or another user signing in on the same tab (logout and login are
 * soft navigations), could still open the page from the cache. These subtrees
 * have no `loading.tsx`, so their default (`auto`) prefetch carries only the
 * route tree and the layout runs again on every navigation. Add any new server
 * layout or page under `/dashboard` that reads the session or the database.
 */
const SERVER_GATED_DASHBOARD_ROUTES: readonly string[] = [
  '/dashboard/projects',
  '/dashboard/members',
  '/dashboard/providers',
  '/dashboard/tenant-settings',
];

function isWithinRoute(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

function isDashboardPath(pathname: string): boolean {
  return isWithinRoute(pathname, '/dashboard');
}

function isServerGatedDashboardPath(pathname: string): boolean {
  return SERVER_GATED_DASHBOARD_ROUTES.some((route) => isWithinRoute(pathname, route));
}

/**
 * Prefetch kind for a navigation intent (hover, focus, pointer down) on
 * `href`, or `null` to skip it: other origins, non-http(s) schemes, `/api/*`
 * and the current URL. `full` is only kept from one dashboard page to another
 * outside `SERVER_GATED_DASHBOARD_ROUTES`. Next renders a prefetch from the
 * first segment that differs from the current page, so the dashboard layout,
 * which loads the signed-in user, is never part of it; the other dashboard
 * segments read neither the session nor the database, so the payload holds no
 * user data and Next may reuse it for its static stale time.
 */
export function resolveIntentPrefetchKind(
  href: string | null | undefined,
  currentHref: string,
  requested: PrefetchIntentKind,
): PrefetchIntentKind | null {
  const rawHref = href?.trim();
  if (!rawHref || rawHref.startsWith('#')) return null;
  const key = toNavigationKey(rawHref, currentHref);
  if (!key) return null;
  const pathname = getKeyPathname(key);
  if (isApiPath(pathname)) return null;
  const currentKey = getLocationKey({ href: currentHref });
  if (key === currentKey) return null;
  if (requested !== 'full') return 'auto';
  const fromDashboard = currentKey !== null && isDashboardPath(getKeyPathname(currentKey));
  return fromDashboard && isDashboardPath(pathname) && !isServerGatedDashboardPath(pathname)
    ? 'full'
    : 'auto';
}

/**
 * Whether a navigation to another dashboard page should request a full
 * prefetch just before it starts. A cached partial (`auto`, i.e. default
 * `<Link>`) prefetch makes Next commit the target's `loading.tsx` fallback
 * first, and React may then hold the real content back until that fallback has
 * been visible for 300 ms (its Suspense reveal throttle); with a full prefetch
 * the route commits in one step.
 * Same-page query changes keep the current page mounted, so they are skipped.
 */
export function shouldUpgradeNavigationPrefetch(href: string, currentHref: string): boolean {
  if (resolveIntentPrefetchKind(href, currentHref, 'full') !== 'full') return false;
  const key = toNavigationKey(href.trim(), currentHref);
  const currentKey = getLocationKey({ href: currentHref });
  return key !== null && currentKey !== null && getKeyPathname(key) !== getKeyPathname(currentKey);
}

// ─── Controller (state + timers) ────────────────────────────────────────────

type TimerHandle = unknown;

export interface NavigationProgressControllerOptions {
  showDelayMs?: number;
  completeMs?: number;
  safetyTimeoutMs?: number;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export interface NavigationProgressController {
  getState(): NavigationProgressState;
  subscribe(listener: () => void): () => void;
  /** Enables tracking (a progress UI is mounted) at the given committed URL. */
  activate(committedKey: string | null): void;
  /** Disables tracking and clears any in-flight progress. */
  deactivate(): void;
  isActive(): boolean;
  /** Starts (or joins) a navigation. Returns its id, or `null` when ignored. */
  start(targetKey: string): number | null;
  /** Reports the URL that is now rendered. Completes an in-flight navigation. */
  commit(key: string): void;
  /** The navigation's transition finished (possibly without a URL change). */
  settle(id: number): void;
  /** The navigation was cancelled before it started. */
  cancel(id: number): void;
  reset(committedKey?: string | null): void;
}

export function createNavigationProgressController(
  options: NavigationProgressControllerOptions = {},
): NavigationProgressController {
  const showDelayMs = options.showDelayMs ?? NAVIGATION_PROGRESS_SHOW_DELAY_MS;
  const completeMs = options.completeMs ?? NAVIGATION_PROGRESS_COMPLETE_MS;
  const safetyTimeoutMs = options.safetyTimeoutMs ?? NAVIGATION_PROGRESS_SAFETY_TIMEOUT_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let state: NavigationProgressState = INITIAL_NAVIGATION_PROGRESS_STATE;
  let active = false;
  const listeners = new Set<() => void>();
  let revealTimer: TimerHandle | null = null;
  let safetyTimer: TimerHandle | null = null;
  let finishTimer: TimerHandle | null = null;

  const clear = (handle: TimerHandle | null) => {
    if (handle !== null) clearTimer(handle);
    return null;
  };

  const syncTimers = (prev: NavigationProgressState, next: NavigationProgressState) => {
    if (next.phase === 'idle') {
      revealTimer = clear(revealTimer);
      safetyTimer = clear(safetyTimer);
      finishTimer = clear(finishTimer);
      return;
    }
    if (next.phase === 'completing') {
      revealTimer = clear(revealTimer);
      safetyTimer = clear(safetyTimer);
      if (prev.phase !== 'completing' || prev.id !== next.id) {
        finishTimer = clear(finishTimer);
        const id = next.id;
        finishTimer = setTimer(() => {
          finishTimer = null;
          dispatch({ type: 'finish', id });
        }, completeMs);
      }
      return;
    }
    // pending | visible
    finishTimer = clear(finishTimer);
    if (next.phase === 'pending' && revealTimer === null) {
      // A re-targeted pending navigation keeps the original delay: the user
      // has been waiting since the first click.
      revealTimer = setTimer(() => {
        revealTimer = null;
        dispatch({ type: 'reveal' });
      }, showDelayMs);
    }
    if (next.phase === 'visible') revealTimer = clear(revealTimer);
    if (next.id !== prev.id) {
      safetyTimer = clear(safetyTimer);
      const id = next.id;
      safetyTimer = setTimer(() => {
        safetyTimer = null;
        dispatch({ type: 'timeout', id });
      }, safetyTimeoutMs);
    }
  };

  function dispatch(event: NavigationProgressEvent) {
    const prev = state;
    const next = reduceNavigationProgress(prev, event);
    if (next === prev) return;
    state = next;
    syncTimers(prev, next);
    listeners.forEach((listener) => listener());
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate(committedKey) {
      active = true;
      dispatch({ type: 'reset', committedKey });
    },
    deactivate() {
      active = false;
      dispatch({ type: 'reset', committedKey: null });
    },
    isActive: () => active,
    start(targetKey) {
      if (!active) return null;
      dispatch({ type: 'start', targetKey });
      return getPendingNavigationKey(state) === targetKey ? state.id : null;
    },
    commit(key) {
      if (!active) return;
      dispatch({ type: 'commit', key });
    },
    settle(id) {
      dispatch({ type: 'settle', id });
    },
    cancel(id) {
      dispatch({ type: 'cancel', id });
    },
    reset(committedKey) {
      dispatch({ type: 'reset', committedKey });
    },
  };
}
