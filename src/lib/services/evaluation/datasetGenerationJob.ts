/**
 * Async dataset generation — queue enqueue + job runner.
 *
 * Generating a Q&A dataset can take many model calls, so it must not block the
 * HTTP request. Instead:
 *   1. `enqueueDatasetGeneration` creates an empty `generated` dataset with a
 *      `metadata.generation.status = 'pending'` marker and publishes a job.
 *   2. The queue consumer (see `datasetGenerationConsumer`) calls
 *      `runDatasetGenerationJob`, which flips the status to `running`, generates
 *      the items, then writes them back with status `ready` (or `failed`).
 *
 * Progress is tracked on the dataset's own `metadata` — no extra collection —
 * so the dashboard can poll the normal dataset list and show a live badge.
 */

import { isServiceDisabledError } from '@/lib/services/availability/serviceAvailability';
import { createLogger } from '@/lib/core/logger';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import type { IEvaluationDataset } from '@/lib/database';
import {
  appendDatasetItems,
  createDataset,
  getDataset,
  listDatasetItems,
  patchDatasetMetadata,
  type WithId,
} from './service';
import { generateDatasetItems, type DatasetGenerationSource } from './datasetGeneration';

const logger = createLogger('eval-dataset-gen:job');

/** Queue attempts (first run included); the job writes `failed` only on the last one. */
export const DATASET_GEN_ATTEMPTS = 2;

/** Dedicated queue + job name (plain name works on both memory + bullmq). */
export const DATASET_GEN_QUEUE = 'evaluation-dataset-gen';
export const DATASET_GEN_JOB = 'dataset.generate';

export type DatasetGenerationStatus = 'pending' | 'running' | 'ready' | 'failed';
export type DatasetGenerationSourceKind = 'rag' | 'text' | 'file';

