/**
 * Route authorization declarations (C3).
 *
 * Every Fastify route states HOW it is authorized, in its route config:
 *
 *   app.get('/thing', { config: authz.service('agents') }, handler);
 *   app.post('/auth/login', { config: authz.public() }, handler);
 *
 * Kinds
 *   public         no authentication at all. The route MUST also be covered by
 *                  the global public path list (plugin.ts PUBLIC_API_PATHS /
 *                  PUBLIC_API_PREFIXES); the CI guard test enforces that.
 *   authenticated  any signed-in principal of the tenant (session user or valid
 *                  API token). No service permission applies; the handler may
 *                  still filter what the caller sees.
 *   self           the handler authenticates non-session credentials itself
 *                  (machine/agent tokens, signed links, shared secrets,
 *                  slug-addressed public endpoints). `reason` is mandatory and
 *                  says how. The permission gate does not run.
 *   service        gated by a permission service, exactly like the entries of
 *                  ROUTE_PREFIXES: GET/HEAD/OPTIONS need `read`, other methods
 *                  `write` (`admin` on adminService services). `level`
 *                  overrides the required level of that route.
 *
 * Effective declaration of a request = the explicit `config.authz`, else the
 * ROUTE_PREFIXES / resolver mapping of its path (a `service` declaration), else
 * UNDECLARED. In legacy and shadow mode only the service part is enforced
 * (undeclared / authenticated / public / self routes behave exactly as before,
 * except that an explicit `service` declaration is now enforced on routes that
 * ROUTE_PREFIXES does not map). In enforce mode all kinds are honoured and an
 * undeclared route is refused with 403 `route_not_declared`.
 *
 * This file is imported by every plugin, so it only depends on rbac.ts (types
 * and the path map) and never on the engine, the database or Cedar.
 */

import {
  getPermissionServiceForPath,
  getServiceDefinition,
  isPermissionService,
  isServicePermissionLevel,
  type PermissionService,
  type ServicePermissionLevel,
} from '@/lib/security/rbac';

export const ROUTE_AUTHZ_KINDS = ['public', 'authenticated', 'self', 'service'] as const;
export type RouteAuthzKind = typeof ROUTE_AUTHZ_KINDS[number];

/** A level a route can require (never `none`). */
export type RouteAuthzLevel = Exclude<ServicePermissionLevel, 'none'>;

export type RouteAuthz =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'self'; reason: string }
  | { kind: 'service'; service: PermissionService; level?: RouteAuthzLevel };

/** The fragment that goes into a Fastify route's `config`. */
export interface RouteAuthzConfig {
  authz: RouteAuthz;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** How this route is authorized (see src/lib/iam/routeAuthz.ts). */
    authz?: RouteAuthz;
  }
}

/**
 * Declaration helpers. Each returns a `config` fragment, so they compose with
 * other route config: `{ config: { ...authz.service('rag'), rawBody: true } }`.
 * Misuse (unknown service, `self` without a reason) throws while the plugin is
 * registered, i.e. at boot, never at request time.
 */
export const authz = {
  public(): RouteAuthzConfig {
    return { authz: { kind: 'public' } };
  },
  authenticated(): RouteAuthzConfig {
    return { authz: { kind: 'authenticated' } };
  },
  self(reason: string): RouteAuthzConfig {
    if (typeof reason !== 'string' || reason.trim().length < 8) {
      throw new Error("authz.self(reason) needs a reason (>= 8 characters) saying how the handler authenticates the caller");
    }
    return { authz: { kind: 'self', reason: reason.trim() } };
  },
  service(service: PermissionService, level?: RouteAuthzLevel): RouteAuthzConfig {
    if (!isPermissionService(service)) {
      throw new Error(`authz.service(): unknown permission service "${String(service)}"`);
    }
    if (level !== undefined) {
      if (!isServicePermissionLevel(level) || (level as string) === 'none') {
        throw new Error(`authz.service(): invalid level "${String(level)}" (use read, write or admin)`);
      }
      // A mutation on an adminService service already needs `admin`, so a lower
      // `write` override cannot be expressed by the policy engine's action model.
      if (level === 'write' && getServiceDefinition(service).adminService) {
        throw new Error(`authz.service(): level "write" is not expressible on the admin service "${service}"`);
      }
    }
    return { authz: level ? { kind: 'service', service, level } : { kind: 'service', service } };
  },
} as const;

