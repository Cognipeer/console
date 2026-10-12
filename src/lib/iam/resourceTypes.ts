/**
 * Resource types the policy engine knows about = the resource registry
 * (community + whatever the enterprise overlay contributed) plus the always
 * present extras. The registry is populated lazily, so this ensures the
 * community registration first, exactly like the resource service does.
 */

import { ensureCommunityResourceTypesRegistered } from '@/lib/resources/providers';
import { listResourceTypeDefinitions } from '@/lib/resources/registry';
import { withExtraResourceTypes, type CatalogResourceType } from './actions';

export function listIamResourceTypes(): CatalogResourceType[] {
  try {
    ensureCommunityResourceTypesRegistered();
  } catch {
    // Registration problems must not take the engine down: fall back to
    // whatever is registered (possibly nothing) plus the extras.
  }
  return withExtraResourceTypes(
    listResourceTypeDefinitions().map((def) => ({ type: def.type, service: def.service })),
  );
}
