/**
 * Client Batch API plugin (OpenAI-compatible async bulk inference).
 *
 * External-facing batch surface, authenticated with an API token and using
 * the `/client/v1/*` paths with snake_case request/response fields like the
 * other client modules.
 *
 *   POST /client/v1/batches              – create a batch (inline `requests`
 *                                          or `input_file` JSONL in a bucket)
 *   GET  /client/v1/batches              – list batches
 *   GET  /client/v1/batches/:id          – batch status + request counts
 *   POST /client/v1/batches/:id/cancel   – cooperative cancel
 *   GET  /client/v1/batches/:id/items    – per-request line status
 *   GET  /client/v1/batches/:id/results  – finished lines as JSONL (OpenAI
 *                                          batch output format)
 *
 * Requests execute asynchronously via per-item queue fan-out; budget quota
 * is enforced per item on behalf of the submitting API token.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { LicenseType } from '@/lib/license/license-manager';
import { createLogger } from '@/lib/core/logger';
import type { IBatchJob, IBatchJobItem } from '@/lib/database';
import {
  BatchValidationError,
  buildResultsJsonl,
  cancelBatch,
  createBatch,
  getBatch,
  getBatchItems,
  listBatches,
} from '@/lib/services/batch';
import type { BatchContext, BatchRequestLine } from '@/lib/services/batch';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import {
  getApiTokenContextForRequest,
  safeReadJsonBody,
  sendApiTokenError,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-batches');

function toBatchContext(auth: ApiTokenContext): BatchContext {
  return {
    tenantDbName: auth.tenantDbName,
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    userId: auth.tokenRecord.userId ? String(auth.tokenRecord.userId) : undefined,
    licenseType: auth.tenant.licenseType as LicenseType,
    tokenId: auth.tokenRecord._id ? String(auth.tokenRecord._id) : undefined,
  };
}

function toUnixSeconds(value: Date | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Shape the internal record into the snake_case client response. */
function toClientBatch(job: IBatchJob): Record<string, unknown> {
  return {
    id: String(job._id),
    object: 'batch',
    endpoint: job.endpoint,
    status: job.status,
    completion_window: job.completionWindow ?? null,
    input_file: job.inputFile
      ? { bucket_key: job.inputFile.bucketKey, object_key: job.inputFile.objectKey }
      : null,
    output_file: job.outputFile
      ? { bucket_key: job.outputFile.bucketKey, object_key: job.outputFile.objectKey ?? null }
      : null,
    error_message: job.errorMessage ?? null,
    request_counts: {
      total: job.itemsTotal,
      completed: job.itemsSucceeded,
      failed: job.itemsFailed,
      cancelled: job.itemsCancelled,
    },
    usage: {
      input_tokens: job.usageInputTokens,
      output_tokens: job.usageOutputTokens,
      total_tokens: job.usageTotalTokens,
    },
    metadata: job.metadata ?? {},
    created_at: toUnixSeconds(job.createdAt),
    started_at: toUnixSeconds(job.startedAt),
    completed_at: toUnixSeconds(job.completedAt),
    cancelled_at: toUnixSeconds(job.cancelledAt),
  };
}

function toClientItem(item: IBatchJobItem): Record<string, unknown> {
  return {
    id: String(item._id),
    object: 'batch.item',
    index: item.index,
    custom_id: item.customId ?? null,
    status: item.status,
    response_status_code: item.responseStatusCode ?? null,
    response_body: item.responseBody ?? null,
    error_message: item.errorMessage ?? null,
    usage: item.usage
      ? {
          input_tokens: item.usage.inputTokens ?? 0,
          output_tokens: item.usage.outputTokens ?? 0,
          total_tokens: item.usage.totalTokens ?? 0,
        }
      : null,
    started_at: toUnixSeconds(item.startedAt),
    ended_at: toUnixSeconds(item.endedAt),
  };
}

/** Parse the inline `requests` array of the create call. */
function parseInlineRequests(value: unknown): BatchRequestLine[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new BatchValidationError('`requests` must be an array');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BatchValidationError(`requests[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const body = (record.body ?? record) as Record<string, unknown>;
    return {
      customId: typeof record.custom_id === 'string' ? record.custom_id : undefined,
      body,
    };
  });
}

function parseFileRef(value: unknown, field: string): { bucketKey: string; objectKey: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BatchValidationError(`\`${field}\` must be an object`);
  }
  const record = value as Record<string, unknown>;
  const bucketKey = record.bucket_key ?? record.bucketKey;
  const objectKey = record.object_key ?? record.objectKey;
  if (typeof bucketKey !== 'string' || typeof objectKey !== 'string') {
    throw new BatchValidationError(`\`${field}.bucket_key\` and \`${field}.object_key\` are required`);
  }
  return { bucketKey, objectKey };
}

