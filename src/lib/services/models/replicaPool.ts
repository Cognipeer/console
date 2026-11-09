/**
 * Replica pools: interchangeable deployments of the SAME model.
 *
 * The distinction that shapes everything here — a pool answers "which copy of
 * this model?", Dynamic LLM answers "which model?". A pool must therefore be
 * INVISIBLE: same price, same capability profile, same cache key, one usage
 * row. Only the deployment actually dialled differs, and that is recorded as a
 * detail of the call rather than as a routing decision.
 *
 * Health comes free from the circuit breaker. `replicaBreakerKey` is scoped to
 * `provider:modelId` (a managed route: its route id), which is exactly replica
 * granularity, so an open breaker IS the "this deployment is cooling down"
 * signal — no separate health subsystem, no second source of truth about what
 * is failing.
 *
 * A MANAGED model (its provider is managed by the hosting operator) takes its
 * pool from the operator's routes instead of the stored `replicas`: each route
 * is a replica with its own driver, upstream model id and connection. The
 * tenant-facing model stays the same; only the route that serves differs.
 *
 * The pool itself (listReplicas, modelForReplica, primaryReplicaModel) lives in
 * replicaList.ts, which has no server-only imports, so code that also reaches the
 * browser can use it; this file adds the breaker-aware ordering on top.
 */
import type { IModel } from '@/lib/database';
import { getCircuitState } from '@/lib/core/resilience';
import { listReplicas, type ResolvedReplica } from './replicaList';

export { listReplicas, modelForReplica, primaryReplicaModel, type ResolvedReplica } from './replicaList';

/**
 * The circuit-breaker key of one replica, shared by the gateway (which trips it) and the pool order (which reads
 * it). Tenant-scoped: the breaker map is process-global and provider keys are tenant-chosen names. A managed route is
 * keyed by its route id, so two routes of one model never share a breaker.
 */
export function replicaBreakerKey(prefix: string, tenantDbName: string, replica: Pick<ResolvedReplica, 'providerKey' | 'modelId' | 'routeId'>): string {
  if (replica.routeId) return `${prefix}:${tenantDbName}:managed:${replica.routeId}`;
  return `${prefix}:${tenantDbName}:${replica.providerKey}:${replica.modelId}`;
}

/** True when this replica's breaker is open, i.e. it is cooling down. */
function isCooling(prefix: string, tenantDbName: string, replica: ResolvedReplica): boolean {
  return getCircuitState(replicaBreakerKey(prefix, tenantDbName, replica))?.state === 'open';
}

/**
 * The order to try replicas in for one request.
 *
 * Healthy replicas are shuffled by weight and come first; cooling ones are kept
 * at the BACK rather than dropped, so a pool whose breakers all tripped still
 * attempts a call instead of failing the request outright on stale state — the
 * breaker will re-test one of them on its own half-open schedule.
 */
export function replicaOrder(
  model: IModel,
  prefix: 'chat' | 'chat-stream',
  random: () => number = Math.random,
  tenantDbName = '',
): ResolvedReplica[] {
  const replicas = listReplicas(model);
  if (replicas.length <= 1) return replicas;

  const healthy: ResolvedReplica[] = [];
  const cooling: ResolvedReplica[] = [];
  for (const replica of replicas) {
    (isCooling(prefix, tenantDbName, replica) ? cooling : healthy).push(replica);
  }

  return [...weightedShuffle(healthy, random), ...weightedShuffle(cooling, random)];
}

/**
 * Weighted random order, drawing without replacement so the whole pool stays
 * available as a fallback chain rather than only its first pick.
 */
function weightedShuffle(
  replicas: readonly ResolvedReplica[],
  random: () => number,
): ResolvedReplica[] {
  const pool = [...replicas];
  const ordered: ResolvedReplica[] = [];

  while (pool.length > 0) {
    const total = pool.reduce((sum, replica) => sum + replica.weight, 0);
    let ticket = random() * total;
    let picked = pool.length - 1;
    for (let i = 0; i < pool.length; i += 1) {
      ticket -= pool[i].weight;
      if (ticket <= 0) {
        picked = i;
        break;
      }
    }
    ordered.push(pool[picked]);
    pool.splice(picked, 1);
  }

  return ordered;
}

/**
 * Whether a failure should move to the next replica.
 *
 * Capacity and availability faults travel; the caller's own mistakes do not. A
 * 400 or a 401 will fail identically on every replica, so retrying one is pure
 * cost and pure latency — and for an auth fault it is also a way to lock out
 * several provider credentials instead of one.
 */
export function shouldTryNextReplica(error: unknown): boolean {
  const status = readStatus(error);
  if (status !== undefined) {
    if (status === 408 || status === 409 || status === 429) return true;
    return status >= 500;
  }

  const signal = `${(error as Error)?.name ?? ''} ${(error as Error)?.message ?? ''}`.toLowerCase();
  return /circuit breaker|timeout|timed out|aborterror|econn|enotfound|fetch failed|connection (error|refused|reset)|socket hang up|unavailable/.test(
    signal,
  );
}

function readStatus(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    for (const key of ['status', 'statusCode', 'status_code']) {
      const value = record[key];
      if (typeof value === 'number' && value >= 100 && value < 600) return value;
    }
    queue.push(record.error, record.response, record.cause);
  }
  return undefined;
}
