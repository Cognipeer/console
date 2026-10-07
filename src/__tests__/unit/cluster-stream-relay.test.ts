/**
 * Cluster stream relay — live callbacks and cancel for calls `routeInstanceCall`
 * forwards to another node.
 *
 * The transport is a fake in-memory pub/sub that delivers asynchronously (one
 * timer tick per message, in publish order) so the races the relay guards
 * against are real here: a frame published before anyone subscribed is lost,
 * exactly as with Redis.
 *
 * The router's collaborators (placement, node registry, queue) are mocked; the
 * fake BullMQ queue's `invoke` plays the remote worker by running the payload
 * through the real `withWorkerRelay`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  resolveInstancePlacement: vi.fn(),
  listClusterNodes: vi.fn(),
  getQueue: vi.fn(),
}));

vi.mock('@/lib/core/cluster/instanceAssignmentStore', () => ({
  resolveInstancePlacement: hoisted.resolveInstancePlacement,
}));

vi.mock('@/lib/core/cluster/nodeRegistry', () => ({
  getThisNodeName: () => 'node-a',
  listClusterNodes: hoisted.listClusterNodes,
}));

vi.mock('@/lib/core/queue', () => ({
  getQueue: hoisted.getQueue,
}));

import { routeInstanceCall } from '@/lib/core/cluster/serviceRouter';
import {
  STREAM_RELAY_PAYLOAD_KEY,
  openCallerRelay,
  openWorkerRelay,
  readRelayDescriptor,
  relayIsUseful,
  setRelayTransportForTests,
  withWorkerRelay,
  type RelayTransport,
  type WorkerRelay,
} from '@/lib/core/cluster/streamRelay';

/* ── Fake pub/sub ────────────────────────────────────────────────────────── */

interface FakeTransport extends RelayTransport {
  published: Array<{ channel: string; frame: Record<string, unknown> }>;
  subscribed: string[];
  unsubscribed: string[];
  /**
   * Resolves once every message published so far, and every one published in
   * reaction to a delivery, has been delivered. Waiting on the exchange itself
   * (not on a fixed delay) keeps the tests independent of how busy the machine is.
   */
  idle(): Promise<void>;
}

