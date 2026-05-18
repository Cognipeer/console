/**
 * Queue Provider Interface
 *
 * A minimal job-queue abstraction. Two drivers ship in-tree:
 *
 *   - `memory`  — in-process, no persistence. Default when Redis is
 *                 absent; ideal for small/dev deployments.
 *   - `bullmq`  — Redis-backed via BullMQ. Auto-selected when Redis
 *                 is configured; survives restarts, supports
 *                 cross-node routing.
 *
 * Selection is hidden behind `getQueue()`; consumers always program
 * to this interface.
 *
 * Routing semantics
 * -----------------
 * Each `(queueName, targetNode)` pair maps to a distinct underlying
 * channel. Producers specify `targetNode` to address a specific node.
 * Consumers always read from `${queueName}:${thisNode}` plus the
 * shared `${queueName}` "auto" channel.
 */

export type QueuePayload = Record<string, unknown>;

export interface JobOptions {
  /** Target node name. Omit or pass 'auto' to load-balance across nodes. */
  targetNode?: string;
  /** Max attempts including the first run. */
  attempts?: number;
  /** Initial backoff between retries (ms); doubles each retry. */
  backoffMs?: number;
  /** Delay before the job becomes available. */
  delayMs?: number;
  /** Dedup key: jobs with the same key are deduplicated. */
  dedupKey?: string;
}

export interface InvokeOptions extends JobOptions {
  /** Max time to wait for the job result. Defaults to 60s. */
  timeoutMs?: number;
}

export interface JobContext<T = QueuePayload> {
  name: string;
  data: T;
  attemptsMade: number;
  /** Underlying job id assigned by the driver. */
  id: string;
}

export type JobHandler<T = QueuePayload, R = unknown> = (
  ctx: JobContext<T>,
) => Promise<R>;

export interface JobWorker {
  pause(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
  readonly queueName: string;
}

export interface QueueProvider {
  /** Driver name. */
  readonly name: 'memory' | 'bullmq';

  init(): Promise<void>;
  destroy(): Promise<void>;

  /** Fire-and-forget. Returns the job id. */
  publish<T extends QueuePayload>(
    queueName: string,
    jobName: string,
    payload: T,
    opts?: JobOptions,
  ): Promise<string>;

  /**
   * RPC-style enqueue. Resolves with the job's return value or rejects
   * if it errors / times out. Memory driver runs the handler directly
   * when one is registered locally; BullMQ uses waitUntilFinished().
   */
  invoke<T extends QueuePayload, R = unknown>(
    queueName: string,
    jobName: string,
    payload: T,
    opts?: InvokeOptions,
  ): Promise<R>;

  /**
   * Register this node as a consumer for `queueName`. Returns a worker
   * handle for lifecycle management. Calling multiple times for the
   * same queue + node is a no-op (single worker per queue per node).
   */
  consume<T extends QueuePayload, R = unknown>(
    queueName: string,
    handler: JobHandler<T, R>,
    opts?: { concurrency?: number },
  ): JobWorker;

  /** Whether the current process owns a local consumer for `queueName`. */
  hasLocalConsumer(queueName: string): boolean;
}
