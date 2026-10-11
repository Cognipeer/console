/**
 * Portal facts seam for the policy engine — COMMUNITY (open-source) edition.
 *
 * A portal (an enterprise feature) lets chosen people and groups use chosen
 * agents. Who may open it, and run its agents, is decided by the policy engine from
 * the portal's access list (managed policies `managed:portal:*`), so the engine,
 * the Access check and the policy editor have to be able to read that list WITHOUT
 * the community core depending on any enterprise code. The resource registry does
 * not carry it on purpose (an inventory entry is not an access list).
 *
 * Contract:
 *   - Nothing is registered in the community edition: `resolveIamPortal` answers
 *     null, the portal rules are reported as not enforced and the Access check
 *     says there is no such portal.
 *   - The overlay calls `registerIamPortalResolver(...)` once at load, from its
 *     `registry.ts`. This is a separate community file (NOT replaced by the
 *     overlay), so the `registry.ts` seam shape and SEAM_CONTRACT_VERSION do not
 *     change because of it.
 *   - The resolver reads the portal of THIS workspace only (the tenant is passed in,
 *     never taken from the portal id) and returns what the access list says now:
 *     the engine adds no cache of its own.
 *
 * Leaf module on purpose: no imports besides the logger, so the overlay registry
 * can import it at load time without creating a cycle.
 */
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('iam:portal-seam');

/** A portal's access list, as the portal feature stores it. */
export interface IamPortalAccessFacts {
  /** `all`: everyone in the workspace. `selected`: the people and groups below (none listed = nobody). */
  mode: 'all' | 'selected';
  userIds: string[];
  groupIds: string[];
  /**
   * The networks the portal may be used from (`access.networks`). Absent or `any` = no boundary; `allow_list` admits
   * only requests whose address is inside one of the ranges (an empty list admits nobody). See lib/iam/portalNetworks.ts.
   */
  networks?: { mode: 'any' | 'allow_list'; cidrs: string[] };
  /**
   * What the access list means for people who arrive through the portal's embed with an identity the host application
   * signed (`access.embedded`): `access_list` (the default; they must be on the list like everybody else) or
   * `any_verified` (every person whose token the portal verified is admitted).
   */
  embedded?: 'access_list' | 'any_verified';
}

/** Everything the engine and the Access check need to know about one portal. */
export interface IamPortalFacts {
  id: string;
  key: string;
  name: string;
  status: 'enabled' | 'disabled';
  access: IamPortalAccessFacts;
  /** Registry ids (the agent resource ids) of the agents the portal offers. */
  agentIds: string[];
}

export interface IamPortalTenant {
  tenantDbName: string;
  tenantId: string;
}

export type IamPortalResolver = (tenant: IamPortalTenant, portalId: string) => Promise<IamPortalFacts | null>;

let resolver: IamPortalResolver | null = null;

/** The overlay registers its resolver once at load; `null` clears it (tests). A later registration replaces the earlier one. */
export function registerIamPortalResolver(fn: IamPortalResolver | null): void {
  resolver = fn;
}

/** True when this build has portals (the enterprise overlay registered its resolver). */
export function hasIamPortalResolver(): boolean {
  return resolver !== null;
}

/**
 * The portal of this workspace, or null when there is none, when this build has no
 * portals, or when the resolver failed (the failure is logged: the caller reports a
 * portal it cannot find, it never guesses one).
 */
export async function resolveIamPortal(tenant: IamPortalTenant, portalId: string): Promise<IamPortalFacts | null> {
  if (!resolver) return null;
  try {
    return (await resolver(tenant, portalId)) ?? null;
  } catch (error) {
    logger.warn('The portal resolver failed', { portalId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
