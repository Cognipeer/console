/**
 * The replicas of a model as a list, and the model as one replica serves it.
 *
 * Kept free of server-only imports (no circuit breaker, no logger) so modules
 * that also reach the browser can read a model's serving driver. The ordering
 * and failover rules that need breaker state live in replicaPool.ts.
 */
import type { IModel } from '@/lib/database';
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
