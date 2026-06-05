/**
 * Dashboard OCR Jobs API (cookie-authenticated).
 * Routes registered under `/ocr-jobs/*` (plugin mounts at `/api/`).
 *
 * OCR Job = persistent container (rules + bucket + callback). Files are sent to
 * it over time and processed per-file via queue fan-out.
 */
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  addFilesToJob,
  createOcrJob,
  deleteOcrJob,
  getOcrJob,
  getOcrJobItem,
  getOcrJobItems,
  listOcrJobs,
  setOcrJobStatus,
  updateOcrJob,
  OcrJobValidationError,
  type CreateOcrJobInput,
  type OcrJobContext,
  type OcrJobItemInput,
  type UpdateOcrJobInput,
} from '@/lib/services/ocrJobs';
import type {
  IOcrJob,
  IOcrJobItem,
  OcrJobWebhookEvent,
  OcrOutputKind,
} from '@/lib/database';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:ocr-jobs');

const VALID_OUTPUTS: OcrOutputKind[] = ['full_text', 'summary', 'structured'];
const VALID_EVENTS: OcrJobWebhookEvent[] = ['item.succeeded', 'item.failed'];

function sendError(
  reply: { code: (s: number) => { send: (b: Record<string, unknown>) => unknown } },
  error: unknown,
  fallback: string,
) {
  const message = error instanceof Error ? error.message : fallback;
  const status = error instanceof OcrJobValidationError ? 400 : /not found/i.test(message) ? 404 : 500;
  return reply.code(status).send({ error: message });
}

function normalizeOutputs(raw: unknown): OcrOutputKind[] {
  const arr = Array.isArray(raw) ? raw.map((v) => String(v)) : [];
  const filtered = arr.filter((v): v is OcrOutputKind => (VALID_OUTPUTS as string[]).includes(v));
  return filtered.length ? filtered : ['full_text'];
}
function normalizeEvents(raw: unknown): OcrJobWebhookEvent[] | undefined {
  if (raw === undefined) return undefined;
  const arr = Array.isArray(raw) ? raw.map((v) => String(v)) : [];
  const filtered = arr.filter((v): v is OcrJobWebhookEvent => (VALID_EVENTS as string[]).includes(v));
  return filtered.length ? filtered : undefined;
}

function serializeJob(job: IOcrJob) {
  return {
    id: String(job._id),
    name: job.name,
    status: job.status,
    bucketKey: job.bucketKey,
    ocrModelKey: job.ocrModelKey,
    llmModelKey: job.llmModelKey,
    outputs: job.outputs,
    summaryPrompt: job.summaryPrompt,
    structuredSchema: job.structuredSchema,
    language: job.language,
    pdfMaxPages: job.pdfMaxPages ?? null,
    callbackUrl: job.callbackUrl,
    callbackEvents: job.callbackEvents,
    itemsTotal: job.itemsTotal,
    itemsProcessed: job.itemsProcessed,
    itemsFailed: job.itemsFailed,
    usage: {
      inputTokens: job.usageInputTokens ?? 0,
      outputTokens: job.usageOutputTokens ?? 0,
      totalTokens: job.usageTotalTokens ?? 0,
      pages: job.usagePages ?? 0,
      ocrTokens: job.usageOcrTokens ?? 0,
      llmTokens: job.usageLlmTokens ?? 0,
    },
    costTotal: job.costTotal ?? 0,
    costOcr: job.costOcr ?? 0,
    costLlm: job.costLlm ?? 0,
    costCurrency: job.costCurrency,
    lastItemAt: job.lastItemAt,
    createdAt: job.createdAt,
  };
}

function serializeItem(item: IOcrJobItem) {
  return {
    id: String(item._id),
    index: item.index,
    fileName: item.fileName,
    status: item.status,
    result: item.result,
    usage: item.usage,
    costTotal: item.costTotal,
    costCurrency: item.costCurrency,
    callbackStatus: item.callbackStatus,
    errorMessage: item.errorMessage,
  };
}

