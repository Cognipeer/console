/**
 * Navigation progress: click filtering + state machine behind the dashboard's
 * top progress bar and nav pending affordances.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNavigationProgressController,
  getKeyPathname,
  getLocationKey,
  getPendingNavigationKey,
  getTrackableNavigationKey,
  INITIAL_NAVIGATION_PROGRESS_STATE,
  isNavigationPendingFor,
  NAVIGATION_PROGRESS_COMPLETE_MS,
  NAVIGATION_PROGRESS_SAFETY_TIMEOUT_MS,
  NAVIGATION_PROGRESS_SHOW_DELAY_MS,
  reduceNavigationProgress,
  resolveIntentPrefetchKind,
  shouldUpgradeNavigationPrefetch,
  toNavigationKey,
  type NavigationAnchorInput,
  type NavigationClickInput,
  type NavigationProgressPhase,
  type NavigationProgressState,
} from '@/lib/navigation/navigationProgress';

const CURRENT = 'http://localhost:3000/dashboard/overview';

const click = (overrides: Partial<NavigationClickInput> = {}): NavigationClickInput => ({
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  ...overrides,
});

const anchor = (
  href: string | null,
  overrides: Partial<NavigationAnchorInput> = {},
): NavigationAnchorInput => ({
  href,
  target: null,
  hasDownload: false,
  optedOut: false,
  ...overrides,
});

describe('navigation keys', () => {
  it('resolves same-origin hrefs to pathname + search', () => {
    expect(toNavigationKey('/dashboard/models', CURRENT)).toBe('/dashboard/models');
    expect(toNavigationKey('models?tab=usage', CURRENT)).toBe('/dashboard/models?tab=usage');
    expect(toNavigationKey('http://localhost:3000/dashboard/x#frag', CURRENT)).toBe('/dashboard/x');
  });

  it('rejects other origins and non-http(s) schemes', () => {
    expect(toNavigationKey('https://docs.example.com/x', CURRENT)).toBeNull();
    expect(toNavigationKey('http://localhost:4000/dashboard', CURRENT)).toBeNull();
    expect(toNavigationKey('mailto:team@example.com', CURRENT)).toBeNull();
    expect(toNavigationKey('blob:http://localhost:3000/abc', CURRENT)).toBeNull();
    expect(toNavigationKey('data:text/plain,hi', CURRENT)).toBeNull();
  });

  it('derives location keys and pathnames', () => {
    expect(getLocationKey({ href: 'http://localhost:3000/dashboard/models?range=7d#top' })).toBe(
      '/dashboard/models?range=7d',
    );
    expect(getKeyPathname('/dashboard/models?range=7d')).toBe('/dashboard/models');
    expect(getKeyPathname('/dashboard/models')).toBe('/dashboard/models');
  });

  it('matches pending targets by resolved href', () => {
    expect(isNavigationPendingFor('/dashboard/models', '/dashboard/models', CURRENT)).toBe(true);
    expect(isNavigationPendingFor('/dashboard/models', '/dashboard/models?x=1', CURRENT)).toBe(false);
    expect(isNavigationPendingFor(null, '/dashboard/models', CURRENT)).toBe(false);
    expect(isNavigationPendingFor('/dashboard/models', undefined, CURRENT)).toBe(false);
  });
});

describe('getTrackableNavigationKey', () => {
  it('tracks plain primary clicks on internal links', () => {
    expect(getTrackableNavigationKey(click(), anchor('/dashboard/models'), CURRENT)).toBe(
      '/dashboard/models',
    );
    expect(getTrackableNavigationKey(click(), anchor('/dashboard/models?x=1'), CURRENT)).toBe(
      '/dashboard/models?x=1',
    );
    expect(
      getTrackableNavigationKey(click(), anchor('/dashboard/models', { target: '_self' }), CURRENT),
    ).toBe('/dashboard/models');
  });

  it.each([
    ['meta', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
    ['middle button', { button: 1 }],
    ['already prevented', { defaultPrevented: true }],
  ] as const)('ignores %s clicks (browser/new-tab handling)', (_label, overrides) => {
    expect(getTrackableNavigationKey(click(overrides), anchor('/dashboard/models'), CURRENT)).toBeNull();
  });

  it('ignores new-window targets, downloads and opted-out links', () => {
    expect(
      getTrackableNavigationKey(click(), anchor('/dashboard/models', { target: '_blank' }), CURRENT),
    ).toBeNull();
    expect(
      getTrackableNavigationKey(click(), anchor('/dashboard/models', { hasDownload: true }), CURRENT),
    ).toBeNull();
    expect(
      getTrackableNavigationKey(click(), anchor('/dashboard/models', { optedOut: true }), CURRENT),
    ).toBeNull();
  });

  it('ignores external, non-http and API links', () => {
    expect(getTrackableNavigationKey(click(), anchor('https://github.com/Cognipeer'), CURRENT)).toBeNull();
    expect(getTrackableNavigationKey(click(), anchor('mailto:a@b.c'), CURRENT)).toBeNull();
    expect(getTrackableNavigationKey(click(), anchor('javascript:void(0)'), CURRENT)).toBeNull();
    expect(getTrackableNavigationKey(click(), anchor('/api/files/export.csv'), CURRENT)).toBeNull();
    expect(getTrackableNavigationKey(click(), anchor('/api'), CURRENT)).toBeNull();
    expect(getTrackableNavigationKey(click(), anchor('/apiary'), CURRENT)).toBe('/apiary');
  });

  it('ignores hash-only changes and same-URL clicks', () => {
    expect(getTrackableNavigationKey(click(), anchor('#section'), CURRENT)).toBeNull();
    expect(getTrackableNavigationKey(click(), anchor('/dashboard/overview#stats'), CURRENT)).toBeNull();
    expect(getTrackableNavigationKey(click(), anchor('/dashboard/overview'), CURRENT)).toBeNull();
    expect(getTrackableNavigationKey(click(), anchor('/dashboard/overview?tab=x'), CURRENT)).toBe(
      '/dashboard/overview?tab=x',
    );
  });

  it('ignores anchors without a usable href', () => {
    expect(getTrackableNavigationKey(click(), anchor(null), CURRENT)).toBeNull();
    expect(getTrackableNavigationKey(click(), anchor('   '), CURRENT)).toBeNull();
  });
});

describe('prefetch policy', () => {
  it('keeps full prefetches for other dashboard pages only', () => {
    expect(resolveIntentPrefetchKind('/dashboard/models', CURRENT, 'full')).toBe('full');
    expect(resolveIntentPrefetchKind('/dashboard/models/abc?tab=logs', CURRENT, 'full')).toBe('full');
    expect(resolveIntentPrefetchKind('/dashboard', CURRENT, 'full')).toBe('full');
    expect(resolveIntentPrefetchKind('/dashboardish', CURRENT, 'full')).toBe('auto');
    expect(resolveIntentPrefetchKind('/login', CURRENT, 'full')).toBe('auto');
    expect(resolveIntentPrefetchKind('/dashboard/models', CURRENT, 'auto')).toBe('auto');
  });

  it('skips the current URL, hashes, API routes and other origins', () => {
    expect(resolveIntentPrefetchKind('/dashboard/overview', CURRENT, 'full')).toBeNull();
    expect(resolveIntentPrefetchKind('/dashboard/overview#stats', CURRENT, 'full')).toBeNull();
    expect(resolveIntentPrefetchKind('#stats', CURRENT, 'auto')).toBeNull();
    expect(resolveIntentPrefetchKind('/api/models', CURRENT, 'full')).toBeNull();
    expect(resolveIntentPrefetchKind('https://example.com/dashboard/models', CURRENT, 'full')).toBeNull();
    expect(resolveIntentPrefetchKind('mailto:team@example.com', CURRENT, 'auto')).toBeNull();
    expect(resolveIntentPrefetchKind(null, CURRENT, 'full')).toBeNull();
    expect(resolveIntentPrefetchKind('  ', CURRENT, 'full')).toBeNull();
    expect(resolveIntentPrefetchKind('/dashboard/overview?tab=x', CURRENT, 'full')).toBe('full');
  });

  it('upgrades imperative navigations that change the dashboard page', () => {
    expect(shouldUpgradeNavigationPrefetch('/dashboard/models', CURRENT)).toBe(true);
    expect(shouldUpgradeNavigationPrefetch('http://localhost:3000/dashboard/models/abc', CURRENT)).toBe(true);
    expect(shouldUpgradeNavigationPrefetch('/dashboard/overview?range=7d', CURRENT)).toBe(false);
    expect(shouldUpgradeNavigationPrefetch('/dashboard/overview', CURRENT)).toBe(false);
    expect(shouldUpgradeNavigationPrefetch('/login', CURRENT)).toBe(false);
    expect(shouldUpgradeNavigationPrefetch('/api/models', CURRENT)).toBe(false);
    expect(shouldUpgradeNavigationPrefetch('https://example.com/dashboard/models', CURRENT)).toBe(false);
  });

  it('keeps routes behind per-user server layouts on auto', () => {
    const gated = [
      '/dashboard/projects/p1',
      '/dashboard/projects/p1/settings?tab=members',
      'http://localhost:3000/dashboard/projects/p1',
      '/dashboard/projects',
      '/dashboard/members',
      '/dashboard/providers',
      '/dashboard/providers/openai',
      '/dashboard/tenant-settings',
      '/dashboard/tenant-settings/projects/p1',
    ];
    for (const href of gated) {
      expect(resolveIntentPrefetchKind(href, CURRENT, 'full')).toBe('auto');
      expect(resolveIntentPrefetchKind(href, CURRENT, 'auto')).toBe('auto');
      expect(shouldUpgradeNavigationPrefetch(href, CURRENT)).toBe(false);
    }
    expect(
      resolveIntentPrefetchKind('/dashboard/projects/p2', 'http://localhost:3000/dashboard/projects/p1', 'full'),
    ).toBe('auto');
  });

  it('matches gated routes by whole path segment', () => {
    expect(resolveIntentPrefetchKind('/dashboard/projects-archive', CURRENT, 'full')).toBe('full');
    expect(resolveIntentPrefetchKind('/dashboard/membership', CURRENT, 'full')).toBe('full');
    expect(
      resolveIntentPrefetchKind('/dashboard/models', 'http://localhost:3000/dashboard/projects/p1', 'full'),
    ).toBe('full');
  });

  it('only upgrades to full from a dashboard page, where the dashboard layout is shared', () => {
    const login = 'http://localhost:3000/login';
    expect(resolveIntentPrefetchKind('/dashboard/models', login, 'full')).toBe('auto');
    expect(resolveIntentPrefetchKind('/dashboard', 'http://localhost:3000/no-project', 'full')).toBe('auto');
    expect(shouldUpgradeNavigationPrefetch('/dashboard/models', login)).toBe(false);
  });
});

describe('reduceNavigationProgress', () => {
  const at = (overrides: Partial<NavigationProgressState>): NavigationProgressState => ({
    ...INITIAL_NAVIGATION_PROGRESS_STATE,
    committedKey: '/a',
    ...overrides,
  });

  it('walks idle → pending → visible → completing → idle', () => {
    let state = reduceNavigationProgress(at({}), { type: 'start', targetKey: '/b' });
    expect(state).toMatchObject({ phase: 'pending', id: 1, targetKey: '/b' });
    expect(getPendingNavigationKey(state)).toBe('/b');

    state = reduceNavigationProgress(state, { type: 'reveal' });
    expect(state.phase).toBe('visible');

    state = reduceNavigationProgress(state, { type: 'commit', key: '/b' });
    expect(state).toMatchObject({ phase: 'completing', committedKey: '/b' });
    expect(getPendingNavigationKey(state)).toBeNull();

    state = reduceNavigationProgress(state, { type: 'finish', id: 1 });
    expect(state).toMatchObject({ phase: 'idle', targetKey: null, committedKey: '/b' });
  });

  it('drops a navigation that commits before it was revealed', () => {
    const pending = at({ phase: 'pending', id: 3, targetKey: '/b' });
    expect(reduceNavigationProgress(pending, { type: 'commit', key: '/b' })).toMatchObject({
      phase: 'idle',
      committedKey: '/b',
      targetKey: null,
    });
  });

  it('ignores same-URL starts and dedupes an in-flight target', () => {
    const idle = at({});
    expect(reduceNavigationProgress(idle, { type: 'start', targetKey: '/a' })).toBe(idle);

    const pending = at({ phase: 'pending', id: 1, targetKey: '/b' });
    expect(reduceNavigationProgress(pending, { type: 'start', targetKey: '/b' })).toBe(pending);
  });

  it('ends an in-flight navigation when returning to the committed URL', () => {
    const visible = at({ phase: 'visible', id: 2, targetKey: '/b' });
    expect(reduceNavigationProgress(visible, { type: 'start', targetKey: '/a' }).phase).toBe(
      'completing',
    );
  });

  it('re-targets without hiding a visible bar', () => {
    const visible = at({ phase: 'visible', id: 2, targetKey: '/b' });
    expect(reduceNavigationProgress(visible, { type: 'start', targetKey: '/c' })).toMatchObject({
      phase: 'visible',
      id: 3,
      targetKey: '/c',
    });

    const completing = at({ phase: 'completing', id: 2, targetKey: '/b' });
    expect(reduceNavigationProgress(completing, { type: 'start', targetKey: '/c' })).toMatchObject({
      phase: 'visible',
      id: 3,
    });

    const pending = at({ phase: 'pending', id: 2, targetKey: '/b' });
    expect(reduceNavigationProgress(pending, { type: 'start', targetKey: '/c' })).toMatchObject({
      phase: 'pending',
      id: 3,
      targetKey: '/c',
    });
  });

  it('only settles / cancels / times out the current navigation', () => {
    const visible = at({ phase: 'visible', id: 4, targetKey: '/b' });
    for (const type of ['settle', 'cancel', 'timeout'] as const) {
      expect(reduceNavigationProgress(visible, { type, id: 3 })).toBe(visible);
      expect(reduceNavigationProgress(visible, { type, id: 4 }).phase).toBe('completing');
    }
    const pending = at({ phase: 'pending', id: 4, targetKey: '/b' });
    expect(reduceNavigationProgress(pending, { type: 'cancel', id: 4 }).phase).toBe('idle');
  });

  it('ignores commits of the already committed URL and stale finishes', () => {
    const pending = at({ phase: 'pending', id: 1, targetKey: '/b' });
    expect(reduceNavigationProgress(pending, { type: 'commit', key: '/a' })).toBe(pending);

    const completing = at({ phase: 'completing', id: 2 });
    expect(reduceNavigationProgress(completing, { type: 'finish', id: 1 })).toBe(completing);
  });

  it('resets to idle while keeping ids monotonic', () => {
    const visible = at({ phase: 'visible', id: 7, targetKey: '/b' });
    expect(reduceNavigationProgress(visible, { type: 'reset', committedKey: '/z' })).toEqual({
      phase: 'idle',
      id: 7,
      targetKey: null,
      committedKey: '/z',
    });
    const idle = at({ id: 7 });
    expect(reduceNavigationProgress(idle, { type: 'reset' })).toBe(idle);
  });
});

describe('createNavigationProgressController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => {
    const controller = createNavigationProgressController();
    const phases: NavigationProgressPhase[] = [];
    controller.subscribe(() => phases.push(controller.getState().phase));
    controller.activate('/a');
    phases.length = 0;
    return { controller, phases };
  };

  it('does nothing until a progress UI activates it', () => {
    const controller = createNavigationProgressController();
    expect(controller.start('/b')).toBeNull();
    controller.commit('/b');
    expect(controller.getState()).toEqual(INITIAL_NAVIGATION_PROGRESS_STATE);
    expect(controller.isActive()).toBe(false);
  });

  it('reveals the bar only after the show delay', () => {
    const { controller } = setup();
    const id = controller.start('/b');
    expect(id).toBe(1);
    expect(controller.getState().phase).toBe('pending');

    vi.advanceTimersByTime(NAVIGATION_PROGRESS_SHOW_DELAY_MS - 1);
    expect(controller.getState().phase).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(controller.getState().phase).toBe('visible');

    controller.commit('/b');
    expect(controller.getState().phase).toBe('completing');
    vi.advanceTimersByTime(NAVIGATION_PROGRESS_COMPLETE_MS);
    expect(controller.getState()).toMatchObject({ phase: 'idle', committedKey: '/b' });
  });

  it('never flashes for navigations that commit quickly', () => {
    const { controller, phases } = setup();
    controller.start('/b');
    vi.advanceTimersByTime(NAVIGATION_PROGRESS_SHOW_DELAY_MS - 20);
    controller.commit('/b');
    vi.advanceTimersByTime(NAVIGATION_PROGRESS_SAFETY_TIMEOUT_MS * 2);
    expect(phases).toEqual(['pending', 'idle']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the original delay when the target changes before reveal', () => {
    const { controller } = setup();
    controller.start('/b');
    vi.advanceTimersByTime(100);
    const second = controller.start('/c');
    expect(second).toBe(2);
    vi.advanceTimersByTime(NAVIGATION_PROGRESS_SHOW_DELAY_MS - 100);
    expect(controller.getState()).toMatchObject({ phase: 'visible', targetKey: '/c' });
  });

  it('dedupes repeated starts for the same target', () => {
    const { controller } = setup();
    const first = controller.start('/b');
    expect(controller.start('/b')).toBe(first);
    expect(controller.getState().id).toBe(first);
  });

  it('ignores same-URL navigations', () => {
    const { controller, phases } = setup();
    expect(controller.start('/a')).toBeNull();
    expect(phases).toEqual([]);
  });

  it('abandons navigations that never commit after the safety timeout', () => {
    const { controller } = setup();
    controller.start('/b');
    vi.advanceTimersByTime(NAVIGATION_PROGRESS_SAFETY_TIMEOUT_MS);
    expect(controller.getState().phase).toBe('completing');
    vi.advanceTimersByTime(NAVIGATION_PROGRESS_COMPLETE_MS);
    expect(controller.getState()).toMatchObject({ phase: 'idle', committedKey: '/a' });
  });

  it('restarts the safety timeout for each new target', () => {
    const { controller } = setup();
    controller.start('/b');
    vi.advanceTimersByTime(NAVIGATION_PROGRESS_SAFETY_TIMEOUT_MS - 1_000);
    controller.start('/c');
    vi.advanceTimersByTime(2_000);
    expect(controller.getState()).toMatchObject({ phase: 'visible', targetKey: '/c' });
  });

  it('cancels and settles only the matching navigation', () => {
    const { controller } = setup();
    const first = controller.start('/b')!;
    const second = controller.start('/c')!;
    controller.cancel(first);
    expect(controller.getState()).toMatchObject({ phase: 'pending', targetKey: '/c' });
    controller.settle(second);
    expect(controller.getState().phase).toBe('idle');
    vi.advanceTimersByTime(NAVIGATION_PROGRESS_SAFETY_TIMEOUT_MS);
    expect(controller.getState().phase).toBe('idle');
  });

  it('continues a completing bar when a new navigation starts', () => {
    const { controller } = setup();
    controller.start('/b');
    vi.advanceTimersByTime(NAVIGATION_PROGRESS_SHOW_DELAY_MS);
    controller.commit('/b');
    expect(controller.getState().phase).toBe('completing');
    controller.start('/c');
    vi.advanceTimersByTime(NAVIGATION_PROGRESS_COMPLETE_MS);
    expect(controller.getState()).toMatchObject({ phase: 'visible', targetKey: '/c' });
    controller.commit('/c');
    vi.advanceTimersByTime(NAVIGATION_PROGRESS_COMPLETE_MS);
    expect(controller.getState()).toMatchObject({ phase: 'idle', committedKey: '/c' });
  });

  it('clears in-flight progress and timers on deactivate', () => {
    const { controller } = setup();
    controller.start('/b');
    controller.deactivate();
    expect(controller.getState()).toMatchObject({ phase: 'idle', committedKey: null });
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.start('/c')).toBeNull();
  });

  it('notifies subscribers until they unsubscribe', () => {
    const controller = createNavigationProgressController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.activate('/a');
    controller.start('/b');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    controller.commit('/b');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
