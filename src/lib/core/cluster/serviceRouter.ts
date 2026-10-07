/**
 * Service Router
 *
 * Wraps a per-instance service call so it transparently runs locally or
 * forwards to the assigned worker node via the job queue.
 *
 * Resolution rules (in order):
 *
 *   1. No explicit assignment AND no fallback configured → call local handler
 *      (preserves pre-cluster behaviour for unmanaged instances).
 *   2. Assignment present AND it points at this node → call local handler.
 *   3. Assignment present AND a queue consumer for the target queue is
 *      locally registered → still call local handler (single-node, memory
 *      queue, "all" role).
 *   4. Otherwise → queue.invoke() to the target node.
 *      - `strict`     → reject if target node is offline.
 *      - `preferred`  → fall back to the 'auto' channel so any node
 *                       running a consumer can pick the job up.
 *
 * Consumers register on every node that *might* execute the work; the
 * router is the only place that decides who actually runs it.
 *
 * Live callbacks (`opts.relay`): the queue carries data, not functions. When a
 * call is forwarded, the caller's callbacks and abort signal are bridged over
 * Redis pub/sub (see `streamRelay.ts`); the local paths call the handler,
 * which closes over the real callbacks, and never open a relay.
 */

import { createLogger } from '../logger';
import { listClusterNodes } from './nodeRegistry';
import { getThisNodeName } from './nodeRegistry';
import { resolveInstancePlacement } from './instanceAssignmentStore';
import { getQueue, type InvokeOptions, type QueuePayload } from '../queue';
import type { InstanceEntityType } from './types';
import {
  STREAM_RELAY_PAYLOAD_KEY,
  openCallerRelay,
  relayIsUseful,
  type RelayCallerOptions,
} from './streamRelay';

const log = createLogger('cluster.router');

export interface RouteOptions extends Omit<InvokeOptions, 'targetNode'> {
  /**
   * Override resolution. Useful when an entity is sticky to the node that
   * created it (e.g. a live browser session bound to a Playwright context).
   */
  forceNodeName?: string;
  /**
   * Callbacks/abort signal of a call that may be forwarded to another node.
   * Ignored on the local paths (the local handler already has them).
   */
  relay?: RelayCallerOptions;
}

export interface RouteContext {
  entityType: InstanceEntityType;
  entityId: string;
  jobName: string;
}

/**
 * Route a per-instance call. The router never touches the local handler's
 * return value — what runs on the worker is exactly what would have run
 * inline.
 */
export async function routeInstanceCall<T extends QueuePayload, R>(
  ctx: RouteContext,
  payload: T,
  localHandler: () => Promise<R>,
  opts: RouteOptions = {},
): Promise<R> {
  const thisNode = getThisNodeName();

  const target = opts.forceNodeName
    ? { nodeName: opts.forceNodeName, mode: 'strict' as const, explicit: true }
    : await resolveInstancePlacement(ctx.entityType, ctx.entityId);

  // Local fast path: target is this node, or no explicit assignment yet.
  if (!target.explicit || target.nodeName === thisNode) {
    return localHandler();
  }

  const queue = await getQueue();
  const queueName = queueNameFor(ctx.entityType);

  // Memory queue + assignment to another node is meaningless: collapse to
  // local execution and warn (this signals a deployment misconfiguration —
  // assignments should not exist when there is only one process).
  if (queue.name === 'memory') {
    log.warn('Instance assignment ignored: memory queue cannot route off-node', {
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      assigned: target.nodeName,
      thisNode,
    });
    return localHandler();
  }

  const { relay: relayOptions, ...invokeOpts } = opts;
  const invokeRemote = async (targetNode: string | undefined): Promise<R> => {
    const relay = relayIsUseful(relayOptions) ? await openCallerRelay(relayOptions) : null;
    const routedPayload = relay
      ? ({ ...payload, [STREAM_RELAY_PAYLOAD_KEY]: relay.descriptor } as T)
      : payload;
    try {
      const result = await queue.invoke<T, R>(queueName, ctx.jobName, routedPayload, {
        ...invokeOpts,
        // A relayed call has already handed its live callbacks part of the
        // answer: a queue retry would re-run the job and replay its text
        // (and tool events) into the same caller on top of what the failed
        // attempt streamed — duplicated or, when the first attempt's `end`
        // won the race, truncated output. So the queue is not asked to retry
        // it.
        //
        // That only covers a FAILED attempt. BullMQ also re-runs a STALLED job
        // (the worker was killed mid-turn, or lost its lock) whatever
        // `attempts` says, with the same payload and so the same relay. The
        // relay is what makes that safe for the caller: each execution stamps
        // its frames with its own run id and the caller follows only the first
        // (`streamRelay.ts`).
        ...(relay ? { attempts: 1 } : {}),
        targetNode,
      });
      await relay?.finish();
      return result;
    } catch (error) {
      await relay?.close();
      throw error;
    }
  };

  if (target.mode === 'strict') {
    await assertNodeOnline(target.nodeName, ctx);
    return invokeRemote(target.nodeName);
  }

  // Preferred mode: try the targeted node; if it's offline, fall back to
  // the shared "auto" channel so any consumer can pick it up.
  if (await isNodeOnline(target.nodeName)) {
    return invokeRemote(target.nodeName);
  }
  log.warn('Preferred node offline; routing to auto channel', {
    entityType: ctx.entityType,
    entityId: ctx.entityId,
    assigned: target.nodeName,
  });
  return invokeRemote(undefined); // auto
}

/** Conventional queue name for a given entity type. */
export function queueNameFor(entityType: InstanceEntityType): string {
  return `cluster.${entityType}`;
}

async function isNodeOnline(name: string): Promise<boolean> {
  try {
    const nodes = await listClusterNodes();
    const found = nodes.find((n) => n.name === name);
    return Boolean(found && found.status === 'online');
  } catch {
    return false;
  }
}

async function assertNodeOnline(name: string, ctx: RouteContext): Promise<void> {
  if (await isNodeOnline(name)) return;
  throw new Error(
    `Instance ${ctx.entityType}/${ctx.entityId} is strictly assigned to node "${name}" which is currently offline.`,
  );
}
