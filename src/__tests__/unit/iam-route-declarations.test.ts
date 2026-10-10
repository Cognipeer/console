/**
 * CI guard: every API route states how it is authorized (src/lib/iam/routeAuthz).
 *
 * Builds the REAL app (all community plugins; in an enterprise build tree the
 * overlay's registry adds its plugins to the same fastifyApiPlugin) and fails on
 * any undeclared route or contradictory declaration. The gate refuses an
 * undeclared route (403 route_not_declared) in every workspace, so a route that
 * slips through here would be refused for everybody.
 */
import { describe, expect, it } from 'vitest';
import { auditRouteDeclarations, collectApiRoutes, type CollectedRoute } from '../helpers/routeDeclarations';
import { authz, readRouteAuthz, resolveRouteAuthz } from '@/lib/iam/routeAuthz';

describe('route authorization declarations', () => {
  it('every /api route is declared or prefix-mapped, with no contradictions', async () => {
    const routes = await collectApiRoutes();
    expect(routes.length).toBeGreaterThan(500); // sanity: the whole app was registered
    const problems = auditRouteDeclarations(routes);
    expect(problems, problems.join('\n')).toEqual([]);
    // sanity: the gate marker is really detected (a collector that sees nothing gated would hide bare handlers)
    expect(routes.filter((r) => r.kind === 'service' && r.gated).length).toBeGreaterThan(300);
  }, 60_000);

  it('the community routes that had no mapping are all declared explicitly', async () => {
    const routes = await collectApiRoutes();
    const byKey = new Map(routes.map((r) => [`${r.method} ${r.url}`, r]));
    const expected: Array<[string, string, string]> = [
      ['POST', '/api/auth/login', 'public'],
      ['POST', '/api/auth/register', 'public'],
      ['GET', '/api/auth/register/options', 'public'],
      ['POST', '/api/auth/forgot-password', 'public'],
      ['POST', '/api/auth/reset-password', 'public'],
      ['POST', '/api/auth/logout', 'authenticated'],
      ['GET', '/api/auth/session', 'authenticated'],
      ['POST', '/api/auth/change-password', 'authenticated'],
      ['GET', '/api/dashboard', 'authenticated'],
      ['POST', '/api/dashboard/playground/chat', 'service'],
      ['POST', '/api/dashboard/playground/transcription', 'service'],
      ['POST', '/api/dashboard/playground/speech', 'service'],
      ['POST', '/api/dashboard/playground/images', 'service'],
      ['POST', '/api/dashboard/playground/embeddings', 'service'],
      ['POST', '/api/dashboard/playground/ocr', 'service'],
      ['POST', '/api/public/mcp/:tenantId/:endpointSlug/message', 'self'],
      ['POST', '/api/public/mcp/:tenantId/:endpointSlug/sse', 'self'],
      ['GET', '/api/public/mcp/:tenantId/:endpointSlug/sse', 'self'],
      ['GET', '/api/public/a2a/:tenantId/:endpointSlug/.well-known/agent-card.json', 'self'],
      ['POST', '/api/public/a2a/:tenantId/:endpointSlug', 'self'],
      ['GET', '/api/health/live', 'public'],
      ['GET', '/api/health/ready', 'public'],
      ['GET', '/api/support/status', 'authenticated'],
      ['POST', '/api/support/handoff', 'authenticated'],
      ['GET', '/api/metrics', 'authenticated'],
    ];
    for (const [method, url, kind] of expected) {
      const route = byKey.get(`${method} ${url}`);
      expect(route, `${method} ${url} is registered`).toBeDefined();
      expect(route!.declared, `${method} ${url} is declared explicitly`).toBe(true);
      expect(route!.kind, `${method} ${url}`).toBe(kind);
    }
    // the playgrounds need READ on their service (not the POST-derived write): a member who may
    // test models keeps the playground, only one without the service loses it
    for (const [method, url] of expected.filter(([, u, k]) => u.startsWith('/api/dashboard/playground/') && k === 'service')) {
      const service = url.endsWith('/ocr') ? 'ocr' : 'models';
      expect(byKey.get(`${method} ${url}`)!.authz, `${method} ${url}`).toEqual({ kind: 'service', service, level: 'read' });
    }
  }, 60_000);
});

