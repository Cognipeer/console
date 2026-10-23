import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getConfigSource, setConfigSource } from '@/lib/core/config';
import { signPortalHostSession } from '@/lib/portalHost/token';

const verifyToken = vi.hoisted(() => vi.fn());
vi.mock('@/lib/license/token-manager', () => ({ TokenManager: { verifyToken } }));

import { config, middleware } from '@/middleware';

const BASE = 'http://console.test';
const originalSource = getConfigSource();

function request(path: string, token?: string): NextRequest {
  return new NextRequest(`${BASE}${path}`, token ? { headers: { cookie: `token=${token}` } } : undefined);
}

const validPayload = {
  userId: 'u1',
  email: 'user@demo.local',
  role: 'user',
  tenantId: 't1',
  tenantSlug: 'demo',
  tenantDbName: 'tenant_demo',
  licenseType: 'FREE',
  features: [],
};

function matcherRegex(): RegExp {
  return new RegExp(`^${config.matcher[0]}$`);
}

describe('middleware: portal pages', () => {
  beforeEach(() => {
    verifyToken.mockReset();
  });

  it('matches /p/* in the matcher but still excludes api and static assets', () => {
    const re = matcherRegex();
    expect(re.test('/p/branch-assistant')).toBe(true);
    expect(re.test('/p')).toBe(true);
    expect(re.test('/dashboard')).toBe(true);
    expect(re.test('/api/portal/x/info')).toBe(false);
    expect(re.test('/api')).toBe(false);
    expect(re.test('/api-embed/portal/x')).toBe(false);
    expect(re.test('/_next/static/chunk.js')).toBe(false);
    // Only the `api` segment is the API: on a portal host this is the portal keyed `api-desk`.
    expect(re.test('/api-desk')).toBe(true);
    expect(re.test('/apiary')).toBe(true);
  });

  it('sends a cookie-less /p/* visitor to login with the way back', async () => {
    const res = await middleware(request('/p/branch-assistant?agent=a'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      `${BASE}/login?returnTo=${encodeURIComponent('/p/branch-assistant?agent=a')}`,
    );
  });

  it('sends an invalid-token /p/* visitor to login with the way back and clears the cookie', async () => {
    verifyToken.mockResolvedValue(null);
    const res = await middleware(request('/p/branch-assistant', 'garbage'));
    expect(res.headers.get('location')).toBe(
      `${BASE}/login?returnTo=${encodeURIComponent('/p/branch-assistant')}`,
    );
    expect(res.headers.get('set-cookie')).toMatch(/token=;/);
  });

  it('keeps the bare /login redirect for every other protected path', async () => {
    const noCookie = await middleware(request('/dashboard/agents'));
    expect(noCookie.headers.get('location')).toBe(`${BASE}/login`);

    verifyToken.mockResolvedValue(null);
    const badToken = await middleware(request('/dashboard/agents?x=1', 'garbage'));
    expect(badToken.headers.get('location')).toBe(`${BASE}/login`);

    // Not a portal page: a look-alike prefix gets no returnTo either.
    const lookalike = await middleware(request('/pricing'));
    expect(lookalike.headers.get('location')).toBe(`${BASE}/login`);
  });

  it('lets a signed-in user through on /p/* and injects the session headers', async () => {
    verifyToken.mockResolvedValue(validPayload);
    const res = await middleware(request('/p/branch-assistant', 'good'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    // NextResponse.next({ request: { headers } }) exposes overrides this way.
    expect(res.headers.get('x-middleware-override-headers')).toContain('x-user-id');
    expect(res.headers.get('x-middleware-request-x-user-id')).toBe('u1');
    expect(res.headers.get('x-middleware-request-x-tenant-id')).toBe('t1');
  });

  it('restricts images to this origin on portal pages only (markdown image exfiltration)', async () => {
    verifyToken.mockResolvedValue(validPayload);
    const portal = await middleware(request('/p/branch-assistant', 'good'));
    expect(portal.headers.get('content-security-policy')).toBe("img-src 'self' data: blob:");
    const dashboard = await middleware(request('/dashboard', 'good'));
    expect(dashboard.headers.get('content-security-policy')).toBeNull();
  });

  it('keeps login pages public', async () => {
    const res = await middleware(request('/login?returnTo=%2Fp%2Fx'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('middleware: a portal host', () => {
  const PORTAL = 'http://acme.portal.cognipeer.test';
  let token: string;

  function portalRequest(path: string, options: { cookie?: string; headers?: Record<string, string> } = {}): NextRequest {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.cookie !== undefined) headers.cookie = `cp_portal_session=${options.cookie}`;
    return new NextRequest(`${PORTAL}${path}`, { headers });
  }

  beforeEach(async () => {
    verifyToken.mockReset();
    setConfigSource({
      name: 'test',
      get: (key) => ({
        APP_URL: BASE,
        PORTAL_BASE_DOMAIN: 'portal.cognipeer.test',
        JWT_SECRET: 's'.repeat(40),
        JWT_EXPIRES_IN: '7d',
      } as Record<string, string>)[key],
    });
    token = await signPortalHostSession({
      userId: 'u1',
      email: 'user@acme.test',
      tenantId: 't1',
      tenantSlug: 'acme',
      tenantDbName: 'tenant_acme',
      host: 'acme.portal.cognipeer.test',
    });
  });

  afterEach(() => {
    setConfigSource(originalSource);
  });

  it('sends a person without a session to the sign-in, with the way back', async () => {
    const res = await middleware(portalRequest('/hr-desk?agent=a'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${PORTAL}/api/portal-host/sign-in?path=${encodeURIComponent('/hr-desk?agent=a')}`);
    // The Console session is not looked at here at all.
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('clears a session cookie that is not good for this host', async () => {
    const other = await signPortalHostSession({
      userId: 'u1', email: 'user@acme.test', tenantId: 't1', tenantSlug: 'acme', tenantDbName: 'tenant_acme',
      host: 'beta.portal.cognipeer.test',
    });
    const res = await middleware(portalRequest('/', { cookie: other }));
    expect(res.headers.get('location')).toBe(`${PORTAL}/api/portal-host/sign-in?path=${encodeURIComponent('/')}`);
    expect(res.headers.get('set-cookie')).toMatch(/cp_portal_session=;/);
  });

  it('shows the chooser at / and a portal at /{key}, as the person of the session', async () => {
    const home = await middleware(portalRequest('/', { cookie: token }));
    expect(home.headers.get('x-middleware-rewrite')).toBe(`${PORTAL}/p`);
    expect(home.headers.get('x-middleware-request-x-user-id')).toBe('u1');
    expect(home.headers.get('x-middleware-request-x-tenant-id')).toBe('t1');
    expect(home.headers.get('x-middleware-request-x-portal-host')).toBe('acme.portal.cognipeer.test');

    const portal = await middleware(portalRequest('/HR-Desk?agent=a', { cookie: token }));
    expect(portal.headers.get('x-middleware-rewrite')).toBe(`${PORTAL}/p/hr-desk?agent=a`);
    expect(portal.headers.get('content-security-policy')).toBe("img-src 'self' data: blob:");
  });

  it('drops identity headers a client sends', async () => {
    const res = await middleware(portalRequest('/hr-desk', { cookie: token, headers: { 'x-user-role': 'owner', 'x-license-type': 'ENTERPRISE' } }));
    const overridden = res.headers.get('x-middleware-override-headers') ?? '';
    expect(overridden).toContain('x-user-id');
    expect(res.headers.get('x-middleware-request-x-user-role')).toBeNull();
    expect(res.headers.get('x-middleware-request-x-license-type')).toBeNull();
  });

  it('sends a Console-style link to the short address', async () => {
    const res = await middleware(portalRequest('/p/hr-desk?agent=a', { cookie: token }));
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`${PORTAL}/hr-desk?agent=a`);
    const chooser = await middleware(portalRequest('/p'));
    expect(chooser.headers.get('location')).toBe(`${PORTAL}/`);
  });

  it('has no other page: not the dashboard, not the login', async () => {
    expect((await middleware(portalRequest('/dashboard/agents', { cookie: token }))).status).toBe(404);
    expect((await middleware(portalRequest('/hr-desk/extra', { cookie: token }))).status).toBe(404);
  });

  it('leaves the Console host as it was', async () => {
    const res = await middleware(request('/p/hr-desk'));
    expect(res.headers.get('location')).toBe(`${BASE}/login?returnTo=${encodeURIComponent('/p/hr-desk')}`);
  });

  it('does not let a client mark a Console page as a portal host page', async () => {
    verifyToken.mockResolvedValue(validPayload);
    const res = await middleware(new NextRequest(`${BASE}/p/hr-desk`, { headers: { cookie: 'token=good', 'x-portal-host': 'acme.portal.cognipeer.test' } }));
    expect(res.headers.get('x-middleware-request-x-portal-host')).toBeNull();
    // The override replaces the request headers: a name left out of it is gone downstream.
    expect((res.headers.get('x-middleware-override-headers') ?? '').split(',')).not.toContain('x-portal-host');
  });
});
