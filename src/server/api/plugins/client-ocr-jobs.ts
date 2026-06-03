/**
 * Client OCR Jobs API (API-token authenticated).
 *
 * An OCR Job is a persistent container (rules + bucket + callback). Files are
 * sent to it over time and processed per-file via queue fan-out, producing
 * full-text / summary / structured output with token+cost accounting and an
 * optional per-file callback.
 *
 * Routes mounted under `/api`, living at `/client/v1/ocr-jobs`.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { LicenseType } from '@/lib/license/license-manager';
import { createLogger } from '@/lib/core/logger';
import { isShuttingDown } from '@/lib/core/lifecycle';
import { runWithRequestContext } from '@/lib/core/requestContext';
import { ApiTokenAuthError, type ApiTokenContext } from '@/lib/services/apiTokenAuth';
import {
  checkBudget,
  checkPerRequestLimits,
  checkRateLimit,
} from '@/lib/quota/quotaGuard';
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
import { readJsonBody, requireApiTokenContext } from '../fastify-utils';

const logger = createLogger('api:client-ocr-jobs');

const VALID_OUTPUTS: OcrOutputKind[] = ['full_text', 'summary', 'structured'];
const VALID_EVENTS: OcrJobWebhookEvent[] = ['item.succeeded', 'item.failed'];

function unauthorizedPayload(message = 'Invalid API token') {
  return { error: { message, type: 'invalid_request_error' } };
}
function quotaExceededPayload(message = 'Quota exceeded') {
  return { error: { message, type: 'rate_limit_error' } };
}

function withClientContext(
  handler: (request: FastifyRequest, reply: FastifyReply, auth: ApiTokenContext) => Promise<unknown> | unknown,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (isShuttingDown()) {
      return reply.code(503).header('Retry-After', '5').send({ error: { message: 'Service is shutting down', type: 'server_error' } });
    }
    let auth: ApiTokenContext;
    try {
      auth = await requireApiTokenContext(request);
      request.apiTokenContext = auth;
    } catch (error) {
      if (error instanceof ApiTokenAuthError) return reply.code(401).send(unauthorizedPayload(error.message));
      logger.error('OCR jobs auth error', { error });
      return reply.code(401).send(unauthorizedPayload());
    }
    return runWithRequestContext(
      {
        requestId: request.apiRequestId,
        tenantId: auth.tenantId,
        tenantSlug: auth.tenantSlug,
        userId: auth.user?._id ? String(auth.user._id) : undefined,
      },
      () => handler(request, reply, auth),
    );
  };
}

async function runQuotaGuard(auth: ApiTokenContext, modelKey: string): Promise<string | null> {
  const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
  const ctx = {
    tenantDbName: auth.tenantDbName,
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    licenseType: auth.tenant.licenseType as LicenseType,
    userId: auth.tokenRecord.userId,
    tokenId,
    domain: 'ocr' as const,
    resourceKey: modelKey,
  };
  const perRequest = await checkPerRequestLimits(ctx, {});
  if (!perRequest.allowed) return perRequest.reason || 'Quota exceeded';
  const rate = await checkRateLimit(ctx, { requests: 1 });
  if (!rate.allowed) return rate.reason || 'Rate limit exceeded';
  const budget = await checkBudget(ctx);
  if (!budget.allowed) return budget.reason || 'Budget exceeded';
  return null;
}

function ctxFromAuth(auth: ApiTokenContext): OcrJobContext {
  return { tenantDbName: auth.tenantDbName, tenantId: auth.tenantId, projectId: auth.projectId, userId: auth.tokenRecord.userId };
}

function getContentType(request: FastifyRequest): string {
  const h = request.headers['content-type'];
  return Array.isArray(h) ? h[0] ?? '' : (h ?? '');
}

async function parseFormData(request: FastifyRequest): Promise<FormData> {
  const body = request.body;
  const buf = Buffer.isBuffer(body)
    ? body
    : typeof body === 'string'
      ? Buffer.from(body, 'utf8')
      : Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  const req = new Request('http://internal.local/_multipart', {
    method: 'POST',
    headers: { 'content-type': getContentType(request) },
    body: new Uint8Array(buf),
  });
  return req.formData();
}

function normalizeOutputs(raw: unknown): OcrOutputKind[] {
  const arr = Array.isArray(raw) ? raw.map((v) => String(v)) : typeof raw === 'string' ? raw.split(',').map((v) => v.trim()) : [];
  const filtered = arr.filter((v): v is OcrOutputKind => (VALID_OUTPUTS as string[]).includes(v));
  return filtered.length ? filtered : ['full_text'];
}

function normalizeEvents(raw: unknown): OcrJobWebhookEvent[] | undefined {
  if (raw === undefined) return undefined;
  const arr = Array.isArray(raw) ? raw.map((v) => String(v)) : typeof raw === 'string' ? raw.split(',').map((v) => v.trim()) : [];
  const filtered = arr.filter((v): v is OcrJobWebhookEvent => (VALID_EVENTS as string[]).includes(v));
  return filtered.length ? filtered : undefined;
}

function itemFromJson(raw: unknown): OcrJobItemInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const fileName = typeof obj.fileName === 'string' ? obj.fileName : undefined;

  const src = obj.source as Record<string, unknown> | undefined;
  if (src && typeof src.kind === 'string') {
    if (src.kind === 'inline' && typeof src.data === 'string') {
      return { source: { kind: 'inline', data: src.data, fileName: typeof src.fileName === 'string' ? src.fileName : fileName, contentType: typeof src.contentType === 'string' ? src.contentType : undefined }, fileName };
    }
    if (src.kind === 'url' && typeof src.url === 'string') {
      return { source: { kind: 'url', url: src.url, contentType: typeof src.contentType === 'string' ? src.contentType : undefined }, fileName };
    }
    if (src.kind === 'bucket' && typeof src.bucketKey === 'string' && typeof src.objectKey === 'string') {
      return { source: { kind: 'bucket', bucketKey: src.bucketKey, objectKey: src.objectKey }, fileName };
    }
  }

  const bucket = obj.bucket as Record<string, unknown> | undefined;
  if (bucket && typeof bucket.bucketKey === 'string' && typeof bucket.objectKey === 'string') {
    return { source: { kind: 'bucket', bucketKey: bucket.bucketKey, objectKey: bucket.objectKey }, fileName };
  }
  const document = (obj.document as Record<string, unknown> | undefined) ?? obj;
  if (typeof document.url === 'string') {
    return { source: { kind: 'url', url: document.url, contentType: typeof document.contentType === 'string' ? document.contentType : undefined }, fileName };
  }
  if (typeof document.data === 'string') {
    const f = typeof document.fileName === 'string' ? document.fileName : fileName;
    return { source: { kind: 'inline', data: document.data, fileName: f, contentType: typeof document.contentType === 'string' ? document.contentType : undefined }, fileName: f };
  }
  return null;
}

function buildCreateInput(body: Record<string, unknown>): CreateOcrJobInput {
  const ocrModelKey = typeof body.ocr_model === 'string' ? body.ocr_model : typeof body.model === 'string' ? body.model : '';
  if (!ocrModelKey) throw new OcrJobValidationError('`ocr_model` is required.');
  const bucketKey = typeof body.bucket_key === 'string' ? body.bucket_key : typeof body.bucketKey === 'string' ? body.bucketKey : '';
  if (!bucketKey) throw new OcrJobValidationError('`bucket_key` is required.');
  return {
    name: typeof body.name === 'string' ? body.name : undefined,
    bucketKey,
    ocrModelKey,
    llmModelKey: typeof body.llm_model === 'string' ? body.llm_model : undefined,
    outputs: normalizeOutputs(body.outputs),
    summaryPrompt: typeof body.summary_prompt === 'string' ? body.summary_prompt : undefined,
    structuredSchema: body.structured_schema && typeof body.structured_schema === 'object' ? (body.structured_schema as Record<string, unknown>) : undefined,
    language: typeof body.language === 'string' ? body.language : undefined,
    features: Array.isArray(body.features) ? body.features.map((v) => String(v)) : undefined,
    pdfMaxPages: typeof body.pdf_max_pages === 'number' ? body.pdf_max_pages : undefined,
    callbackUrl: typeof body.callback_url === 'string' ? body.callback_url : undefined,
    callbackSecret: typeof body.callback_secret === 'string' ? body.callback_secret : undefined,
    callbackEvents: normalizeEvents(body.callback_events),
    metadata: body.metadata && typeof body.metadata === 'object' ? (body.metadata as Record<string, unknown>) : undefined,
  };
}

async function buildFileInputs(request: FastifyRequest): Promise<{ items: OcrJobItemInput[]; mode: 'sync' | 'async' }> {
  const contentType = getContentType(request);
  if (contentType.startsWith('multipart/form-data')) {
    const form = await parseFormData(request);
    const items: OcrJobItemInput[] = [];
    for (const value of form.getAll('files').concat(form.getAll('file'))) {
      if (value && typeof value !== 'string') {
        const blob = value as Blob & { name?: string };
        const data = Buffer.from(await blob.arrayBuffer()).toString('base64');
        items.push({ source: { kind: 'inline', data, fileName: blob.name, contentType: blob.type || undefined }, fileName: blob.name });
      }
    }
    const mode = String(form.get('mode') ?? 'async') === 'sync' ? 'sync' : 'async';
    return { items, mode };
  }
  if (contentType.includes('application/json')) {
    const body = readJsonBody<Record<string, unknown>>(request);
    const raw = Array.isArray(body.items) ? body.items : Array.isArray(body.documents) ? body.documents : [];
    const items = raw.map(itemFromJson).filter((v): v is OcrJobItemInput => v !== null);
    return { items, mode: body.mode === 'sync' ? 'sync' : 'async' };
  }
  throw new OcrJobValidationError('Content-Type must be multipart/form-data or application/json.');
}

function serializeJob(job: IOcrJob) {
  return {
    id: String(job._id),
    name: job.name,
    status: job.status,
    bucket_key: job.bucketKey,
    ocr_model: job.ocrModelKey,
    llm_model: job.llmModelKey,
    outputs: job.outputs,
    pdf_max_pages: job.pdfMaxPages ?? null,
    callback_url: job.callbackUrl,
    items_total: job.itemsTotal,
    items_processed: job.itemsProcessed,
    items_failed: job.itemsFailed,
    usage: {
      input_tokens: job.usageInputTokens ?? 0,
      output_tokens: job.usageOutputTokens ?? 0,
      total_tokens: job.usageTotalTokens ?? 0,
      pages: job.usagePages ?? 0,
      ocr_tokens: job.usageOcrTokens ?? 0,
      llm_tokens: job.usageLlmTokens ?? 0,
    },
    cost_total: job.costTotal ?? 0,
    cost_ocr: job.costOcr ?? 0,
    cost_llm: job.costLlm ?? 0,
    cost_currency: job.costCurrency,
    last_item_at: job.lastItemAt,
    created_at: job.createdAt,
  };
}

function serializeItem(item: IOcrJobItem) {
  return {
    id: String(item._id),
    index: item.index,
    file_name: item.fileName,
    status: item.status,
    result: item.result,
    usage: item.usage,
    cost_total: item.costTotal,
    cost_currency: item.costCurrency,
    callback_status: item.callbackStatus,
    error_message: item.errorMessage,
  };
}

function csvEscape(value: unknown): string {
  const str = value === undefined || value === null ? '' : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function badReq(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: { message, type: 'invalid_request_error' } });
}
function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: { message: 'Not found', type: 'invalid_request_error' } });
}

export const clientOcrJobsApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Create job (container) ────────────────────────────────────────
  app.post('/client/v1/ocr-jobs', withClientContext(async (request, reply, auth) => {
    try {
      const input = buildCreateInput(readJsonBody<Record<string, unknown>>(request));
      const job = await createOcrJob(ctxFromAuth(auth), input);
      return reply.code(201).send({ job: serializeJob(job) });
    } catch (error) {
      if (error instanceof OcrJobValidationError) return badReq(reply, error.message);
      logger.error('Create OCR job failed', { error });
      return reply.code(500).send({ error: { message: error instanceof Error ? error.message : 'OCR job error', type: 'server_error' } });
    }
  }));

  app.get('/client/v1/ocr-jobs', withClientContext(async (request, reply, auth) => {
    const query = (request.query ?? {}) as { status?: string; limit?: string };
    const jobs = await listOcrJobs(ctxFromAuth(auth), { status: query.status, limit: query.limit ? Number(query.limit) : undefined });
    return reply.code(200).send({ jobs: jobs.map(serializeJob) });
  }));

  app.get('/client/v1/ocr-jobs/:id', withClientContext(async (request, reply, auth) => {
    const { id } = request.params as { id: string };
    const job = await getOcrJob(auth, id);
    if (!job) return notFound(reply);
    return reply.code(200).send({ job: serializeJob(job) });
  }));

  app.patch('/client/v1/ocr-jobs/:id', withClientContext(async (request, reply, auth) => {
    try {
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const patch: UpdateOcrJobInput = {};
      if (typeof body.name === 'string') patch.name = body.name;
      if (typeof body.status === 'string' && ['active', 'paused', 'archived'].includes(body.status)) patch.status = body.status as IOcrJob['status'];
      if (typeof body.ocr_model === 'string') patch.ocrModelKey = body.ocr_model;
      if (typeof body.llm_model === 'string') patch.llmModelKey = body.llm_model;
      if (body.outputs !== undefined) patch.outputs = normalizeOutputs(body.outputs);
      if (typeof body.summary_prompt === 'string') patch.summaryPrompt = body.summary_prompt;
      if (body.structured_schema !== undefined) patch.structuredSchema = body.structured_schema as Record<string, unknown>;
      if (typeof body.language === 'string') patch.language = body.language;
      if (typeof body.pdf_max_pages === 'number') patch.pdfMaxPages = body.pdf_max_pages;
      if (typeof body.callback_url === 'string') patch.callbackUrl = body.callback_url;
      if (typeof body.callback_secret === 'string') patch.callbackSecret = body.callback_secret;
      if (body.callback_events !== undefined) patch.callbackEvents = normalizeEvents(body.callback_events);
      const job = await updateOcrJob(auth, id, patch);
      if (!job) return notFound(reply);
      return reply.code(200).send({ job: serializeJob(job) });
    } catch (error) {
      if (error instanceof OcrJobValidationError) return badReq(reply, error.message);
      logger.error('Update OCR job failed', { error });
      return reply.code(500).send({ error: { message: 'OCR job error', type: 'server_error' } });
    }
  }));

  app.delete('/client/v1/ocr-jobs/:id', withClientContext(async (request, reply, auth) => {
    const { id } = request.params as { id: string };
    const ok = await deleteOcrJob(auth, id);
    if (!ok) return notFound(reply);
    return reply.code(200).send({ ok: true });
  }));

  // ── Send files to a job ───────────────────────────────────────────
  app.post('/client/v1/ocr-jobs/:id/files', withClientContext(async (request, reply, auth) => {
    try {
      const { id } = request.params as { id: string };
      const job = await getOcrJob(auth, id);
      if (!job) return notFound(reply);

      const quotaError = await runQuotaGuard(auth, job.ocrModelKey);
      if (quotaError) return reply.code(429).send(quotaExceededPayload(quotaError));

      const { items, mode } = await buildFileInputs(request);
      if (!items.length) return badReq(reply, 'At least one file is required');

      const result = await addFilesToJob(ctxFromAuth(auth), id, items, { mode });
      return reply.code(result.sync ? 200 : 202).send({ items: result.items.map(serializeItem) });
    } catch (error) {
      if (error instanceof OcrJobValidationError) return badReq(reply, error.message);
      logger.error('Add files to OCR job failed', { error });
      return reply.code(500).send({ error: { message: error instanceof Error ? error.message : 'OCR job error', type: 'server_error' } });
    }
  }));

  app.post('/client/v1/ocr-jobs/:id/pause', withClientContext(async (request, reply, auth) => {
    const { id } = request.params as { id: string };
    const job = await setOcrJobStatus(auth, id, 'paused');
    if (!job) return notFound(reply);
    return reply.code(200).send({ job: serializeJob(job) });
  }));

  app.post('/client/v1/ocr-jobs/:id/resume', withClientContext(async (request, reply, auth) => {
    const { id } = request.params as { id: string };
    const job = await setOcrJobStatus(auth, id, 'active');
    if (!job) return notFound(reply);
    return reply.code(200).send({ job: serializeJob(job) });
  }));

  // ── Items ─────────────────────────────────────────────────────────
  app.get('/client/v1/ocr-jobs/:id/items', withClientContext(async (request, reply, auth) => {
    const { id } = request.params as { id: string };
    const { limit, skip, status } = (request.query ?? {}) as { limit?: string; skip?: string; status?: string };
    const items = await getOcrJobItems(auth, id, { limit: limit ? Number(limit) : undefined, skip: skip ? Number(skip) : undefined, status });
    if (!items) return notFound(reply);
    return reply.code(200).send({ items: items.map(serializeItem) });
  }));

  app.get('/client/v1/ocr-jobs/:id/items/:itemId', withClientContext(async (request, reply, auth) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const item = await getOcrJobItem(auth, id, itemId);
    if (!item) return notFound(reply);
    return reply.code(200).send({ item: serializeItem(item) });
  }));

  // ── Usage (aggregate token + cost) ────────────────────────────────
  app.get('/client/v1/ocr-jobs/:id/usage', withClientContext(async (request, reply, auth) => {
    const { id } = request.params as { id: string };
    const job = await getOcrJob(auth, id);
    if (!job) return notFound(reply);
    return reply.code(200).send({
      usage: {
        items_total: job.itemsTotal,
        items_processed: job.itemsProcessed,
        items_failed: job.itemsFailed,
        input_tokens: job.usageInputTokens ?? 0,
        output_tokens: job.usageOutputTokens ?? 0,
        total_tokens: job.usageTotalTokens ?? 0,
        pages: job.usagePages ?? 0,
        ocr_tokens: job.usageOcrTokens ?? 0,
        llm_tokens: job.usageLlmTokens ?? 0,
        cost_total: job.costTotal ?? 0,
        cost_ocr: job.costOcr ?? 0,
        cost_llm: job.costLlm ?? 0,
        cost_currency: job.costCurrency,
      },
    });
  }));

  // ── Export ────────────────────────────────────────────────────────
  app.get('/client/v1/ocr-jobs/:id/export', withClientContext(async (request, reply, auth) => {
    const { id } = request.params as { id: string };
    const { format: formatRaw } = (request.query ?? {}) as { format?: string };
    const format = (formatRaw ?? 'json').toLowerCase();
    const job = await getOcrJob(auth, id);
    if (!job) return notFound(reply);
    const items = (await getOcrJobItems(auth, id)) ?? [];
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
  }));
};
