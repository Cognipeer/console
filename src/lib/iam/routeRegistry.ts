/**
 * Registry of every route the API registered and how it is authorized. Filled
 * by the `onRoute` hook of the API plugin (server/api/plugin.ts). It tells the
 * authorization settings API whether any route would be refused as undeclared,
 * and (gateActions.ts) which gate actions anything in this build asks for. The
 * CI guard test asserts the undeclared list is empty for the community and the
 * enterprise build.
 */

import { resolveRouteAuthz, type RouteAuthzLevel } from './routeAuthz';

export interface RegisteredRoute {
  method: string;
  /** The route pattern as registered (with the /api prefix). */
  url: string;
  kind: 'public' | 'authenticated' | 'self' | 'service' | 'undeclared';
  /** Whether the kind comes from an explicit config.authz (true) or the ROUTE_PREFIXES map (false). */
  declared: boolean;
  service?: string;
  /** The level the route declared for itself (`authz.service(svc, level)`); absent = derived from the method. */
  level?: RouteAuthzLevel;
}

const routes = new Map<string, RegisteredRoute>();
const MAX_ROUTES = 20_000;

/** A route pattern as a concrete path the prefix map can classify (`:id` -> `x`, `*` -> `x`). */
export function concretePath(url: string): string {
  return url.replace(/:[A-Za-z0-9_]+/g, 'x').replace(/\*/g, 'x');
}

export function classifyRoute(url: string, config: unknown): Omit<RegisteredRoute, 'method' | 'url'> {
  const { effective } = resolveRouteAuthz(config, concretePath(url));
  if (effective.kind === 'service') {
    return {
      kind: 'service',
      declared: effective.declared,
      service: effective.service,
      ...(effective.level ? { level: effective.level } : {}),
    };
  }
  if (effective.kind === 'undeclared') return { kind: 'undeclared', declared: false };
  return { kind: effective.kind, declared: true };
}

export function recordRegisteredRoute(method: string | readonly string[], url: string, config: unknown): void {
  try {
    if (routes.size >= MAX_ROUTES) return;
    const methods = Array.isArray(method) ? method : [method];
    const classified = classifyRoute(url, config);
    for (const m of methods as string[]) {
      routes.set(`${m} ${url}`, { method: m, url, ...classified });
    }
  } catch {
    // diagnostics only; never break route registration
  }
}

export function listRegisteredRoutes(): RegisteredRoute[] {
  return [...routes.values()];
}

/** Only `/api` routes count: the Next.js catch-all is not part of the gated API surface. */
export function listUndeclaredRoutes(): RegisteredRoute[] {
  return [...routes.values()].filter((r) => r.kind === 'undeclared' && r.url.startsWith('/api'));
}

export function resetRouteRegistryForTests(): void {
  routes.clear();
}
