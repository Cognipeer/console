/**
 * Where an alert's entity lives in the console.
 *
 * Core pages: agents (tracing), knowledge bases (by key), models, MCP servers
 * and tools (by record id, found from the entity key). The enterprise overlay
 * may register a resolver (`registerEntityLinkResolver`) that answers with its
 * own health pages first; whatever it does not know falls back to the core page.
 */

import type { DatabaseProvider, EntityMetricType } from '@/lib/database';
import { getEntityLinkResolver } from '@/enterprise/alert-extensions';

/** Core management page of an entity that is already known by record id (or key, for agents and KBs). */
export function coreEntityPath(entityType: EntityMetricType | string | null | undefined, keyOrId: string): string | null {
  if (!keyOrId) return null;
  const part = encodeURIComponent(keyOrId);
  switch (entityType) {
    case 'agent': return `/dashboard/tracing/agents/${part}`;
    case 'kb': return `/dashboard/rag/${part}`;
    case 'model': return `/dashboard/models/${part}`;
    case 'mcp': return `/dashboard/mcp/${part}`;
    case 'tool': return `/dashboard/agents/tools/${part}`;
    default: return null;
  }
}

/** The record id behind a model / MCP server / tool key; null when the entity has no console record (traces-only models and tools). */
async function recordIdOf(
  db: Pick<DatabaseProvider, 'findModelByKey' | 'findMcpServerByKey' | 'findToolByKey'>,
  projectId: string,
  entityType: EntityMetricType,
  key: string,
): Promise<string | null> {
  const record = entityType === 'model'
    ? await db.findModelByKey(key, projectId)
    : entityType === 'mcp'
      ? await db.findMcpServerByKey(key, projectId)
      : await db.findToolByKey(key, projectId);
  return record?._id ? String(record._id) : null;
}

/**
 * Path (no origin) of the entity's page, or null when there is none. Best
 * effort: a failing lookup or resolver reads as "no link".
 */
export async function resolveEntityPath(
  db: Pick<DatabaseProvider, 'findModelByKey' | 'findMcpServerByKey' | 'findToolByKey'>,
  projectId: string,
  entityType: EntityMetricType,
  entityKey: string,
): Promise<string | null> {
  if (!entityKey) return null;
  try {
    const custom = getEntityLinkResolver();
    if (custom) {
      const path = custom(entityType, entityKey);
      if (path) return path;
    }
    if (entityType === 'agent' || entityType === 'kb') return coreEntityPath(entityType, entityKey);
    if (entityType === 'model' || entityType === 'mcp' || entityType === 'tool') {
      const id = await recordIdOf(db, projectId, entityType, entityKey);
      return id ? coreEntityPath(entityType, id) : null;
    }
    return null;
  } catch {
    return null;
  }
}
