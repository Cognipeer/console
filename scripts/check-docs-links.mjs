#!/usr/bin/env node
/**
 * Checks every docs page the console links to against the live docs site: the pages of
 * src/config/docs-links.json and the docsPath of every service in src/config/platform-services.json.
 *
 * A page must answer 200 as itself, not as a "Page moved" page (the docs site writes one with
 * <meta http-equiv="refresh"> for each old address), and an #anchor must be an id on it.
 *
 *   npm run docs:links                                        # https://docs.cognipeer.com
 *   DOCS_BASE_URL=https://docs.example.internal npm run docs:links
 *
 * The docs repo runs the same check against its own pages on every pull request, which keeps a
 * docs restructure from breaking these links; this one catches a console change that links a page
 * the site does not have (yet: a new page has to be published before the console links it).
 */

import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

const base = (process.env.DOCS_BASE_URL || 'https://docs.cognipeer.com').trim().replace(/\/+$/, '');
const { pages } = readJson('src/config/docs-links.json');
const { services } = readJson('src/config/platform-services.json');

const links = [
  ...Object.entries(pages).map(([id, page]) => ({ label: `docs-links.json ${id}`, path: page.path })),
  ...services.map((service) => ({ label: `platform-services.json ${service.id}`, path: service.docsPath })),
];

/** One request per page, however many links point into it. */
const fetched = new Map();
function fetchPage(pathname) {
  if (!fetched.has(pathname)) {
    fetched.set(
      pathname,
      fetch(`${base}${pathname}`, { redirect: 'follow', signal: AbortSignal.timeout(20_000) })
        .then(async (response) => ({ status: response.status, html: response.ok ? await response.text() : '' }))
        .catch((error) => ({ status: 0, html: '', error: error instanceof Error ? error.message : String(error) })),
    );
  }
  return fetched.get(pathname);
}

async function problemOf({ path }) {
  if (typeof path !== 'string' || !path.startsWith('/')) return 'no docs path';
  const [pathname, anchor] = path.split('#');
  const page = await fetchPage(pathname);
  if (page.status !== 200) return page.error ? `request failed: ${page.error}` : `HTTP ${page.status}`;
  const refresh = page.html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i);
  if (refresh) return `a "Page moved" redirect page; link ${refresh[1]} instead`;
  if (anchor && !new RegExp(`\\sid=["']${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(page.html)) {
    return `no #${anchor} on the page`;
  }
  return null;
}

const results = await Promise.all(links.map(async (link) => ({ ...link, problem: await problemOf(link) })));
const failures = results.filter((result) => result.problem);

for (const failure of failures) {
  console.error(`✗ ${failure.label}: ${base}${failure.path ?? ''} — ${failure.problem}`);
}
console.log(`${links.length - failures.length}/${links.length} docs links resolve on ${base} (${fetched.size} pages).`);
process.exit(failures.length > 0 ? 1 : 0);
