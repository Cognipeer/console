/**
 * Agent queue consumer.
 *
 * Registers a handler on the cluster.agent queue that invokes the local
 * (non-routed) entry points. Producer side stays in agentService.ts;
 * this module only matters when an assignment routes work to another
 * node via BullMQ.
 *
 * A routed chat/playground turn may carry a stream-relay descriptor: the
 * caller's `onTextChunk` / `onToolEvent` / `onCompaction` and its abort
 * signal, bridged over Redis pub/sub (`withWorkerRelay`). The local entry
 * point then runs with callbacks that publish back to the caller, and with a
 * signal the caller's cancel aborts.
 *
 * Agent runs have queues of their own: `agent-runs` (default class,
 * `AGENT_RUN_CONCURRENCY`), `agent-runs-deferred` (`AGENT_DEFERRED_CONCURRENCY`)
 * and `agent-run-callbacks` (`AGENT_RUN_CALLBACK_CONCURRENCY`). The run
 * consumers' handles are kept: the shutdown drain pauses them before it waits
 * for the runs executing here.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type JobWorker, type QueuePayload } from '@/lib/core/queue';
import { registerShutdownHandler } from '@/lib/core/lifecycle';
import { queueNameFor, withWorkerRelay } from '@/lib/core/cluster';
import {
  agentRelayCallbacks,
  executeAgentChatLocal,
  executePlaygroundChatLocal,
  type AgentChatRequest,
  type AgentPlaygroundChatRequest,
} from './agentService';
import { getConfig } from '@/lib/core/config';
import {
  AGENT_RUN_CALLBACK_QUEUE,
  AGENT_RUN_DEFERRED_QUEUE,
  AGENT_RUN_QUEUE,
  deliverAgentRunCallbackJob,
  drainLocalAgentRuns,
  runAgentJobLocal,
} from './agentRunService';

const log = createLogger('agent.consumer');
let started = false;
/** The run consumers (default + deferred), paused by the shutdown drain. */
const runWorkers: JobWorker[] = [];

type RunJobPayload = Parameters<typeof runAgentJobLocal>[0];
type CallbackJobPayload = Parameters<typeof deliverAgentRunCallbackJob>[0];

/** `run` = a new turn, `resume` = a run queued to continue a paused turn (the worker reads which from the row). */
function runJobHandler(queueName: string, deferred: boolean) {
  return async (ctx: JobContext<QueuePayload>) => {
    if (ctx.name === 'run' || ctx.name === 'resume') {
      const payload = ctx.data as unknown as RunJobPayload;
      return runAgentJobLocal(deferred ? { ...payload, runClass: 'deferred' } : payload);
    }
    // Callback jobs published before callbacks got their own queue.
    if (ctx.name === 'callback') return deliverAgentRunCallbackJob(ctx.data as unknown as CallbackJobPayload);
    throw new Error(`Unknown ${queueName} job: ${ctx.name}`);
  };
}

let draining: Promise<void> | null = null;

/**
 * Shutdown (§4.8): stop taking runs, give the ones executing here (inline
 * turns and queue workers) `AGENT_RUN_DRAIN_TIMEOUT_MS` to finish, then mark
 * the rest interrupted with their notifications — an inline run's caller is
 * answered with that outcome, which ends its stream. Runs once per process:
 * the HTTP server's close calls it before it waits for open connections (an
 * open stream would otherwise keep the drain from ever starting), and the
 * `agent-runs` shutdown handler gets the same drain.
 */
export function drainAgentRunConsumers(): Promise<void> {
  draining ??= (async () => {
    await Promise.all(runWorkers.map((worker) => worker.pause().catch((error) => {
      log.warn('Could not pause an agent run consumer', {
        queueName: worker.queueName,
        error: error instanceof Error ? error.message : String(error),
      });
    })));
    await drainLocalAgentRuns(getConfig().agent.runDrainTimeoutMs);
  })();
  return draining;
}

/** Test seam: the next `drainAgentRunConsumers` drains again. */
export function resetAgentRunDrainForTests(): void {
  draining = null;
}

export async function startAgentQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  // Concurrent agent turns per node (`AGENT_CHAT_CONCURRENCY`). These jobs are
  // LLM round-trips — almost entirely I/O wait — so serialising them head-of-line
  // blocked every cross-node turn behind the slowest one, and the queue's 60s
  // invoke timeout then failed the ones still waiting.
  const chatConcurrency = getConfig().agent.chatConcurrency;
  queue.consume(queueNameFor('agent'), async (ctx: JobContext<QueuePayload>) => {
    if (ctx.name === 'chat') {
      return withWorkerRelay(ctx.data, (relay, data) => {
        // `onTextChunk`, `onReasoningChunk` + `signal` are all a chat turn takes;
        // tool/compaction events are a playground-only surface.
        const { onTextChunk, onReasoningChunk, signal } = agentRelayCallbacks(relay);
        return executeAgentChatLocal({
          ...(data as unknown as AgentChatRequest),
          ...(onTextChunk ? { onTextChunk } : {}),
          ...(onReasoningChunk ? { onReasoningChunk } : {}),
          ...(signal ? { signal } : {}),
        });
      });
    }
    if (ctx.name === 'playground') {
      return withWorkerRelay(ctx.data, (relay, data) => executePlaygroundChatLocal({
        ...(data as unknown as AgentPlaygroundChatRequest),
        ...agentRelayCallbacks(relay),
      }));
    }
    throw new Error(`Unknown agent job: ${ctx.name}`);
  }, { concurrency: chatConcurrency });

  // Runs, with their own concurrency: a run can take 30 minutes, and sharing
  // the chat queue's slots blocked chat. Deferred runs get their own share.
  const agent = getConfig().agent;
  runWorkers.push(
    queue.consume(AGENT_RUN_QUEUE, runJobHandler(AGENT_RUN_QUEUE, false), { concurrency: agent.runConcurrency }),
    queue.consume(AGENT_RUN_DEFERRED_QUEUE, runJobHandler(AGENT_RUN_DEFERRED_QUEUE, true), { concurrency: agent.deferredConcurrency }),
  );
  // Callbacks take seconds; behind 30-minute runs they waited for a free slot.
  queue.consume(AGENT_RUN_CALLBACK_QUEUE, async (ctx: JobContext<QueuePayload>) => {
    if (ctx.name === 'callback') return deliverAgentRunCallbackJob(ctx.data as unknown as CallbackJobPayload);
    throw new Error(`Unknown ${AGENT_RUN_CALLBACK_QUEUE} job: ${ctx.name}`);
  }, { concurrency: agent.runCallbackConcurrency });
  // Registered after the queue and database handlers, so (LIFO) it runs before them.
  registerShutdownHandler('agent-runs', drainAgentRunConsumers);
  started = true;
  log.info('Agent queue consumer registered', {
    concurrency: chatConcurrency,
    runConcurrency: agent.runConcurrency,
    deferredConcurrency: agent.deferredConcurrency,
    callbackConcurrency: agent.runCallbackConcurrency,
  });
}
