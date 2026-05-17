/**
 * Instance Assignment Store
 *
 * Per-instance routing: which node should run a given entity instance
 * (agent, mcp server, browser, ...). Empty assignment falls back to the
 * cluster default node.
 *
 * Reads are cached for short TTL to avoid hammering the DB on hot paths
 * (agent execution, browser action). Writes invalidate the cache.
 */

import { createLogger } from '../logger';
import { getDatabase, type IInstanceAssignment, type InstanceEntityType } from '@/lib/database';
import { resolveDefaultNodeName } from './defaultNode';

const log = createLogger('cluster.instance-assignment');

const CACHE_TTL_MS = 5_000;

interface CacheEntry {
  value: IInstanceAssignment | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(entityType: InstanceEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function getCached(entityType: InstanceEntityType, entityId: string): CacheEntry | undefined {
  const entry = cache.get(cacheKey(entityType, entityId));
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(cacheKey(entityType, entityId));
    return undefined;
  }
  return entry;
}

function setCached(
  entityType: InstanceEntityType,
  entityId: string,
  value: IInstanceAssignment | null,
): void {
  cache.set(cacheKey(entityType, entityId), {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function invalidate(entityType: InstanceEntityType, entityId: string): void {
  cache.delete(cacheKey(entityType, entityId));
}

export async function findInstanceAssignment(
  entityType: InstanceEntityType,
  entityId: string,
): Promise<IInstanceAssignment | null> {
  const cached = getCached(entityType, entityId);
  if (cached) return cached.value;

  const db = await getDatabase();
  const value = await db.findInstanceAssignment(entityType, entityId);
  setCached(entityType, entityId, value);
  return value;
}

/**
 * Resolve effective placement for an instance.
 *
 * Returns the assigned node name, or the cluster default if no
 * explicit assignment exists. `mode` defaults to 'preferred' when
 * no assignment is set so a missing/offline default does not break
 * the system.
 */
export async function resolveInstancePlacement(
  entityType: InstanceEntityType,
  entityId: string,
): Promise<{ nodeName: string; mode: IInstanceAssignment['mode']; explicit: boolean }> {
  const assignment = await findInstanceAssignment(entityType, entityId);
  if (assignment) {
    return { nodeName: assignment.nodeName, mode: assignment.mode, explicit: true };
  }
  const defaultName = await resolveDefaultNodeName();
  return { nodeName: defaultName, mode: 'preferred', explicit: false };
}

export async function setInstanceAssignment(input: {
  entityType: InstanceEntityType;
  entityId: string;
  nodeName: string;
  mode?: IInstanceAssignment['mode'];
  updatedBy?: string | null;
}): Promise<IInstanceAssignment> {
  const db = await getDatabase();
  const stored = await db.setInstanceAssignment({
    entityType: input.entityType,
    entityId: input.entityId,
    nodeName: input.nodeName,
    mode: input.mode ?? 'strict',
    updatedBy: input.updatedBy ?? null,
  });
  invalidate(input.entityType, input.entityId);
  log.info('Instance assignment updated', {
    entityType: input.entityType,
    entityId: input.entityId,
    nodeName: input.nodeName,
    mode: stored.mode,
  });
  return stored;
}

export async function deleteInstanceAssignment(
  entityType: InstanceEntityType,
  entityId: string,
): Promise<boolean> {
  const db = await getDatabase();
  const ok = await db.deleteInstanceAssignment(entityType, entityId);
  invalidate(entityType, entityId);
  return ok;
}

export async function listInstanceAssignments(filters: {
  entityType?: InstanceEntityType;
  nodeName?: string;
} = {}): Promise<IInstanceAssignment[]> {
  const db = await getDatabase();
  return db.listInstanceAssignments(filters);
}

export function clearInstanceAssignmentCache(): void {
  cache.clear();
}
