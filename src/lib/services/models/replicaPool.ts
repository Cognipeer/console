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
 */
import type { IModel } from '@/lib/database';
import { getCircuitState } from '@/lib/core/resilience';
import { isManagedModel, listManagedRoutes } from '@/enterprise/managed-credits';

export interface ResolvedReplica {
  /** Position in the pool, stable across a request for logging. */
  index: number;
  providerKey: string;
  modelId: string;
  weight: number;
  label?: string;
  settings?: Record<string, unknown>;
  /** Managed route only: the driver that serves it. */
  driver?: string;
  /** Managed route only: the operator's route id (never tenant-visible). */
  routeId?: string;
  /** Managed route only: the connection the runtime is built from. */
  connectionId?: string;
}

/**
 * The pool as a list, including the single-replica case.
 *
 * A model with no `replicas` is a pool of one built from its own
 * `providerKey`/`modelId`, so every path below is the same path whether or not
 * an operator ever opened the Replicas tab. A managed model's pool is its live
 * routes, and is EMPTY when none is live (the call is refused, nothing is dialled).
 */
export function listReplicas(model: IModel): ResolvedReplica[] {
  if (isManagedModel(model)) return managedReplicas(model);

  const configured = Array.isArray(model.replicas) ? model.replicas : [];
  const enabled = configured.filter((replica) => replica?.enabled !== false && replica?.providerKey);

  if (enabled.length === 0) {
    return [{
      index: 0,
      providerKey: model.providerKey,
      modelId: model.modelId,
      weight: 1,
    }];
  }

  return enabled.map((replica, index) => ({
    index,
    providerKey: replica.providerKey,
    modelId: replica.modelId || model.modelId,
    weight: typeof replica.weight === 'number' && replica.weight > 0 ? replica.weight : 1,
    label: replica.label,
    settings: replica.settings,
  }));
}

/** A managed model's routes as replicas; stored `replicas` never apply to it. */
function managedReplicas(model: IModel): ResolvedReplica[] {
  const routes = listManagedRoutes({
    providerKey: model.providerKey,
    modelKey: model.key,
    modelId: model.modelId,
    kind: model.category === 'embedding' ? 'embedding' : 'chat',
  });
  return routes.map((route, index) => ({
    index,
    providerKey: model.providerKey,
    modelId: route.modelId || model.modelId,
    weight: typeof route.weight === 'number' && route.weight > 0 ? route.weight : 1,
    ...(route.settings ? { settings: route.settings } : {}),
    driver: route.driver,
    routeId: route.id,
    connectionId: route.connectionId,
  }));
}

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
 * The model as it looks when this replica serves the call.
 *
 * Handed to everything downstream — parameter resolution, runtime construction,
 * the resilience key, the usage row — so none of them needs to know a pool
 * exists. `settings` is merged shallowly: a replica overrides individual knobs
 * (`azureApiVersion`) without having to restate the model's whole settings
 * object. A managed route also swaps the driver: every driver-keyed rule
 * (unsupported parameters, upstream API, reasoning, output limits) must see
 * the driver that actually serves the call.
 */
export function modelForReplica(model: IModel, replica: ResolvedReplica): IModel {
  if (
    !replica.routeId
    && !replica.driver
    && replica.providerKey === model.providerKey
    && replica.modelId === model.modelId
    && !replica.settings
  ) {
    return model;
  }
  return {
    ...model,
    providerKey: replica.providerKey,
    modelId: replica.modelId,
    ...(replica.driver ? { providerDriver: replica.driver } : {}),
    ...(replica.settings
      ? { settings: { ...(model.settings ?? {}), ...replica.settings } }
      : {}),
  };
}

/**
 * The model as served by its first enabled replica, in stored order (a managed
 * model: its first live route).
 *
 * For paths that do not load-balance (audio, image, moderation, OCR,
 * evaluation runs) and for server-side planning that needs the serving
 * driver's rules. A model without replicas comes back unchanged, so only
 * operators who opened the Replicas tab see any difference. A managed model
 * with no live route comes back unchanged too; its call is refused later.
 */
export function primaryReplicaModel(model: IModel): IModel {
  const first = listReplicas(model)[0];
  return first ? modelForReplica(model, first) : model;
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
