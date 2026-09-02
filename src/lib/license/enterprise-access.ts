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
  {
    // Usage reports powering the overview dashboard's service-report cards.
    module: 'reports',
    prefixes: ['/api/reports/'],
  },
  // NOTE: there is deliberately NO rule for the guardrail hook plane (the old
  // 'aegis' enforcement module, whose `/api/aegis/*` prefixes lived here). The
  // whole enforcement surface — hooks, tool policy, webhook checks, streaming
  // gates — is COMMUNITY, so a FREE tenant must reach it. Re-adding an entry
  // for `/api/guardrails/` or `/api/aegis/` would 402 every free tenant on
  // functionality they are entitled to; RBAC (the `guardrails` service) is the
  // only gate that applies.
  {
    // Cost & Optimization: spend attribution, the deterministic analysis
    // workbench, automated prescriptions, the pricing catalog and reports.
    // `/api/prescriptions` is a separate prefix but the same product module —
    // RBAC already maps it to the `cost` service.
    module: 'cost',
    prefixes: ['/api/cost/', '/api/prescriptions'],
  },
  {
    // Abacus cost intelligence: what-if repricing + optimization recommendations.
    module: 'abacus',
    prefixes: ['/api/abacus/'],
  },
  {
    // MCP Hubs: curated MCP-server catalogs published as a discovery API.
    // Gates the admin CRUD + the token discovery surface. The public surface
    // (/api/public/mcp/hubs/) never reaches this guard — the plugin checks
    // the owning tenant's license in-handler.
    module: 'mcp-hub',
    prefixes: ['/api/mcp/hubs', '/api/client/v1/mcp/hubs'],
  },
  {
    // AI App Gateway: the control plane for coding agents (Claude Code, Codex,
    // Copilot, Cursor). Only the FIRST prefix is actually enforced here — the
    // admin CRUD surface is a cookie-session path, so it reaches the guard in
    // plugin.ts. The other two are listed for discoverability and
    // defence-in-depth but are NEVER evaluated: the onRequest hook returns for
    // `/api/client/*` (bearer branch) and for `/api/appgw/*` (contributed to
    // enterprisePublicApiPrefixes by the overlay) before the guard runs. Those
    // two surfaces check the license in-handler instead — see the overlay's
    // aiAppGateway/licenseGuard.ts, modelled on public-mcp-hubs.ts.
    module: 'ai-app-gateway',
    prefixes: ['/api/ai-app-gateway/', '/api/client/v1/ai-app-gateway/', '/api/appgw/'],
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
