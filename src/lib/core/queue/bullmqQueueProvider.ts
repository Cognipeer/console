/**
 * BullMQ-backed queue provider.
 *
 * Each `(queueName, targetNode)` maps to a distinct BullMQ Queue named
 * `${prefix}${queueName}:${targetNode}`. The shared "auto" channel is
 * `${prefix}${queueName}` (no node suffix). Consumers register on
 * `${queueName}:${thisNode}` and on the shared channel — both at once
 * so the node accepts both targeted and load-balanced jobs.
 */

import { Queue, QueueEvents, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { createLogger } from '../logger';
import { getThisNodeName } from '../cluster/nodeRegistry';
import type {
  InvokeOptions,
  JobContext,
  JobHandler,
  JobOptions,
  JobWorker,
  QueueProvider,
  QueuePayload,
} from './queueProvider.interface';

const log = createLogger('queue.bullmq');

const AUTO_NODE = 'auto';

interface BullMQConfig {
  redisUrl: string;
  prefix: string;
  defaultAttempts: number;
  defaultBackoffMs: number;
}

export class BullMQQueueProvider implements QueueProvider {
  readonly name = 'bullmq' as const;

  private readonly cfg: BullMQConfig;
  private connection: Redis | null = null;
  private subscriberConnection: Redis | null = null;
  private readonly queues = new Map<string, Queue>(); // key = bullmq queue name
  private readonly events = new Map<string, QueueEvents>();
  private readonly workers = new Map<string, Worker>(); // key = bullmq queue name
  private readonly localConsumerLogicalNames = new Set<string>(); // logical queue names with a local consumer
  private destroyed = false;

  constructor(cfg: BullMQConfig) {
    this.cfg = cfg;
  }

  async init(): Promise<void> {
    this.connection = this.createConnection();
    this.subscriberConnection = this.createConnection();
    // No-op until first publish/consume — keeps boot cheap on idle nodes.
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    for (const worker of this.workers.values()) {
      await worker.close().catch((err) => log.warn('Worker close failed', { err: String(err) }));
    }
    this.workers.clear();
    for (const events of this.events.values()) {
      await events.close().catch((err) => log.warn('QueueEvents close failed', { err: String(err) }));
    }
    this.events.clear();
    for (const queue of this.queues.values()) {
      await queue.close().catch((err) => log.warn('Queue close failed', { err: String(err) }));
    }
    this.queues.clear();
    if (this.connection) {
      this.connection.disconnect();
      this.connection = null;
    }
    if (this.subscriberConnection) {
      this.subscriberConnection.disconnect();
      this.subscriberConnection = null;
    }
  }

  async publish<T extends QueuePayload>(
    queueName: string,
    jobName: string,
    payload: T,
    opts: JobOptions = {},
  ): Promise<string> {
    const bullmqQueueName = this.resolveBullMQQueueName(queueName, opts.targetNode);
    const queue = this.getOrCreateQueue(bullmqQueueName);
    const job = await queue.add(jobName, payload, this.buildAddOptions(opts));
    return String(job.id ?? '');
  }

  async invoke<T extends QueuePayload, R = unknown>(
    queueName: string,
    jobName: string,
    payload: T,
    opts: InvokeOptions = {},
  ): Promise<R> {
    const bullmqQueueName = this.resolveBullMQQueueName(queueName, opts.targetNode);
    const queue = this.getOrCreateQueue(bullmqQueueName);
    const events = this.getOrCreateQueueEvents(bullmqQueueName);
    const job = await queue.add(jobName, payload, this.buildAddOptions(opts));
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return (await job.waitUntilFinished(events, timeoutMs)) as R;
  }

  consume<T extends QueuePayload, R = unknown>(
    queueName: string,
    handler: JobHandler<T, R>,
    opts: { concurrency?: number } = {},
  ): JobWorker {
    const nodeName = getThisNodeName();
    const targetedQueueName = this.bullmqName(queueName, nodeName);
    const autoQueueName = this.bullmqName(queueName, AUTO_NODE);

    // One Worker per (queueName, channel) pair, since each Worker is bound
    // to a single BullMQ queue name.
    const erasedHandler = handler as JobHandler;
    this.registerWorker(queueName, targetedQueueName, erasedHandler, opts.concurrency ?? 1);
    this.registerWorker(queueName, autoQueueName, erasedHandler, opts.concurrency ?? 1);
    this.localConsumerLogicalNames.add(queueName);

    const workers = this.workers;
    const localConsumerLogicalNames = this.localConsumerLogicalNames;
    return {
      queueName,
      pause: async () => {
        const a = workers.get(targetedQueueName);
        const b = workers.get(autoQueueName);
        await Promise.all([a?.pause(true), b?.pause(true)]);
      },
      resume: async () => {
        const a = workers.get(targetedQueueName);
        const b = workers.get(autoQueueName);
        await Promise.all([a?.resume(), b?.resume()]);
      },
      close: async () => {
        const a = workers.get(targetedQueueName);
        const b = workers.get(autoQueueName);
        await Promise.all([a?.close(), b?.close()]);
        workers.delete(targetedQueueName);
        workers.delete(autoQueueName);
        localConsumerLogicalNames.delete(queueName);
      },
    };
  }

  hasLocalConsumer(queueName: string): boolean {
    return this.localConsumerLogicalNames.has(queueName);
  }

  // ── Internals ─────────────────────────────────────────────────────

  private createConnection(): Redis {
    return new Redis(this.cfg.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }

  private connectionOptions(): ConnectionOptions {
    if (!this.connection) {
      throw new Error('BullMQ provider not initialized');
    }
    return this.connection;
  }

  private bullmqName(logicalQueueName: string, nodeName: string): string {
    if (!nodeName || nodeName === AUTO_NODE) {
      return `${this.cfg.prefix}${logicalQueueName}`;
    }
    return `${this.cfg.prefix}${logicalQueueName}:${nodeName}`;
  }

  private resolveBullMQQueueName(logicalQueueName: string, targetNode?: string): string {
    const node = targetNode && targetNode !== AUTO_NODE ? targetNode : AUTO_NODE;
    return this.bullmqName(logicalQueueName, node);
  }

  private buildAddOptions(opts: JobOptions) {
    return {
      attempts: opts.attempts ?? this.cfg.defaultAttempts,
      backoff: {
        type: 'exponential' as const,
        delay: opts.backoffMs ?? this.cfg.defaultBackoffMs,
      },
      delay: opts.delayMs,
      removeOnComplete: { age: 3_600 },
      removeOnFail: { age: 24 * 3_600 },
      jobId: opts.dedupKey,
    };
  }

  private getOrCreateQueue(bullmqQueueName: string): Queue {
    const existing = this.queues.get(bullmqQueueName);
    if (existing) return existing;
    const queue = new Queue(bullmqQueueName, { connection: this.connectionOptions() });
    this.queues.set(bullmqQueueName, queue);
    return queue;
  }

  private getOrCreateQueueEvents(bullmqQueueName: string): QueueEvents {
    const existing = this.events.get(bullmqQueueName);
    if (existing) return existing;
    if (!this.subscriberConnection) {
      throw new Error('BullMQ subscriber connection not initialized');
    }
    const events = new QueueEvents(bullmqQueueName, { connection: this.subscriberConnection });
    this.events.set(bullmqQueueName, events);
    return events;
  }

  private registerWorker(
    logicalQueueName: string,
    bullmqQueueName: string,
    handler: JobHandler,
    concurrency: number,
  ): void {
    if (this.workers.has(bullmqQueueName)) return;
    const worker = new Worker(
      bullmqQueueName,
      async (job: Job) => {
        const ctx: JobContext = {
          id: String(job.id ?? ''),
          name: job.name,
          data: job.data as QueuePayload,
          attemptsMade: job.attemptsMade,
        };
        return handler(ctx);
      },
      {
        concurrency,
        connection: this.connectionOptions(),
      },
    );

    worker.on('failed', (job, err) => {
      log.warn('BullMQ job failed', {
        queue: bullmqQueueName,
        logicalQueueName,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        error: err?.message,
      });
    });

    worker.on('error', (err) => {
      if (this.destroyed) return;
      log.error('BullMQ worker error', {
        queue: bullmqQueueName,
        error: err?.message,
      });
    });

    this.workers.set(bullmqQueueName, worker);
    log.info('BullMQ worker registered', {
      logicalQueueName,
      bullmqQueueName,
      concurrency,
    });
  }
}
