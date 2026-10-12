/**
 * Resource registry seam — COMMUNITY (open-source) edition.
 *
 * Lets the enterprise overlay add resource types (sandbox templates, GPU hosts,
 * ...) and the edge kinds that connect them to the Resource Registry WITHOUT the
 * community core depending on any enterprise code.
 *
 * Contract:
 *   - Nothing is registered in the community edition: the contributions are
 *     empty and the registry is exactly the community one.
 *   - The overlay calls `registerEnterpriseResources(...)` once at load, from its
 *     `registry.ts`. This is a separate community file (NOT replaced by the
 *     overlay), so the `registry.ts` seam shape and SEAM_CONTRACT_VERSION do not
 *     change.
 *   - The registry service picks the contributions up every time it ensures its
 *     registrations (`ensureCommunityResourceTypesRegistered`), so a contribution
 *     that arrives after the first request is still seen.
 *
 * Leaf module on purpose: only TYPE imports from the resource library, so the
 * overlay registry can import this at load time without creating a cycle.
 */
import { createLogger } from '@/lib/core/logger';
import type { EdgeKindDefinition } from '@/lib/resources/references';
import type { ResourceTypeDefinition } from '@/lib/resources/types';

const logger = createLogger('resources:enterprise');

export interface EnterpriseResourceContribution {
  types?: ResourceTypeDefinition[];
  edgeKinds?: EdgeKindDefinition[];
}

const types = new Map<string, ResourceTypeDefinition>();
const edgeKinds = new Map<string, EdgeKindDefinition>();

/**
 * Idempotent per type id and per edge kind: the first registration wins, a later
 * duplicate is ignored (with a debug log), so the overlay can call this on every
 * hot reload or from several modules.
 */
export function registerEnterpriseResources(contribution: EnterpriseResourceContribution): void {
  for (const def of contribution.types ?? []) {
    if (types.has(def.type)) {
      logger.debug('Ignoring duplicate enterprise resource type', { type: def.type });
      continue;
    }
    types.set(def.type, def);
  }
  for (const def of contribution.edgeKinds ?? []) {
    if (edgeKinds.has(def.kind)) {
      logger.debug('Ignoring duplicate enterprise resource edge kind', { kind: def.kind });
      continue;
    }
    edgeKinds.set(def.kind, def);
  }
}

export function getEnterpriseResourceContributions(): {
  types: ResourceTypeDefinition[];
  edgeKinds: EdgeKindDefinition[];
} {
  return { types: [...types.values()], edgeKinds: [...edgeKinds.values()] };
}

/** Test seam. */
export function resetEnterpriseResourcesForTests(): void {
  types.clear();
  edgeKinds.clear();
}
