/**
 * Aggregates the community resource-type groups and registers them once.
 * Each group file owns its own types so parallel work never edits a shared file.
 */
import { getEnterpriseResourceContributions } from '@/enterprise/resource-providers';
import { registerResourceTypes, getResourceTypeDefinition } from '../registry';
import { registerEdgeKindDefinitions } from '../references';
import type { ResourceTypeDefinition } from '../types';
import { coreResourceTypes } from './core';
import { agentsExtraResourceTypes } from './agentsExtra';
import { knowledgeResourceTypes } from './knowledge';
import { modelsSafetyResourceTypes } from './modelsSafety';
import { qualityResourceTypes } from './quality';
import { operationsResourceTypes } from './operations';

export const communityResourceTypes: ResourceTypeDefinition[] = [
  ...coreResourceTypes,
  ...agentsExtraResourceTypes,
  ...knowledgeResourceTypes,
  ...modelsSafetyResourceTypes,
  ...qualityResourceTypes,
  ...operationsResourceTypes,
];

let registered = false;

/**
 * Registers the community types once, and folds in whatever the enterprise
 * overlay has contributed (src/enterprise/resource-providers.ts). The enterprise
 * part runs on every call (a handful of map lookups) so a contribution that was
 * registered after the first request is still picked up. Idempotent.
 */
export function ensureCommunityResourceTypesRegistered(): void {
  if (!registered) {
    registerResourceTypes(communityResourceTypes);
    registered = true;
  }
  const enterprise = getEnterpriseResourceContributions();
  // Edge kinds first: an extractor needs its kinds when the types list.
  registerEdgeKindDefinitions(enterprise.edgeKinds);
  const fresh = enterprise.types.filter((def) => !getResourceTypeDefinition(def.type));
  if (fresh.length > 0) registerResourceTypes(fresh);
}

/** Test seam (pair with resetResourceRegistryForTests). */
export function resetCommunityRegistrationForTests(): void {
  registered = false;
}