function fakeTransport(): FakeTransport {
  const listeners = new Map<string, Set<(message: string) => void>>();
  const published: FakeTransport['published'] = [];
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  let inFlight = 0;
  return {
    published,
    subscribed,
    unsubscribed,
    async publish(channel, message) {
      published.push({ channel, frame: JSON.parse(message) as Record<string, unknown> });
      // Snapshot of who is subscribed NOW — a later subscriber never sees it.
      const targets = [...(listeners.get(channel) ?? [])];
      inFlight += 1;
      setTimeout(() => {
        try {
          for (const listener of targets) listener(message);
        } finally {
          inFlight -= 1;
        }
      }, 0);
    },
    async idle() {
      // A turn first: the relay publishes through a promise chain, and what its
      // last await queued has not reached `publish` (nor `inFlight`) yet.
      do {
        await tick();
      } while (inFlight > 0);
    },
    async subscribe(channel, onMessage) {
      subscribed.push(channel);
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(onMessage);
      return async () => {
        unsubscribed.push(channel);
        set?.delete(onMessage);
      };
    },
  };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Frames of one kind (`k`) published on any channel, in order. */
function frames(transport: FakeTransport, kind: string) {
  return transport.published.filter((p) => p.frame.k === kind);
}

/* ── Fake routed queue ───────────────────────────────────────────────────── */

type RemoteHandler = (relay: WorkerRelay | null, data: Record<string, unknown>) => Promise<unknown>;

function bullmqQueue(remote: RemoteHandler, opts: { workerDelayMs?: number } = {}) {
  type Invoke = (queue: string, job: string, payload: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
  const invoke = vi.fn<Invoke>(async (_queue, _job, payload) => {
    if (opts.workerDelayMs) await tick(opts.workerDelayMs);
    return withWorkerRelay(payload, remote);
  });
  return { name: 'bullmq' as const, invoke };
}

const ROUTE = { entityType: 'agent' as const, entityId: 'tenant:agent', jobName: 'playground' };

let transport: FakeTransport;

beforeEach(() => {
  vi.clearAllMocks();
  transport = fakeTransport();
  setRelayTransportForTests(transport);
  hoisted.resolveInstancePlacement.mockResolvedValue({ nodeName: 'node-b', mode: 'strict', explicit: true });
  hoisted.listClusterNodes.mockResolvedValue([{ name: 'node-b', status: 'online' }]);
});

afterEach(() => {
  setRelayTransportForTests(undefined);
});

/* ── Router integration ──────────────────────────────────────────────────── */

describe('routeInstanceCall with a relay', () => {
  it('replays every worker callback, in order, before the routed call returns', async () => {
    const queue = bullmqQueue(async (relay, data) => {
      expect(data).not.toHaveProperty(STREAM_RELAY_PAYLOAD_KEY);
      relay!.emit('text', 'Hel');
      relay!.emit('tool', { phase: 'start', name: 'search' });
      relay!.emit('text', 'lo');
      return { content: 'Hello', echoed: data.question };
    });
    hoisted.getQueue.mockResolvedValue(queue);
    const seen: string[] = [];
    const local = vi.fn();

    const result = await routeInstanceCall(ROUTE, { question: 'hi' }, local, {
      relay: {
        handlers: {
          text: (d) => seen.push(`text:${String(d)}`),
          tool: (d) => seen.push(`tool:${(d as { name: string }).name}`),
          compaction: undefined,
        },
      },
    });

    expect(result).toEqual({ content: 'Hello', echoed: 'hi' });
    expect(seen).toEqual(['text:Hel', 'tool:search', 'text:lo']);
    expect(local).not.toHaveBeenCalled();

    const [, , payload, invokeOpts] = queue.invoke.mock.calls[0];
    const descriptor = readRelayDescriptor(payload);
    expect(descriptor).toMatchObject({ events: ['text', 'tool'], cancellable: false });
    // No `relay` (functions) handed to the queue, and a relayed call is never retried.
    expect(invokeOpts).toEqual({ targetNode: 'node-b', attempts: 1 });
    // The caller's subscription is gone once the call returned.
    expect(transport.unsubscribed).toContain(`relay:${descriptor!.id}:up`);
  });

  it('the caller aborting cancels the remote run, which resolves with its partial result', async () => {
    const controller = new AbortController();
    const queue = bullmqQueue(async (relay) => {
      relay!.emit('text', 'Half');
      await new Promise<void>((resolve) => relay!.signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { content: 'Half', cancelled: true };
    });
    hoisted.getQueue.mockResolvedValue(queue);

    const result = await routeInstanceCall(ROUTE, {}, vi.fn(), {
      relay: {
        handlers: { text: () => controller.abort() },
        signal: controller.signal,
      },
    });

    expect(result).toEqual({ content: 'Half', cancelled: true });
    expect(frames(transport, 'cancel')).toHaveLength(1);
    expect(frames(transport, 'cancel-ack')).toHaveLength(1);
    expect(readRelayDescriptor(queue.invoke.mock.calls[0][2])?.cancellable).toBe(true);
  });

  it('a cancel sent before the worker subscribed is repeated once the worker says ready', async () => {
    const controller = new AbortController();
    controller.abort(); // aborted before the job is even enqueued
    let workerSignalAborted = false;
    const queue = bullmqQueue(async (relay) => {
      await transport.idle(); // our `ready` reached the caller, whose repeated cancel reached us
      workerSignalAborted = relay!.signal!.aborted;
      return 'stopped';
    }, { workerDelayMs: 10 });
    hoisted.getQueue.mockResolvedValue(queue);

    await routeInstanceCall(ROUTE, {}, vi.fn(), { relay: { handlers: {}, signal: controller.signal } });

    expect(workerSignalAborted).toBe(true);
    // First cancel was lost (nobody listening yet); the second followed `ready`.
    expect(frames(transport, 'cancel')).toHaveLength(2);
    expect(frames(transport, 'cancel-ack')).toHaveLength(1);
  });

  it('a throwing callback is logged, not propagated, and later frames still arrive', async () => {
    hoisted.getQueue.mockResolvedValue(bullmqQueue(async (relay) => {
      relay!.emit('text', 'a');
      relay!.emit('text', 'b');
      return 'ok';
    }));
    const seen: string[] = [];
    const result = await routeInstanceCall(ROUTE, {}, vi.fn(), {
      relay: {
        handlers: {
          text: (d) => {
            seen.push(String(d));
            if (d === 'a') throw new Error('listener broke');
          },
        },
      },
    });
    expect(result).toBe('ok');
    expect(seen).toEqual(['a', 'b']);
  });

  it('a failed remote call closes the relay and rejects as before', async () => {
    hoisted.getQueue.mockResolvedValue(bullmqQueue(async () => {
      throw new Error('worker exploded');
    }));
    await expect(routeInstanceCall(ROUTE, {}, vi.fn(), { relay: { handlers: { text: vi.fn() } } }))
      .rejects.toThrow('worker exploded');
    const up = transport.subscribed.find((c) => c.endsWith(':up'));
    expect(transport.unsubscribed).toContain(up);
    // The worker still said `end` on its way out.
    expect(frames(transport, 'end')).toHaveLength(1);
  });

  it('a worker that never opens its end (old node / no Redis there) does not delay the result', async () => {
    const invoke = vi.fn(async () => 'from an old worker'); // ignores the descriptor
    hoisted.getQueue.mockResolvedValue({ name: 'bullmq', invoke });
    const started = Date.now();
    const result = await routeInstanceCall(ROUTE, {}, vi.fn(), { relay: { handlers: { text: vi.fn() } } });
    expect(result).toBe('from an old worker');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('without a transport the routed call runs as it did before the relay existed', async () => {
    setRelayTransportForTests(null);
    const queue = bullmqQueue(async (relay) => {
      expect(relay).toBeNull();
      return 'plain';
    });
    hoisted.getQueue.mockResolvedValue(queue);
    const text = vi.fn();
    await expect(routeInstanceCall(ROUTE, { a: 1 }, vi.fn(), { relay: { handlers: { text } } })).resolves.toBe('plain');
    expect(queue.invoke.mock.calls[0][2]).toEqual({ a: 1 });
    expect(text).not.toHaveBeenCalled();
  });

  it('local fast path (no assignment): the handler runs here and no relay is opened', async () => {
    hoisted.resolveInstancePlacement.mockResolvedValue({ nodeName: 'node-a', mode: 'preferred', explicit: false });
    const local = vi.fn(async () => 'local');
    await expect(routeInstanceCall(ROUTE, {}, local, { relay: { handlers: { text: vi.fn() } } })).resolves.toBe('local');
    expect(local).toHaveBeenCalledOnce();
    expect(transport.subscribed).toEqual([]);
    expect(hoisted.getQueue).not.toHaveBeenCalled();
  });

  it('memory queue: an off-node assignment collapses to local execution, no relay', async () => {
    const invoke = vi.fn();
    hoisted.getQueue.mockResolvedValue({ name: 'memory', invoke });
    const local = vi.fn(async () => 'local');
    await expect(routeInstanceCall(ROUTE, {}, local, { relay: { handlers: { text: vi.fn() } } })).resolves.toBe('local');
    expect(invoke).not.toHaveBeenCalled();
    expect(transport.subscribed).toEqual([]);
  });

  it('nothing to relay (no handlers, no signal): no subscription, payload untouched', async () => {
    const queue = bullmqQueue(async () => 'ok');
    hoisted.getQueue.mockResolvedValue(queue);
    await routeInstanceCall(ROUTE, { a: 1 }, vi.fn(), { relay: { handlers: { text: undefined } } });
    expect(transport.subscribed).toEqual([]);
    expect(queue.invoke.mock.calls[0][2]).toEqual({ a: 1 });
  });

  it('preferred mode with the target offline routes to the auto channel, relay included', async () => {
    hoisted.resolveInstancePlacement.mockResolvedValue({ nodeName: 'node-b', mode: 'preferred', explicit: true });
    hoisted.listClusterNodes.mockResolvedValue([{ name: 'node-b', status: 'offline' }]);
    const queue = bullmqQueue(async (relay) => {
      relay!.emit('text', 'via auto');
      return 'ok';
    });
    hoisted.getQueue.mockResolvedValue(queue);
    const text = vi.fn();
    await routeInstanceCall(ROUTE, {}, vi.fn(), { relay: { handlers: { text } } });
    expect(queue.invoke.mock.calls[0][3]).toEqual({ targetNode: undefined, attempts: 1 });
    expect(text).toHaveBeenCalledWith('via auto');
  });

  it('a relayed call is not retried: a failed attempt is not replayed into the same caller', async () => {
    // BullMQ semantics: a failed job is re-run (same data, same relay
    // descriptor) until `attempts` is exhausted, and the caller keeps waiting.
    let runs = 0;
    const invoke = vi.fn(async (_q: string, _j: string, payload: Record<string, unknown>, opts?: { attempts?: number }) => {
      const attempts = opts?.attempts ?? 3;
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          return await withWorkerRelay(payload, async (relay) => {
            runs++;
            if (runs === 1) {
              relay!.emit('text', 'The capital ');
              throw new Error('provider 529');
            }
            relay!.emit('text', 'The capital of France is Paris.');
            return { content: 'The capital of France is Paris.' };
          });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    });
    hoisted.getQueue.mockResolvedValue({ name: 'bullmq', invoke });
    const seen: string[] = [];

    await expect(routeInstanceCall(ROUTE, {}, vi.fn(), {
      relay: { handlers: { text: (d) => seen.push(String(d)) } },
    })).rejects.toThrow('provider 529');

    expect(runs).toBe(1);
    expect(seen.join('')).not.toContain('Paris');
  });

  it('a stalled job that BullMQ re-runs after its worker died is not replayed into the caller: it hears the first run only', async () => {
    // `attempts: 1` stops retries of a FAILED job. A job whose worker was killed
    // mid-turn (OOM, a hard deploy) is "stalled" instead, and BullMQ re-queues it
    // whatever `attempts` says — same payload, so the same relay descriptor.
    const invoke = vi.fn(async (_queue: string, _job: string, payload: Record<string, unknown>) => {
      // 1st execution: streams "The databa", then its process is gone — no `end`, no result.
      const dead = await openWorkerRelay(readRelayDescriptor(payload)!, transport);
      dead!.emit('text', 'The databa');
      await transport.idle(); // the caller has heard it, so it follows this run
      // Stall recovery: another worker runs the SAME job from the start.
      return withWorkerRelay(payload, async (relay) => {
        relay!.emit('tool', { phase: 'start', name: 'lookup' });
        relay!.emit('text', 'The database is down.');
        return { content: 'The database is down.' };
      });
    });
    hoisted.getQueue.mockResolvedValue({ name: 'bullmq', invoke });
    const seen: string[] = [];
    const started = Date.now();

    const result = await routeInstanceCall(ROUTE, {}, vi.fn(), {
      relay: {
        handlers: {
          text: (d) => seen.push(`text:${String(d)}`),
          tool: (d) => seen.push(`tool:${(d as { name: string }).name}`),
        },
      },
    });

    // The caller got the first run's text once, not "The databaThe database is down.".
    expect(seen).toEqual(['text:The databa']);
    // The re-run's result completes the call (the final-tail check can extend what streamed)...
    expect(result).toEqual({ content: 'The database is down.' });
    // ...and the re-run's `end` ends the wait: the dead run's never comes.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('a routed call without live callbacks keeps the queue default retries', async () => {
    const queue = bullmqQueue(async () => 'ok');
    hoisted.getQueue.mockResolvedValue(queue);
    await routeInstanceCall(ROUTE, { a: 1 }, vi.fn(), { timeoutMs: 5000 });
    expect(queue.invoke.mock.calls[0][3]).toEqual({ timeoutMs: 5000, targetNode: 'node-b' });
  });
});

/* ── Relay primitives ────────────────────────────────────────────────────── */

describe('relay primitives', () => {
  it('relayIsUseful: only when a handler or a signal is present', () => {
    expect(relayIsUseful(undefined)).toBe(false);
    expect(relayIsUseful({ handlers: { text: undefined } })).toBe(false);
    expect(relayIsUseful({ handlers: { text: () => undefined } })).toBe(true);
    expect(relayIsUseful({ handlers: {}, signal: new AbortController().signal })).toBe(true);
  });

  it('readRelayDescriptor refuses malformed ids (a payload cannot pick arbitrary channels)', () => {
    expect(readRelayDescriptor({})).toBeUndefined();
    expect(readRelayDescriptor({ [STREAM_RELAY_PAYLOAD_KEY]: { id: 'short' } })).toBeUndefined();
    expect(readRelayDescriptor({ [STREAM_RELAY_PAYLOAD_KEY]: { id: 'a:b:c:other-channel*' } })).toBeUndefined();
    expect(readRelayDescriptor({ [STREAM_RELAY_PAYLOAD_KEY]: { id: '0f8fad5b-d9cb-469f-a165-70867728950e', events: ['text', 3], cancellable: 'yes' } }))
      .toEqual({ id: '0f8fad5b-d9cb-469f-a165-70867728950e', events: ['text'], cancellable: false });
  });

  it('openCallerRelay with no transport resolves null', async () => {
    await expect(openCallerRelay({ handlers: { text: vi.fn() } }, null)).resolves.toBeNull();
  });

  it('openCallerRelay degrades to null when subscribing fails', async () => {
    const broken: RelayTransport = {
      publish: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };
    await expect(openCallerRelay({ handlers: { text: vi.fn() } }, broken)).resolves.toBeNull();
  });

  it('a subscribe that never completes (Redis unreachable) degrades to null instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      const lateUnsubscribe = vi.fn(async () => undefined);
      let completeLate: (() => void) | undefined;
      const hanging: RelayTransport = {
        publish: vi.fn(async () => undefined),
        subscribe: vi.fn(() => new Promise<() => Promise<void>>((resolve) => {
          completeLate = () => resolve(lateUnsubscribe);
        })),
      };
      const pending = openCallerRelay({ handlers: { text: vi.fn() } }, hanging);
      await vi.advanceTimersByTimeAsync(2_100);
      await expect(pending).resolves.toBeNull();
      // A subscription that finally lands after the deadline is undone.
      completeLate!();
      await vi.advanceTimersByTimeAsync(0);
      expect(lateUnsubscribe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the worker\'s close() does not wait forever on a publish that never completes', async () => {
    vi.useFakeTimers();
    try {
      const stuck: RelayTransport = {
        publish: vi.fn(() => new Promise<void>(() => undefined)),
        subscribe: vi.fn(async () => async () => undefined),
      };
      const worker = await openWorkerRelay({ id: '0f8fad5b-d9cb-469f-a165-70867728950e', events: ['text'], cancellable: true }, stuck);
      worker!.emit('text', 'x');
      const closing = worker!.close();
      await vi.advanceTimersByTimeAsync(2_100);
      await expect(closing).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the worker publishes only after `ready`, and `end` after every event', async () => {
    const caller = await openCallerRelay({ handlers: { text: vi.fn() } }, transport);
    const worker = await openWorkerRelay(caller!.descriptor, transport);
    worker!.emit('text', 'x');
    await worker!.close();
    worker!.emit('text', 'after close'); // ignored
    const kinds = transport.published.map((p) => p.frame.k);
    expect(kinds).toEqual(['ready', 'event', 'end']);
    await caller!.finish();
  });

  it('a non-cancellable descriptor gets no signal and no down-channel subscription', async () => {
    const caller = await openCallerRelay({ handlers: { text: vi.fn() } }, transport);
    const worker = await openWorkerRelay(caller!.descriptor, transport);
    expect(worker!.signal).toBeUndefined();
    expect(transport.subscribed.some((c) => c.endsWith(':down'))).toBe(false);
    await worker!.close();
    await caller!.close();
  });

  it('withWorkerRelay without a descriptor runs with relay = null and the payload as is', async () => {
    const run = vi.fn(async (relay: WorkerRelay | null, data: Record<string, unknown>) => ({ relay, data }));
    await expect(withWorkerRelay({ a: 1 }, run)).resolves.toEqual({ relay: null, data: { a: 1 } });
    expect(transport.published).toEqual([]);
  });

  describe('one job, more than one execution', () => {
    const upFrames = () => transport.published.filter((p) => p.channel.endsWith(':up')).map((p) => p.frame);

    it('every frame a worker publishes names the execution that sent it; a re-run gets a run id of its own', async () => {
      const caller = await openCallerRelay({ handlers: { text: vi.fn() } }, transport);
      const first = await openWorkerRelay(caller!.descriptor, transport);
      first!.emit('text', 'a');
      await first!.close();
      const rerun = await openWorkerRelay(caller!.descriptor, transport);
      await rerun!.close();

      const frames = upFrames();
      const runs = new Set(frames.map((f) => f.run));
      expect(frames.every((f) => typeof f.run === 'string' && f.run.length > 0)).toBe(true);
      expect(runs.size).toBe(2);
      // Within one execution the id never changes.
      expect(frames.slice(0, 3).map((f) => f.run)).toEqual(Array(3).fill(frames[0].run));
      await caller!.close();
    });

    it('the caller follows the first run it hears from and drops the frames of any other', async () => {
      const seen: string[] = [];
      const caller = await openCallerRelay({ handlers: { text: (d) => seen.push(String(d)) } }, transport);
      const first = await openWorkerRelay(caller!.descriptor, transport);
      const rerun = await openWorkerRelay(caller!.descriptor, transport);
      await transport.idle(); // both `ready` frames delivered: the caller follows the first
      first!.emit('text', 'The databa');
      rerun!.emit('text', 'The database is down.');
      first!.emit('text', 'se');
      rerun!.emit('text', ' (re-run)');
      await transport.idle();
      expect(seen).toEqual(['The databa', 'se']);
      await first!.close();
      await rerun!.close();
      await caller!.close();
    });

    it('a re-run that speaks first is the one followed (the first run never got a frame out)', async () => {
      const seen: string[] = [];
      const caller = await openCallerRelay({ handlers: { text: (d) => seen.push(String(d)) } }, transport);
      const rerun = await openWorkerRelay(caller!.descriptor, transport);
      rerun!.emit('text', 'whole answer');
      await transport.idle();
      expect(seen).toEqual(['whole answer']);
      await rerun!.close();
      await caller!.close();
    });

    it('a finished re-run ends the caller\'s wait; it does not sit out the grace period for a run that died', async () => {
      const caller = await openCallerRelay({ handlers: { text: vi.fn() } }, transport);
      const dead = await openWorkerRelay(caller!.descriptor, transport); // never closes: its process is gone
      dead!.emit('text', 'x');
      const rerun = await openWorkerRelay(caller!.descriptor, transport);
      await rerun!.close(); // publishes its `end`
      await transport.idle(); // delivered: the caller has what it waits for
      const started = Date.now();
      await caller!.finish();
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('a cancel the caller already sent is repeated to a re-run once that announces itself', async () => {
      const controller = new AbortController();
      const caller = await openCallerRelay({ handlers: { text: vi.fn() }, signal: controller.signal }, transport);
      controller.abort(); // before any worker is listening: lost
      const first = await openWorkerRelay(caller!.descriptor, transport);
      await transport.idle(); // its `ready` reached the caller, whose repeated cancel came back
      expect(first!.signal!.aborted).toBe(true);
      // The job is re-queued after the first run died; the re-run subscribes late.
      const rerun = await openWorkerRelay(caller!.descriptor, transport);
      await transport.idle();
      expect(rerun!.signal!.aborted).toBe(true);
      await first!.close();
      await rerun!.close();
      await caller!.close();
    });

    it('a frame that carries no run id is not one of ours and is ignored', async () => {
      const seen: string[] = [];
      const caller = await openCallerRelay({ handlers: { text: (d) => seen.push(String(d)) } }, transport);
      const up = `relay:${caller!.descriptor.id}:up`;
      await transport.publish(up, JSON.stringify({ k: 'event', name: 'text', data: 'forged' }));
      await transport.publish(up, JSON.stringify({ k: 'event', run: '', name: 'text', data: 'forged' }));
      await transport.idle(); // both forged frames delivered — and ignored
      expect(seen).toEqual([]);
      await caller!.close();
    });
  });

  it('finish() waits for the worker\'s `end` so trailing frames are replayed first', async () => {
    const seen: string[] = [];
    const caller = await openCallerRelay({ handlers: { text: (d) => seen.push(String(d)) } }, transport);
    const worker = await openWorkerRelay(caller!.descriptor, transport);
    await transport.idle(); // `ready` delivered
    worker!.emit('text', 'late');
    void worker!.close();
    // The result "arrived" right now — before the frames were delivered.
    await caller!.finish();
    expect(seen).toEqual(['late']);
  });
});
