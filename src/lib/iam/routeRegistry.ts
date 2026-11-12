/**
 * Registry of every route the API registered and how it is authorized. Filled
 * by the `onRoute` hook of the API plugin (server/api/plugin.ts). It tells the
 * authorization settings API whether any route would be refused as undeclared,
 * and (gateActions.ts) which gate actions anything in this build asks for. The
 * CI guard test asserts the undeclared list is empty for the community and the
 * enterprise build.
 */

import { resolveRouteAuthz, type RouteAuthzLevel } from './routeAuthz';
import { UNDECLARED_ROUTE_EXCEPTIONS } from './routeDeclarationRules';

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

export interface RouteDeclarationCheckInput {
  method: string | readonly string[];
  /** The route pattern as registered (with the /api prefix). */
  url: string;
  config?: unknown;
}

export interface RouteDeclarationCheckOptions {
  /** Throw instead of reporting (see isStrictRouteRegistration). */
  strict: boolean;
  /** Called with the problem when `strict` is off. */
  report: (message: string, route: { method: string; url: string }) => void;
  /** Extra paths the caller knows never reach the gate (public / self-auth), on top of UNDECLARED_ROUTE_EXCEPTIONS. */
  isExempt?: (concretePath: string) => boolean;
}

/**
 * The registration-time check: an /api route that resolves to nothing (no explicit
 * `config.authz`, no ROUTE_PREFIXES / resolver mapping) is refused at request time
 * with 403 `route_not_declared`, so it is a defect. Throws when `strict`, otherwise
 * reports it once and lets the server register the route (the gate keeps refusing it).
 * Returns the problem text, or null when the route is fine or out of scope.
 */
export function assertRouteDeclared(route: RouteDeclarationCheckInput, options: RouteDeclarationCheckOptions): string | null {
  if (!route.url.startsWith('/api')) return null;
  const path = concretePath(route.url);
  const { effective } = resolveRouteAuthz(route.config, path);
  if (effective.kind !== 'undeclared') return null;
  if (UNDECLARED_ROUTE_EXCEPTIONS.some((entry) => entry.match.test(path)) || options.isExempt?.(path)) return null;
  const method = Array.isArray(route.method) ? route.method.join(',') : String(route.method);
  const message = `${method} ${route.url} is not declared: add config: authz.<kind>(...) to the route or map its prefix in ROUTE_PREFIXES (until then the gate refuses it with 403 route_not_declared)`;
  if (options.strict) throw new Error(message);
  options.report(message, { method, url: route.url });
  return message;
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
