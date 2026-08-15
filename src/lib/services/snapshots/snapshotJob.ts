/**
 * Async snapshot creation — queue enqueue + job runner.
 *
 * Scanning up to SNAPSHOT_SCAN_CAP rows (and, for tracing sources, fetching
 * every sampled session's events) is too slow to hold an HTTP request open —
 * large snapshots died silently on proxy timeouts. The wizard therefore goes
 * through a queue job (mirroring dataset generation):
 *   1. `enqueueSnapshotDataset` creates an empty dataset with
 *      `metadata.snapshot.status = 'pending'` and publishes a job.
 *   2. The queue consumer (see `snapshotConsumer.ts`) calls `runSnapshotJob`,
 *      which flips the status to `running`, builds the items
 *      (scan → sample → redact + anonymize), then writes them back with
 *      status `ready` (or `failed` + error).
 *
 * Status lives on the dataset's own metadata — no extra collection — so the
 * wizard (and the dataset list) can poll the normal dataset endpoints.
 *
 * Salt: a caller-provided stable salt travels only inside the transient queue
 * payload; when absent, the salt is generated AT RUN TIME so it never leaves
 * the executing process. Dataset metadata never records it either way.
 */

import { randomBytes } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { createDataset, updateDataset } from '@/lib/services/evaluation/service';
import type { AnonymizeOptions } from '@/lib/services/pii/anonymize';
import { assertAnonymizeOptions, buildSnapshotDataset } from './snapshotService';
import type {
  CreateSnapshotParams,
  SnapshotContext,
  SnapshotFilters,
  SnapshotSource,
} from './types';

const logger = createLogger('snapshots:job');

/** Dedicated queue + job name (plain name works on both memory + bullmq). */
export const SNAPSHOT_QUEUE = 'evaluation-snapshot';
export const SNAPSHOT_JOB = 'snapshot.create';

export type SnapshotJobStatus = 'pending' | 'running' | 'ready' | 'failed';

/** Wire-safe filters (dates as ISO strings) for the queue payload. */
interface SnapshotJobFilters {
  from?: string;
  to?: string;
  modelKey?: string;
  agentName?: string;
  status?: 'success' | 'error';
  samplePct?: number;
  limit?: number;
}

export interface SnapshotJobPayload extends QueuePayload {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  userId?: string;
  datasetId: string;
  name: string;
  description?: string;
  source: SnapshotSource;
  filters: SnapshotJobFilters;
  anonymize: {
    categories: string[];
    strategy: 'mask' | 'pseudonym';
    /** Present only when the caller supplied a stable salt. */
    salt?: string;
    customPatterns?: AnonymizeOptions['customPatterns'];
  };
  enqueuedAt: string;
}

/** `enqueueSnapshotDataset` input: like the sync path, but salt is optional. */
export type EnqueueSnapshotParams = Omit<CreateSnapshotParams, 'anonymize'> & {
  anonymize: Omit<AnonymizeOptions, 'salt'> & { salt?: string };
};

function nowIso(): string {
  return new Date().toISOString();
}

/** metadata.snapshot shape while the job is still in flight (no counts yet).
 *  (Pick, not Omit — Omit over QueuePayload's index signature erases types.) */
function pendingSnapshotMeta(
  payload: Pick<SnapshotJobPayload, 'source' | 'filters' | 'anonymize' | 'enqueuedAt'>,
  status: SnapshotJobStatus,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status,
    source: payload.source,
    filters: {
      from: payload.filters.from,
      to: payload.filters.to,
      modelKey: payload.filters.modelKey,
      agentName: payload.filters.agentName,
      status: payload.filters.status,
    },
    samplePct: payload.filters.samplePct,
    limit: payload.filters.limit,
    anonymization: {
      strategy: payload.anonymize.strategy,
      categories: payload.anonymize.categories,
      customPatternCount: payload.anonymize.customPatterns?.length ?? 0,
    },
    enqueuedAt: payload.enqueuedAt,
    ...extra,
  };
}

async function writeSnapshotStatus(
  payload: SnapshotJobPayload,
  meta: Record<string, unknown>,
  items?: Parameters<typeof updateDataset>[3]['items'],
): Promise<void> {
  await updateDataset(payload.tenantDbName, payload.datasetId, payload.userId ?? 'system', {
    ...(items ? { items } : {}),
    metadata: { snapshot: meta },
  });
}

