import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { TokenManager } from '@/lib/license/token-manager';

// UI paths that don't require a session cookie.
const PUBLIC_UI_PATHS = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
];

/** Inject common security headers into every response. */
function applySecurityHeaders(response: NextResponse): void {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(self), geolocation=()',
  );
  // Baseline CSP: blocks framing/plugin embedding and restricts fetch/form
  // targets to same-origin. `unsafe-inline`/`unsafe-eval` are kept for
  // script-src because the app hasn't been audited for a nonce-based policy
  // yet — tightening this further needs browser-level verification.
  response.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  // HSTS – only effective over HTTPS; max-age = 1 year
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains',
  );
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
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // Verify token
  const payload = await TokenManager.verifyToken(token);

  if (!payload) {
    const response = NextResponse.redirect(new URL('/login', request.url));
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
  applySecurityHeaders(response);
  return response;
}

export const config = {
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
