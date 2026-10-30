/**
 * OCR item runner – processes a single file (item) of an OCR Job.
 *
 * Called by the queue consumer (per-item fan-out) and by the sync fast path.
 * Runs OCR (reusing `handleOcrRequest`), then optional summary/structured
 * extraction (`handleChatCompletion`), computes per-call cost, stores the
 * result + usage on the item, atomically rolls the totals up onto the job,
 * and fires a per-file callback.
 */

import { assertServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import type { IModel, IOcrJob, IOcrJobItem, IOcrJobItemResult } from '@/lib/database';
import {
  handleChatCompletion,
  handleOcrRequest,
} from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { calculateCost, type TokenUsage } from '@/lib/services/models/usageLogger';
import { OutputTokenLimitError, UpstreamFinishError } from '@/lib/services/models/openaiErrors';
import { NON_STREAM_DEFAULT_CAP, modelMaxOutputTokens } from '@/lib/services/models/outputLimits';
import { isTruncatedFinishReason, normalizeFinishReason } from '@/lib/shared/finishReason';
import { downloadFile } from '@/lib/services/files/fileService';
import { recordUsageEvent } from '@/lib/services/usage/usageEvents';
import type { OcrDocumentSource, OcrFeature } from '@/lib/providers';
import { sendOcrJobWebhook } from './ocrJobWebhook';
import type { OcrJobContext } from './types';
import { stripInlineReasoning } from '@/lib/shared/inlineReasoning';

const logger = createLogger('ocr-job:runner');

/** Set on a pending item whose queue message arrived while its job was paused. */
export const OCR_ITEM_HELD_WHILE_PAUSED = 'Waiting: the job was paused';

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

const DEFAULT_SUMMARY_PROMPT =
  'Summarize the following document text concisely, preserving key facts, names, dates, and figures.';
const DEFAULT_STRUCTURED_PROMPT =
  'Extract structured data from the following document text. Respond ONLY with a valid JSON object that conforms to the provided schema, with no extra commentary or markdown fences.';

function stripJsonFences(text: string): string {
  const trimmed = stripInlineReasoning(text).trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

function extractMessageText(response: unknown): string {
  const choices = (response as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? (part as { text: string }).text
            : '',
      )
      .join('');
  }
  return '';
}

/** Whether the reply was cut off at the output limit (the first choice's finish reason says so). */
function wasCutOff(response: unknown): boolean {
  const choices = (response as { choices?: Array<{ finish_reason?: unknown }> } | null | undefined)?.choices;
  return isTruncatedFinishReason(normalizeFinishReason(choices?.[0]?.finish_reason));
}

function positiveNumber(...values: unknown[]): number | undefined {
  return values.find((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
}

/**
 * The `max_tokens` the summary / structured steps are sent with, or undefined to leave the limit to the model's own
 * setting. An OCR item has no request body to take one from, and a document's summary or extraction is long: so a
 * model whose maximum is known (declared in the Model Hub, or a Claude the built-in table knows) is asked for that,
 * not for the gateway's default. Never above NON_STREAM_DEFAULT_CAP, the most a non-streaming call is given by
 * default: a document can fill much of the context window, and a limit as large as the model's whole maximum
 * (128000 for a current Claude) would not fit next to it. A limit the operator configured on the model that is
 * already as large is left alone rather than restated (an explicit value is a hard cap: it would also drop the
 * thinking headroom the gateway adds to a configured limit).
 */
function llmStepMaxTokens(model: IModel | null | undefined): number | undefined {
  const modelMax = modelMaxOutputTokens(model);
  if (modelMax === undefined) return undefined;
  const wanted = Math.min(modelMax, NON_STREAM_DEFAULT_CAP);
  const settings = (model?.settings ?? {}) as Record<string, unknown>;
  const configured = positiveNumber(settings.maxCompletionTokens, settings.maxTokens);
  return configured !== undefined && configured >= wanted ? undefined : wanted;
}

async function resolveDocument(
  ctx: OcrJobContext,
  item: IOcrJobItem,
): Promise<OcrDocumentSource> {
  const source = item.source;
  if (source.kind === 'inline') {
    return {
      kind: 'bytes',
      data: Buffer.from(source.data, 'base64'),
      fileName: source.fileName ?? item.fileName,
      contentType: source.contentType,
    };
  }
  if (source.kind === 'url') {
    return { kind: 'url', url: source.url, contentType: source.contentType };
  }
  const download = await downloadFile(
    ctx.tenantDbName,
    ctx.tenantId,
    ctx.projectId ?? '',
    source.bucketKey,
    source.objectKey,
  );
  return {
    kind: 'bytes',
    data: download.data,
    fileName: download.fileName ?? item.fileName,
    contentType: download.contentType,
  };
}

interface ProcessedTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  pages: number;
  ocrTokens: number;
  llmTokens: number;
  costOcr: number;
  costLlm: number;
  cost: number;
  currency?: string;
}

/**
 * Process a single OCR item end-to-end. Returns the updated item. Errors are
 * caught and recorded on the item; the function itself does not throw for
 * per-document failures so the queue does not retry indefinitely on bad input.
 */
export async function processOcrItem(ctx: OcrJobContext, itemId: string): Promise<IOcrJobItem | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const item = await db.findOcrJobItemById(itemId);
  if (!item || item.tenantId !== ctx.tenantId) {
    logger.warn('OCR item not found, skipping', { itemId });
    return null;
  }
  if (item.status === 'succeeded') return item;

  const job = await db.findOcrJobById(item.jobId);
  if (!job) {
    logger.warn('OCR job not found for item, skipping', { itemId, jobId: item.jobId });
    return null;
  }
  if (job.status === 'archived') {
    await db.updateOcrJobItem(itemId, { status: 'failed', errorMessage: 'Job archived', endedAt: new Date() });
    await db.incrementOcrJobAggregates(item.jobId, { itemsFailed: 1 }, { lastItemAt: new Date() });
    return null;
  }

  // A paused job keeps its queued items pending rather than failing them. The
  // marker tells the resume which items lost their queue message here, so it
  // re-enqueues exactly those (items still waiting in the queue are left alone).
  if (job.status === 'paused') {
    logger.info('OCR job is paused, leaving item pending', { itemId, jobId: item.jobId });
    return db.updateOcrJobItem(itemId, { errorMessage: OCR_ITEM_HELD_WHILE_PAUSED });
  }

  await db.updateOcrJobItem(itemId, { status: 'running', startedAt: new Date() });
  const startedAt = Date.now();
  // Hoisted so a failure after OCR (or a first LLM step) still rolls the tokens,
  // pages and cost already billed into the item and the job aggregates.
  const totals: ProcessedTotals = {
    inputTokens: 0, outputTokens: 0, totalTokens: 0, pages: 0,
    ocrTokens: 0, llmTokens: 0, costOcr: 0, costLlm: 0, cost: 0,
  };
  let llmPricing: Parameters<typeof calculateCost>[0] | undefined;
  // Set once the success aggregates hold this item's tokens and cost: a later
  // failure (callback status, completion check) must not add them a second time.
  let aggregated = false;

  try {
    // Inside the try so a switched-off service fails this item (recorded,
    // webhook sent, job completion counted) instead of throwing into the queue
    // and being retried. A paused job was already held above.
    await assertServiceEnabled({ tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId }, 'ocr');
    const projectId = ctx.projectId ?? '';
    const document = await resolveDocument(ctx, item);

    const ocr = await handleOcrRequest({
      tenantDbName: ctx.tenantDbName,
      modelKey: job.ocrModelKey,
      projectId,
      input: {
        document,
        language: job.language,
        features: (job.features as OcrFeature[] | undefined) ?? undefined,
        pdfMaxPages: job.pdfMaxPages,
      },
    });

    const fullText = ocr.response?.text ?? '';
    const ocrUsage = ocr.response?.usage ?? {};
    const result: IOcrJobItemResult = {};
    const usage: NonNullable<IOcrJobItem['usage']> = { ocr: ocrUsage as Record<string, unknown> };

    // Steps whose reply was cut off at the output limit: the item still succeeds (the text it has is kept),
    // but the result says which part is incomplete. 'ocr' = a VLM page whose transcription was cut off.
    const truncatedSteps: NonNullable<IOcrJobItemResult['truncated']> = [];
    if (ocr.response?.pages?.some((p) => p.truncated)) truncatedSteps.push('ocr');

    if (job.outputs.includes('full_text')) result.fullText = fullText;
    result.pages = ocrUsage.pages;

    // ── Cost: OCR ──
    const ocrTokenUsage: TokenUsage = {
      inputTokens: ocrUsage.inputTokens,
      outputTokens: ocrUsage.outputTokens,
      pages: ocrUsage.pages,
      ...(ocrUsage.cachedInputTokens ? { cachedInputTokens: ocrUsage.cachedInputTokens } : {}),
      ...(ocrUsage.cachedWriteTokens ? { cachedWriteTokens: ocrUsage.cachedWriteTokens } : {}),
      ...(ocrUsage.reasoningTokens ? { reasoningTokens: ocrUsage.reasoningTokens } : {}),
    };
    if (ocr.model?.pricing) {
      const c = calculateCost(ocr.model.pricing, ocrTokenUsage, ocr.model);
      totals.costOcr += c.totalCost;
      totals.cost += c.totalCost;
      totals.currency = c.currency;
    }
    totals.inputTokens += ocrUsage.inputTokens ?? 0;
    totals.outputTokens += ocrUsage.outputTokens ?? 0;
    totals.ocrTokens += (ocrUsage.inputTokens ?? 0) + (ocrUsage.outputTokens ?? 0);
    totals.pages += ocrUsage.pages ?? 0;

    // ── Summary / structured via LLM ──
    const needsLlm = job.outputs.includes('summary') || job.outputs.includes('structured');
    if (needsLlm && job.llmModelKey) {
      const llmModel = await getModelByKey(ctx.tenantDbName, job.llmModelKey, projectId);
      llmPricing = llmModel?.pricing;
      const stepMaxTokens = llmStepMaxTokens(llmModel);
      if (job.outputs.includes('summary')) {
        const resp = await handleChatCompletion({
          tenantDbName: ctx.tenantDbName,
          modelKey: job.llmModelKey,
          projectId,
          body: {
            messages: [
              { role: 'system', content: job.summaryPrompt || DEFAULT_SUMMARY_PROMPT },
              { role: 'user', content: fullText },
            ],
            ...(stepMaxTokens !== undefined ? { max_tokens: stepMaxTokens } : {}),
          },
        });
        result.summary = extractMessageText(resp.response).trim();
        if (wasCutOff(resp.response)) truncatedSteps.push('summary');
        usage.llm = { ...(usage.llm ?? {}), summary: resp.usage };
        accumulateLlm(totals, resp.usage, llmModel?.pricing);
      }

      if (job.outputs.includes('structured') && job.structuredSchema) {
        const resp = await handleChatCompletion({
          tenantDbName: ctx.tenantDbName,
          modelKey: job.llmModelKey,
          projectId,
          body: {
            messages: [
              {
                role: 'system',
                content: `${DEFAULT_STRUCTURED_PROMPT}\n\nJSON Schema:\n${JSON.stringify(job.structuredSchema)}`,
              },
              { role: 'user', content: fullText },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'extraction', schema: job.structuredSchema },
            },
            ...(stepMaxTokens !== undefined ? { max_tokens: stepMaxTokens } : {}),
          },
        });
        const raw = extractMessageText(resp.response);
        if (wasCutOff(resp.response)) {
          // A reply cut at the limit is not the object the schema asked for (the JSON stops mid-value, and one that
          // still parses is missing fields). Kept raw and flagged, never stored as a parsed result.
          result.structured = { _raw: raw, _truncated: true };
          truncatedSteps.push('structured');
        } else {
          try {
            result.structured = JSON.parse(stripJsonFences(raw)) as Record<string, unknown>;
          } catch {
            result.structured = { _raw: raw, _parseError: true };
          }
        }
        usage.llm = { ...(usage.llm ?? {}), structured: resp.usage };
        accumulateLlm(totals, resp.usage, llmModel?.pricing);
      }

    }

    if (truncatedSteps.length > 0) result.truncated = truncatedSteps;

    totals.totalTokens = totals.inputTokens + totals.outputTokens;
    usage.inputTokens = totals.inputTokens;
    usage.outputTokens = totals.outputTokens;
    usage.totalTokens = totals.totalTokens;
    usage.pages = totals.pages;

    const updated = await db.updateOcrJobItem(itemId, {
      status: 'succeeded',
      result,
      usage,
      costTotal: totals.cost,
      costCurrency: totals.currency,
      endedAt: new Date(),
    });

    const afterJob = await db.incrementOcrJobAggregates(
      item.jobId,
      {
        itemsProcessed: 1,
        usageInputTokens: totals.inputTokens,
        usageOutputTokens: totals.outputTokens,
        usageTotalTokens: totals.totalTokens,
        usagePages: totals.pages,
        usageOcrTokens: totals.ocrTokens,
        usageLlmTokens: totals.llmTokens,
        costOcr: totals.costOcr,
        costLlm: totals.costLlm,
        costTotal: totals.cost,
      },
      { costCurrency: totals.currency, lastItemAt: new Date() },
    );
    aggregated = true;

    // Rollup event per item — attribution comes from the fields stamped on
    // the job row at creation (the runner is outside the request ALS). No
    // tokens/cost: OCR + LLM calls already meter via logModelUsage.
    recordUsageEvent({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId: job.projectId,
      service: 'ocr',
      refKey: job.ocrModelKey,
      status: 'success',
      latencyMs: Date.now() - startedAt,
      units: { items: 1, pages: totals.pages },
      attribution: {
        userId: job.userId,
        apiTokenId: job.apiTokenId,
        actorType: job.actorType,
      },
    });

    const delivered = await sendOcrJobWebhook({
      job,
      event: 'item.succeeded',
      data: { itemId, index: item.index, fileName: item.fileName, result, usage, cost: totals.cost, currency: totals.currency },
    }).catch(() => false);
    if (job.callbackUrl) {
      await db.updateOcrJobItem(itemId, { callbackStatus: delivered ? 'delivered' : 'failed' });
    }

    await maybeFireJobCompleted(afterJob);

    logger.info('OCR item succeeded', { itemId, jobId: item.jobId, durationMs: Date.now() - startedAt });
    return updated ?? item;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // An output-limit hit burned real LLM tokens that never reached a response.
    if ((err instanceof OutputTokenLimitError || err instanceof UpstreamFinishError) && err.usage) {
      accumulateLlm(totals, err.usage, llmPricing);
    }
    totals.totalTokens = totals.inputTokens + totals.outputTokens;
    const burned = !aggregated
      && (totals.inputTokens > 0 || totals.outputTokens > 0 || totals.pages > 0 || totals.cost > 0);
    await db.updateOcrJobItem(itemId, {
      status: 'failed',
      errorMessage: message,
      endedAt: new Date(),
      ...(burned
        ? {
            usage: {
              inputTokens: totals.inputTokens,
              outputTokens: totals.outputTokens,
              totalTokens: totals.totalTokens,
              pages: totals.pages,
            },
            costTotal: totals.cost,
            ...(totals.currency ? { costCurrency: totals.currency } : {}),
          }
        : {}),
    });
    const afterJob = await db.incrementOcrJobAggregates(
      item.jobId,
      burned
        ? {
            itemsFailed: 1,
            usageInputTokens: totals.inputTokens,
            usageOutputTokens: totals.outputTokens,
            usageTotalTokens: totals.totalTokens,
            usagePages: totals.pages,
            usageOcrTokens: totals.ocrTokens,
            usageLlmTokens: totals.llmTokens,
            costOcr: totals.costOcr,
            costLlm: totals.costLlm,
            costTotal: totals.cost,
          }
        : { itemsFailed: 1 },
      { ...(burned && totals.currency ? { costCurrency: totals.currency } : {}), lastItemAt: new Date() },
    );
    recordUsageEvent({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId: job.projectId,
      service: 'ocr',
      refKey: job.ocrModelKey,
      status: 'error',
      latencyMs: Date.now() - startedAt,
      units: { items: 1 },
      attribution: {
        userId: job.userId,
        apiTokenId: job.apiTokenId,
        actorType: job.actorType,
      },
    });
    const delivered = await sendOcrJobWebhook({
      job,
      event: 'item.failed',
      data: { itemId, index: item.index, fileName: item.fileName, error: message },
    }).catch(() => false);
    if (job.callbackUrl) {
      await db.updateOcrJobItem(itemId, { callbackStatus: delivered ? 'delivered' : 'failed' });
    }
    await maybeFireJobCompleted(afterJob);
    logger.error('OCR item failed', { itemId, jobId: item.jobId, error: message });
    return null;
  }
}

