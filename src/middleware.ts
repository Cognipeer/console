import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { TokenManager } from '@/lib/license/token-manager';
import { LicenseManager } from '@/lib/license/license-manager';

// Paths that don't require authentication
const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/api/auth/login',
  '/api/auth/register',
];

// Client API paths that use Bearer token authentication instead of cookie
const CLIENT_API_PATHS = ['/api/client/', '/api/models/v1/', '/api/metrics'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  // Allow client API paths (they use Bearer token authentication)
  if (CLIENT_API_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
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

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
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
