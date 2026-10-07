/**
 * Stream Relay — live callbacks and cancellation for routed calls.
 *
 * `routeInstanceCall` can run a call on another node through the job queue.
 * The queue carries data, not functions: a caller's `onTextChunk` /
 * `onToolEvent` and its `AbortSignal` cannot ride along in the payload. This
 * relay restores them over Redis pub/sub:
 *
 *   caller                                   worker
 *   ──────                                   ──────
 *   subscribe  <id>:up                       (job picked up)
 *   enqueue job { …, __streamRelay }   ───▶  subscribe  <id>:down
 *                                      ◀───  ready
 *   replay into callbacks              ◀───  event {name, data}   (one per callback fire)
 *   signal aborts → cancel             ───▶  local AbortController.abort()
 *                                      ◀───  cancel-ack
 *                                      ◀───  end                  (handler settled)
 *   job result via the queue (unchanged)
 *
 * Properties this keeps:
 *
 *  - The CALLER subscribes before the job is enqueued, so no frame the worker
 *    publishes can precede the subscription.
 *  - A cancel published before the worker subscribed is not lost: the worker
 *    announces `ready` once subscribed and the caller repeats the cancel then.
 *  - Frames from one worker leave over one connection, so Redis delivers them
 *    in order. The job result travels separately (BullMQ), so the caller waits
 *    briefly for `end` before returning — every chunk is replayed before the
 *    caller sees the final result.
 *  - A job can run MORE THAN ONCE. `attempts: 1` stops the queue retrying a
 *    failure, but BullMQ also re-runs a STALLED job (its worker was killed
 *    mid-turn, or lost its lock) whatever `attempts` says — with the same
 *    payload, so the same relay descriptor. Every execution therefore stamps
 *    its frames with a run id of its own, and the caller follows only the first
 *    run it hears from: a re-run's text and tool events never land in callbacks
 *    that already received part of the first run's, and the final result (the
 *    re-run's) is what completes the call.
 *  - Single node / memory queue never get here: the router's local fast path
 *    calls the handler with the real callbacks. No Redis configured → no
 *    relay; the routed call still completes, it just does not stream (the
 *    pre-relay behaviour).
 *
 * Callbacks are replayed best-effort: a throwing callback is logged, never
 * propagated into the transport.
 */

import { randomUUID } from 'node:crypto';
import { getConfig } from '../config';
import { createLogger } from '../logger';
import { registerShutdownHandler } from '../lifecycle';
import { getThisNodeName } from './nodeRegistry';

const log = createLogger('cluster.relay');

/** Payload key the descriptor travels under. */
export const STREAM_RELAY_PAYLOAD_KEY = '__streamRelay';

/** How long a finished caller waits for the worker's `end` frame. */
const END_GRACE_MS = 1_000;

/**
 * How long a finished caller waits for a `ready` it has not seen yet. A fast
 * run's result can overtake its own frames (they travel on another
 * connection); a worker that never opens its end at all (no Redis there, a
 * node from before the relay existed) must not cost the full grace.
 */
const READY_GRACE_MS = 150;

/**
 * Upper bound on a subscribe / the worker's final flush. ioredis queues
 * commands while disconnected (`maxRetriesPerRequest: null`, as the queue uses
 * it), so without a bound a Redis outage would hang the call — or, on the
 * worker, the job's completion — instead of degrading to "no live callbacks".
 */
const TRANSPORT_TIMEOUT_MS = 2_000;

