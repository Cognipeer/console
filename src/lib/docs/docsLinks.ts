/**
 * The docs pages the console links to, and the URLs that open them.
 *
 * A page is named by an id of `src/config/docs-links.json`, by the `docsPath` of a service
 * (platform-services.json), or by its path on the docs site. Every URL is built on one base, the
 * `DOCS_BASE_URL` of the deployment (server config, handed to the client by the dashboard layout),
 * so a self-hosted install can point the console at a copy of the docs it can reach.
 */

import docsLinksJson from '@/config/docs-links.json';

export const DEFAULT_DOCS_BASE_URL = 'https://docs.cognipeer.com';

const PAGES = docsLinksJson.pages;

export type DocId = keyof typeof PAGES;

/** A page of the docs site by its path from the site root (`/console/guide/...`), `#anchor` allowed. */
export type DocPath = `/${string}`;

export type DocTarget = DocId | DocPath;

/** What a Documentation entry opens when nothing more specific applies. */
export const DEFAULT_DOC: DocId = 'console-home';

export interface ResolvedDoc {
  path: DocPath;
  /** The page title, when the registry (or the caller) knows it. */
  title?: string;
}

export function isDocId(value: string): value is DocId {
  return Object.prototype.hasOwnProperty.call(PAGES, value);
}

/** A rooted path on the docs site: starts with one `/`, no whitespace or backslash. */
export function isDocPath(value: string): value is DocPath {
  return /^\/(?!\/)[^\s\\]*$/.test(value);
}

/** The page a target names; anything else (none, an unknown id, not a path) is the default page. */
export function resolveDoc(target?: string | null, title?: string): ResolvedDoc {
  if (target && isDocId(target)) {
    return { path: PAGES[target].path as DocPath, title: title ?? PAGES[target].title };
  }
  if (target && isDocPath(target)) return { path: target, title };
  return { path: PAGES[DEFAULT_DOC].path as DocPath, title: PAGES[DEFAULT_DOC].title };
}

/**
 * The docs base URL as a deployment sets it: an http(s) URL, kept without query, anchor or
 * trailing slash. Unset or unusable is the public site.
 */
export function normalizeDocsBaseUrl(value?: string | null): string {
  const raw = value?.trim();
  if (!raw) return DEFAULT_DOCS_BASE_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULT_DOCS_BASE_URL;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return DEFAULT_DOCS_BASE_URL;
  }
}

/** The URL of a docs page on `baseUrl`; `query` goes before the page's anchor. */
export function buildDocsUrl(
  baseUrl: string,
  target?: string | null,
  query?: Record<string, string>,
): string {
  const { path } = resolveDoc(target);
  const hashAt = path.indexOf('#');
  const pathname = hashAt === -1 ? path : path.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : path.slice(hashAt);
  const search = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query)}` : '';
  return `${baseUrl}${pathname}${search}${hash}`;
}
