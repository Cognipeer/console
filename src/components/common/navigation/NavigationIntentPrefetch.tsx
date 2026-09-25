'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  getTrackableNavigationKey,
  resolveIntentPrefetchKind,
} from '@/lib/navigation/navigationProgress';
import { readNavigationAnchor, readNavigationClick } from './navigationAnchor';
import { requestRouterPrefetch } from './useNavigationFeedback';

/**
 * Turns an imminent in-app link click — pointer down, or Enter on a focused
 * link — into a full prefetch of the target dashboard page, for every link in
 * the document (including plain `next/link` links on pages that do not import
 * this module). A default `<Link>` prefetch stops at the target's
 * `loading.tsx`, so its navigation would commit that fallback first and React
 * could hold the real content back until the fallback had been visible for
 * 300 ms. With the full prefetch requested before the click, Next commits the
 * route in one step. Links opted out with `data-nav-progress="off"`, new-tab
 * clicks, downloads and other origins are left alone.
 */
export default function NavigationIntentPrefetch() {
  const router = useRouter();

  useEffect(() => {
    const onIntent = (event: PointerEvent | KeyboardEvent) => {
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Enter') return;
      const anchor = readNavigationAnchor(event.target);
      if (!anchor) return;
      const currentHref = window.location.href;
      const key = getTrackableNavigationKey(readNavigationClick(event), anchor, currentHref);
      if (!key || resolveIntentPrefetchKind(key, currentHref, 'full') !== 'full') return;
      requestRouterPrefetch(router, key, 'full');
    };

    document.addEventListener('pointerdown', onIntent, true);
    document.addEventListener('keydown', onIntent, true);
    return () => {
      document.removeEventListener('pointerdown', onIntent, true);
      document.removeEventListener('keydown', onIntent, true);
    };
  }, [router]);

  return null;
}
