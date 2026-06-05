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

import { createLogger } from '@/lib/core/logger';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import type { IEvaluationDataset } from '@/lib/database';
import { createDataset, updateDataset, type WithId } from './service';
import { generateDatasetItems, type DatasetGenerationSource } from './datasetGeneration';

const logger = createLogger('eval-dataset-gen:job');

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
  error?: string;
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
  await queue.publish(DATASET_GEN_QUEUE, DATASET_GEN_JOB, payload, { attempts: 2, backoffMs: 3000 });
  logger.info('Dataset generation enqueued', { datasetId: dataset.id, count: input.count });

  return dataset;
}

async function writeStatus(
  payload: DatasetGenerationJobPayload,
  meta: DatasetGenerationMeta,
  items?: IEvaluationDataset['items'],
): Promise<void> {
  await updateDataset(payload.tenantDbName, payload.datasetId, payload.createdBy, {
    ...(items ? { items } : {}),
    metadata: { generation: meta },
  });
}

/** Execute one generation job. Throws on failure so the queue can retry. */
export async function runDatasetGenerationJob(payload: DatasetGenerationJobPayload): Promise<void> {
  const base = { requested: payload.count, source: payload.sourceKind };
  await writeStatus(payload, { ...base, status: 'running', startedAt: nowIso() });

  try {
    const { items } = await generateDatasetItems({
      tenantDbName: payload.tenantDbName,
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      generationModelKey: payload.generationModelKey,
      source: payload.source,
      count: payload.count,
      language: payload.language,
    });

    await writeStatus(
      payload,
      { ...base, status: 'ready', generated: items.length, finishedAt: nowIso() },
      items,
    );
    logger.info('Dataset generation completed', { datasetId: payload.datasetId, generated: items.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Generation failed';
    await writeStatus(payload, { ...base, status: 'failed', error: message, finishedAt: nowIso() });
    logger.error('Dataset generation failed', { datasetId: payload.datasetId, error: message });
    throw err;
  }
}