/** Defensive parse of whatever sits in `routeOptions.config.authz` (a bad value is "undeclared"). */
export function readRouteAuthz(config: unknown): RouteAuthz | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const raw = (config as { authz?: unknown }).authz;
  if (!raw || typeof raw !== 'object') return undefined;
  const decl = raw as Record<string, unknown>;
  switch (decl.kind) {
    case 'public':
      return { kind: 'public' };
    case 'authenticated':
      return { kind: 'authenticated' };
    case 'self':
      return typeof decl.reason === 'string' && decl.reason ? { kind: 'self', reason: decl.reason } : undefined;
    case 'service': {
      if (!isPermissionService(decl.service)) return undefined;
      if (decl.level === undefined) return { kind: 'service', service: decl.service };
      if (!isServicePermissionLevel(decl.level) || decl.level === 'none') return undefined;
      return { kind: 'service', service: decl.service, level: decl.level as RouteAuthzLevel };
    }
    default:
      return undefined;
  }
}

export type EffectiveRouteAuthz =
  | { kind: 'public'; declared: true }
  | { kind: 'authenticated'; declared: true }
  | { kind: 'self'; declared: true; reason: string }
  | { kind: 'service'; declared: boolean; service: PermissionService; level?: RouteAuthzLevel }
  | { kind: 'undeclared' };

export interface RouteAuthzResolution {
  /** The explicit declaration on the route, if any. */
  declaration: RouteAuthz | undefined;
  /** What ROUTE_PREFIXES / resolvers say about the request path. */
  prefixService: PermissionService | null;
  /**
   * What the LEGACY gate enforces: an explicit `service` declaration, else the
   * path map. Everything else is "not a gated surface" there, as before.
   */
  legacy: { service: PermissionService; level?: RouteAuthzLevel } | null;
  /** What ENFORCE mode decides on. */
  effective: EffectiveRouteAuthz;
}

/** Resolve the declaration for a request. `config` is `request.routeOptions.config`. */
export function resolveRouteAuthz(config: unknown, pathname: string): RouteAuthzResolution {
  const declaration = readRouteAuthz(config);
  const prefixService = getPermissionServiceForPath(pathname);

  let legacy: RouteAuthzResolution['legacy'] = null;
  if (declaration?.kind === 'service') {
    legacy = declaration.level
      ? { service: declaration.service, level: declaration.level }
      : { service: declaration.service };
  } else if (prefixService) {
    legacy = { service: prefixService };
  }

  let effective: EffectiveRouteAuthz;
  if (declaration?.kind === 'service') {
    effective = {
      kind: 'service',
      declared: true,
      service: declaration.service,
      ...(declaration.level ? { level: declaration.level } : {}),
    };
  } else if (declaration) {
    effective = declaration.kind === 'self'
      ? { kind: 'self', declared: true, reason: declaration.reason }
      : { kind: declaration.kind, declared: true };
  } else if (prefixService) {
    effective = { kind: 'service', declared: false, service: prefixService };
  } else {
    effective = { kind: 'undeclared' };
  }
  return { declaration, prefixService, legacy, effective };
}

/** The permission service of a request for audit/RBAC purposes (declared service wins over the path map). */
export function serviceForRequest(config: unknown, pathname: string): PermissionService | null {
  return resolveRouteAuthz(config, pathname).legacy?.service ?? null;
}

// ── gate marker ──────────────────────────────────────────────────────────────

/**
 * The permission gate (service permissions, enforce-mode undeclared refusal) runs
 * INSIDE withApiRequestContext / withClientApiRequestContext, not as a Fastify
 * hook. A route that declares `authz.service(...)` (or is prefix-mapped) but is
 * registered with a bare handler is therefore not gated at all, in any mode. The
 * wrappers tag the function they return with this marker so the CI guard
 * (unit/iam-route-declarations) can tell, and fail, when such a route is not on
 * its explicit allowlist (routes that authenticate and authorize themselves).
 */
export const GATED_HANDLER = Symbol.for('cognipeer.iam.gatedHandler');

/** Tag a request handler as running the permission gate. Returns the same function. */
export function markGated<T extends (...args: never[]) => unknown>(handler: T): T {
  Object.defineProperty(handler, GATED_HANDLER, { value: true, enumerable: false });
  return handler;
}

export function isGatedHandler(handler: unknown): boolean {
  return typeof handler === 'function' && (handler as unknown as Record<symbol, unknown>)[GATED_HANDLER] === true;
}