/** Channel ids are generated here; anything else in a payload is refused. */
const RELAY_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Minimal pub/sub surface; the Redis implementation is below, tests inject a fake. */
export interface RelayTransport {
  publish(channel: string, message: string): Promise<void>;
  /** Resolves once the subscription is live. Returns the unsubscribe function. */
  subscribe(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>>;
}

/** What the worker needs to find the caller. Plain data — serializes over the queue. */
export interface StreamRelayDescriptor {
  id: string;
  /** Callback names the caller listens for; the worker wires only these. */
  events: string[];
  /** Whether the caller can cancel (passed a signal). */
  cancellable: boolean;
}

/**
 * What a worker publishes. `run` identifies the EXECUTION that sent it (see
 * the header: one job can be executed more than once, over the same channel).
 */
type WorkerFrame =
  | { k: 'ready'; run: string }
  | { k: 'event'; run: string; name: string; data: unknown }
  | { k: 'cancel-ack'; run: string }
  | { k: 'end'; run: string };

type RelayFrame = WorkerFrame | { k: 'cancel' };

function upChannel(id: string): string {
  return `relay:${id}:up`;
}

function downChannel(id: string): string {
  return `relay:${id}:down`;
}

function parseFrame(message: string): RelayFrame | undefined {
  try {
    const frame = JSON.parse(message) as RelayFrame;
    return frame && typeof frame === 'object' && typeof frame.k === 'string' ? frame : undefined;
  } catch {
    return undefined;
  }
}

/** Resolves after `ms` (unref'd: never keeps the process alive). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * `transport.subscribe` bounded by `TRANSPORT_TIMEOUT_MS`. A subscription
 * that completes after the deadline is undone at once, so a late success
 * never leaves a listener nobody will remove.
 */
async function subscribeWithin(
  transport: RelayTransport,
  channel: string,
  onMessage: (message: string) => void,
): Promise<() => Promise<void>> {
  const pending = transport.subscribe(channel, onMessage);
  const winner = await Promise.race([pending, delay(TRANSPORT_TIMEOUT_MS).then(() => null)]);
  if (winner) return winner;
  pending.then((unsubscribe) => unsubscribe()).catch(() => undefined);
  throw new Error(`subscribe to ${channel} timed out after ${TRANSPORT_TIMEOUT_MS}ms`);
}

/* ── Transport ────────────────────────────────────────────────────────── */

/**
 * ioredis pub/sub over the queue's Redis (`QUEUE_REDIS_URL`, falling back to
 * `REDIS_URL` — the same resolution `getQueue()` uses, since routing only
 * exists on the BullMQ queue). Two connections: a subscribed ioredis client
 * cannot publish. Channels carry the queue key prefix so deployments sharing
 * one Redis do not hear each other.
 */
class RedisRelayTransport implements RelayTransport {
  private readonly listeners = new Map<string, Set<(message: string) => void>>();
  private publisher: import('ioredis').Redis | null = null;
  private subscriber: import('ioredis').Redis | null = null;
  private ready: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly prefix: string,
  ) {}

  private async connect(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const { Redis } = await import('ioredis');
        const options = { maxRetriesPerRequest: null, enableReadyCheck: false } as const;
        const node = getThisNodeName();
        this.publisher = new Redis(this.url, { ...options, connectionName: `console:${node}:relay-pub` });
        this.subscriber = new Redis(this.url, { ...options, connectionName: `console:${node}:relay-sub` });
        this.subscriber.on('message', (channel: string, message: string) => {
          const set = this.listeners.get(channel);
          if (!set) return;
          for (const listener of [...set]) listener(message);
        });
        for (const client of [this.publisher, this.subscriber]) {
          client.on('error', (error: Error) => log.warn('Stream relay Redis error', { error: error.message }));
        }
      })();
    }
    await this.ready;
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.connect();
    await this.publisher!.publish(`${this.prefix}${channel}`, message);
  }

  async subscribe(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>> {
    await this.connect();
    const full = `${this.prefix}${channel}`;
    let set = this.listeners.get(full);
    if (!set) {
      set = new Set();
      this.listeners.set(full, set);
      await this.subscriber!.subscribe(full);
    }
    set.add(onMessage);
    return async () => {
      const current = this.listeners.get(full);
      if (!current) return;
      current.delete(onMessage);
      if (current.size > 0) return;
      this.listeners.delete(full);
      await this.subscriber?.unsubscribe(full).catch(() => undefined);
    };
  }

  async destroy(): Promise<void> {
    this.listeners.clear();
    this.publisher?.disconnect();
    this.subscriber?.disconnect();
    this.publisher = null;
    this.subscriber = null;
    this.ready = null;
  }
}

let transportOverride: RelayTransport | null | undefined;
let redisTransport: RedisRelayTransport | null = null;

/** The relay transport, or null when this deployment has no Redis (no cross-node routing either). */
export function getRelayTransport(): RelayTransport | null {
  if (transportOverride !== undefined) return transportOverride;
  if (redisTransport) return redisTransport;
  const cfg = getConfig();
  const url = cfg.queue.redis.url || cfg.cache.redis.url || '';
  if (!url) return null;
  redisTransport = new RedisRelayTransport(url, cfg.queue.redis.prefix);
  registerShutdownHandler('stream-relay', async () => {
    await redisTransport?.destroy();
    redisTransport = null;
  });
  return redisTransport;
}

