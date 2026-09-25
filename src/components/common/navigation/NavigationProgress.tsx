'use client';

import { Suspense, useEffect, useSyncExternalStore } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { VisuallyHidden } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import {
  getLocationKey,
  getTrackableNavigationKey,
  NAVIGATION_PROGRESS_OPT_OUT_ATTRIBUTE,
  NAVIGATION_PROGRESS_OPT_OUT_VALUE,
  type NavigationProgressPhase,
} from '@/lib/navigation/navigationProgress';
import {
  getRouterTransitionStartCount,
  isRouterTransitionHookInstalled,
  navigationProgress,
} from '@/lib/navigation/navigationProgressRuntime';
import classes from './NavigationProgress.module.css';

const OPT_OUT_SELECTOR = `[${NAVIGATION_PROGRESS_OPT_OUT_ATTRIBUTE}="${NAVIGATION_PROGRESS_OPT_OUT_VALUE}"]`;

function handleDocumentClick(event: MouseEvent) {
  const origin = event.target;
  if (!(origin instanceof Element)) return;
  const anchor = origin.closest('a[href]');
  if (!anchor) return;

  const key = getTrackableNavigationKey(
    {
      button: event.button,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      defaultPrevented: event.defaultPrevented,
    },
    {
      href: anchor.getAttribute('href'),
      target: anchor.getAttribute('target'),
      hasDownload: anchor.hasAttribute('download'),
      optedOut: anchor.closest(OPT_OUT_SELECTOR) !== null,
    },
    window.location.href,
  );
  if (!key) return;

  const routerStartsBefore = getRouterTransitionStartCount();
  const id = navigationProgress.start(key);
  if (id === null || !isRouterTransitionHookInstalled()) return;

  // `next/link` starts its navigation synchronously from its click handler.
  // If the click finished dispatching, its default action was prevented and no
  // router navigation started, app code cancelled it (e.g. opened a modal).
  window.setTimeout(() => {
    if (event.defaultPrevented && getRouterTransitionStartCount() === routerStartsBefore) {
      navigationProgress.cancel(id);
    }
  }, 0);
}

function handlePopState() {
  // Back/forward. Hash-only entries resolve to the committed key and are ignored.
  const key = getLocationKey(window.location);
  if (key) navigationProgress.start(key);
}

function handlePageShow(event: PageTransitionEvent) {
  if (event.persisted) navigationProgress.reset(getLocationKey(window.location));
}

/** Reports every committed URL so in-flight progress can complete. */
function NavigationCommitWatcher() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? '';

  useEffect(() => {
    const key = getLocationKey(window.location);
    if (key) navigationProgress.commit(key);
  }, [pathname, search]);

  return null;
}

const getPhaseSnapshot = (): NavigationProgressPhase => navigationProgress.getState().phase;
const getServerPhase = (): NavigationProgressPhase => 'idle';

function NavigationProgressBar() {
  const phase = useSyncExternalStore(navigationProgress.subscribe, getPhaseSnapshot, getServerPhase);
  const t = useTranslations('navigationFeedback');

  return (
    <>
      <div className={classes.root} data-phase={phase} aria-hidden="true">
        <div className={classes.bar} />
      </div>
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {phase === 'visible' ? t('loadingPage') : ''}
      </VisuallyHidden>
    </>
  );
}

/**
 * Shell-level navigation feedback: a thin top progress bar that appears only
 * when an in-app navigation is still pending after a short delay.
 *
 * Tracks every same-origin link click in the document (including plain
 * `next/link` links rendered by pages that do not import this module),
 * imperative router navigations (via `instrumentation-client.ts` and
 * `useNavigationFeedback`) and back/forward. Mount once per layout.
 * Individual links can opt out with `data-nav-progress="off"`.
 */
export default function NavigationProgress() {
  useEffect(() => {
    navigationProgress.activate(getLocationKey(window.location));
    document.addEventListener('click', handleDocumentClick, true);
    window.addEventListener('popstate', handlePopState);
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      document.removeEventListener('click', handleDocumentClick, true);
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('pageshow', handlePageShow);
      navigationProgress.deactivate();
    };
  }, []);

  return (
    <>
      <Suspense fallback={null}>
        <NavigationCommitWatcher />
      </Suspense>
      <NavigationProgressBar />
    </>
  );
}
