/**
 * Messaging deployment facts seam for the policy engine — COMMUNITY (open-source) edition.
 *
 * A channel deployment (an enterprise feature) lets chosen people and groups talk to one agent from Slack or
 * Microsoft Teams. Who may, is decided by the policy engine from the deployment's access list (managed policies
 * `managed:messaging:*`), so the engine, the Access check and the policy editor have to be able to read that list
 * WITHOUT the community core depending on any enterprise code. The resource registry does not carry it on purpose
 * (an inventory entry is not an access list).
 *
 * Contract:
 *   - Nothing is registered in the community edition: `resolveIamMessagingDeployment` answers null, the
 *     messaging rules are reported as not enforced.
 *   - The overlay calls `registerIamMessagingResolver(...)` once at load, from its `registry.ts`. This is a separate
 *     community file (NOT replaced by the overlay), so the `registry.ts` seam shape and SEAM_CONTRACT_VERSION do not
 *     change because of it.
 *   - The resolver reads the deployment of THIS workspace only (the tenant is passed in, never taken from the
 *     deployment id) and returns what the access list says now: the engine adds no cache of its own.
 *
 * Leaf module on purpose: no imports besides the logger, so the overlay registry can import it at load time without
 * creating a cycle.
 */
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('iam:messaging-seam');

/** A deployment's access list, as the channels feature stores it. */
export interface IamMessagingAccessFacts {
  /** `all`: everyone in the workspace. `selected`: the people and groups below (none listed = nobody). */
  mode: 'all' | 'selected';
  userIds: string[];
  groupIds: string[];
}

/** Everything the engine and the Access check need to know about one deployment of an agent on a Slack / Teams connection. */
export interface IamMessagingDeploymentFacts {
  id: string;
  connectionId: string;
  name: string;
  status: 'enabled' | 'disabled';
  /** The agent the deployment runs: its registry/agent id, its key and its project. */
  agent: { id: string; key: string; projectId: string };
  access: IamMessagingAccessFacts;
}

export interface IamMessagingTenant {
  tenantDbName: string;
  tenantId: string;
}

export type IamMessagingResolver = (tenant: IamMessagingTenant, deploymentId: string) => Promise<IamMessagingDeploymentFacts | null>;

let resolver: IamMessagingResolver | null = null;

/** The overlay registers its resolver once at load; `null` clears it (tests). A later registration replaces the earlier one. */
export function registerIamMessagingResolver(fn: IamMessagingResolver | null): void {
  resolver = fn;
}

/** True when this build has Slack / Teams channels (the enterprise overlay registered its resolver). */
export function hasIamMessagingResolver(): boolean {
  return resolver !== null;
}

/**
 * The deployment of this workspace, or null when there is none, when this build has no channels, or when the resolver
 * failed (the failure is logged: the caller reports a deployment it cannot find, it never guesses one).
 */
export async function resolveIamMessagingDeployment(
  tenant: IamMessagingTenant,
  deploymentId: string,
): Promise<IamMessagingDeploymentFacts | null> {
  if (!resolver) return null;
  try {
    return (await resolver(tenant, deploymentId)) ?? null;
  } catch (error) {
    logger.warn('The messaging resolver failed', { deploymentId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
