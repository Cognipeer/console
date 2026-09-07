'use client';

/**
 * The two hooks both browser workbenches are built from.
 *
 * `useWorkbenchStage` owns what the page LOOKS like — the screenshot, the
 * aria snapshot behind the element list, the console. It is deliberately
 * keyed on a session key rather than a session object, because the flow
 * editor points it at two different sessions over its lifetime (the one you
 * are authoring in, and the fresh one a test run drives) and the panels
 * should not care which.
 *
 * `useDriveSession` owns the other half: opening a session and running one
 * action against it. It reports the outcome and leaves the bookkeeping to the
 * caller, because that is exactly where the playground and the editor
 * diverge — one appends to a scratch log, the other appends to a flow.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { notifications } from '@mantine/notifications';
import type { BrowserSessionView } from '@/lib/services/browser';
import { INTERACTIVE_ROLES, parseSnapshot, type SnapshotNode } from './snapshot';

/** Console lines and failed requests, as the diagnostics endpoint returns them. */
export interface StageDiagnostics {
  console: Array<{ type: string; text: string }>;
  networkFailures: Array<{ url: string; failure?: string }>;
}

export interface WorkbenchStage {
  snapshot: string;
  nodes: SnapshotNode[];
  pageUrl: string;
  pageTitle: string;
  shotUrl: string;
  autoRefresh: boolean;
  setAutoRefresh: (next: boolean) => void;
  diagnostics: StageDiagnostics | null;
  loadDiagnostics: () => Promise<void>;
  refresh: () => void;
  /**
   * Refresh from a key given explicitly rather than the one this hook was
   * rendered with. A run's session key does not exist yet on the tick that
   * starts watching it, so the polling loop reads it off the just-fetched run
   * instead of waiting for this hook to re-render with it.
   */
  refreshFrom: (sessionKey: string) => Promise<void>;
  /** Fold an action's own response in, so acting refreshes without a round trip. */
  applyResult: (result: Record<string, unknown> | undefined) => Promise<void>;
  /**
   * One cheap fetch, for keeping the element list live while it is on screen.
   * Unlike `refreshFrom` it does not retry — the next tick is the retry.
   */
  poll: (sessionKey: string) => Promise<void>;
  /**
   * True while the page on screen has nothing addressable in it — a
   * client-rendered route that has arrived but not painted. The panel polls
   * faster in this state, and says so instead of looking broken.
   */
  awaitingContent: boolean;
  reset: () => void;
}

