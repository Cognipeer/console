/**
 * In-memory queue provider.
 *
 * Single-process driver — producer and consumer share the same Map. No
 * persistence, no cross-node routing: `targetNode` is recorded but
 * ignored when delivering. Retries, delays and dedup keys all work
 * locally; jobs are lost when the process exits.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger';
import type {
  InvokeOptions,
  JobContext,
  JobHandler,
  JobOptions,
  JobWorker,
  QueueProvider,
  QueuePayload,
} from './queueProvider.interface';

const log = createLogger('queue.memory');

interface Job {
  id: string;
  queueName: string;
  jobName: string;
  payload: QueuePayload;
  attempts: number;
  attemptsMade: number;
  backoffMs: number;
  availableAt: number;
  dedupKey?: string;
  resolve?: (value: unknown) => void;
  reject?: (error: Error) => void;
}

interface ConsumerSlot {
  handler: JobHandler;
  concurrency: number;
  active: number;
  paused: boolean;
}

export class MemoryQueueProvider implements QueueProvider {
  readonly name = 'memory' as const;

  private readonly queues = new Map<string, Job[]>();
  private readonly consumers = new Map<string, ConsumerSlot>();
  private readonly dedup = new Map<string, string>(); // dedupKey → jobId
  private readonly defaults: { attempts: number; backoffMs: number };
  private sweepTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(defaults: { attempts: number; backoffMs: number }) {
    this.defaults = defaults;
  }

  async init(): Promise<void> {
    this.sweepTimer = setInterval(() => this.drain(), 25);
    this.sweepTimer.unref();
  }

  async destroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const list of this.queues.values()) {
      for (const job of list) {
        job.reject?.(new Error('Queue shutting down'));
      }
    }
    this.queues.clear();
    this.consumers.clear();
    this.dedup.clear();
  }

  async publish<T extends QueuePayload>(
    queueName: string,
    jobName: string,
    payload: T,
    opts: JobOptions = {},
  ): Promise<string> {
    const job = this.enqueue(queueName, jobName, payload, opts);
    return job.id;
  }

  async invoke<T extends QueuePayload, R = unknown>(
    queueName: string,
    jobName: string,
    payload: T,
    opts: InvokeOptions = {},
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const job = this.enqueue(queueName, jobName, payload, opts);
      job.resolve = resolve as (value: unknown) => void;
      job.reject = reject;

      const timeoutMs = opts.timeoutMs ?? 60_000;
      const timer = setTimeout(() => {
        job.resolve = undefined;
        job.reject = undefined;
        reject(new Error(`Job ${queueName}:${jobName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
    });
  }

  consume<T extends QueuePayload, R = unknown>(
    queueName: string,
    handler: JobHandler<T, R>,
    opts: { concurrency?: number } = {},
  ): JobWorker {
    if (!this.consumers.has(queueName)) {
      this.consumers.set(queueName, {
        handler: handler as JobHandler,
        concurrency: Math.max(opts.concurrency ?? 1, 1),
        active: 0,
        paused: false,
      });
      log.debug('Memory consumer registered', { queueName });
    }
    const slot = this.consumers.get(queueName)!;
    const consumers = this.consumers;
    return {
      queueName,
      pause: async () => { slot.paused = true; },
      resume: async () => { slot.paused = false; },
      close: async () => { consumers.delete(queueName); },
    };
  }

  hasLocalConsumer(queueName: string): boolean {
    return this.consumers.has(queueName);
  }

  // ── Internals ─────────────────────────────────────────────────────

  private enqueue(
    queueName: string,
    jobName: string,
    payload: QueuePayload,
    opts: JobOptions,
  ): Job {
    if (opts.dedupKey) {
      const existingId = this.dedup.get(opts.dedupKey);
      if (existingId) {
        const list = this.queues.get(queueName) ?? [];
        const existing = list.find((j) => j.id === existingId);
        if (existing) return existing;
      }
    }

    const job: Job = {
      id: randomUUID(),
      queueName,
      jobName,
      payload,
      attempts: opts.attempts ?? this.defaults.attempts,
      attemptsMade: 0,
      backoffMs: opts.backoffMs ?? this.defaults.backoffMs,
      availableAt: Date.now() + Math.max(opts.delayMs ?? 0, 0),
      dedupKey: opts.dedupKey,
    };

    if (!this.queues.has(queueName)) this.queues.set(queueName, []);
    this.queues.get(queueName)!.push(job);
    if (opts.dedupKey) this.dedup.set(opts.dedupKey, job.id);

    return job;
  }

  private drain(): void {
    if (this.shuttingDown) return;
    const now = Date.now();
    for (const [queueName, list] of this.queues) {
      const slot = this.consumers.get(queueName);
      if (!slot || slot.paused) continue;
      while (slot.active < slot.concurrency && list.length > 0) {
        const idx = list.findIndex((j) => j.availableAt <= now);
        if (idx === -1) break;
        const [job] = list.splice(idx, 1);
        slot.active += 1;
        void this.runJob(slot, job);
      }
    }
  }

  private async runJob(slot: ConsumerSlot, job: Job): Promise<void> {
    job.attemptsMade += 1;
    const ctx: JobContext = {
      id: job.id,
      name: job.jobName,
      data: job.payload,
      attemptsMade: job.attemptsMade,
    };

    try {
      const result = await slot.handler(ctx);
      job.resolve?.(result);
      if (job.dedupKey) this.dedup.delete(job.dedupKey);
    } catch (error) {
      if (job.attemptsMade < job.attempts) {
        job.availableAt = Date.now() + job.backoffMs * 2 ** (job.attemptsMade - 1);
        const list = this.queues.get(job.queueName) ?? [];
        list.push(job);
      } else {
        const err = error instanceof Error ? error : new Error(String(error));
        log.error('Memory queue job failed permanently', {
          queueName: job.queueName,
          jobName: job.jobName,
          attempts: job.attemptsMade,
          error: err.message,
        });
        job.reject?.(err);
        if (job.dedupKey) this.dedup.delete(job.dedupKey);
      }
    } finally {
      slot.active -= 1;
    }
  }
}
