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
 *                  overrides the required level of that route. `anyOf` names
 *                  more services for a route that serves the resources of
 *                  several (`/responses`: models and agents): a holder of ANY of
 *                  them passes the gate, and the handler authorizes the
 *                  resource it resolved (authorizeServiceForRequest).
 *                  `service` stays the route's owner (path map, audit).
 *
 * Effective declaration of a request = the explicit `config.authz`, else the
 * ROUTE_PREFIXES / resolver mapping of its path (a `service` declaration), else
 * UNDECLARED. The gate decides on it: a `service` route goes to the policy
 * engine, `authenticated` admits any signed-in principal of the tenant,
 * `public` / `self` skip the gate (the handler is responsible), and an
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
  | { kind: 'service'; service: PermissionService; level?: RouteAuthzLevel; anyOf?: PermissionService[] };

/** The fragment that goes into a Fastify route's `config`. */
export interface RouteAuthzConfig {
  authz: RouteAuthz;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** How this route is authorized (see src/lib/iam/routeAuthz.ts). */
    authz?: RouteAuthz;
    /**
     * A POST that only computes (compile / preview / simulate in the Authorization
     * center): a successful call is not an administrative event, so the audit hook
     * skips it. Refusals and errors are still audited.
     */
    skipAuditOnSuccess?: boolean;
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
  /** A route serving several services' resources; the first is its owner (see `anyOf` above). */
  serviceAnyOf(services: readonly [PermissionService, PermissionService, ...PermissionService[]], level?: RouteAuthzLevel): RouteAuthzConfig {
    for (const service of services) authz.service(service, level); // the same checks, per service
    if (new Set(services).size !== services.length) {
      throw new Error('authz.serviceAnyOf(): a service is named twice');
    }
    const [service, ...anyOf] = services;
    return { authz: level ? { kind: 'service', service, level, anyOf } : { kind: 'service', service, anyOf } };
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
      let anyOf: PermissionService[] | undefined;
      if (decl.anyOf !== undefined) {
        const others = decl.anyOf;
        if (!Array.isArray(others) || others.length === 0 || !others.every(isPermissionService)
          || new Set([decl.service, ...others]).size !== others.length + 1) return undefined;
        anyOf = [...others];
      }
      const extra = anyOf ? { anyOf } : {};
      if (decl.level === undefined) return { kind: 'service', service: decl.service, ...extra };
      if (!isServicePermissionLevel(decl.level) || decl.level === 'none') return undefined;
      return { kind: 'service', service: decl.service, level: decl.level as RouteAuthzLevel, ...extra };
    }
    default:
      return undefined;
  }
}

export type EffectiveRouteAuthz =
  | { kind: 'public'; declared: true }
  | { kind: 'authenticated'; declared: true }
  | { kind: 'self'; declared: true; reason: string }
  | { kind: 'service'; declared: boolean; service: PermissionService; level?: RouteAuthzLevel; anyOf?: PermissionService[] }
  | { kind: 'undeclared' };

export interface RouteAuthzResolution {
  /** The explicit declaration on the route, if any. */
  declaration: RouteAuthz | undefined;
  /** What ROUTE_PREFIXES / resolvers say about the request path. */
  prefixService: PermissionService | null;
  /** What the gate decides on. */
  effective: EffectiveRouteAuthz;
}

/** Resolve the declaration for a request. `config` is `request.routeOptions.config`. */
export function resolveRouteAuthz(config: unknown, pathname: string): RouteAuthzResolution {
  const declaration = readRouteAuthz(config);
  const prefixService = getPermissionServiceForPath(pathname);

  let effective: EffectiveRouteAuthz;
  if (declaration?.kind === 'service') {
    effective = {
      kind: 'service',
      declared: true,
      service: declaration.service,
      ...(declaration.level ? { level: declaration.level } : {}),
      ...(declaration.anyOf ? { anyOf: declaration.anyOf } : {}),
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
  return { declaration, prefixService, effective };
}

/**
 * The permission service of a request for audit purposes: an explicit `service`
 * declaration wins, else the path map. (A route declared `self` / `authenticated`
 * that sits under a mapped prefix still audits as that service.)
 */
export function serviceForRequest(config: unknown, pathname: string): PermissionService | null {
  const { declaration, prefixService } = resolveRouteAuthz(config, pathname);
  return declaration?.kind === 'service' ? declaration.service : prefixService;
}

// ── gate marker ──────────────────────────────────────────────────────────────

/**
 * The permission gate (service permissions, the undeclared-route refusal) runs
 * INSIDE withApiRequestContext / withClientApiRequestContext, not as a Fastify
 * hook. A route that declares `authz.service(...)` (or is prefix-mapped) but is
 * registered with a bare handler is therefore not gated at all. The
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

