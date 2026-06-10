/**
 * Batch API service.
 *
 * A Batch is a one-shot bulk inference job (OpenAI `/v1/batches` semantics):
 * a set of chat-completion or embedding requests submitted together — inline
 * or as a JSONL object in a Document Store bucket — and executed
 * asynchronously via per-item queue fan-out (concurrent, multi-node).
 */

import { createLogger } from '@/lib/core/logger';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import type { BatchJobEndpoint, IBatchJob, IBatchJobItem } from '@/lib/database';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { queueNameFor } from '@/lib/core/cluster';
import { downloadFile } from '@/lib/services/files/fileService';
import type { BatchContext, BatchRequestLine, CreateBatchInput } from './types';

const logger = createLogger('batch:service');

/** Hard cap on request lines per batch (overridable via env). */
export const BATCH_MAX_REQUESTS = Math.max(
  1,
  Number(process.env.BATCH_MAX_REQUESTS ?? 10_000) || 10_000,
);

const SUPPORTED_ENDPOINTS: BatchJobEndpoint[] = ['/v1/chat/completions', '/v1/embeddings'];

export class BatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchValidationError';
  }
}

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

export function isSupportedBatchEndpoint(value: unknown): value is BatchJobEndpoint {
  return typeof value === 'string' && (SUPPORTED_ENDPOINTS as string[]).includes(value);
}

/** Validate one request line against the batch endpoint. Throws on problems. */
function validateRequestLine(endpoint: BatchJobEndpoint, line: BatchRequestLine, index: number): void {
  const where = line.customId ? `request "${line.customId}"` : `request at index ${index}`;
  const body = line.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BatchValidationError(`${where}: \`body\` must be an object`);
  }
  if (typeof body.model !== 'string' || body.model.length === 0) {
    throw new BatchValidationError(`${where}: \`body.model\` is required`);
  }
  if (body.stream === true) {
    throw new BatchValidationError(`${where}: streaming is not supported in batches`);
  }
  if (endpoint === '/v1/chat/completions' && !Array.isArray(body.messages)) {
    throw new BatchValidationError(`${where}: \`body.messages\` array is required`);
  }
  if (endpoint === '/v1/embeddings' && body.input === undefined) {
    throw new BatchValidationError(`${where}: \`body.input\` is required`);
  }
}

/**
 * Parse OpenAI batch JSONL: one JSON object per line with
 * `{custom_id?, method?, url?, body}`. `url` (when present) must match the
 * batch endpoint.
 */
export function parseBatchJsonl(content: string, endpoint: BatchJobEndpoint): BatchRequestLine[] {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const requests: BatchRequestLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      throw new BatchValidationError(`Input line ${i + 1} is not valid JSON`);
    }
    const url = parsed.url;
    if (url !== undefined && url !== endpoint) {
      throw new BatchValidationError(
        `Input line ${i + 1}: \`url\` (${String(url)}) does not match the batch endpoint (${endpoint})`,
      );
    }
    const method = parsed.method;
    if (method !== undefined && String(method).toUpperCase() !== 'POST') {
      throw new BatchValidationError(`Input line ${i + 1}: only POST requests are supported`);
    }
    requests.push({
      customId: typeof parsed.custom_id === 'string' ? parsed.custom_id : undefined,
      body: (parsed.body ?? {}) as Record<string, unknown>,
    });
  }
  return requests;
}

/**
 * Create a batch: validate every line up front (the whole submission is
 * rejected on the first invalid line), persist the job + items, then fan out
 * one queue job per item.
 */
