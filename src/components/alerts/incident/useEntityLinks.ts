'use client';

import { useEntityLinkLookup, type EntityRef } from '@/lib/api/queries/alerts';
import { entityLinkKey } from '../alertCatalog';

export type { EntityRef };

/**
 * Where the entities on screen live (`POST /alerts/entities/links`): models, MCP servers and tools are
 * addressed by record id, which only the server can look up. Feed the result to `entityHref(type, key, links)`.
 * Until it answers (or when it fails) the built-in guess for agents and knowledge bases still applies.
 */
export function useEntityLinks(entities: EntityRef[], projectId?: string): Record<string, string | null> {
  return useEntityLinkLookup(entities, projectId, entityLinkKey);
}
