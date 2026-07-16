/**
 * OCR Job service.
 *
 * An OCR Job is a persistent container: rules (models/outputs/schema) + a
 * storage area (bucket + prefix) + an optional callback. Files are sent to it
 * over time; each file is uploaded to the bucket, recorded as an item, and
 * processed independently via per-item queue fan-out (concurrent, multi-node).
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import type { IOcrJob, IOcrJobItem, OcrOutputKind } from '@/lib/database';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { queueNameFor } from '@/lib/core/cluster';
import { uploadFile } from '@/lib/services/files/fileService';
import { resolveUsageAttribution } from '@/lib/services/usage/usageEvents';
import { processOcrItem } from './ocrJobRunner';
import {
  type AddFilesResult,
  type CreateOcrJobInput,
  type OcrJobContext,
  type OcrJobItemInput,
  type UpdateOcrJobInput,
} from './types';

const logger = createLogger('ocr-job:service');

export class OcrJobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrJobValidationError';
  }
}

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

function validateRules(input: { ocrModelKey?: string; outputs?: OcrOutputKind[]; llmModelKey?: string; structuredSchema?: unknown }): void {
  if (!input.ocrModelKey) throw new OcrJobValidationError('`ocrModelKey` is required');
  const outputs = input.outputs?.length ? input.outputs : ['full_text'];
  const needsLlm = outputs.includes('summary') || outputs.includes('structured');
  if (needsLlm && !input.llmModelKey) {
    throw new OcrJobValidationError('`llmModelKey` is required when outputs include summary or structured');
  }
  if (outputs.includes('structured') && !input.structuredSchema) {
    throw new OcrJobValidationError('`structuredSchema` is required when outputs include structured');
  }
}

export async function createOcrJob(ctx: OcrJobContext, input: CreateOcrJobInput): Promise<IOcrJob> {
  validateRules(input);
  if (!input.bucketKey) throw new OcrJobValidationError('`bucketKey` is required (select a Document Store bucket)');
  const db = await withTenantDb(ctx.tenantDbName);

  const outputs: OcrOutputKind[] = input.outputs?.length ? input.outputs : ['full_text'];
  const jobId = randomUUID();
  // Attribution is stamped at creation (request ALS in scope); rollup events
  // are emitted per item by the runner.
  const attribution = resolveUsageAttribution();
  const job = await db.createOcrJob({
    userId: attribution.userId,
    apiTokenId: attribution.apiTokenId,
    actorType: attribution.actorType,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    name: input.name,
    status: 'active',
    bucketKey: input.bucketKey,
    prefix: `ocr-jobs/${jobId}/`,
    ocrModelKey: input.ocrModelKey,
    llmModelKey: input.llmModelKey,
    outputs,
    summaryPrompt: input.summaryPrompt,
    structuredSchema: input.structuredSchema,
    language: input.language,
    features: input.features,
    pdfMaxPages: input.pdfMaxPages,
    callbackUrl: input.callbackUrl,
    callbackSecret: input.callbackSecret,
    callbackEvents: input.callbackEvents,
    itemsTotal: 0,
    itemsProcessed: 0,
    itemsFailed: 0,
    metadata: { ...(input.metadata ?? {}), jobId },
    createdBy: ctx.userId,
  });
  return job;
}

export async function updateOcrJob(
  ctx: Pick<OcrJobContext, 'tenantDbName' | 'tenantId'>,
  jobId: string,
  patch: UpdateOcrJobInput,
): Promise<IOcrJob | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const job = await db.findOcrJobById(jobId);
  if (!job || job.tenantId !== ctx.tenantId) return null;
  if (patch.ocrModelKey || patch.outputs || patch.structuredSchema !== undefined) {
    validateRules({
      ocrModelKey: patch.ocrModelKey ?? job.ocrModelKey,
      outputs: patch.outputs ?? job.outputs,
      llmModelKey: patch.llmModelKey ?? job.llmModelKey,
      structuredSchema: patch.structuredSchema ?? job.structuredSchema,
    });
  }
  return db.updateOcrJob(jobId, patch);
}

/**
 * Send files to a job. Inline uploads are written to the job's bucket; bucket
 * and url sources are referenced directly. Each file becomes an item and is
 * enqueued for processing (or run inline when `mode === 'sync'`).
 */