/**
 * Fire the job-level `job.completed` webhook exactly once, when the last item
 * settles. Because `incrementOcrJobAggregates` applies the counter atomically
 * and returns the post-increment job, only the worker that observes
 * `itemsProcessed + itemsFailed === itemsTotal` triggers the callback.
 */
async function maybeFireJobCompleted(job: IOcrJob | null): Promise<void> {
  if (!job) return;
  const total = job.itemsTotal ?? 0;
  if (total <= 0) return;
  if (job.itemsProcessed + job.itemsFailed !== total) return;
  await sendOcrJobWebhook({
    job,
    event: 'job.completed',
    data: {
      jobId: job._id ? String(job._id) : '',
      itemsTotal: total,
      itemsProcessed: job.itemsProcessed,
      itemsFailed: job.itemsFailed,
      cost: job.costTotal ?? 0,
      currency: job.costCurrency,
      usage: {
        inputTokens: job.usageInputTokens,
        outputTokens: job.usageOutputTokens,
        totalTokens: job.usageTotalTokens,
        pages: job.usagePages,
      },
    },
  }).catch(() => false);
}

function accumulateLlm(
  totals: ProcessedTotals,
  usage: TokenUsage | undefined,
  pricing?: Parameters<typeof calculateCost>[0],
): void {
  if (!usage) return;
  totals.inputTokens += usage.inputTokens ?? 0;
  totals.outputTokens += usage.outputTokens ?? 0;
  totals.llmTokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (pricing) {
    const c = calculateCost(pricing, usage);
    totals.costLlm += c.totalCost;
    totals.cost += c.totalCost;
    if (!totals.currency) totals.currency = c.currency;
  }
}
