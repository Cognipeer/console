/**
 * Route handler wrapper — establishes per-request AsyncLocalStorage context.
 *
 * Reads `x-request-id`, `x-tenant-id`, `x-tenant-slug`, `x-user-id` headers
 * injected by the Fastify API hooks and wires them into the request context so
 * that every downstream `createLogger(…)` call auto-correlates logs.
 *
 * Usage (named export):
 *   export const POST = withRequestContext(async (request) => { … });
 *
 * Usage (dynamic route):
 *   export const GET = withRequestContext(async (request, ctx) => { … });
 */

import { NextResponse, type NextRequest } from '@/server/api/http';
import { runWithRequestContext } from '@/lib/core/requestContext';
import { isShuttingDown } from '@/lib/core/lifecycle';

/* eslint-disable @typescript-eslint/no-explicit-any */
type RouteHandler = (request: NextRequest, ctx?: any) => Promise<NextResponse | Response>;

/**
 * Wraps a Next.js App-Router handler in `runWithRequestContext`.
 *
 * The resulting function signature is compatible with both static and
 * dynamic routes (the optional second arg carries `params`).
 *
 * Also returns 503 if the process is shutting down.
 */
export function withRequestContext(handler: RouteHandler): RouteHandler {
  return (request: NextRequest, ctx?: any) => {
    // Decline new work during graceful shutdown
    if (isShuttingDown()) {
      return Promise.resolve(
        NextResponse.json(
          { error: 'Service is shutting down' },
          { status: 503, headers: { 'Retry-After': '5' } },
        ),
      );
    }

    const requestId = request.headers.get('x-request-id') || undefined;
    const tenantId = request.headers.get('x-tenant-id') || undefined;
    const tenantSlug = request.headers.get('x-tenant-slug') || undefined;
    const userId = request.headers.get('x-user-id') || undefined;

    return runWithRequestContext(
      { requestId, tenantId, tenantSlug, userId },
      () => handler(request, ctx),
    );
  };
}