export async function addFilesToJob(
  ctx: OcrJobContext,
  jobId: string,
  inputs: OcrJobItemInput[],
  options?: { mode?: 'sync' | 'async' },
): Promise<AddFilesResult> {
  if (!inputs.length) throw new OcrJobValidationError('At least one file is required');
  const db = await withTenantDb(ctx.tenantDbName);
  const job = await db.findOcrJobById(jobId);
  if (!job || job.tenantId !== ctx.tenantId) throw new OcrJobValidationError('Job not found');
  if (job.status !== 'active') throw new OcrJobValidationError(`Job is ${job.status}; resume it to accept files`);

  const mode = options?.mode ?? 'async';
  const baseIndex = job.itemsTotal;
  const created: IOcrJobItem[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    let source = input.source;

    // Persist inline uploads to the job's bucket and reference by key.
    if (source.kind === 'inline') {
      const fileName = source.fileName ?? input.fileName ?? `document-${baseIndex + i}`;
      const uploaded = await uploadFile(ctx.tenantDbName, ctx.tenantId, ctx.projectId ?? '', {
        bucketKey: job.bucketKey,
        fileName,
        contentType: source.contentType,
        data: source.data, // base64
        convertToMarkdown: false,
        keyHint: `${job.prefix ?? ''}${randomUUID()}-${fileName}`,
        createdBy: ctx.userId,
        metadata: { ocrJobId: jobId },
      });
      source = { kind: 'bucket', bucketKey: job.bucketKey, objectKey: uploaded.record.key };
    }

    const item = await db.createOcrJobItem({
      tenantId: ctx.tenantId,
      jobId,
      index: baseIndex + i,
      source,
      fileName: input.fileName ?? (input.source.kind === 'inline' ? input.source.fileName : undefined),
      status: 'pending',
    });
    await db.incrementOcrJobAggregates(jobId, { itemsTotal: 1 });
    created.push(item);
  }

  // Sync: single file, process inline and return the result.
  if (mode === 'sync' && created.length === 1) {
    const processed = await processOcrItem(ctx, String(created[0]._id));
    return { items: processed ? [processed] : created, sync: true };
  }

  // Async: fan out one queue job per item.
  const queue = await getQueue();
  for (const item of created) {
    const payload = { ctx, itemId: String(item._id) } as unknown as QueuePayload;
    await queue.publish(queueNameFor('ocr'), 'ocr.item', payload, { attempts: 3, backoffMs: 2000 });
  }
  return { items: created };
}

export async function getOcrJob(
  ctx: Pick<OcrJobContext, 'tenantDbName' | 'tenantId'>,
  jobId: string,
): Promise<IOcrJob | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const job = await db.findOcrJobById(jobId);
  if (!job || job.tenantId !== ctx.tenantId) return null;
  return job;
}

export async function listOcrJobs(
  ctx: OcrJobContext,
  filters?: { status?: string; limit?: number },
): Promise<IOcrJob[]> {
  const db = await withTenantDb(ctx.tenantDbName);
  return db.listOcrJobs(ctx.tenantId, {
    projectId: ctx.projectId,
    status: filters?.status,
    limit: filters?.limit,
  });
}

export async function getOcrJobItems(
  ctx: Pick<OcrJobContext, 'tenantDbName' | 'tenantId'>,
  jobId: string,
  options?: { limit?: number; skip?: number; status?: string },
): Promise<IOcrJobItem[] | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const job = await db.findOcrJobById(jobId);
  if (!job || job.tenantId !== ctx.tenantId) return null;
  return db.listOcrJobItems(jobId, options);
}

export async function getOcrJobItem(
  ctx: Pick<OcrJobContext, 'tenantDbName' | 'tenantId'>,
  jobId: string,
  itemId: string,
): Promise<IOcrJobItem | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const item = await db.findOcrJobItemById(itemId);
  if (!item || item.tenantId !== ctx.tenantId || item.jobId !== jobId) return null;
  return item;
}

export async function setOcrJobStatus(
  ctx: Pick<OcrJobContext, 'tenantDbName' | 'tenantId'>,
  jobId: string,
  status: IOcrJob['status'],
): Promise<IOcrJob | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const job = await db.findOcrJobById(jobId);
  if (!job || job.tenantId !== ctx.tenantId) return null;
  return db.updateOcrJob(jobId, { status });
}

export async function deleteOcrJob(
  ctx: Pick<OcrJobContext, 'tenantDbName' | 'tenantId'>,
  jobId: string,
): Promise<boolean> {
  const db = await withTenantDb(ctx.tenantDbName);
  const job = await db.findOcrJobById(jobId);
  if (!job || job.tenantId !== ctx.tenantId) return false;
  return db.deleteOcrJob(jobId);
}

export { queueNameFor };
export { logger as ocrJobLogger };
