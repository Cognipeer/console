/**
 * Batch item runner – executes one request line of a batch.
 *
 * Each item runs independently (queue fan-out). The runner that applies the
 * aggregate increment which makes the counters reach `itemsTotal` is the one
 * that finalizes the batch — the increments are atomic, so exactly one runner
 * observes that transition and the finalizer never races.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import type { BatchJobAggregateDelta, IBatchJob, IBatchJobItem } from '@/lib/database';
import {
  GuardrailBlockError,
  handleChatCompletion,
  handleEmbeddingRequest,
} from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { calculateCost } from '@/lib/services/models/usageLogger';
import { uploadFile } from '@/lib/services/files/fileService';
import { recordUsageEvent } from '@/lib/services/usage/usageEvents';
import { checkBudget } from '@/lib/quota/quotaGuard';
import { buildResultsJsonl } from './batchService';
import type { BatchContext } from './types';

const logger = createLogger('batch:runner');

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

function quotaContextFor(ctx: BatchContext, job: IBatchJob, modelKey: string) {
  if (!ctx.licenseType) return null;
  return {
    domain: job.endpoint === '/v1/embeddings' ? ('embedding' as const) : ('llm' as const),
    licenseType: ctx.licenseType,
    projectId: ctx.projectId ?? '',
    resourceKey: modelKey,
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    tokenId: ctx.tokenId,
    userId: ctx.userId,
  };
}

/** Execute one item end to end; never throws (failures land on the item). */
export async function processBatchItem(ctx: BatchContext, itemId: string): Promise<IBatchJobItem | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const item = await db.findBatchJobItemById(itemId);
  if (!item || item.tenantId !== ctx.tenantId || item.status !== 'pending') {
    return item;
  }
  const job = await db.findBatchJobById(item.batchId);
  if (!job) return item;

  // Cooperative cancel: pending items drain as `cancelled` without running.
  if (job.status === 'cancelling' || job.status === 'cancelled') {
    const updated = await db.updateBatchJobItem(itemId, { status: 'cancelled', endedAt: new Date() });
    await applyDeltaAndMaybeFinalize(ctx, item.batchId, { itemsCancelled: 1 });
    return updated;
  }

  await db.updateBatchJobItem(itemId, { status: 'running', startedAt: new Date() });

  const requestBody: Record<string, unknown> = { ...item.requestBody };
  requestBody.stream = false;
  requestBody.request_id = randomUUID();
  const modelKey = String(requestBody.model ?? '');
  const delta: BatchJobAggregateDelta = {};
  let patch: Partial<IBatchJobItem>;

  try {
    const quotaContext = quotaContextFor(ctx, job, modelKey);
    if (quotaContext) {
      const budget = await checkBudget(quotaContext);
      if (!budget.allowed) {
        throw new BatchItemError(budget.reason || 'Budget exceeded', 429);
      }
    }

    let response: Record<string, unknown> | undefined;
    let usage: IBatchJobItem['usage'];
    if (job.endpoint === '/v1/embeddings') {
      const result = await handleEmbeddingRequest({
        tenantDbName: ctx.tenantDbName,
        modelKey,
        projectId: ctx.projectId ?? '',
        body: requestBody,
      });
      response = result.response as Record<string, unknown> | undefined;
      // Embedding usage travels inside the OpenAI-shaped response body.
      usage = mapUsage(response?.usage as Record<string, number> | undefined);
    } else {
      const result = await handleChatCompletion({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        modelKey,
        projectId: ctx.projectId ?? '',
        body: requestBody,
      });
      response = result.response;
      usage = mapUsage(result.usage as Record<string, number> | undefined);
    }

    patch = {
      status: 'succeeded',
      responseStatusCode: 200,
      responseBody: response,
      usage,
      endedAt: new Date(),
    };
    delta.itemsSucceeded = 1;
    if (usage?.inputTokens) delta.usageInputTokens = usage.inputTokens;
    if (usage?.outputTokens) delta.usageOutputTokens = usage.outputTokens;
    if (usage?.totalTokens) delta.usageTotalTokens = usage.totalTokens;

    // Consume budget with the real cost (mirrors the sync inference path).
    if (quotaContext && usage) {
      try {
        const model = await getModelByKey(ctx.tenantDbName, modelKey, ctx.projectId ?? '');
        if (model) {
          const cost = calculateCost(model.pricing, usage);
          if (cost.currency === 'USD' && Number.isFinite(cost.totalCost) && cost.totalCost > 0) {
            await checkBudget(quotaContext, { usd: cost.totalCost });
          }
        }
      } catch (error) {
        logger.warn('Batch budget usage update failed', { error, itemId });
      }
    }
  } catch (error) {
    const statusCode = error instanceof BatchItemError
      ? error.statusCode
      : error instanceof GuardrailBlockError
        ? 400
        : 500;
    patch = {
      status: 'failed',
      responseStatusCode: statusCode,
      errorMessage: error instanceof Error ? error.message : 'Batch item failed',
      endedAt: new Date(),
    };
    delta.itemsFailed = 1;
  }

  const updated = await db.updateBatchJobItem(itemId, patch);
  await applyDeltaAndMaybeFinalize(ctx, item.batchId, delta);
  return updated;
}

