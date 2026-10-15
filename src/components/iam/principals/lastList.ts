/**
 * The last address of the principals list (search, filters, kind and all), kept for the
 * session so the pages opened from it can lead back to the very same view.
 *
 * Only a same-origin `/dashboard/iam?tab=principals...` address is ever written or read:
 * whatever sits in storage is untrusted input to a link.
 */

import { IAM_PATH, isListType } from '../links';

export const LAST_LIST_URL_KEY = 'iam:principals:lastListUrl';

/** The address when it is a principals-list address of the IAM center (path + query), else null. */
export function sanitizeLastListUrl(raw: unknown, origin?: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  // A relative address only: `//host` and `/\host` are protocol-relative.
  const base = origin ?? 'http://localhost';
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.origin !== new URL(base).origin) return null;
  if (url.pathname !== IAM_PATH) return null;
  if (url.searchParams.get('tab') !== 'principals') return null;
  return `${url.pathname}${url.search}`;
}

/** The kind of principal an address of the list shows (the list defaults to people). */
export function listTypeOf(href: string): 'user' | 'group' | 'token' {
  try {
    const type = new URL(href, 'http://localhost').searchParams.get('principalType');
    return isListType(type) ? type : 'user';
  } catch {
    return 'user';
  }
}

/** The remembered list view when it shows this kind of principal, else null. */
export function lastListUrlFor(type: string, href: string | null | undefined): string | null {
  const clean = sanitizeLastListUrl(href ?? null);
  return clean && listTypeOf(clean) === type ? clean : null;
}

/** Parameters of the list address that belong to a form or a page opened from it, not to the list view. */
const TRANSIENT_PARAMS = ['new', 'edit', 'principalId'];

function currentOrigin(): string | undefined {
  try {
    return typeof window !== 'undefined' ? window.location.origin : undefined;
  } catch {
    return undefined;
  }
}

export function writeLastListUrl(href: string): void {
  try {
    const clean = sanitizeLastListUrl(href, currentOrigin());
    if (!clean) return;
    const url = new URL(clean, 'http://localhost');
    for (const key of TRANSIENT_PARAMS) url.searchParams.delete(key);
    window.sessionStorage.setItem(LAST_LIST_URL_KEY, `${url.pathname}${url.search}`);
  } catch {
    /* storage unavailable (private window, blocked site data): the fallback link is used */
  }
}

export function readLastListUrl(): string | null {
  try {
    return sanitizeLastListUrl(window.sessionStorage.getItem(LAST_LIST_URL_KEY), currentOrigin());
  } catch {
    return null;
  }
}
