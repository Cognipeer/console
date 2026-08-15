/**
 * Traffic Snapshots API plugin — sample production traffic (gateway
 * model-usage logs / agent tracing sessions) into an evaluation dataset,
 * behind a mandatory anonymization gate.
 *
 *   POST /snapshots/preview – count matching + would-sample rows, per-model/
 *                             agent breakdown; never returns payload content
 *   POST /snapshots         – create the dataset (refuses without `anonymize`)
 *
 * The pseudonym salt is accepted from the caller (deterministic tokens across
 * multiple snapshots) or generated per request when absent; it is never
 * persisted and never echoed back.
 *
 * NOTE: registration in plugin.ts is done by the integration orchestrator —
 * see .integration-handoff/snapshots.md.
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { IPiiCustomPattern } from '@/lib/database';
import {
  listSnapshotFilterOptions,
  previewSnapshot,
} from '@/lib/services/snapshots/snapshotService';
import { enqueueSnapshotDataset } from '@/lib/services/snapshots/snapshotJob';
import type { SnapshotFilters, SnapshotSource } from '@/lib/services/snapshots/types';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:snapshots');

const SOURCES: SnapshotSource[] = ['gateway', 'tracing'];

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

interface SnapshotRequestBody {
  source?: string;
  from?: string;
  to?: string;
  modelKey?: string;
  agentName?: string;
  status?: string;
  samplePct?: number;
  limit?: number;
  // create only
  name?: string;
  description?: string;
  anonymize?: {
    categories?: string[];
    strategy?: string;
    salt?: string;
    customPatterns?: IPiiCustomPattern[];
  };
}

function parseFilters(body: SnapshotRequestBody): SnapshotFilters {
  return {
    from: parseDate(body.from),
    to: parseDate(body.to),
    modelKey: typeof body.modelKey === 'string' && body.modelKey.trim() ? body.modelKey.trim() : undefined,
    agentName: typeof body.agentName === 'string' && body.agentName.trim() ? body.agentName.trim() : undefined,
    status: body.status === 'success' || body.status === 'error' ? body.status : undefined,
    samplePct: typeof body.samplePct === 'number' ? body.samplePct : undefined,
    limit: typeof body.limit === 'number' ? body.limit : undefined,
  };
}

function parseSource(body: SnapshotRequestBody): SnapshotSource | undefined {
  return SOURCES.includes(body.source as SnapshotSource) ? (body.source as SnapshotSource) : undefined;
}

export const snapshotsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/snapshots/filters', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = request.query as { from?: string; to?: string };
      const options = await listSnapshotFilterOptions(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, userId: session.userId },
        { from: parseDate(query.from), to: parseDate(query.to) },
      );
      return reply.code(200).send(options);
    } catch (error) {
      logger.error('Snapshot filter options error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.post('/snapshots/preview', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<SnapshotRequestBody>(request);
      const source = parseSource(body);
      if (!source) {
        return reply.code(400).send({ error: '`source` must be "gateway" or "tracing"' });
      }
      const preview = await previewSnapshot(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, userId: session.userId },
        { source, filters: parseFilters(body) },
      );
      return reply.code(200).send(preview);
    } catch (error) {
      logger.error('Snapshot preview error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.post('/snapshots', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<SnapshotRequestBody>(request);
      const source = parseSource(body);
      if (!source) {
        return reply.code(400).send({ error: '`source` must be "gateway" or "tracing"' });
      }
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return reply.code(400).send({ error: '`name` is required' });
      }
      if (!body.anonymize || typeof body.anonymize !== 'object') {
        return reply.code(400).send({ error: '`anonymize` is required — snapshot creation must pass the anonymization gate' });
      }
      const strategy = body.anonymize.strategy;
      if (strategy !== 'mask' && strategy !== 'pseudonym') {
        return reply.code(400).send({ error: '`anonymize.strategy` must be "mask" or "pseudonym"' });
      }
      // Background job: the scan is too slow to hold the request open (large
      // tracing snapshots died on proxy timeouts). 202 + datasetId; the
      // wizard polls the dataset's metadata.snapshot.status.
      const result = await enqueueSnapshotDataset(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, userId: session.userId },
        {
          source,
          filters: parseFilters(body),
          name: body.name.trim(),
          description: body.description,
          anonymize: {
            categories: Array.isArray(body.anonymize.categories) ? body.anonymize.categories : [],
            strategy,
            // Caller-supplied salt keeps pseudonyms stable across snapshots;
            // when absent the job generates one at run time (never persisted).
            ...(typeof body.anonymize.salt === 'string' && body.anonymize.salt.length > 0
              ? { salt: body.anonymize.salt }
              : {}),
            customPatterns: Array.isArray(body.anonymize.customPatterns)
              ? body.anonymize.customPatterns
              : undefined,
          },
        },
      );
      return reply.code(202).send(result);
    } catch (error) {
      if (error instanceof Error && /required|must/.test(error.message)) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Snapshot create error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));
};