/** Tests: inject a fake transport (`null` = no transport). `undefined` restores the real one. */
export function setRelayTransportForTests(transport: RelayTransport | null | undefined): void {
  transportOverride = transport;
}

/* ── Caller side ──────────────────────────────────────────────────────── */

export interface RelayCallerOptions {
  /**
   * Callbacks keyed by event name. Only names with a function are relayed —
   * the worker wires exactly these, so a caller that did not ask for text
   * does not switch the remote run into streaming mode.
   */
  handlers: Record<string, ((data: unknown) => void) | undefined>;
  /** Aborting it cancels the remote run (it resolves with its partial result). */
  signal?: AbortSignal;
}

export interface CallerRelay {
  readonly descriptor: StreamRelayDescriptor;
  /** The call succeeded: wait (bounded) for the worker's last frames, then close. */
  finish(): Promise<void>;
  /** Stop listening now. Idempotent. */
  close(): Promise<void>;
}

/** True when the options would relay anything at all. */
export function relayIsUseful(options: RelayCallerOptions | undefined): options is RelayCallerOptions {
  if (!options) return false;
  return Boolean(options.signal) || Object.values(options.handlers).some((h) => typeof h === 'function');
}

/**
 * Opens the caller's end. Resolves null when there is no transport or it
 * cannot subscribe — the routed call then runs without live callbacks rather
 * than failing.
 */
export async function openCallerRelay(
  options: RelayCallerOptions,
  transport: RelayTransport | null = getRelayTransport(),
): Promise<CallerRelay | null> {
  if (!transport) return null;
  const id = randomUUID();
  const events = Object.entries(options.handlers)
    .filter(([, handler]) => typeof handler === 'function')
    .map(([name]) => name);
  const descriptor: StreamRelayDescriptor = { id, events, cancellable: Boolean(options.signal) };
  const { signal } = options;

  let closed = false;
  let aborted = false;
  let workerReady = false;
  // The execution the caller listens to: the first one it hears from.
  let followedRun: string | undefined;
  let rerunLogged = false;
  let resolveEnd: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    resolveEnd = resolve;
  });
  let resolveReady: () => void = () => undefined;
  const readySeen = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const sendCancel = () => {
    transport.publish(downChannel(id), JSON.stringify({ k: 'cancel' } satisfies RelayFrame)).catch((error) => {
      log.warn('Stream relay cancel publish failed', { relayId: id, error: String(error) });
    });
  };

  const onFrame = (message: string) => {
    if (closed) return;
    const frame = parseFrame(message);
    // Only a worker publishes on this channel; a frame without a run id is not one of ours.
    if (!frame || frame.k === 'cancel' || typeof frame.run !== 'string' || !frame.run) return;
    if (followedRun === undefined) followedRun = frame.run;
    const followed = frame.run === followedRun;
    if (!followed && !rerunLogged) {
      rerunLogged = true;
      log.warn('Routed job ran again (stalled and re-queued); ignoring the re-run\'s live frames', { relayId: id });
    }
    switch (frame.k) {
      case 'event': {
        if (!followed) return;
        const handler = options.handlers[frame.name];
        if (typeof handler !== 'function') return;
        try {
          handler(frame.data);
        } catch (error) {
          log.warn('Relayed callback failed', { relayId: id, event: frame.name, error: String(error) });
        }
        return;
      }
      case 'ready':
        // Every execution announces itself, a re-run included: a cancel sent
        // before it subscribed was lost on it as well.
        if (aborted) sendCancel();
        if (!followed) return;
        workerReady = true;
        resolveReady();
        return;
      case 'cancel-ack':
        if (followed) log.debug('Routed run acknowledged cancel', { relayId: id });
        return;
      case 'end':
        // An execution that finished — any of them — means the job is done:
        // what the followed one never got to say (it died) is not coming, and
        // the caller need not wait out the grace period for it.
        resolveEnd();
        return;
      default:
        return;
    }
  };

  let unsubscribe: () => Promise<void>;
  try {
    unsubscribe = await subscribeWithin(transport, upChannel(id), onFrame);
  } catch (error) {
    log.warn('Stream relay unavailable; routed call runs without live callbacks', { error: String(error) });
    return null;
  }

  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    sendCancel();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  const close = async () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    resolveEnd();
    resolveReady();
    await unsubscribe().catch(() => undefined);
  };

  /** Resolves when `until` settles or after `ms`, whichever is first. */
  const waitAtMost = (until: Promise<void>, ms: number) => Promise.race([until, delay(ms)]);

  return {
    descriptor,
    async finish() {
      // Frames are published before the job completes but travel on another
      // connection than the result, so they may still be in flight. Still no
      // `ready` after a short grace: the worker never opened its end and no
      // `end` is coming.
      if (!workerReady) await waitAtMost(readySeen, READY_GRACE_MS);
      if (workerReady) await waitAtMost(ended, END_GRACE_MS);
      await close();
    },
    close,
  };
}

