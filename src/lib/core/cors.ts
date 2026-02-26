/**
 * CORS Module — configurable Cross-Origin Resource Sharing.
 *
 * Controlled via ENV:
 *   CORS_ENABLED=true
 *   CORS_ALLOWED_ORIGINS=https://app.example.com,https://other.com
 *   CORS_MAX_AGE=86400
 *
 * Applied only to /api/client/* paths (external API consumers).
 *
 * Usage in middleware:
 *   import { applyCors, handleCorsPreflightIfNeeded } from '@/lib/core/cors';
 *
 *   // For preflight (OPTIONS):
 *   const preflightResponse = handleCorsPreflightIfNeeded(request);
 *   if (preflightResponse) return preflightResponse;
 *
 *   // For normal responses:
 *   const response = NextResponse.next(...);
 *   applyCors(request, response);
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getConfig } from './config';

const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_HEADERS = 'Authorization, Content-Type, X-Request-Id, X-Api-Key';

/**
 * Check if the request origin is allowed.
 */
function isOriginAllowed(origin: string): boolean {
  const cfg = getConfig();
  if (!cfg.cors.enabled) return false;

  // If no specific origins configured, allow all (wildcard mode)
  if (cfg.cors.allowedOrigins.length === 0) return true;

  return cfg.cors.allowedOrigins.some((allowed) => {
    // Support wildcard subdomains: *.example.com
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(2);
      const originHost = new URL(origin).hostname;
      return originHost === domain || originHost.endsWith(`.${domain}`);
    }
    return allowed === origin;
  });
}

/**
 * Apply CORS headers to a response. Call this for non-preflight responses.
 */
export function applyCors(request: NextRequest, response: NextResponse): void {
  const cfg = getConfig();
  if (!cfg.cors.enabled) return;

  const origin = request.headers.get('origin');
  if (!origin) return;

  if (!isOriginAllowed(origin)) return;

  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', CORS_METHODS);
  response.headers.set('Access-Control-Allow-Headers', CORS_HEADERS);
  response.headers.set('Access-Control-Max-Age', String(cfg.cors.maxAge));
  response.headers.set('Access-Control-Allow-Credentials', 'true');
}

/**
 * Handle CORS preflight (OPTIONS) requests.
 * Returns a Response if it's a preflight that was handled, or null otherwise.
 */
export function handleCorsPreflightIfNeeded(request: NextRequest): NextResponse | null {
  const cfg = getConfig();
  if (!cfg.cors.enabled) return null;
  if (request.method !== 'OPTIONS') return null;

  const origin = request.headers.get('origin');
  if (!origin || !isOriginAllowed(origin)) return null;

  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': CORS_METHODS,
      'Access-Control-Allow-Headers': CORS_HEADERS,
      'Access-Control-Max-Age': String(cfg.cors.maxAge),
      'Access-Control-Allow-Credentials': 'true',
    },
  });
}
