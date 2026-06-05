/**
 * Job Queue — provider-based, auto-selection.
 *
 * QUEUE_PROVIDER:
 *   - auto    (default) → bullmq when Redis is configured, otherwise memory.
 *   - memory  → in-process driver (no persistence, no cross-node routing).
 *   - bullmq  → Redis-backed; requires QUEUE_REDIS_URL or REDIS_URL.
 *
 * Usage:
 *   import { getQueue } from '@/lib/core/queue';
 *   const q = await getQueue();
 *   await q.publish('audit-log', 'create', { ... });
 *   const result = await q.invoke('agent', 'execute', { agentId, input });
 *   q.consume('agent', async ({ data }) => runAgent(data));
 */

import { getConfig } from '../config';
import { createLogger } from '../logger';
import { MemoryQueueProvider } from './memoryQueueProvider';
import type { QueueProvider } from './queueProvider.interface';

export type { QueueProvider } from './queueProvider.interface';
export type {
  JobOptions,
  InvokeOptions,
  JobHandler,
  JobContext,
  JobWorker,
  QueuePayload,
} from './queueProvider.interface';

const log = createLogger('queue');

let instance: QueueProvider | null = null;
let initPromise: Promise<QueueProvider> | null = null;

function resolveRedisUrl(): string {
  const cfg = getConfig();
  return cfg.queue.redis.url || cfg.cache.redis.url || '';
}

function shouldUseBullMQ(): boolean {
  const cfg = getConfig();
  if (cfg.queue.provider === 'bullmq') return true;
  if (cfg.queue.provider === 'memory') return false;
  return resolveRedisUrl().length > 0; // auto
}

async function createProvider(): Promise<QueueProvider> {
  const cfg = getConfig();

  if (shouldUseBullMQ()) {
    const redisUrl = resolveRedisUrl();
    if (!redisUrl) {
      throw new Error('QUEUE_PROVIDER=bullmq requires QUEUE_REDIS_URL or REDIS_URL');
    }
    // Lazy import: BullMQ pulls in ioredis + native deps. Loading it only
    // when actually selected keeps cold-start cheap for memory-only deploys.
    const { BullMQQueueProvider } = await import('./bullmqQueueProvider');
    return new BullMQQueueProvider({
      redisUrl,
      prefix: cfg.queue.redis.prefix,
      defaultAttempts: cfg.queue.defaultAttempts,
      defaultBackoffMs: cfg.queue.defaultBackoffMs,
    });
  }

  return new MemoryQueueProvider({
    attempts: cfg.queue.defaultAttempts,
    backoffMs: cfg.queue.defaultBackoffMs,
  });
}

/** Get the active queue provider (singleton). Initialized on first call. */
export async function getQueue(): Promise<QueueProvider> {
  if (instance) return instance;
  if (!initPromise) {
    initPromise = (async () => {
      const provider = await createProvider();
      await provider.init();
      instance = provider;
      log.info(`Queue provider initialized: ${provider.name}`);
      return provider;
    })();
  }
  return initPromise;
}

/** Tear down the queue provider (for graceful shutdown / tests). */
export async function destroyQueue(): Promise<void> {
  if (!instance) return;
  await instance.destroy();
  instance = null;
  initPromise = null;
}
