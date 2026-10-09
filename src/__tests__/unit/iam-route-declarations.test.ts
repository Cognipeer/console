/**
 * CI guard: every API route states how it is authorized (src/lib/iam/routeAuthz).
 *
 * Builds the REAL app (all community plugins; in an enterprise build tree the
 * overlay's registry adds its plugins to the same fastifyApiPlugin) and fails on
 * any undeclared route or contradictory declaration. Enforce mode refuses an
 * undeclared route, so a route that slips through here would be a 403 for every
 * tenant that switches to enforce.
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
    expect(forRoute('GET /api/agents/selfdecl')).toContain('access widens in enforce mode only');
    expect(forRoute('GET /api/agents/bare')).toContain('NO mode gates it');
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
    expect(explicit.legacy).toEqual({ service: 'ldap' });

    const mapped = resolveRouteAuthz(undefined, '/api/agents/abc');
    expect(mapped.effective).toMatchObject({ kind: 'service', service: 'agents', declared: false });

    expect(resolveRouteAuthz(undefined, '/api/zzz/abc').effective).toEqual({ kind: 'undeclared' });

    // legacy never gated authenticated/public/self routes that no prefix maps
    expect(resolveRouteAuthz(authz.authenticated(), '/api/zzz').legacy).toBeNull();
    expect(resolveRouteAuthz(authz.authenticated(), '/api/zzz').effective).toEqual({ kind: 'authenticated', declared: true });
  });
});