class BatchItemError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'BatchItemError';
    this.statusCode = statusCode;
  }
}

function mapUsage(usage: Record<string, number> | undefined): IBatchJobItem['usage'] {
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens ?? usage.promptTokens ?? usage.prompt_tokens;
  const outputTokens = usage.outputTokens ?? usage.completionTokens ?? usage.completion_tokens;
  const totalTokens = usage.totalTokens ?? usage.total_tokens
    ?? ((inputTokens ?? 0) + (outputTokens ?? 0) || undefined);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens };
}

async function applyDeltaAndMaybeFinalize(
  ctx: BatchContext,
  batchId: string,
  delta: BatchJobAggregateDelta,
): Promise<void> {
  const db = await withTenantDb(ctx.tenantDbName);
  const job = await db.incrementBatchJobAggregates(batchId, delta);
  if (!job) return;

  const done = job.itemsSucceeded + job.itemsFailed + job.itemsCancelled;
  if (done < job.itemsTotal) return;
  if (job.status !== 'in_progress' && job.status !== 'cancelling') return;

  const finalStatus = job.status === 'cancelling' ? 'cancelled' : 'completed';
  let outputFile = job.outputFile;
  if (finalStatus === 'completed' && outputFile?.bucketKey && !outputFile.objectKey) {
    try {
      const items = await db.listBatchJobItems(batchId);
      const jsonl = buildResultsJsonl(items);
      const objectKey = `batches/${batchId}/output.jsonl`;
      await uploadFile(ctx.tenantDbName, ctx.tenantId, ctx.projectId ?? '', {
        bucketKey: outputFile.bucketKey,
        fileName: `batch-${batchId}-output.jsonl`,
        contentType: 'application/jsonl',
        data: Buffer.from(jsonl, 'utf8'),
        convertToMarkdown: false,
        keyHint: objectKey,
        createdBy: ctx.userId ?? 'batch',
        metadata: { batchId },
      });
      outputFile = { ...outputFile, objectKey };
    } catch (error) {
      logger.error('Batch output file write failed', { batchId, error });
    }
  }

  await db.updateBatchJob(batchId, {
    status: finalStatus,
    completedAt: finalStatus === 'completed' ? new Date() : undefined,
    outputFile,
  });

  // Rollup event at finalize — attribution comes from the fields stamped on
  // the job row at creation (the runner is outside the request ALS). No
  // tokens/cost: per-item inference already meters via logModelUsage.
  recordUsageEvent({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: job.projectId,
    service: 'batch',
    refKey: job.endpoint,
    status: 'success',
    latencyMs: job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : undefined,
    units: { items: job.itemsTotal },
    attribution: {
      userId: job.userId,
      apiTokenId: job.apiTokenId,
      actorType: job.actorType,
    },
  });
  logger.info('Batch finalized', { batchId, status: finalStatus, done, total: job.itemsTotal });
}
