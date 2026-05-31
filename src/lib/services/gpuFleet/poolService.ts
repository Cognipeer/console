/**
 * LLM pool service.
 *
 * A pool fronts N deployments of the same model with a single
 * OpenAI-compatible endpoint at /api/internal/gpu-pool/<poolKey>/v1/*.
 * Members are kept up to date by `attachDeploymentToPool` /
 * `detachDeploymentFromPool`, normally called by the event ingestor when
 * deployments flip healthy/unhealthy.
 */

import slugify from 'slugify';
import { createLogger } from '@/lib/core/logger';
import {
  getDatabase,
  type ILlmDeployment,
  type ILlmPool,
  type LlmPoolAlgorithm,
} from '@/lib/database';

const log = createLogger('gpu-fleet:pool');

export interface CreatePoolInput {
  tenantDbName: string;
  tenantId: string;
  name: string;
  modelName: string;
  modelLibraryId?: string | null;
  algorithm?: LlmPoolAlgorithm;
  createdBy: string;
}

export async function createLlmPool(input: CreatePoolInput): Promise<ILlmPool> {
  const db = await getDatabase();
  await db.switchToTenant(input.tenantDbName);
  const key = slugify(input.name, { lower: true, strict: true });
  if (!key) throw new Error('Pool name produces an empty key');
  const existing = await db.findLlmPoolByKey(input.tenantId, key);
  if (existing) throw new Error(`Pool '${key}' already exists`);
  return db.createLlmPool({
    tenantId: input.tenantId,
    key,
    name: input.name.trim(),
    description: null,
    modelName: input.modelName,
    modelLibraryId: input.modelLibraryId ?? null,
    algorithm: input.algorithm ?? 'round-robin',
    status: 'active',
    deploymentIds: [],
    weights: {},
    providerKey: null,
    modelKey: null,
    createdBy: input.createdBy,
  });
}

export async function listLlmPools(tenantDbName: string, tenantId: string): Promise<ILlmPool[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listLlmPools(tenantId);
}

export async function getLlmPool(
  tenantDbName: string,
  tenantId: string,
  key: string,
): Promise<ILlmPool | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findLlmPoolByKey(tenantId, key);
}

export async function attachDeploymentToPool(args: {
  tenantDbName: string;
  tenantId: string;
  poolKey: string;
  deploymentId: string;
}): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);
  const pool = await db.findLlmPoolByKey(args.tenantId, args.poolKey);
  if (!pool) throw new Error(`Pool '${args.poolKey}' not found`);
  if (pool.deploymentIds.includes(args.deploymentId)) return;
  await db.updateLlmPool(args.tenantId, args.poolKey, {
    deploymentIds: [...pool.deploymentIds, args.deploymentId],
  });
  log.info('attached deployment to pool', { pool: args.poolKey, deployment: args.deploymentId });
}

export async function detachDeploymentFromPool(args: {
  tenantDbName: string;
  tenantId: string;
  poolKey: string;
  deploymentId: string;
}): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);
  const pool = await db.findLlmPoolByKey(args.tenantId, args.poolKey);
  if (!pool) return;
  await db.updateLlmPool(args.tenantId, args.poolKey, {
    deploymentIds: pool.deploymentIds.filter((id) => id !== args.deploymentId),
  });
}

export async function deleteLlmPool(
  tenantDbName: string,
  tenantId: string,
  key: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.deleteLlmPool(tenantId, key);
}

// ── Member selection algorithms ─────────────────────────────────────────

const roundRobinCursor = new Map<string, number>();

export interface SelectableMember {
  deployment: ILlmDeployment;
  hostAddress: string;
}

function pickRoundRobin(pool: ILlmPool, candidates: SelectableMember[]): SelectableMember {
  const cursor = roundRobinCursor.get(pool.key) ?? 0;
  const choice = candidates[cursor % candidates.length];
  roundRobinCursor.set(pool.key, (cursor + 1) % candidates.length);
  return choice;
}

/**
 * Async member selection. The least-busy strategy needs to query the live
 * inference-monitoring snapshot, so the function returns a Promise; callers
 * always await regardless of algorithm.
 */
export async function selectPoolMember(
  pool: ILlmPool,
  candidates: SelectableMember[],
): Promise<SelectableMember | null> {
  if (candidates.length === 0) return null;
  switch (pool.algorithm) {
    case 'round-robin':
      return pickRoundRobin(pool, candidates);
    case 'random':
      return candidates[Math.floor(Math.random() * candidates.length)];
    case 'weighted-static': {
      const weights = candidates.map((m) => Math.max(0, pool.weights[m.deployment.id] ?? 1));
      const total = weights.reduce((a, b) => a + b, 0);
      if (total <= 0) return candidates[0];
      let pick = Math.random() * total;
      for (let i = 0; i < candidates.length; i += 1) {
        pick -= weights[i];
        if (pick <= 0) return candidates[i];
      }
      return candidates[candidates.length - 1];
    }
    case 'least-busy':
      return pickLeastBusy(pool, candidates);
    default:
      return candidates[0];
  }
}

async function pickLeastBusy(
  pool: ILlmPool,
  candidates: SelectableMember[],
): Promise<SelectableMember> {
  const db = await getDatabase();
  // Look up the most recent inference-server metrics snapshot for each member.
  // Members without an attached IInferenceServer (or no metrics yet) get a
  // synthetic +Infinity score so they slot in only after metric-bearing peers.
  const scored = await Promise.all(
    candidates.map(async (member) => {
      const key = member.deployment.inferenceServerKey;
      if (!key) return { member, score: Number.POSITIVE_INFINITY };
      const latest = await db.listInferenceServerMetrics(key, { limit: 1 });
      const running = latest[0]?.numRequestsRunning;
      const score = typeof running === 'number' ? running : Number.POSITIVE_INFINITY;
      return { member, score };
    }),
  );

  scored.sort((a, b) => a.score - b.score);
  const minScore = scored[0]?.score ?? Number.POSITIVE_INFINITY;

  // If nobody has metrics yet, fall back to round-robin to spread load evenly
  // until the monitoring poller catches up.
  if (!Number.isFinite(minScore)) return pickRoundRobin(pool, candidates);

  // Tied lowest? Use round-robin across the tied set so we don't hammer one
  // member when the queue depth is identical.
  const tied = scored.filter((s) => s.score === minScore).map((s) => s.member);
  if (tied.length === 1) return tied[0];
  return pickRoundRobin(pool, tied);
}
