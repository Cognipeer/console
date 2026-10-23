import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const verifyToken = vi.hoisted(() => vi.fn());
vi.mock('@/lib/license/token-manager', () => ({ TokenManager: { verifyToken } }));

import { middleware } from '@/middleware';
import { isChannelLinkPagePath, safeReturnTo } from '@/lib/security/returnTo';

const BASE = 'http://console.test';
const LINK = '/channels/link/tenant1.abc_DEF-123';

function request(path: string, token?: string): NextRequest {
  return new NextRequest(`${BASE}${path}`, token ? { headers: { cookie: `token=${token}` } } : undefined);
}

describe('isChannelLinkPagePath', () => {
  it('matches the link page only', () => {
    expect(isChannelLinkPagePath(LINK)).toBe(true);
    expect(isChannelLinkPagePath('/channels/link/')).toBe(true);
    expect(isChannelLinkPagePath('/channels/link')).toBe(false);
    expect(isChannelLinkPagePath('/channels')).toBe(false);
    expect(isChannelLinkPagePath('/dashboard/channels/link/x')).toBe(false);
    expect(isChannelLinkPagePath('/api/channels/link/x')).toBe(false);
  });

  it('is a valid returnTo target', () => {
    expect(safeReturnTo(LINK)).toBe(LINK);
  });
});

describe('middleware: channel link pages', () => {
  beforeEach(() => {
    verifyToken.mockReset();
  });

  it('sends a cookie-less visitor to login with the way back', async () => {
    const res = await middleware(request(LINK));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${BASE}/login?returnTo=${encodeURIComponent(LINK)}`);
  });

  it('keeps returnTo for an invalid token and clears the cookie', async () => {
    verifyToken.mockResolvedValue(null);
    const res = await middleware(request(LINK, 'garbage'));
    expect(res.headers.get('location')).toBe(`${BASE}/login?returnTo=${encodeURIComponent(LINK)}`);
    expect(res.headers.get('set-cookie')).toMatch(/token=;/);
  });

  it('does not add returnTo to look-alike paths', async () => {
    const res = await middleware(request('/channels/other'));
    expect(res.headers.get('location')).toBe(`${BASE}/login`);
  });
});