export function useWorkbenchStage(
  sessionKey: string | undefined,
  options: { paused?: boolean } = {},
): WorkbenchStage {
  const { paused = false } = options;

  const [snapshot, setSnapshot] = useState('');
  const [nodes, setNodes] = useState<SnapshotNode[]>([]);
  const [pageUrl, setPageUrl] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [shotUrl, setShotUrl] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [diagnostics, setDiagnostics] = useState<StageDiagnostics | null>(null);
  const [awaitingContent, setAwaitingContent] = useState(false);

  /** URL of the tree currently on screen, so the poll can tell a real move. */
  const lastCommittedUrl = useRef<string | null>(null);

  const reset = useCallback(() => {
    lastCommittedUrl.current = null;
    setAwaitingContent(false);
    setSnapshot('');
    setNodes([]);
    setShotUrl('');
    setDiagnostics(null);
  }, []);

  const refreshFrom = useCallback(async (key: string) => {
    // Cache-busted rather than polled through JSON: the endpoint returns the
    // image itself with `cache-control: no-store`, so the <img> is the
    // cheapest live view available.
    const shot = () => setShotUrl(
      `/api/browser/sessions/${encodeURIComponent(key)}/screenshot/live?ts=${Date.now()}`,
    );
    shot();

    // An element list you cannot act on is almost never the truth — it is a
    // snapshot that landed before the page finished arriving.
    //
    // The bar is a target you could actually pick, not "any node": a
    // client-rendered app answers `domcontentloaded` with its empty shell,
    // whose tree is a handful of `generic` wrappers and nothing to click. A
    // retry keyed on "no nodes at all" accepts that shell and leaves the
    // panel useless — which is exactly the state in which the next step
    // cannot be built.
    const RETRY_DELAYS_MS = [300, 600, 900];
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const res = await fetch(`/api/browser/sessions/${encodeURIComponent(key)}/snapshot`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const tree = (data.ariaSnapshot ?? '') as string;
      const parsed = parseSnapshot(tree);
      const usable = parsed.some((node) => INTERACTIVE_ROLES.has(node.role));

      if (usable || attempt === RETRY_DELAYS_MS.length) {
        setAwaitingContent(!usable);
        lastCommittedUrl.current = typeof data.url === 'string' ? data.url : lastCommittedUrl.current;
        setSnapshot(tree);
        setNodes(parsed);
        if (data.url) setPageUrl(data.url);
        if (data.title) setPageTitle(data.title);
        // The page moved on while we waited, so the picture did too.
        if (attempt > 0) shot();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }, []);

  const refresh = useCallback(() => {
    if (!sessionKey) return;
    void refreshFrom(sessionKey);
  }, [sessionKey, refreshFrom]);

  /**
   * Keep the element list honest while the user is looking at it.
   *
   * Refreshing after an action is not enough: the page moves on its own too —
   * a login redirect, a client-side route change, a modal that renders a
   * second later — and a list that only updates when YOU act goes stale
   * exactly when it matters, which is the moment you are trying to pick the
   * next element on the page in front of you.
   *
   * Committed only when it is worth committing: a tree with something to pick
   * in it, or one from a URL different to what is on screen (the page really
   * did move, even if the new one has nothing interactive on it yet). A
   * half-rendered tree mid-navigation is dropped, and the next tick corrects
   * it — that is what makes this safe to run on a timer.
   */
  const poll = useCallback(async (key: string) => {
    const res = await fetch(`/api/browser/sessions/${encodeURIComponent(key)}/snapshot`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const tree = (data.ariaSnapshot ?? '') as string;
    const parsed = parseSnapshot(tree);
    const usable = parsed.some((node) => INTERACTIVE_ROLES.has(node.role));
    const movedOn = typeof data.url === 'string' && data.url !== lastCommittedUrl.current;

    // A page that has arrived but not painted is worth reporting AS that,
    // rather than as an element list with nothing in it: the URL and the
    // screenshot have moved on, so pretending the old list still describes
    // the page would be worse. `awaitingContent` is what makes the panel say
    // so — and poll faster until it is no longer true.
    setAwaitingContent(!usable);
    if (!usable && !movedOn) return;

    lastCommittedUrl.current = typeof data.url === 'string' ? data.url : lastCommittedUrl.current;
    setSnapshot(tree);
    setNodes(parsed);
    if (data.url) setPageUrl(data.url);
    if (data.title) setPageTitle(data.title);
  }, []);

  const applyResult = useCallback(async (result: Record<string, unknown> | undefined) => {
    if (!sessionKey) return;
    if (typeof result?.url === 'string') setPageUrl(result.url);
    if (typeof result?.pageTitle === 'string') setPageTitle(result.pageTitle);
    // An action that already carries the fresh snapshot saves a round trip;
    // `extract` does not, so fall back to asking. So does a snapshot with no
    // addressable elements in it — that is the navigation race, and asking
    // again (which retries) beats showing an empty list.
    if (typeof result?.ariaSnapshot === 'string' && result.ariaSnapshot) {
      const parsed = parseSnapshot(result.ariaSnapshot);
      if (parsed.some((node) => INTERACTIVE_ROLES.has(node.role))) {
        if (typeof result.url === 'string') lastCommittedUrl.current = result.url;
        setSnapshot(result.ariaSnapshot);
        setNodes(parsed);
        setShotUrl(`/api/browser/sessions/${encodeURIComponent(sessionKey)}/screenshot/live?ts=${Date.now()}`);
        return;
      }
    }
    await refreshFrom(sessionKey);
  }, [sessionKey, refreshFrom]);

  const loadDiagnostics = useCallback(async () => {
    if (!sessionKey) return;
    const res = await fetch(`/api/browser/sessions/${encodeURIComponent(sessionKey)}/diagnostics`, { cache: 'no-store' });
    if (res.ok) setDiagnostics(await res.json());
  }, [sessionKey]);

  // Only the screenshot is polled. The snapshot is refetched when something
  // actually happens (an action lands, a run advances a step) — re-parsing a
  // whole aria tree every three seconds to watch a static page is waste.
  useEffect(() => {
    if (!sessionKey || !autoRefresh || paused) return;
    const timer = setInterval(() => {
      setShotUrl(`/api/browser/sessions/${encodeURIComponent(sessionKey)}/screenshot/live?ts=${Date.now()}`);
    }, 3000);
    return () => clearInterval(timer);
  }, [sessionKey, autoRefresh, paused]);

  return {
    snapshot,
    nodes,
    pageUrl,
    pageTitle,
    shotUrl,
    autoRefresh,
    setAutoRefresh,
    diagnostics,
    loadDiagnostics,
    refresh,
    refreshFrom,
    applyResult,
    poll,
    awaitingContent,
    reset,
  };
}

export interface ActionOutcome {
  ok: boolean;
  /** The API's own result object, or `{}` when the request itself failed. */
  result: Record<string, unknown>;
  detail?: string;
  durationMs: number;
}

export interface DriveSession {
  session: BrowserSessionView | null;
  starting: boolean;
  busy: boolean;
  start: () => Promise<BrowserSessionView | null>;
  end: () => Promise<void>;
  runAction: (action: Record<string, unknown>) => Promise<ActionOutcome | null>;
}

export function useDriveSession(config: {
  browserId: string;
  name: string;
  stage: Pick<WorkbenchStage, 'applyResult' | 'reset'>;
  onStarted?: () => void;
}): DriveSession {
  const { browserId, name, stage, onStarted } = config;
  const [session, setSession] = useState<BrowserSessionView | null>(null);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  // `end` fires on unmount, where reading `session` from state would close
  // over whatever it was when the effect was set up.
  const current = useRef<BrowserSessionView | null>(null);
  current.current = session;

  const start = useCallback(async () => {
    if (!browserId) return null;
    setStarting(true);
    try {
      const res = await fetch('/api/browser/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ browserId, name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not start a session');
      setSession(data.session);
      stage.reset();
      onStarted?.();
      notifications.show({ color: 'teal', title: 'Session started', message: data.session.sessionKey });
      return data.session as BrowserSessionView;
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
      return null;
    } finally {
      setStarting(false);
    }
  }, [browserId, name, stage, onStarted]);

  const end = useCallback(async () => {
    const open = current.current;
    if (!open) return;
    setSession(null);
    stage.reset();
    await fetch(`/api/browser/sessions/${encodeURIComponent(open.sessionKey)}`, { method: 'DELETE' })
      .catch(() => undefined);
  }, [stage]);

  const runAction = useCallback(async (action: Record<string, unknown>): Promise<ActionOutcome | null> => {
    const open = current.current;
    if (!open) return null;

    setBusy(true);
    const started = Date.now();
    try {
      // `extract` reads rather than acts, so it has its own endpoint — but to
      // the person driving, it is one more step in the same sequence.
      const isRead = action.type === 'extract';
      const endpoint = isRead ? 'extract' : 'actions';
      const body = isRead ? { ...action, type: undefined } : action;
      const res = await fetch(
        `/api/browser/sessions/${encodeURIComponent(open.sessionKey)}/${endpoint}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))),
        },
      );
      const data = await res.json().catch(() => ({}));
      const result = (data.result ?? data ?? {}) as Record<string, unknown>;
      const ok = res.ok && result?.ok !== false;

      const outcome: ActionOutcome = {
        ok,
        result,
        detail: isRead
          ? (Array.isArray(result.values) ? result.values.join(' · ').slice(0, 200) : undefined)
          : (result.errorMessage as string | undefined) ?? (data.error as string | undefined),
        durationMs: Date.now() - started,
      };

      if (!ok) {
        notifications.show({
          color: 'red',
          title: 'Action failed',
          message: outcome.detail ?? 'Failed',
        });
      } else {
        await stage.applyResult(result);
      }
      return outcome;
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
      return { ok: false, result: {}, durationMs: Date.now() - started };
    } finally {
      setBusy(false);
    }
  }, [stage]);

  return { session, starting, busy, start, end, runAction };
}

/**
 * Size a workbench to exactly the dashboard's `<main>` content area.
 *
 * It cannot be `position: absolute` — the dashboard shell's `<main>` is not
 * the nearest positioned ancestor, so an absolute box escapes it and paints
 * over the sidebar. Height and the padding-cancelling margins are measured
 * instead and applied inline. `undefined` until the first measurement lands,
 * so the shell renders at its natural size for one frame rather than at 0.
 *
 * The ref is a CALLBACK ref, not an object one, because a page that renders
 * "Loading…" before its workbench attaches the ref on a later render — and an
 * effect with an empty dependency list has already run and found nothing by
 * then, leaving the shell at its natural (collapsed) height forever.
 */
export function useFillMain(): {
  ref: (node: HTMLDivElement | null) => void;
  style: { height: number; margin: string } | undefined;
} {
  const [shell, setShell] = useState<HTMLDivElement | null>(null);
  const [fill, setFill] = useState<{ height: number; margin: string } | null>(null);

  useEffect(() => {
    const main = shell?.closest('main');
    if (!shell || !main) return;

    const measure = () => {
      const mainRect = main.getBoundingClientRect();
      const mainStyle = getComputedStyle(main);
      const padLeft = parseFloat(mainStyle.paddingLeft) || 0;
      const padRight = parseFloat(mainStyle.paddingRight) || 0;
      const padBottom = parseFloat(mainStyle.paddingBottom) || 0;
      // The shell's own top is stable regardless of its height — it's fixed
      // by whatever sits above it — so this isn't circular: measure top, then
      // derive height from it.
      const top = shell.getBoundingClientRect().top;
      setFill({
        height: Math.max(0, mainRect.bottom - top),
        margin: `0 -${padRight}px -${padBottom}px -${padLeft}px`,
      });
    };

    measure();
    // ResizeObserver over window resize: also fires when the service sub-nav
    // collapses/expands and changes <main>'s width without a resize event.
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    return () => observer.disconnect();
  }, [shell]);

  return { ref: setShell, style: fill ?? undefined };
}
