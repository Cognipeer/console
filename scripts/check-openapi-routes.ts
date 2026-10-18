#!/usr/bin/env tsx
/**
 * OpenAPI route gate.
 *
 * `openapi.yaml` is the one description of the client API. This script builds
 * the real API (fastifyApiPlugin, through an `onRoute` hook, so routes that a
 * plugin registers in a loop or through a helper are seen too) and compares
 * METHOD + path of every `/client/v1` and `/public` route with the operations
 * of the document. Path parameters are compared by position (`:id`, `{key}`
 * -> `{}`).
 *
 *   - a live route the spec does not document      -> fail (add the operation)
 *   - a spec operation no live route answers       -> fail (delete the operation)
 *
 * Known gaps live in `openapi-routes.baseline.json`. A baseline entry that no
 * longer applies is printed so the list only ever shrinks.
 *
 * Spec paths are relative to `/api/client/v1`, or to `/api/public` for a path
 * item whose own `servers` say so.
 *
 * Run via: `npm run test:openapi`
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { parse } from 'yaml';
import { fastifyApiPlugin } from '@/server/api/plugin';

const ROOT = path.resolve(__dirname, '..');
const SPEC_PATH = path.join(ROOT, 'openapi.yaml');
const BASELINE_PATH = path.join(__dirname, 'openapi-routes.baseline.json');

const METHODS = ['get', 'put', 'post', 'delete', 'patch'];
const CLIENT_PREFIX = '/client/v1';
const PUBLIC_PREFIX = '/public';

/**
 * Baseline file format:
 *   { undocumented: ["GET /client/v1/foo/{}"], specOnly: ["POST /client/v1/bar"], note: "..." }
 * Keys are `METHOD /full/path` as the server registers it (without `/api`).
 */
type Baseline = { undocumented: string[]; specOnly: string[]; note?: string };

async function loadBaseline(): Promise<Baseline> {
  try {
    return JSON.parse(await fs.readFile(BASELINE_PATH, 'utf8')) as Baseline;
  } catch {
    return { undocumented: [], specOnly: [] };
  }
}

/** `:id` and `{id}` both become `{}`; a trailing slash is dropped. */
function normalise(p: string): string {
  return p.replace(/:[A-Za-z0-9_]+|\{[^}]+\}/g, '{}').replace(/(.)\/$/, '$1');
}

const key = (method: string, p: string) => `${method.toUpperCase()} ${normalise(p)}`;

function isDocumented(p: string): boolean {
  return p.startsWith(`${CLIENT_PREFIX}/`) || p.startsWith(`${PUBLIC_PREFIX}/`);
}

async function liveRoutes(): Promise<Set<string>> {
  const app = Fastify({ logger: false });
  const routes = new Set<string>();
  app.addHook('onRoute', (route) => {
    if (!isDocumented(route.url)) return;
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      // HEAD twins of GET routes and CORS preflights are not API operations.
      if (METHODS.includes(method.toLowerCase())) routes.add(key(method, route.url));
    }
  });
  await app.register(fastifyApiPlugin);
  await app.ready();
  await app.close();
  return routes;
}

type PathItem = { servers?: Array<{ url?: string }> } & Record<string, unknown>;

async function specOperations(): Promise<Set<string>> {
  const spec = parse(await fs.readFile(SPEC_PATH, 'utf8')) as { paths: Record<string, PathItem> };
  const ops = new Set<string>();
  for (const [p, item] of Object.entries(spec.paths)) {
    const prefix = item.servers?.some((s) => s.url?.endsWith('/api/public')) ? PUBLIC_PREFIX : CLIENT_PREFIX;
    for (const method of METHODS) {
      if (item[method]) ops.add(key(method, prefix + p));
    }
  }
  return ops;
}

function report(title: string, entries: string[], hint: string): void {
  console.error(`✗ ${entries.length} ${title}:`);
  for (const e of entries) console.error(`    ${e}`);
  console.error(`  ${hint}`);
  console.error('');
}

async function main(): Promise<void> {
  const [live, spec, baseline] = await Promise.all([liveRoutes(), specOperations(), loadBaseline()]);

  const undocumented = [...live].filter((k) => !spec.has(k)).sort();
  const specOnly = [...spec].filter((k) => !live.has(k)).sort();
  const allowedUndocumented = new Set(baseline.undocumented);
  const allowedSpecOnly = new Set(baseline.specOnly);

  const newUndocumented = undocumented.filter((k) => !allowedUndocumented.has(k));
  const newSpecOnly = specOnly.filter((k) => !allowedSpecOnly.has(k));
  const staleBaseline = [
    ...baseline.undocumented.filter((k) => !undocumented.includes(k)),
    ...baseline.specOnly.filter((k) => !specOnly.includes(k)),
  ];

  console.log(`Live routes:      ${live.size}`);
  console.log(`Spec operations:  ${spec.size}`);
  console.log(`Undocumented:     ${undocumented.length}  (baseline tolerates ${allowedUndocumented.size})`);
  console.log(`Spec-only:        ${specOnly.length}  (baseline tolerates ${allowedSpecOnly.size})`);
  console.log('');

  if (staleBaseline.length > 0) {
    console.log(`✓ ${staleBaseline.length} baseline entry/entries no longer apply — ratchet the baseline:`);
    for (const k of staleBaseline) console.log(`    ${k}`);
    console.log('');
  }

  if (newUndocumented.length === 0 && newSpecOnly.length === 0) {
    console.log('✓ openapi.yaml and the registered routes agree (modulo the baseline).');
    process.exit(0);
  }

  if (newUndocumented.length > 0) {
    report(
      'live route(s) missing from openapi.yaml',
      newUndocumented,
      'Document the operation in openapi.yaml, or add it to scripts/openapi-routes.baseline.json (only if intentional).',
    );
  }
  if (newSpecOnly.length > 0) {
    report(
      'openapi.yaml operation(s) no registered route answers',
      newSpecOnly,
      'Remove the operation from openapi.yaml, or add it to scripts/openapi-routes.baseline.json (only if the route is provided by the enterprise overlay).',
    );
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('check-openapi-routes failed:', err);
  process.exit(2);
});