function sendBatchError(reply: Parameters<Parameters<typeof withClientApiRequestContext>[0]>[1], error: unknown) {
  if (error instanceof BatchValidationError) {
    return reply.code(400).send({ error: error.message });
  }
  return null;
}

export const clientBatchesApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Create ──
  app.post('/client/v1/batches', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      const body = safeReadJsonBody<Record<string, unknown>>(request);

      const requests = parseInlineRequests(body.requests);
      const inputFile = parseFileRef(body.input_file ?? body.inputFile, 'input_file');
      const outputBucket = body.output_bucket_key ?? body.outputBucketKey;
      if (outputBucket !== undefined && typeof outputBucket !== 'string') {
        return reply.code(400).send({ error: '`output_bucket_key` must be a string' });
      }

      const job = await createBatch(toBatchContext(auth), {
        endpoint: body.endpoint as never,
        requests,
        inputFile,
        outputBucketKey: outputBucket,
        completionWindow: typeof body.completion_window === 'string' ? body.completion_window : undefined,
        metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          ? body.metadata as Record<string, unknown>
          : undefined,
      });
      return reply.code(201).send(toClientBatch(job));
    } catch (error) {
      logger.error('Client batch create error', { error });
      return sendApiTokenError(reply, error)
        ?? sendBatchError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── List ──
  app.get('/client/v1/batches', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      const query = request.query as { status?: string; limit?: string };
      const limit = query.limit ? Math.max(1, Math.min(Number(query.limit) || 50, 500)) : 50;
      const batches = await listBatches(toBatchContext(auth), { status: query.status, limit });
      return reply.code(200).send({
        object: 'list',
        data: batches.map(toClientBatch),
      });
    } catch (error) {
      logger.error('Client batch list error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Retrieve ──
  app.get('/client/v1/batches/:batchId', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      const { batchId } = request.params as { batchId: string };
      const job = await getBatch(toBatchContext(auth), batchId);
      if (!job) return reply.code(404).send({ error: 'Batch not found' });
      return reply.code(200).send(toClientBatch(job));
    } catch (error) {
      logger.error('Client batch get error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Cancel ──
  app.post('/client/v1/batches/:batchId/cancel', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      const { batchId } = request.params as { batchId: string };
      const job = await cancelBatch(toBatchContext(auth), batchId);
      if (!job) return reply.code(404).send({ error: 'Batch not found' });
      return reply.code(200).send(toClientBatch(job));
    } catch (error) {
      logger.error('Client batch cancel error', { error });
      return sendApiTokenError(reply, error)
        ?? sendBatchError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Items ──
  app.get('/client/v1/batches/:batchId/items', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      const { batchId } = request.params as { batchId: string };
      const query = request.query as { status?: string; limit?: string; skip?: string };
      const items = await getBatchItems(toBatchContext(auth), batchId, {
        status: query.status,
        limit: query.limit ? Math.max(1, Math.min(Number(query.limit) || 100, 1000)) : 100,
        skip: query.skip ? Math.max(0, Number(query.skip) || 0) : undefined,
      });
      if (!items) return reply.code(404).send({ error: 'Batch not found' });
      return reply.code(200).send({
        object: 'list',
        data: items.map(toClientItem),
      });
    } catch (error) {
      logger.error('Client batch items error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Results (JSONL, OpenAI batch output format) ──
  app.get('/client/v1/batches/:batchId/results', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      const { batchId } = request.params as { batchId: string };
      const query = request.query as { status?: string };
      const items = await getBatchItems(toBatchContext(auth), batchId, {
        status: query.status,
        limit: 10000,
      });
      if (!items) return reply.code(404).send({ error: 'Batch not found' });
      const jsonl = buildResultsJsonl(items);
      return reply
        .code(200)
        .header('Content-Type', 'application/jsonl; charset=utf-8')
        .send(jsonl);
    } catch (error) {
      logger.error('Client batch results error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));
};
