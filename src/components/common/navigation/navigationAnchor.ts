import {
  NAVIGATION_PROGRESS_OPT_OUT_ATTRIBUTE,
  NAVIGATION_PROGRESS_OPT_OUT_VALUE,
  type NavigationAnchorInput,
  type NavigationClickInput,
} from '@/lib/navigation/navigationProgress';

const OPT_OUT_SELECTOR = `[${NAVIGATION_PROGRESS_OPT_OUT_ATTRIBUTE}="${NAVIGATION_PROGRESS_OPT_OUT_VALUE}"]`;

/** Closest `a[href]` around an event target, reduced to the attributes that decide navigation. */
export function readNavigationAnchor(target: EventTarget | null): NavigationAnchorInput | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a[href]');
  if (!anchor) return null;
  return {
    href: anchor.getAttribute('href'),
    target: anchor.getAttribute('target'),
    hasDownload: anchor.hasAttribute('download'),
    optedOut: anchor.closest(OPT_OUT_SELECTOR) !== null,
  };
}

/** Button and modifier state of a pointer, mouse or keyboard event. */
export function readNavigationClick(event: MouseEvent | KeyboardEvent): NavigationClickInput {
  return {
    button: 'button' in event ? event.button : 0,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    defaultPrevented: event.defaultPrevented,
  };
}