/* ── Worker side ──────────────────────────────────────────────────────── */

export interface WorkerRelay {
  /** Callback names the caller listens for. */
  readonly events: ReadonlySet<string>;
  /** Aborted when the caller cancels; undefined when the caller cannot cancel. */
  readonly signal: AbortSignal | undefined;
  /** Forward one callback fire. Fire-and-forget, order-preserving. */
  emit(name: string, data: unknown): void;
  /** Publish `end` (after every emitted frame) and stop listening. */
  close(): Promise<void>;
}

/** The descriptor a routed payload carries, validated; undefined when absent or malformed. */
export function readRelayDescriptor(payload: unknown): StreamRelayDescriptor | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const raw = (payload as Record<string, unknown>)[STREAM_RELAY_PAYLOAD_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const { id, events, cancellable } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !RELAY_ID_PATTERN.test(id)) return undefined;
  return {
    id,
    events: Array.isArray(events) ? events.filter((e): e is string => typeof e === 'string') : [],
    cancellable: cancellable === true,
  };
}

/** Opens the worker's end. Null when there is no transport or it fails. */
export async function openWorkerRelay(
  descriptor: StreamRelayDescriptor,
  transport: RelayTransport | null = getRelayTransport(),
): Promise<WorkerRelay | null> {
  if (!transport) return null;
  const { id } = descriptor;
  // This execution. A re-run of the same job opens its own relay on the same
  // channels, with a run id of its own (see the header).
  const run = randomUUID();
  const controller = descriptor.cancellable ? new AbortController() : undefined;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  const send = (frame: RelayFrame) => {
    const message = JSON.stringify(frame);
    chain = chain
      .then(() => transport.publish(upChannel(id), message))
      .catch((error) => {
        log.warn('Stream relay publish failed', { relayId: id, frame: frame.k, error: String(error) });
      });
  };

  let unsubscribe: (() => Promise<void>) | undefined;
  if (controller) {
    try {
      unsubscribe = await subscribeWithin(transport, downChannel(id), (message) => {
        const frame = parseFrame(message);
        if (frame?.k !== 'cancel' || controller.signal.aborted) return;
        log.info('Routed run cancelled by its caller', { relayId: id });
        controller.abort();
        send({ k: 'cancel-ack', run });
      });
    } catch (error) {
      log.warn('Stream relay unavailable on worker; running without it', { relayId: id, error: String(error) });
      return null;
    }
  }
  send({ k: 'ready', run });

  return {
    events: new Set(descriptor.events),
    signal: controller?.signal,
    emit(name, data) {
      if (closed) return;
      send({ k: 'event', run, name, data });
    },
    async close() {
      if (closed) return;
      closed = true;
      send({ k: 'end', run });
      // Bounded: the job's result must not wait on a Redis that went away.
      await Promise.race([chain, delay(TRANSPORT_TIMEOUT_MS)]);
      await unsubscribe?.().catch(() => undefined);
    },
  };
}

/**
 * Worker-side wrapper: opens the relay a routed payload asks for (if any),
 * runs `run` with it and the payload minus the descriptor, and always closes
 * it. A payload without a descriptor (local call, older producer) runs with
 * `relay = null`.
 */
export async function withWorkerRelay<P extends Record<string, unknown>, R>(
  payload: P,
  run: (relay: WorkerRelay | null, data: P) => Promise<R>,
): Promise<R> {
  const descriptor = readRelayDescriptor(payload);
  const data = { ...payload };
  delete (data as Record<string, unknown>)[STREAM_RELAY_PAYLOAD_KEY];
  if (!descriptor) return run(null, data);
  const relay = await openWorkerRelay(descriptor);
  try {
    return await run(relay, data);
  } finally {
    await relay?.close();
  }
}
