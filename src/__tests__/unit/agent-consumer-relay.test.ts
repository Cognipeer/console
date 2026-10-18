/**
 * The agent queue consumer (the WORKER of a routed turn) opens the stream
 * relay a payload asks for and runs the local entry point with callbacks that
 * publish back to the caller — and only those the caller listens for.
 *
 * The local entry points are faked; `agentRelayCallbacks` is the real one, so
 * the event names on both ends of the relay are exercised together. The relay
 * runs on an in-memory pub/sub.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: { name: string; data: Record<string, unknown> }) => Promise<unknown>>(),
  concurrency: new Map<string, number | undefined>(),
  workers: new Map<string, { queueName: string; pause: ReturnType<typeof vi.fn> }>(),
  shutdown: new Map<string, () => Promise<void>>(),
  runAgentJobLocal: vi.fn(),
  deliverAgentRunCallbackJob: vi.fn(),
  drainLocalAgentRuns: vi.fn(),
  executePlaygroundChatLocal: vi.fn(),
  executeAgentChatLocal: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/core/queue', () => ({
  getQueue: async () => ({
    name: 'bullmq',
    consume: (
      queueName: string,
      handler: (ctx: { name: string; data: Record<string, unknown> }) => Promise<unknown>,
      opts?: { concurrency?: number },
    ) => {
      hoisted.handlers.set(queueName, handler);
      hoisted.concurrency.set(queueName, opts?.concurrency);
      const worker = { queueName, pause: vi.fn(async () => undefined), resume: vi.fn(), close: vi.fn() };
      hoisted.workers.set(queueName, worker);
      return worker;
    },
  }),
}));

vi.mock('@/lib/services/agents/agentRunService', () => ({
  AGENT_RUN_QUEUE: 'agent-runs',
  AGENT_RUN_DEFERRED_QUEUE: 'agent-runs-deferred',
  AGENT_RUN_CALLBACK_QUEUE: 'agent-run-callbacks',
  runAgentJobLocal: hoisted.runAgentJobLocal,
  deliverAgentRunCallbackJob: hoisted.deliverAgentRunCallbackJob,
  drainLocalAgentRuns: hoisted.drainLocalAgentRuns,
}));

vi.mock('@/lib/core/lifecycle', () => ({
  registerShutdownHandler: (name: string, fn: () => Promise<void>) => { hoisted.shutdown.set(name, fn); },
}));

vi.mock('@/lib/services/agents/agentService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentService')>();
  return {
    ...actual,
    executePlaygroundChatLocal: hoisted.executePlaygroundChatLocal,
    executeAgentChatLocal: hoisted.executeAgentChatLocal,
  };
});

import { startAgentQueueConsumer } from '@/lib/services/agents/agentConsumer';
import { getConfig } from '@/lib/core/config';
import {
  STREAM_RELAY_PAYLOAD_KEY,
  openCallerRelay,
  setRelayTransportForTests,
  type RelayTransport,
} from '@/lib/core/cluster';

function memoryTransport(): RelayTransport {
  const listeners = new Map<string, Set<(m: string) => void>>();
  return {
    async publish(channel, message) {
      const targets = [...(listeners.get(channel) ?? [])];
      setTimeout(() => targets.forEach((fn) => fn(message)), 0);
    },
    async subscribe(channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(fn);
      return async () => {
        listeners.get(channel)?.delete(fn);
      };
    },
  };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE = {
  tenantDbName: 'tenant_acme',
  tenantId: 'tenant-acme',
  projectId: 'proj-1',
  agentKey: 'voice-agent',
  userMessage: 'hello',
};

let transport: RelayTransport;

beforeEach(async () => {
  vi.clearAllMocks();
  transport = memoryTransport();
  setRelayTransportForTests(transport);
  await startAgentQueueConsumer();
});

afterEach(() => {
  setRelayTransportForTests(undefined);
});

function handler() {
  const h = hoisted.handlers.get('cluster.agent');
  expect(h).toBeTypeOf('function');
  return h!;
}

describe('agent queue consumer + stream relay', () => {
  it('playground job: callbacks publish back to the caller and the caller\'s abort reaches the run', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const caller = await openCallerRelay({
      handlers: {
        text: (d) => seen.push(`text:${String(d)}`),
        tool: (d) => seen.push(`tool:${(d as { name: string }).name}`),
      },
      signal: controller.signal,
    });

    hoisted.executePlaygroundChatLocal.mockImplementation(async (request: Record<string, unknown>) => {
      expect(request).not.toHaveProperty(STREAM_RELAY_PAYLOAD_KEY);
      expect(request).not.toHaveProperty('onCompaction'); // the caller did not ask for it
      (request.onToolEvent as (e: unknown) => void)({ phase: 'start', name: 'search' });
      (request.onTextChunk as (t: string) => void)('Hel');
      (request.onTextChunk as (t: string) => void)('lo');
      const signal = request.signal as AbortSignal;
      await tick(); // frames delivered; the caller aborts now
      controller.abort();
      await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve())));
      return { content: 'Hello', stopReason: 'cancelled' };
    });

    const result = await handler()({
      name: 'playground',
      data: { ...BASE, [STREAM_RELAY_PAYLOAD_KEY]: caller!.descriptor },
    });
    await caller!.finish();

    expect(hoisted.executePlaygroundChatLocal).toHaveBeenCalledOnce();
    expect(result).toEqual({ content: 'Hello', stopReason: 'cancelled' });
    expect(seen).toEqual(['tool:search', 'text:Hel', 'text:lo']);
  });

  it('chat job: only onTextChunk and signal are wired', async () => {
    const caller = await openCallerRelay({
      handlers: { text: vi.fn(), tool: vi.fn() },
      signal: new AbortController().signal,
    });
    hoisted.executeAgentChatLocal.mockImplementation(async (request: Record<string, unknown>) => {
      expect(typeof request.onTextChunk).toBe('function');
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request).not.toHaveProperty('onToolEvent');
      return { id: 'resp' };
    });
    await handler()({ name: 'chat', data: { ...BASE, conversationId: 'c1', [STREAM_RELAY_PAYLOAD_KEY]: caller!.descriptor } });
    await caller!.close();
    expect(hoisted.executeAgentChatLocal).toHaveBeenCalledOnce();
  });

  it('a payload without a descriptor runs exactly as before (no callbacks, no signal)', async () => {
    hoisted.executePlaygroundChatLocal.mockResolvedValue({ content: 'ok' });
    await handler()({ name: 'playground', data: { ...BASE } });
    expect(hoisted.executePlaygroundChatLocal).toHaveBeenCalledWith({ ...BASE });
  });

  it('unknown jobs still fail loudly', async () => {
    await expect(handler()({ name: 'nope', data: {} })).rejects.toThrow(/Unknown agent job/);
  });
});

describe('agent run queues', () => {
  const run = (queueName: string) => hoisted.handlers.get(queueName)!;

  it('registers the default, deferred and callback queues with their own concurrency', () => {
    const agent = getConfig().agent;
    expect(hoisted.concurrency.get('agent-runs')).toBe(agent.runConcurrency);
    expect(hoisted.concurrency.get('agent-runs-deferred')).toBe(agent.deferredConcurrency);
    expect(hoisted.concurrency.get('agent-run-callbacks')).toBe(agent.runCallbackConcurrency);
  });

  it('a deferred-queue job reaches the worker marked deferred (its claim guard); a default one does not', async () => {
    const payload = { runId: 'r1', tenantId: 't', tenantDbName: 'tenant_t' };
    await run('agent-runs-deferred')({ name: 'run', data: payload });
    expect(hoisted.runAgentJobLocal).toHaveBeenLastCalledWith({ ...payload, runClass: 'deferred' });
    await run('agent-runs')({ name: 'resume', data: payload });
    expect(hoisted.runAgentJobLocal).toHaveBeenLastCalledWith(payload);
  });

  it('callbacks are delivered from their own queue (and from the run queue for jobs queued before the move)', async () => {
    await run('agent-run-callbacks')({ name: 'callback', data: { runId: 'r1' } });
    await run('agent-runs')({ name: 'callback', data: { runId: 'r2' } });
    expect(hoisted.deliverAgentRunCallbackJob).toHaveBeenCalledTimes(2);
    await expect(run('agent-run-callbacks')({ name: 'run', data: {} })).rejects.toThrow(/Unknown agent-run-callbacks job/);
  });

  it('the shutdown drain pauses both run consumers before it waits for the runs executing here', async () => {
    const order: string[] = [];
    hoisted.workers.get('agent-runs')!.pause.mockImplementation(async () => { order.push('pause:agent-runs'); });
    hoisted.workers.get('agent-runs-deferred')!.pause.mockImplementation(async () => { order.push('pause:agent-runs-deferred'); });
    hoisted.drainLocalAgentRuns.mockImplementation(async () => { order.push('drain'); return { settled: 0, interrupted: 0 }; });
    const drain = hoisted.shutdown.get('agent-runs');
    expect(drain).toBeTypeOf('function');
    await drain!();
    expect(order.slice(-1)).toEqual(['drain']);
    expect(order).toEqual(expect.arrayContaining(['pause:agent-runs', 'pause:agent-runs-deferred']));
    expect(hoisted.drainLocalAgentRuns).toHaveBeenCalledWith(getConfig().agent.runDrainTimeoutMs);
  });
});
