/**
 * Batch item runner – executes one request line of a batch.
 *
 * Each item runs independently (queue fan-out). The runner that applies the
 * aggregate increment which makes the counters reach `itemsTotal` is the one
 * that finalizes the batch — the increments are atomic, so exactly one runner
 * observes that transition and the finalizer never races.
 */

import { assertServiceEnabled, isServiceDisabledError } from '@/lib/services/availability/serviceAvailability';
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
import { calculateCost, type TokenUsage, type UsageCostResult } from '@/lib/services/models/usageLogger';
import { OutputTokenLimitError, UpstreamFinishError } from '@/lib/services/models/openaiErrors';
import { isTruncatedFinishReason, normalizeFinishReason } from '@/lib/shared/finishReason';
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
  let quotaContext: ReturnType<typeof quotaContextFor> = null;
  // Cost the gateway settled for this item (served model's pricing). It fires for
  // limit hits too, so success and failure share this one budget debit.
  let settledCost = undefined as UsageCostResult | undefined;
  let embeddingUsage: IBatchJobItem['usage'];

  try {
    // An item queued before 'models' was switched off fails here with its own
    // status (403/402) rather than being retried by the queue.
    await assertServiceEnabled({ tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId }, 'models');
    quotaContext = quotaContextFor(ctx, job, modelKey);
    if (quotaContext) {
      const budget = await checkBudget(quotaContext);
      if (!budget.allowed) {
        throw new BatchItemError(budget.reason || 'Budget exceeded', 429);
      }
    }

    let response: Record<string, unknown> | undefined;
    let usage: IBatchJobItem['usage'];
    let finishReason: string | undefined;
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
      embeddingUsage = usage;
    } else {
      const result = await handleChatCompletion({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        modelKey,
        projectId: ctx.projectId ?? '',
        body: requestBody,
        // Fires once per billed call: a Dynamic LLM settles its decider or
        // complexity scorer before the child, so the costs add up.
        onUsageSettled: (cost) => {
          settledCost = addSettledCost(settledCost, cost);
        },
      });
      response = result.response;
      // result.usage is already canonical gateway usage: keep it as is, never re-fold.
      usage = canonicalItemUsage(result.usage as TokenUsage | undefined);
      finishReason = finishReasonOf(response);
    }

    // A reply cut off at the output limit WITH text is a success (the text is returned, as the sync endpoint does:
    // 200 + finish_reason length); the item says so, so a consumer reading results does not take it for a complete
    // answer. (One with nothing to show never gets here: the gateway fails it as an OutputTokenLimitError.)
    patch = {
      status: 'succeeded',
      responseStatusCode: 200,
      responseBody: response,
      ...(finishReason ? { finishReason } : {}),
      ...(isTruncatedFinishReason(finishReason) ? { truncated: true } : {}),
      usage,
      endedAt: new Date(),
    };
    delta.itemsSucceeded = 1;
    addUsageToDelta(delta, usage);

    // Embeddings have no settle hook: price their wire usage with the model's rates.
    if (quotaContext && embeddingUsage) {
      try {
        const model = await getModelByKey(ctx.tenantDbName, modelKey, ctx.projectId ?? '');
        if (model) settledCost = calculateCost(model.pricing, embeddingUsage, model);
      } catch (error) {
        logger.warn('Batch budget usage update failed', { error, itemId });
      }
    }
  } catch (error) {
    const statusCode = error instanceof BatchItemError
      ? error.statusCode
      : error instanceof GuardrailBlockError
        ? 400
        : isServiceDisabledError(error)
          ? error.status
          : 500;
    patch = {
      status: 'failed',
      responseStatusCode: statusCode,
      errorMessage: error instanceof Error ? error.message : 'Batch item failed',
      endedAt: new Date(),
    };
    // A limit hit burned real tokens: keep them on the item and in the aggregates.
    const billedError = error instanceof OutputTokenLimitError || error instanceof UpstreamFinishError ? error : undefined;
    const burned = billedError ? canonicalItemUsage(billedError.usage) : undefined;
    if (burned) {
      patch.usage = burned;
      addUsageToDelta(delta, burned);
    }
    if (billedError?.cost && !settledCost) settledCost = billedError.cost;
    delta.itemsFailed = 1;
  }

  // One budget debit path for success and limit hit alike (mirrors the sync inference path).
  if (quotaContext && settledCost) {
    const cost: UsageCostResult = settledCost;
    if (cost.currency === 'USD' && Number.isFinite(cost.totalCost) && cost.totalCost > 0) {
      try {
        await checkBudget(quotaContext, { usd: cost.totalCost });
      } catch (error) {
        logger.warn('Batch budget usage update failed', { error, itemId });
      }
    }
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

/** The first choice's finish reason of a chat completion response body, normalized (undefined when it has none). */
function finishReasonOf(response: Record<string, unknown> | undefined): string | undefined {
  const choices = response?.choices;
  if (!Array.isArray(choices)) return undefined;
  return normalizeFinishReason((choices[0] as { finish_reason?: unknown } | undefined)?.finish_reason);
}

/** Sums the costs one item settled (a Dynamic LLM's decider or scorer, then its child). */
function addSettledCost(total: UsageCostResult | undefined, cost: UsageCostResult): UsageCostResult {
  if (!total) return cost;
  // One currency per budget: a cost in another currency is left to the debit's USD guard.
  if (total.currency !== cost.currency) return total;
  return {
    ...total,
    inputCost: total.inputCost + cost.inputCost,
    outputCost: total.outputCost + cost.outputCost,
    cachedCost: total.cachedCost + cost.cachedCost,
    cacheWriteCost: total.cacheWriteCost + cost.cacheWriteCost,
    totalCost: total.totalCost + cost.totalCost,
  };
}

/** Usage an item stores: the canonical fields verbatim; totalTokens is input + output, never + cached. */
function canonicalItemUsage(usage: TokenUsage | undefined): IBatchJobItem['usage'] {
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? (inputTokens + outputTokens);
  if (!inputTokens && !outputTokens && !totalTokens) return undefined;
  const stored = {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(usage.cachedInputTokens ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(usage.cachedWriteTokens ? { cachedWriteTokens: usage.cachedWriteTokens } : {}),
    ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
  return stored;
}

function addUsageToDelta(delta: BatchJobAggregateDelta, usage: IBatchJobItem['usage']): void {
  if (usage?.inputTokens) delta.usageInputTokens = usage.inputTokens;
  if (usage?.outputTokens) delta.usageOutputTokens = usage.outputTokens;
  if (usage?.totalTokens) delta.usageTotalTokens = usage.totalTokens;
}

/** Wire (OpenAI-shaped) usage of the embeddings branch; there are no cache fields there. */
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