function parseItems(raw: unknown): OcrJobItemInput[] {
  if (!Array.isArray(raw)) return [];
  const items: OcrJobItemInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const fileName = typeof obj.fileName === 'string' ? obj.fileName : undefined;
    const src = obj.source as Record<string, unknown> | undefined;
    if (src && typeof src.kind === 'string') {
      if (src.kind === 'inline' && typeof src.data === 'string') {
        const f = typeof src.fileName === 'string' ? src.fileName : fileName;
        items.push({ source: { kind: 'inline', data: src.data, fileName: f, contentType: typeof src.contentType === 'string' ? src.contentType : undefined }, fileName: f });
        continue;
      }
      if (src.kind === 'url' && typeof src.url === 'string') {
        items.push({ source: { kind: 'url', url: src.url, contentType: typeof src.contentType === 'string' ? src.contentType : undefined }, fileName });
        continue;
      }
      if (src.kind === 'bucket' && typeof src.bucketKey === 'string' && typeof src.objectKey === 'string') {
        items.push({ source: { kind: 'bucket', bucketKey: src.bucketKey, objectKey: src.objectKey }, fileName });
        continue;
      }
    }
    if (typeof obj.url === 'string') {
      items.push({ source: { kind: 'url', url: obj.url }, fileName });
    } else if (typeof obj.data === 'string') {
      items.push({ source: { kind: 'inline', data: obj.data, fileName, contentType: typeof obj.contentType === 'string' ? obj.contentType : undefined }, fileName });
    }
  }
  return items;
}

function buildCreateInput(body: Record<string, unknown>): CreateOcrJobInput {
  return {
    name: typeof body.name === 'string' ? body.name : undefined,
    bucketKey: typeof body.bucketKey === 'string' ? body.bucketKey : '',
    ocrModelKey: typeof body.ocrModelKey === 'string' ? body.ocrModelKey : '',
    llmModelKey: typeof body.llmModelKey === 'string' ? body.llmModelKey : undefined,
    outputs: normalizeOutputs(body.outputs),
    summaryPrompt: typeof body.summaryPrompt === 'string' ? body.summaryPrompt : undefined,
    structuredSchema: body.structuredSchema && typeof body.structuredSchema === 'object' ? (body.structuredSchema as Record<string, unknown>) : undefined,
    language: typeof body.language === 'string' ? body.language : undefined,
    features: Array.isArray(body.features) ? body.features.map((v) => String(v)) : undefined,
    pdfMaxPages: typeof body.pdfMaxPages === 'number' ? body.pdfMaxPages : undefined,
    callbackUrl: typeof body.callbackUrl === 'string' ? body.callbackUrl : undefined,
    callbackSecret: typeof body.callbackSecret === 'string' ? body.callbackSecret : undefined,
    callbackEvents: normalizeEvents(body.callbackEvents),
  };
}