export async function createBatch(ctx: BatchContext, input: CreateBatchInput): Promise<IBatchJob> {
  if (!isSupportedBatchEndpoint(input.endpoint)) {
    throw new BatchValidationError(
      `\`endpoint\` must be one of: ${SUPPORTED_ENDPOINTS.join(', ')}`,
    );
  }
  if (!input.requests && !input.inputFile) {
    throw new BatchValidationError('Either `requests` (inline) or `input_file` is required');
  }
  if (input.requests && input.inputFile) {
    throw new BatchValidationError('Provide either `requests` or `input_file`, not both');
  }

  let requests: BatchRequestLine[];
  if (input.requests) {
    requests = input.requests;
  } else {
    const { bucketKey, objectKey } = input.inputFile!;
    if (!bucketKey || !objectKey) {
      throw new BatchValidationError('`input_file.bucket_key` and `input_file.object_key` are required');
    }
    let content: string;
    try {
      const downloaded = await downloadFile(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId ?? '',
        bucketKey,
        objectKey,
      );
      content = downloaded.data.toString('utf8');
    } catch (error) {
      throw new BatchValidationError(
        `Could not read input file: ${error instanceof Error ? error.message : 'download failed'}`,
      );
    }
    requests = parseBatchJsonl(content, input.endpoint);
  }

  if (requests.length === 0) {
    throw new BatchValidationError('Batch contains no requests');
  }
  if (requests.length > BATCH_MAX_REQUESTS) {
    throw new BatchValidationError(
      `Batch exceeds the maximum of ${BATCH_MAX_REQUESTS} requests (got ${requests.length})`,
    );
  }
  requests.forEach((line, index) => validateRequestLine(input.endpoint, line, index));

  const db = await withTenantDb(ctx.tenantDbName);
  const job = await db.createBatchJob({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    endpoint: input.endpoint,
    status: 'in_progress',
    completionWindow: input.completionWindow ?? '24h',
    inputFile: input.inputFile,
    outputFile: input.outputBucketKey ? { bucketKey: input.outputBucketKey, objectKey: undefined } : undefined,
    itemsTotal: requests.length,
    itemsSucceeded: 0,
    itemsFailed: 0,
    itemsCancelled: 0,
    usageInputTokens: 0,
    usageOutputTokens: 0,
    usageTotalTokens: 0,
    metadata: input.metadata,
    createdBy: ctx.userId ?? 'api-token',
    startedAt: new Date(),
  });
  const batchId = String(job._id);

  const items = await db.createBatchJobItems(
    requests.map((line, index) => ({
      tenantId: ctx.tenantId,
      batchId,
      index,
      customId: line.customId,
      requestBody: line.body,
      status: 'pending' as const,
    })),
  );

  const queue = await getQueue();
  for (const item of items) {
    const payload = { ctx, itemId: String(item._id) } as unknown as QueuePayload;
    await queue.publish(queueNameFor('batch'), 'batch.item', payload, {
      attempts: 3,
      backoffMs: 2000,
    });
  }

  logger.info('Batch created', { batchId, endpoint: input.endpoint, items: items.length });
  return job;
}

export async function getBatch(
  ctx: Pick<BatchContext, 'tenantDbName' | 'tenantId'>,
  batchId: string,
): Promise<IBatchJob | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const job = await db.findBatchJobById(batchId);
  if (!job || job.tenantId !== ctx.tenantId) return null;
  return job;
}

export async function listBatches(
  ctx: BatchContext,
  filters?: { status?: string; limit?: number },
): Promise<IBatchJob[]> {
  const db = await withTenantDb(ctx.tenantDbName);
  return db.listBatchJobs(ctx.tenantId, {
    projectId: ctx.projectId,
    status: filters?.status,
    limit: filters?.limit,
  });
}

/**
 * Request cancellation. Pending items are skipped cooperatively by the queue
 * runner (each marks itself cancelled); items already running finish
 * normally. The runner finalizes the batch to `cancelled` once the counters
 * drain.
 */
export async function cancelBatch(
  ctx: Pick<BatchContext, 'tenantDbName' | 'tenantId'>,
  batchId: string,
): Promise<IBatchJob | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const job = await db.findBatchJobById(batchId);
  if (!job || job.tenantId !== ctx.tenantId) return null;
  if (job.status !== 'in_progress' && job.status !== 'validating') {
    throw new BatchValidationError(`Batch is ${job.status}; only in-progress batches can be cancelled`);
  }
  return db.updateBatchJob(batchId, { status: 'cancelling', cancelledAt: new Date() });
}

export async function getBatchItems(
  ctx: Pick<BatchContext, 'tenantDbName' | 'tenantId'>,
  batchId: string,
  options?: { limit?: number; skip?: number; status?: string },
): Promise<IBatchJobItem[] | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const job = await db.findBatchJobById(batchId);
  if (!job || job.tenantId !== ctx.tenantId) return null;
  return db.listBatchJobItems(batchId, options);
}

/** Shape one finished item as an OpenAI batch-output JSONL line. */
export function toOutputLine(item: IBatchJobItem): Record<string, unknown> {
  const succeeded = item.status === 'succeeded';
  return {
    id: `batch_req_${String(item._id)}`,
    custom_id: item.customId ?? null,
    response: item.responseStatusCode
      ? {
          status_code: item.responseStatusCode,
          body: succeeded ? (item.responseBody ?? null) : null,
        }
      : null,
    error: succeeded
      ? null
      : {
          code: item.status,
          message: item.errorMessage ?? null,
        },
  };
}

/** Render finished items (succeeded and/or failed) as a JSONL document. */
export function buildResultsJsonl(items: IBatchJobItem[]): string {
  return items
    .filter((item) => item.status === 'succeeded' || item.status === 'failed')
    .map((item) => JSON.stringify(toOutputLine(item)))
    .join('\n');
}

export { queueNameFor };