describe('the Authorization center API surface', () => {
  it('has no route left from the retired modes, and keeps the ones the engine-only product uses', async () => {
    const routes = await collectApiRoutes();
    const keys = new Set(routes.map((r) => `${r.method} ${r.url}`));
    for (const gone of [
      'GET /api/iam/mode', 'PUT /api/iam/mode', 'GET /api/iam/shadow/summary', 'GET /api/iam/shadow/entries', 'POST /api/iam/shadow/reset',
    ]) {
      expect(keys.has(gone), gone).toBe(false);
    }
    for (const here of [
      'GET /api/iam/engine/stats', 'GET /api/iam/policies', 'POST /api/iam/policies', 'PUT /api/iam/policies/:policyId', 'DELETE /api/iam/policies/:policyId',
      'POST /api/iam/policies/compile', 'POST /api/iam/policies/preview', 'POST /api/iam/simulate', 'GET /api/iam/audit', 'GET /api/iam/decisions/:decisionId',
      'GET /api/iam/principals', 'GET /api/iam/settings', 'PUT /api/iam/settings', 'GET /api/auth/session',
    ]) {
      expect(keys.has(here), here).toBe(true);
    }
  }, 60_000);

  it('every route of it is gated by the iam service (the session payload is the one that only needs a signed-in caller)', async () => {
    const routes = await collectApiRoutes();
    const iamRoutes = routes.filter((r) => r.url.startsWith('/api/iam/') && !r.websocket);
    expect(iamRoutes.length).toBeGreaterThan(15);
    for (const route of iamRoutes) {
      expect(route.kind, `${route.method} ${route.url}`).toBe('service');
      expect(route.service, `${route.method} ${route.url}`).toBe('iam');
      expect(route.gated, `${route.method} ${route.url}`).toBe(true);
    }
  }, 60_000);
});

describe('the audit itself', () => {
  const route = (method: string, url: string, declared?: unknown): CollectedRoute => ({
    method, url, kind: 'undeclared', declared: false, authz: declared,
  });

  it('flags undeclared routes and every contradictory declaration', () => {
    const problems = auditRouteDeclarations([
      route('GET', '/api/zzz/new-thing'),                                                       // undeclared
      route('GET', '/api/zzz/typo', { kind: 'service', service: 'nope' }),                      // malformed
      route('POST', '/api/zzz/pub', { kind: 'public' }),                                        // public but not in the public list
      route('POST', '/api/agents/pub', { kind: 'public' }),                                     // public on a mapped path that is not in the public list
      route('GET', '/api/agents/auth', { kind: 'authenticated' }),                              // authenticated on a mapped path
      route('GET', '/api/auth/login/x', { kind: 'authenticated' }),                             // authenticated under a public prefix
      route('GET', '/api/agents/other', { kind: 'service', service: 'models' }),                // conflicts with the prefix map
      route('GET', '/api/sandbox/agent/hello', undefined),                                      // self-auth prefix, prefix-mapped, not declared self
      route('POST', '/api/sandbox/agent/x', { kind: 'service', service: 'sandbox' }),           // self-auth prefix declared as a service
      route('GET', '/api/agents/selfdecl', { kind: 'self', reason: 'pretends to authenticate itself' }), // self on a mapped path
      { ...route('GET', '/api/agents/bare'), kind: 'service', gated: false },                    // service route, handler not wrapped
      { ...route('GET', '/api/gpu-fleet/installer.sh'), kind: 'service', gated: false },        // allowlisted: static installer
      { ...route('GET', '/api/agents/ok'), kind: 'service', gated: true },                      // wrapped
    ]);
    const forRoute = (prefix: string) => problems.filter((p) => p.startsWith(prefix)).join(' | ');
    expect(forRoute('GET /api/zzz/new-thing')).toContain('UNDECLARED');
    expect(forRoute('GET /api/zzz/typo')).toContain('malformed');
    expect(forRoute('POST /api/zzz/pub')).toContain('public path list');
    expect(forRoute('POST /api/agents/pub')).toContain('public path list');
    expect(forRoute('GET /api/agents/auth')).toContain('widen access');
    expect(forRoute('GET /api/auth/login/x')).toContain('public / self-auth prefix');
    expect(forRoute('GET /api/agents/other')).toContain('maps to "agents"');
    expect(forRoute('GET /api/sandbox/agent/hello')).toContain('self-auth prefix');
    expect(forRoute('POST /api/sandbox/agent/x')).toContain('self-auth prefix');
    expect(forRoute('GET /api/agents/selfdecl')).toMatch(/declared self but its path is mapped to the "agents" service/);
    expect(forRoute('GET /api/agents/bare')).toMatch(/not wrapped by withApiRequestContext/);
    expect(forRoute('GET /api/gpu-fleet/installer.sh')).toBe('');
    expect(forRoute('GET /api/agents/ok')).toBe('');
  });

  it('accepts the legitimate shapes', () => {
    expect(auditRouteDeclarations([
      route('POST', '/api/auth/login', { kind: 'public' }),
      route('GET', '/api/agents/abc'),                                                          // prefix-mapped
      route('GET', '/api/client/v1/realtime/models'),                                           // prefix-mapped, even if the prefix is public in an enterprise build
      route('GET', '/api/zzz/self', { kind: 'self', reason: 'verifies a shared secret itself' }),
      route('GET', '/api/sandbox/agent/hello', { kind: 'self', reason: 'agent bearer token verified by the handler' }),
      route('GET', '/api/zzz/svc', { kind: 'service', service: 'ldap' }),
    ])).toEqual([]);
  });
});

