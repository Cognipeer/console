/**
 * Aggregates the community resource-type groups and registers them once.
 * Each group file owns its own types so parallel work never edits a shared file.
 */
import { registerResourceTypes } from '../registry';
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

/** Idempotent: the first call registers, later calls are no-ops. */
export function ensureCommunityResourceTypesRegistered(): void {
  if (registered) return;
  registerResourceTypes(communityResourceTypes);
  registered = true;
}

/** Test seam (pair with resetResourceRegistryForTests). */
export function resetCommunityRegistrationForTests(): void {
  registered = false;
}
