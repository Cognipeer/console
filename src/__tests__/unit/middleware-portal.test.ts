import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const verifyToken = vi.hoisted(() => vi.fn());
vi.mock('@/lib/license/token-manager', () => ({ TokenManager: { verifyToken } }));

import { config, middleware } from '@/middleware';

const BASE = 'http://console.test';

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
    expect(re.test('/_next/static/chunk.js')).toBe(false);
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