describe('authz declaration helpers', () => {
  it('build config fragments and validate their input at registration time', () => {
    expect(authz.public()).toEqual({ authz: { kind: 'public' } });
    expect(authz.authenticated()).toEqual({ authz: { kind: 'authenticated' } });
    expect(authz.self('verifies the signed link itself')).toEqual({ authz: { kind: 'self', reason: 'verifies the signed link itself' } });
    expect(authz.service('ldap')).toEqual({ authz: { kind: 'service', service: 'ldap' } });
    expect(authz.service('agents', 'read')).toEqual({ authz: { kind: 'service', service: 'agents', level: 'read' } });
    expect(() => authz.self('')).toThrow();
    expect(() => authz.self('short')).toThrow();
    expect(() => authz.service('nope' as never)).toThrow(/unknown permission service/);
    expect(() => authz.service('agents', 'none' as never)).toThrow();
    expect(() => authz.service('members', 'write')).toThrow(/admin service/);
  });

  it('a malformed declaration reads as undeclared (fails closed)', () => {
    expect(readRouteAuthz({ authz: { kind: 'service', service: 'nope' } })).toBeUndefined();
    expect(readRouteAuthz({ authz: { kind: 'self' } })).toBeUndefined();
    expect(readRouteAuthz({ authz: { kind: 'root' } })).toBeUndefined();
    expect(readRouteAuthz(undefined)).toBeUndefined();
    expect(resolveRouteAuthz({ authz: { kind: 'service', service: 'nope' } }, '/api/unmapped-thing').effective).toEqual({ kind: 'undeclared' });
  });

  it('effective declaration = explicit config, else the prefix map, else undeclared', () => {
    const explicit = resolveRouteAuthz(authz.service('ldap'), '/api/zzz');
    expect(explicit.effective).toMatchObject({ kind: 'service', service: 'ldap', declared: true });
    expect(explicit.declaration).toEqual({ kind: 'service', service: 'ldap' });
    expect(explicit.prefixService).toBeNull();
    expect(explicit).not.toHaveProperty('legacy');

    const mapped = resolveRouteAuthz(undefined, '/api/agents/abc');
    expect(mapped.effective).toMatchObject({ kind: 'service', service: 'agents', declared: false });
    expect(mapped.prefixService).toBe('agents');

    expect(resolveRouteAuthz(undefined, '/api/zzz/abc').effective).toEqual({ kind: 'undeclared' });

    // an authenticated route that no prefix maps is not gated by a service
    expect(resolveRouteAuthz(authz.authenticated(), '/api/zzz').prefixService).toBeNull();
    expect(resolveRouteAuthz(authz.authenticated(), '/api/zzz').effective).toEqual({ kind: 'authenticated', declared: true });
    // an explicit level travels with the declaration
    expect(resolveRouteAuthz(authz.service('agents', 'admin'), '/api/zzz').effective).toEqual({ kind: 'service', declared: true, service: 'agents', level: 'admin' });
  });
});
