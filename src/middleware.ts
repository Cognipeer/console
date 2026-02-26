import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { TokenManager } from '@/lib/license/token-manager';
import { LicenseManager } from '@/lib/license/license-manager';
import { applyCors, handleCorsPreflightIfNeeded } from '@/lib/core/cors';

// Paths that don't require authentication
const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/health/live',
  '/api/health/ready',
];

// Client API paths that use Bearer token authentication instead of cookie
const CLIENT_API_PATHS = ['/api/client/', '/api/models/v1/', '/api/metrics'];

/** Inject common security headers into every response. */
function applySecurityHeaders(response: NextResponse): void {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  // HSTS – only effective over HTTPS; max-age = 1 year
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains',
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // CORS preflight handling for client API paths
  if (CLIENT_API_PATHS.some((path) => pathname.startsWith(path))) {
    const preflightResponse = handleCorsPreflightIfNeeded(request);
    if (preflightResponse) return preflightResponse;
  }

  // Allow public paths
  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    const response = NextResponse.next();
    applySecurityHeaders(response);
    return response;
  }

  // Allow client API paths (they use Bearer token authentication)
  if (CLIENT_API_PATHS.some((path) => pathname.startsWith(path))) {
    // Defense-in-depth: reject requests without a Bearer token early
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Missing or invalid Authorization header. Use: Bearer <token>' },
        { status: 401 },
      );
    }

    const response = NextResponse.next({
      request: {
        headers: new Headers([
          ...Array.from(request.headers.entries()),
          ['x-request-id', crypto.randomUUID()],
        ]),
      },
    });
    applyCors(request, response);
    applySecurityHeaders(response);
    return response;
  }

  // Get token from cookie
  const token = request.cookies.get('token')?.value;

  if (!token) {
    // Redirect to login if no token
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 },
      );
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // Verify token
  const payload = await TokenManager.verifyToken(token);

  if (!payload) {
    // Token is invalid
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or expired token' },
        { status: 401 },
      );
    }

    const response = NextResponse.redirect(new URL('/login', request.url));
    response.cookies.delete('token');
    return response;
  }

  // Check feature access for API routes
  if (pathname.startsWith('/api/')) {
    const hasAccess = LicenseManager.hasEndpointAccess(
      payload.licenseType,
      pathname,
    );

    if (!hasAccess) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          message: 'Your license does not have access to this feature',
          requiredLicense: 'Please upgrade your plan',
        },
        { status: 403 },
      );
    }
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
  requestHeaders.set('x-license-type', payload.licenseType);
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
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
