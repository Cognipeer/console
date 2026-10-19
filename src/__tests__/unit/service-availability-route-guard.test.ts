/**
 * CI guard: a route that the gate cannot check for a switched-off service
 * states which service its handler checks.
 *
 * The gate (enforceServiceAvailability) only looks at routes that resolve to a
 * permission service. A `public` or `self` route authenticates itself, so the
 * gate never sees which tenant or which service it serves: its handler has to
 * ask `isServiceEnabled` / `assertServiceEnabled` itself. Every such route must
 * appear below with the service it checks, or with the reason it is exempt, so
 * a new public route forces that decision in review.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectApiRoutes } from '../helpers/routeDeclarations';

/** Route pattern (any method) -> the service id its handler checks, or `exempt: <reason>`. */
const PUBLIC_ROUTE_SERVICES: Record<string, string> = {
  '/api/public/mcp/:tenantId/:endpointSlug/message': 'mcp',
  '/api/public/mcp/:tenantId/:endpointSlug/sse': 'mcp',
  '/api/public/a2a/:tenantId/:endpointSlug': 'agents',
  '/api/public/a2a/:tenantId/:endpointSlug/.well-known/agent-card.json': 'agents',
  '/api/public/hooks/:tenantId/:hookId': 'agents',
  '/api/auth/login': 'exempt: sign-in is administration, never switched off',
  '/api/auth/register': 'exempt: sign-up is administration, never switched off',
  '/api/auth/register/options': 'exempt: sign-up is administration, never switched off',
  '/api/auth/forgot-password': 'exempt: account recovery is administration, never switched off',
  '/api/auth/reset-password': 'exempt: account recovery is administration, never switched off',
  '/api/health/live': 'exempt: process liveness, no tenant',
  '/api/health/ready': 'exempt: process readiness, no tenant',
};

/** The plugin file that serves a checked route, so the claim "its handler checks" is verified, not only written. */
const HANDLER_FILES: Array<{ prefix: string; file: string }> = [
  { prefix: '/api/public/mcp/', file: 'src/server/api/plugins/public-mcp.ts' },
  { prefix: '/api/public/a2a/', file: 'src/server/api/plugins/public-a2a.ts' },
  { prefix: '/api/public/hooks/', file: 'src/server/api/plugins/public-hooks.ts' },
];

describe('public and self-authenticated routes name the service they check', () => {
  it('every community public / self route is in the map, and the map has no stale entry', async () => {
    const routes = await collectApiRoutes();
    const declared = new Set(routes.filter((r) => r.kind === 'public' || r.kind === 'self').map((r) => r.url));
    const missing = [...declared].filter((url) => !(url in PUBLIC_ROUTE_SERVICES)).sort();
    expect(
      missing,
      `These public / self routes are not in PUBLIC_ROUTE_SERVICES. Decide which service id their handler checks `
        + `(isServiceEnabled / assertServiceEnabled) or mark them 'exempt: <reason>':\n${missing.join('\n')}`,
    ).toEqual([]);
    const stale = Object.keys(PUBLIC_ROUTE_SERVICES).filter((url) => !declared.has(url)).sort();
    expect(stale, `Entries for routes that are no longer public / self:\n${stale.join('\n')}`).toEqual([]);
  }, 60_000);

  it('a route that checks a service names a known one, and its handler really asks', () => {
    for (const [url, entry] of Object.entries(PUBLIC_ROUTE_SERVICES)) {
      if (entry.startsWith('exempt:')) {
        expect(entry.slice('exempt:'.length).trim().length, `${url}: an exemption needs a reason`).toBeGreaterThan(8);
        continue;
      }
      const owner = HANDLER_FILES.find((h) => url.startsWith(h.prefix));
      expect(owner, `${url}: no handler file is known for this checked route`).toBeDefined();
      const source = readFileSync(resolve(process.cwd(), owner!.file), 'utf8');
      expect(source, `${url}: ${owner!.file} does not ask whether "${entry}" is enabled`).toMatch(
        new RegExp(`(isServiceEnabled|assertServiceEnabled)\\([^;]{0,160}?,\\s*'${entry}'\\)`),
      );
    }
  });
});
