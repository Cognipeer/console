/**
 * Enterprise API access guard (runtime gate, layer 2).
 *
 * Maps an incoming API path to the enterprise module that owns it and decides
 * whether the caller's effective license may use it. This lives in the
 * COMMUNITY core on purpose: the enterprise overlay inherits it unchanged, so a
 * single place enforces per-tenant licensing in BOTH editions.
 *
 * In the community edition the enterprise routes do not exist (they were
 * extracted), so this guard is effectively a no-op there — the routes 404
 * before any handler runs. In the enterprise edition it turns a FREE tenant
 * hitting an enterprise route into a clean 402, instead of silently serving it.
 *
 * Adding a newly-split module = add ONE entry to ENTERPRISE_API_RULES.
 */
import { LicenseManager, isEnterpriseLicenseType, type LicenseType } from './license-manager';

export interface EnterpriseApiRule {
  /** Enterprise module id (matches platform-services.json `enterpriseModule`). */
  module: string;
  /** Path prefixes (under `/api`) that belong to this module's admin surface. */
  prefixes: string[];
  /**
   * Sub-paths that must stay reachable WITHOUT an enterprise license — e.g.
   * machine-to-machine / self-serve endpoints. (Most are already public or
   * self-auth and never reach this guard; listed here as defence-in-depth.)
   */
  exemptPrefixes?: string[];
}

/**
 * Source of truth for which session/admin API surface is enterprise-gated.
 * Keep prefixes coarse — every gpu-pool / gpu-terminal route lives under
 * `/api/gpu-fleet/`, every cluster admin route under `/api/cluster/`, etc.
 */
export const ENTERPRISE_API_RULES: EnterpriseApiRule[] = [
  {
    module: 'gpu-fleet',
    prefixes: ['/api/gpu-fleet/'],
    // installer.sh + agent-bundle are public (handled in plugin.ts), agents
    // self-auth under /api/gpu/agent/. Belt-and-suspenders:
    exemptPrefixes: ['/api/gpu-fleet/installer.sh', '/api/gpu-fleet/agent-bundle/'],
  },
  {
    module: 'sandbox',
    prefixes: ['/api/sandbox/'],
    exemptPrefixes: ['/api/sandbox/agent/'],
  },
  {
    module: 'cluster',
    prefixes: ['/api/cluster/'],
  },
  {
    module: 'prompt-optimizer',
    prefixes: ['/api/prompt-optimizer/'],
  },
  {
    // LDAP directory integration: the admin CONFIG surface is enterprise-gated.
    // The login path itself is /auth/login (not under /api/ldap), so it is never
    // gated here — authentication must work to issue a session. A non-enterprise
    // tenant therefore cannot configure LDAP (402), and with no config the
    // external-auth seam simply skips to local password.
    module: 'ldap',
    prefixes: ['/api/ldap/'],
  },
  {
    // Realtime voice/chat: admin model CRUD under /api/realtime, client session
    // surface under /api/client/v1/realtime. The websocket upgrade itself is
    // public (auth handled in-handler), so it never reaches this guard; the
    // HTTP CRUD + REST endpoints are gated here.
    module: 'realtime',
    prefixes: ['/api/realtime/', '/api/client/v1/realtime/'],
  },
];

export interface EnterpriseDenial {
  status: number;
  body: {
    error: string;
    message: string;
    module: string;
    requiresEnterprise: true;
  };
}

/** Returns the enterprise module owning `pathname`, or null if not gated. */
export function getEnterpriseModuleForPath(pathname: string): string | null {
  for (const rule of ENTERPRISE_API_RULES) {
    if (rule.exemptPrefixes?.some((p) => pathname === p || pathname.startsWith(p))) {
      continue;
    }
    if (rule.prefixes.some((p) => pathname === p || pathname.startsWith(p))) {
      return rule.module;
    }
  }
  return null;
}

/**
 * The per-request decision. Returns a denial when the path is enterprise-gated
 * and the effective license is not an active ENTERPRISE license, or null when
 * the request may proceed.
 *
 * Always enforced. In the community edition the gated routes do not exist
 * (404 before this guard), so this only ever bites in the enterprise edition,
 * where a tenant unlocks the modules via /dashboard/license.
 */
export function checkEnterpriseApiAccess(
  pathname: string,
  effectiveLicenseType: LicenseType | string | undefined,
  expiresAt?: Date | string | number | null,
): EnterpriseDenial | null {
  const enterpriseModule = getEnterpriseModuleForPath(pathname);
  if (!enterpriseModule) {
    return null;
  }
  // buildSessionHeaders already collapses an expired license to FREE, so the
  // type check usually suffices; isEnterpriseActive re-checks expiry+grace when
  // a caller passes the raw type+expiry.
  const allowed = expiresAt === undefined
    ? isEnterpriseLicenseType(effectiveLicenseType)
    : LicenseManager.isEnterpriseActive(effectiveLicenseType, expiresAt);
  if (allowed) {
    return null;
  }
  return {
    status: 402,
    body: {
      error: 'Payment Required',
      message: `The "${enterpriseModule}" module requires an active ENTERPRISE license.`,
      module: enterpriseModule,
      requiresEnterprise: true,
    },
  };
}