export interface DatasetGenerationMeta {
  status: DatasetGenerationStatus;
  requested: number;
  source: DatasetGenerationSourceKind;
  generated?: number;
  /** Set when fewer pairs than `requested` were produced. */
  warning?: string;
  error?: string;
  /** The last failed attempt's message while the queue still has a retry left (status stays `running`). */
  lastError?: string;
  /** Set when the job was refused because its service is switched off. */
  errorCode?: string;
  enqueuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface DatasetGenerationJobPayload extends QueuePayload {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  datasetId: string;
  createdBy: string;
  generationModelKey: string;
  source: DatasetGenerationSource;
  sourceKind: DatasetGenerationSourceKind;
  count: number;
  language?: string;
}

export interface EnqueueDatasetGenerationInput {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  createdBy: string;
  name: string;
  description?: string;
  generationModelKey: string;
  source: DatasetGenerationSource;
  sourceKind: DatasetGenerationSourceKind;
  count: number;
  language?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Create the placeholder dataset and publish the generation job. Returns the
 * dataset immediately (with `pending` status) so the caller can respond fast.
 */
export async function enqueueDatasetGeneration(
  input: EnqueueDatasetGenerationInput,
): Promise<WithId<IEvaluationDataset>> {
  const generation: DatasetGenerationMeta = {
    status: 'pending',
    requested: input.count,
    source: input.sourceKind,
    enqueuedAt: nowIso(),
  };

  const dataset = await createDataset(input.tenantDbName, input.tenantId, input.createdBy, {
    name: input.name,
    description: input.description,
    source: 'generated',
    items: [],
    projectId: input.projectId,
    metadata: { generation },
  });

  const payload: DatasetGenerationJobPayload = {
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    projectId: input.projectId,
    datasetId: dataset.id,
    createdBy: input.createdBy,
    generationModelKey: input.generationModelKey,
    source: input.source,
    sourceKind: input.sourceKind,
    count: input.count,
    language: input.language,
  };

  const queue = await getQueue();
  await queue.publish(DATASET_GEN_QUEUE, DATASET_GEN_JOB, payload, { attempts: DATASET_GEN_ATTEMPTS, backoffMs: 3000 });
  logger.info('Dataset generation enqueued', { datasetId: dataset.id, count: input.count });

  return dataset;
}

/**
 * Write the generation status block alone (an atomic patch of `metadata.generation`): the dataset's other
 * metadata (snapshot status, labeling, ...) and its items are untouched. Returns false when the dataset is gone.
 */
async function writeStatus(payload: DatasetGenerationJobPayload, meta: DatasetGenerationMeta): Promise<boolean> {
  const updated = await patchDatasetMetadata(payload.tenantDbName, payload.datasetId, { generation: meta });
  return updated !== null;
}

/** Items already in the dataset: how many carry the `generated` tag, and every id (to avoid id clashes). */
async function scanItems(
  payload: DatasetGenerationJobPayload,
): Promise<{ total: number; generated: number; ids: Set<string> }> {
  const PAGE = 200;
  const ids = new Set<string>();
  let generated = 0;
  let total = 0;
  for (let skip = 0; ; skip += PAGE) {
    const page = await listDatasetItems(payload.tenantDbName, payload.datasetId, { skip, limit: PAGE });
    total = page.total;
    for (const item of page.items) {
      if (item.id) ids.add(item.id);
      if (item.tags?.includes('generated')) generated += 1;
    }
    if (page.items.length < PAGE || skip + PAGE >= total) break;
  }
  return { total, generated, ids };
}

/**
 * Execute one generation job. Throws on failure so the queue can retry.
 *
 * `ctx.attemptsMade` lets the job tell the last attempt from an earlier one: `failed` is written only on the last,
 * so a retry never flips the status failed -> running. (The memory queue counts the running attempt, BullMQ counts
 * finished ones; the check errs towards writing `failed` early rather than leaving the dataset `running` forever.)
 */
export async function runDatasetGenerationJob(
  payload: DatasetGenerationJobPayload,
  ctx?: { attemptsMade?: number },
): Promise<void> {
  const base = { requested: payload.count, source: payload.sourceKind };

  // A deleted dataset is not an error to retry: stop before any model call is paid for.
  const existing = await getDataset(payload.tenantDbName, payload.datasetId);
  if (!existing) {
    logger.warn('Dataset generation skipped: the dataset no longer exists', { datasetId: payload.datasetId });
    return;
  }
  const previous = (existing.metadata as { generation?: DatasetGenerationMeta } | undefined)?.generation;
  // A redelivered job whose previous run already finished must not generate (and pay) again.
  if (previous?.status === 'ready') {
    logger.info('Dataset generation skipped: already finished', { datasetId: payload.datasetId });
    return;
  }

  // Items are appended in one call, so a retry after a crash between that append and the `ready` write finds
  // the generated items already there: finalise instead of generating a second copy.
  let takenIds = new Set<string>();
  if (previous?.status === 'running') {
    const found = await scanItems(payload);
    if (found.generated > 0) {
      await writeStatus(payload, {
        ...base,
        status: 'ready',
        generated: found.generated,
        ...(previous.startedAt ? { startedAt: previous.startedAt } : {}),
        finishedAt: nowIso(),
      });
      logger.info('Dataset generation finalised from items of an earlier attempt', {
        datasetId: payload.datasetId,
        generated: found.generated,
      });
      return;
    }
    takenIds = found.ids;
  } else {
    // Not a retry: the dataset normally has no items, so skip the full scan unless something is there.
    const head = await listDatasetItems(payload.tenantDbName, payload.datasetId, { limit: 1 });
    if (head.total > 0) takenIds = (await scanItems(payload)).ids;
  }

  const startedAt = nowIso();
  if (!(await writeStatus(payload, { ...base, status: 'running', startedAt }))) {
    logger.warn('Dataset generation skipped: the dataset was deleted', { datasetId: payload.datasetId });
    return;
  }

  try {
    const result = await generateDatasetItems({
      tenantDbName: payload.tenantDbName,
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      generationModelKey: payload.generationModelKey,
      source: payload.source,
      count: payload.count,
      language: payload.language,
      createdBy: payload.createdBy,
      shouldAbort: async () => (await getDataset(payload.tenantDbName, payload.datasetId)) === null,
    });
    if (result.aborted) {
      logger.warn('Dataset generation stopped: the dataset was deleted', { datasetId: payload.datasetId });
      return;
    }

    // Append instead of replacing: items the user added or edited while the job ran must survive. Ids that
    // clash with items already there are renamed rather than rejected.
    let next = 0;
    const items = result.items.map((item) => {
      let id = item.id;
      while (takenIds.has(id)) id = `gen-${payload.datasetId.slice(-4)}-${++next}`;
      takenIds.add(id);
      return id === item.id ? item : { ...item, id };
    });
    await appendDatasetItems(payload.tenantDbName, payload.datasetId, items);

    const stillThere = await writeStatus(payload, {
      ...base,
      status: 'ready',
      generated: items.length,
      startedAt,
      finishedAt: nowIso(),
      ...(result.warning ? { warning: result.warning } : {}),
    });
    if (!stillThere) return;
    logger.info('Dataset generation completed', { datasetId: payload.datasetId, generated: items.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Generation failed';
    const errorCode = isServiceDisabledError(err) ? err.code : undefined;
    const retryable = (err as { retryable?: unknown } | null)?.retryable !== false;
    const finalAttempt = !retryable || ctx?.attemptsMade === undefined || ctx.attemptsMade + 1 >= DATASET_GEN_ATTEMPTS;
    if (finalAttempt) {
      await writeStatus(payload, {
        ...base,
        status: 'failed',
        error: message,
        ...(errorCode ? { errorCode } : {}),
        startedAt,
        finishedAt: nowIso(),
      });
    } else {
      // A retry follows: keep `running` (no failed -> running flap) and note why the attempt failed.
      await writeStatus(payload, { ...base, status: 'running', startedAt, lastError: message });
    }
    logger.error('Dataset generation failed', { datasetId: payload.datasetId, error: message, finalAttempt });
    throw err;
  }
}