/**
 * Create the placeholder dataset and publish the snapshot job. Returns
 * immediately so the HTTP handler can respond 202; the wizard polls the
 * dataset's `metadata.snapshot.status` for progress.
 */
export async function enqueueSnapshotDataset(
  ctx: SnapshotContext,
  params: EnqueueSnapshotParams,
): Promise<{ datasetId: string; name: string; status: SnapshotJobStatus }> {
  if (typeof params.name !== 'string' || !params.name.trim()) {
    throw new Error('`name` is required');
  }
  // Validate the anonymization gate up front (with a throwaway salt when none
  // was given) so a bad request fails the HTTP call, not the background job.
  assertAnonymizeOptions({ ...params.anonymize, salt: params.anonymize.salt ?? 'pending' });

  const filters = params.filters ?? {};
  const wireFilters: SnapshotJobFilters = {
    from: filters.from?.toISOString(),
    to: filters.to?.toISOString(),
    modelKey: filters.modelKey,
    agentName: filters.agentName,
    status: filters.status,
    samplePct: filters.samplePct,
    limit: filters.limit,
  };
  const payloadBase = {
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    userId: ctx.userId,
    name: params.name,
    description: params.description,
    source: params.source,
    filters: wireFilters,
    anonymize: {
      categories: params.anonymize.categories,
      strategy: params.anonymize.strategy,
      ...(params.anonymize.salt ? { salt: params.anonymize.salt } : {}),
      ...(params.anonymize.customPatterns
        ? { customPatterns: params.anonymize.customPatterns }
        : {}),
    },
    enqueuedAt: nowIso(),
  };

  const dataset = await createDataset(ctx.tenantDbName, ctx.tenantId, ctx.userId ?? 'system', {
    name: params.name,
    description: params.description,
    source: 'generated',
    projectId: ctx.projectId,
    items: [],
    metadata: { snapshot: pendingSnapshotMeta(payloadBase, 'pending') },
  });

  const payload: SnapshotJobPayload = { ...payloadBase, datasetId: dataset.id };
  const queue = await getQueue();
  await queue.publish(SNAPSHOT_QUEUE, SNAPSHOT_JOB, payload, { attempts: 2, backoffMs: 3000 });
  logger.info('Snapshot creation enqueued', { datasetId: dataset.id, source: params.source });

  return { datasetId: dataset.id, name: dataset.name, status: 'pending' };
}

/** Execute one snapshot job. Throws on failure so the queue can retry. */
export async function runSnapshotJob(payload: SnapshotJobPayload): Promise<void> {
  const startedAt = nowIso();
  await writeSnapshotStatus(payload, pendingSnapshotMeta(payload, 'running', { startedAt }));

  try {
    const filters: SnapshotFilters = {
      from: payload.filters.from ? new Date(payload.filters.from) : undefined,
      to: payload.filters.to ? new Date(payload.filters.to) : undefined,
      modelKey: payload.filters.modelKey,
      agentName: payload.filters.agentName,
      status: payload.filters.status,
      samplePct: payload.filters.samplePct,
      limit: payload.filters.limit,
    };
    const anonymize: AnonymizeOptions = {
      categories: payload.anonymize.categories,
      strategy: payload.anonymize.strategy,
      customPatterns: payload.anonymize.customPatterns,
      salt: payload.anonymize.salt ?? randomBytes(16).toString('hex'),
    };
    const build = await buildSnapshotDataset(
      {
        tenantDbName: payload.tenantDbName,
        tenantId: payload.tenantId,
        projectId: payload.projectId,
        userId: payload.userId,
      },
      {
        name: payload.name,
        description: payload.description,
        source: payload.source,
        filters,
        anonymize,
      },
    );

    await writeSnapshotStatus(
      payload,
      { ...build.snapshotMeta, status: 'ready', enqueuedAt: payload.enqueuedAt, startedAt, finishedAt: nowIso() },
      build.items,
    );
    logger.info('Snapshot job completed', {
      datasetId: payload.datasetId,
      created: build.items.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Snapshot creation failed';
    await writeSnapshotStatus(
      payload,
      pendingSnapshotMeta(payload, 'failed', { startedAt, finishedAt: nowIso(), error: message }),
    );
    logger.error('Snapshot job failed', { datasetId: payload.datasetId, error: message });
    throw err;
  }
}
