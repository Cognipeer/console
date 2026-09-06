import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getPermissionServiceForPath } from '@/lib/security/rbac';

/**
 * Regression gate for the bug class behind F-01 (finance-institution
 * assessment, 2026-09-05): `getPermissionServiceForPath` returning `null` for
 * an unmapped path makes `enforceApiTokenRbac`/`enforceSessionRbac` skip
 * authorization entirely — a narrow-scope token gets full access to any
 * `/client/v1/*` route the RBAC table doesn't know about yet.
 *
 * This has happened twice already: once for `/a2a` (fixed by a point patch),
 * then again — simultaneously — for `/audio`, `/images`, `/ocr`,
 * `/assistants`, `/threads`, and (previously unnoticed) `/rerankers`. A point
 * fix does not stop a THIRD occurrence when the next `/client/v1/*` plugin
 * ships. This test statically scans every client-token plugin file for its
 * registered route paths and fails if any of them falls through the RBAC map
 * — turning the "silently unenforced" failure mode into a loud CI failure at
 * the moment a route is added, not months later in a pentest report.
 *
 * Every current `/client/v1/*` route is RBAC-mapped by design (no route
 * currently sets `rbac: false`); ALLOWED_UNMAPPED_PREFIXES exists only for a
 * future, deliberate exception — add to it with a comment explaining why the
 * route is intentionally open to any valid token, never to silence a gap you
 * haven't actually reasoned about.
 */

const PLUGINS_DIR = path.join(__dirname, '../../server/api/plugins');
const ROUTE_LITERAL_RE = /app\.(?:get|post|put|delete|patch)\(\s*[`'"](\/client\/v1\/[a-zA-Z0-9_\-:./]*)[`'"]/g;

const ALLOWED_UNMAPPED_PREFIXES: string[] = [];

function isAllowed(clientPath: string): boolean {
  return ALLOWED_UNMAPPED_PREFIXES.some(
    (prefix) => clientPath === prefix || clientPath.startsWith(`${prefix}/`),
  );
}

function discoverClientRoutePaths(): Map<string, string> {
  const paths = new Map<string, string>(); // clientPath -> source file (first seen)
  const files = fs
    .readdirSync(PLUGINS_DIR)
    .filter((f) => f.startsWith('client-') && f.endsWith('.ts'));

  for (const file of files) {
    const content = fs.readFileSync(path.join(PLUGINS_DIR, file), 'utf8');
    let match: RegExpExecArray | null;
    ROUTE_LITERAL_RE.lastIndex = 0;
    while ((match = ROUTE_LITERAL_RE.exec(content))) {
      if (!paths.has(match[1])) paths.set(match[1], file);
    }
  }
  return paths;
}

describe('RBAC route-mapping coverage (client/v1 API-token surface)', () => {
  const routePaths = discoverClientRoutePaths();

  it('discovered a non-trivial number of client/v1 routes to check (sanity check the scanner itself still works)', () => {
    expect(routePaths.size).toBeGreaterThan(100);
  });

  it('maps every registered /client/v1/* route to a permission service, or lists it as a deliberate exception', () => {
    const unmapped: string[] = [];
    for (const [clientPath, file] of routePaths) {
      if (isAllowed(clientPath)) continue;
      const service = getPermissionServiceForPath(`/api${clientPath}`);
      if (!service) {
        unmapped.push(`${clientPath}  (registered in ${file})`);
      }
    }

    expect(
      unmapped,
      'These /client/v1 routes have no RBAC route-prefix entry in src/lib/security/rbac.ts, ' +
        'so ANY valid API token — regardless of its service scope — passes authorization for ' +
        'them unchecked (see enforceApiTokenRbac: unmapped paths return early). Either add a ' +
        '{ prefix, service } entry to ROUTE_PREFIXES, or add the path to ' +
        'ALLOWED_UNMAPPED_PREFIXES in this test with a comment explaining why it is meant to ' +
        'be open to any token.',
    ).toEqual([]);
  });
});