function csvEscape(value: unknown): string {
  const str = value === undefined || value === null ? '' : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function ctxFrom(session: { tenantDbName: string; tenantId: string; userId: string; userEmail?: string }, projectId?: string): OcrJobContext {
  return { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, userId: session.userEmail ?? session.userId };
}

export const ocrJobsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/ocr-jobs', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { status?: string; limit?: string };
      const jobs = await listOcrJobs(ctxFrom(session, projectId), { status: query.status, limit: query.limit ? Number(query.limit) : undefined });
      return reply.code(200).send({ jobs: jobs.map(serializeJob) });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('List OCR jobs failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/ocr-jobs', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const job = await createOcrJob(ctxFrom(session, projectId), buildCreateInput(readJsonBody<Record<string, unknown>>(request)));
      return reply.code(201).send({ job: serializeJob(job) });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Create OCR job failed', { error });
      return sendError(reply, error, 'Failed to create OCR job');
    }
  }));

  app.get('/ocr-jobs/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const job = await getOcrJob(session, id);
      if (!job) return reply.code(404).send({ error: 'Not found' });
      return reply.code(200).send({ job: serializeJob(job) });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/ocr-jobs/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const patch: UpdateOcrJobInput = {};
      if (typeof body.name === 'string') patch.name = body.name;
      if (typeof body.status === 'string' && ['active', 'paused', 'archived'].includes(body.status)) patch.status = body.status as IOcrJob['status'];
      if (typeof body.ocrModelKey === 'string') patch.ocrModelKey = body.ocrModelKey;
      if (typeof body.llmModelKey === 'string') patch.llmModelKey = body.llmModelKey;
      if (body.outputs !== undefined) patch.outputs = normalizeOutputs(body.outputs);
      if (typeof body.summaryPrompt === 'string') patch.summaryPrompt = body.summaryPrompt;
      if (body.structuredSchema !== undefined) patch.structuredSchema = body.structuredSchema as Record<string, unknown>;
      if (typeof body.language === 'string') patch.language = body.language;
      if (typeof body.pdfMaxPages === 'number') patch.pdfMaxPages = body.pdfMaxPages;
      if (typeof body.callbackUrl === 'string') patch.callbackUrl = body.callbackUrl;
      if (typeof body.callbackSecret === 'string') patch.callbackSecret = body.callbackSecret;
      if (body.callbackEvents !== undefined) patch.callbackEvents = normalizeEvents(body.callbackEvents);
      const job = await updateOcrJob(session, id, patch);
      if (!job) return reply.code(404).send({ error: 'Not found' });
      return reply.code(200).send({ job: serializeJob(job) });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      return sendError(reply, error, 'Failed to update OCR job');
    }
  }));

  app.delete('/ocr-jobs/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const ok = await deleteOcrJob(session, id);
      if (!ok) return reply.code(404).send({ error: 'Not found' });
      return reply.code(200).send({ ok: true });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── Send files ────────────────────────────────────────────────────
  app.post('/ocr-jobs/:id/files', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const items = parseItems(body.items);
      if (!items.length) return reply.code(400).send({ error: 'At least one file is required' });
      const mode = body.mode === 'sync' ? 'sync' : 'async';
      const result = await addFilesToJob(ctxFrom(session, projectId), id, items, { mode });
      return reply.code(result.sync ? 200 : 202).send({ items: result.items.map(serializeItem) });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Add files to OCR job failed', { error });
      return sendError(reply, error, 'Failed to add files');
    }
  }));

  app.post('/ocr-jobs/:id/pause', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const job = await setOcrJobStatus(session, id, 'paused');
      if (!job) return reply.code(404).send({ error: 'Not found' });
      return reply.code(200).send({ job: serializeJob(job) });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/ocr-jobs/:id/resume', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const job = await setOcrJobStatus(session, id, 'active');
      if (!job) return reply.code(404).send({ error: 'Not found' });
      return reply.code(200).send({ job: serializeJob(job) });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── Items ─────────────────────────────────────────────────────────
  app.get('/ocr-jobs/:id/items', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const { limit, skip, status } = (request.query ?? {}) as { limit?: string; skip?: string; status?: string };
      const items = await getOcrJobItems(session, id, { limit: limit ? Number(limit) : undefined, skip: skip ? Number(skip) : undefined, status });
      if (!items) return reply.code(404).send({ error: 'Not found' });
      return reply.code(200).send({ items: items.map(serializeItem) });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/ocr-jobs/:id/items/:itemId', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { id, itemId } = request.params as { id: string; itemId: string };
      const item = await getOcrJobItem(session, id, itemId);
      if (!item) return reply.code(404).send({ error: 'Not found' });
      return reply.code(200).send({ item: serializeItem(item) });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── Export ────────────────────────────────────────────────────────
  app.get('/ocr-jobs/:id/export', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const { format: formatRaw } = (request.query ?? {}) as { format?: string };
      const format = (formatRaw ?? 'json').toLowerCase();
      const job = await getOcrJob(session, id);
      if (!job) return reply.code(404).send({ error: 'Not found' });
      const items = (await getOcrJobItems(session, id)) ?? [];
      const filenameBase = `ocr_${String(job._id)}`;

      if (format === 'csv') {
        const lines = ['index,file_name,status,full_text,summary,structured,total_tokens,cost_total'];
        for (const it of items) {
          lines.push([
            csvEscape(it.index), csvEscape(it.fileName), csvEscape(it.status),
            csvEscape(it.result?.fullText), csvEscape(it.result?.summary),
            csvEscape(it.result?.structured ? JSON.stringify(it.result.structured) : ''),
            csvEscape(it.usage?.totalTokens), csvEscape(it.costTotal),
          ].join(','));
        }
        reply.header('Content-Type', 'text/csv; charset=utf-8');
        reply.header('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
        return reply.send(lines.join('\n'));
      }
      if (format === 'jsonl') {
        reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
        reply.header('Content-Disposition', `attachment; filename="${filenameBase}.jsonl"`);
        return reply.send(items.map((it) => JSON.stringify(serializeItem(it))).join('\n'));
      }
      reply.header('Content-Type', 'application/json; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filenameBase}.json"`);
      return reply.send(JSON.stringify({ job: serializeJob(job), items: items.map(serializeItem) }, null, 2));
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
