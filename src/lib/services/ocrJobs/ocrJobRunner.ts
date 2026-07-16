/**
 * OCR item runner – processes a single file (item) of an OCR Job.
 *
 * Called by the queue consumer (per-item fan-out) and by the sync fast path.
 * Runs OCR (reusing `handleOcrRequest`), then optional summary/structured
 * extraction (`handleChatCompletion`), computes per-call cost, stores the
 * result + usage on the item, atomically rolls the totals up onto the job,
 * and fires a per-file callback.
 */

import { createLogger } from '@/lib/core/logger';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import type { IOcrJob, IOcrJobItem, IOcrJobItemResult } from '@/lib/database';
import {
  handleChatCompletion,
  handleOcrRequest,
} from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { calculateCost, type TokenUsage } from '@/lib/services/models/usageLogger';
import { downloadFile } from '@/lib/services/files/fileService';
import { recordUsageEvent } from '@/lib/services/usage/usageEvents';
import type { OcrDocumentSource, OcrFeature } from '@/lib/providers';
import { sendOcrJobWebhook } from './ocrJobWebhook';
import type { OcrJobContext } from './types';

const logger = createLogger('ocr-job:runner');

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
  const trimmed = text.trim();
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

  await db.updateOcrJobItem(itemId, { status: 'running', startedAt: new Date() });
  const startedAt = Date.now();

  try {
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

    if (job.outputs.includes('full_text')) result.fullText = fullText;
    result.pages = ocrUsage.pages;

    // ── Cost: OCR ──
    const totals: ProcessedTotals = {
      inputTokens: 0, outputTokens: 0, totalTokens: 0, pages: 0,
      ocrTokens: 0, llmTokens: 0, costOcr: 0, costLlm: 0, cost: 0,
    };
    const ocrTokenUsage: TokenUsage = {
      inputTokens: ocrUsage.inputTokens,
      outputTokens: ocrUsage.outputTokens,
      pages: ocrUsage.pages,
    };
    if (ocr.model?.pricing) {
      const c = calculateCost(ocr.model.pricing, ocrTokenUsage);
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
          },
        });
        result.summary = extractMessageText(resp.response).trim();
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
          },
        });
        const raw = extractMessageText(resp.response);
        try {
          result.structured = JSON.parse(stripJsonFences(raw)) as Record<string, unknown>;
        } catch {
          result.structured = { _raw: raw, _parseError: true };
        }
        usage.llm = { ...(usage.llm ?? {}), structured: resp.usage };
        accumulateLlm(totals, resp.usage, llmModel?.pricing);
      }
    }

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
    await db.updateOcrJobItem(itemId, { status: 'failed', errorMessage: message, endedAt: new Date() });
    const afterJob = await db.incrementOcrJobAggregates(item.jobId, { itemsFailed: 1 }, { lastItemAt: new Date() });
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
