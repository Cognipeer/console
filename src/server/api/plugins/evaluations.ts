import { Buffer } from 'node:buffer';
import type { FastifyPluginAsync } from 'fastify';
import type {
  EvaluationTargetKind,
  IEvaluationScorerConfig,
  IEvaluationDatasetItem,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import type { DatasetGenerationSource } from '@/lib/services/evaluation/datasetGeneration';
import { enqueueDatasetGeneration } from '@/lib/services/evaluation/datasetGenerationJob';
import { convertFileToText } from '@/lib/services/rag/ragService';
import {
  compareRuns,
  createDataset,
  createSuite,
  createTarget,
  deleteDataset,
  deleteSuite,
  deleteTarget,
  getDataset,
  getRun,
  getSuite,
  getTarget,
  listDatasets,
  listRuns,
  listSuites,
  listTargets,
  updateDataset,
  updateSuite,
  updateTarget,
} from '@/lib/services/evaluation/service';
import { enqueueSuiteRun } from '@/lib/services/evaluation/evaluationRunJob';
import {
  readJsonBody,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:evaluations');

const VALID_KINDS: EvaluationTargetKind[] = ['agent', 'model', 'external'];
const VALID_SCORERS = ['assertion', 'llm-judge', 'semantic'];

function internalError(reply: import('fastify').FastifyReply, error: unknown) {
  return (
    sendProjectContextError(reply, error)
    ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' })
  );
}

function sanitizeScorers(raw: unknown): IEvaluationScorerConfig[] | null {
  if (!Array.isArray(raw)) return null;
  const scorers: IEvaluationScorerConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.type !== 'string' || !VALID_SCORERS.includes(e.type)) return null;
    scorers.push({
      type: e.type as IEvaluationScorerConfig['type'],
      weight: typeof e.weight === 'number' ? e.weight : undefined,
      rubric: typeof e.rubric === 'string' ? e.rubric : undefined,
      threshold: typeof e.threshold === 'number' ? e.threshold : undefined,
    });
  }
  return scorers;
}

export const evaluationsApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Targets ────────────────────────────────────────────────────────

  app.get('/evaluation/targets', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { kind?: EvaluationTargetKind; search?: string };
      const targets = await listTargets(session.tenantDbName, { projectId, kind: query.kind, search: query.search });
      return reply.code(200).send({ targets });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.post('/evaluation/targets', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }
      if (!VALID_KINDS.includes(body.kind as EvaluationTargetKind)) {
        return reply.code(400).send({ error: 'kind must be "agent", "model", or "external"' });
      }
      if (body.kind === 'model' && typeof body.modelKey !== 'string') {
        return reply.code(400).send({ error: 'modelKey is required for model targets' });
      }
      if (body.kind === 'agent' && typeof body.agentKey !== 'string') {
        return reply.code(400).send({ error: 'agentKey is required for agent targets' });
      }
      const target = await createTarget(session.tenantDbName, session.tenantId, session.userId, {
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description : undefined,
        kind: body.kind as EvaluationTargetKind,
        agentKey: body.agentKey as string | undefined,
        modelKey: body.modelKey as string | undefined,
        external: body.external as never,
        defaultParams: body.defaultParams as Record<string, unknown> | undefined,
        projectId,
      });
      return reply.code(201).send({ target });
    } catch (error) {
      logger.error('Create evaluation target error', { error });
      return internalError(reply, error);
    }
  }));

  app.get('/evaluation/targets/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const target = await getTarget(session.tenantDbName, id);
      if (!target) return reply.code(404).send({ error: 'Target not found' });
      return reply.code(200).send({ target });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.patch('/evaluation/targets/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const target = await updateTarget(session.tenantDbName, id, session.userId, {
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        agentKey: body.agentKey as string | undefined,
        modelKey: body.modelKey as string | undefined,
        defaultParams: body.defaultParams as Record<string, unknown> | undefined,
      });
      if (!target) return reply.code(404).send({ error: 'Target not found' });
      return reply.code(200).send({ target });
    } catch (error) {
      logger.error('Update evaluation target error', { error });
      return internalError(reply, error);
    }
  }));

  app.delete('/evaluation/targets/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const deleted = await deleteTarget(session.tenantDbName, id);
      if (!deleted) return reply.code(404).send({ error: 'Target not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── Datasets ───────────────────────────────────────────────────────

  app.get('/evaluation/datasets', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string };
      const datasets = await listDatasets(session.tenantDbName, { projectId, search: query.search });
      return reply.code(200).send({ datasets });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.post('/evaluation/datasets', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }
      if (body.items !== undefined && !Array.isArray(body.items)) {
        return reply.code(400).send({ error: 'items must be an array' });
      }
      const dataset = await createDataset(session.tenantDbName, session.tenantId, session.userId, {
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description : undefined,
        items: body.items as IEvaluationDatasetItem[] | undefined,
        projectId,
      });
      return reply.code(201).send({ dataset });
    } catch (error) {
      logger.error('Create evaluation dataset error', { error });
      return internalError(reply, error);
    }
  }));

  // Generate a Q&A dataset from a RAG module's documents, pasted text, or an
  // uploaded file, then persist it as a `generated` dataset.
  app.post('/evaluation/datasets/generate', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }
      if (typeof body.generationModelKey !== 'string' || body.generationModelKey === '') {
        return reply.code(400).send({ error: 'generationModelKey is required' });
      }
      const sourceType = body.sourceType;
      if (sourceType !== 'rag' && sourceType !== 'text' && sourceType !== 'file') {
        return reply.code(400).send({ error: 'sourceType must be "rag", "text", or "file"' });
      }

      let source: DatasetGenerationSource;
      if (sourceType === 'rag') {
        if (typeof body.ragModuleKey !== 'string' || body.ragModuleKey === '') {
          return reply.code(400).send({ error: 'ragModuleKey is required for sourceType "rag"' });
        }
        source = {
          type: 'rag',
          ragModuleKey: body.ragModuleKey,
          maxChunks: typeof body.maxChunks === 'number' ? body.maxChunks : undefined,
        };
      } else if (sourceType === 'text') {
        if (typeof body.text !== 'string' || body.text.trim() === '') {
          return reply.code(400).send({ error: 'text is required for sourceType "text"' });
        }
        source = { type: 'text', text: body.text };
      } else {
        if (typeof body.fileData !== 'string' || typeof body.fileName !== 'string') {
          return reply.code(400).send({ error: 'fileName and fileData are required for sourceType "file"' });
        }
        const payload = body.fileData.startsWith('data:')
          ? body.fileData.slice(body.fileData.indexOf(',') + 1)
          : body.fileData;
        const buffer = Buffer.from(payload, 'base64');
        const text = await convertFileToText(
          body.fileName,
          buffer,
          typeof body.contentType === 'string' ? body.contentType : undefined,
        );
        source = { type: 'text', text };
      }

      // Enqueue async generation; returns a pending dataset immediately so the
      // request never blocks on the (potentially long) model calls.
      const dataset = await enqueueDatasetGeneration({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        createdBy: session.userId,
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description : undefined,
        generationModelKey: body.generationModelKey,
        source,
        sourceKind: sourceType,
        count: typeof body.count === 'number' && body.count > 0 ? body.count : 10,
        language: typeof body.language === 'string' ? body.language : undefined,
      });

      return reply.code(202).send({ dataset, status: 'pending' });
    } catch (error) {
      logger.error('Generate evaluation dataset error', { error });
      return sendProjectContextError(reply, error) ?? internalError(reply, error);
    }
  }));

  app.get('/evaluation/datasets/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const dataset = await getDataset(session.tenantDbName, id);
      if (!dataset) return reply.code(404).send({ error: 'Dataset not found' });
      return reply.code(200).send({ dataset });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.patch('/evaluation/datasets/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      if (body.items !== undefined && !Array.isArray(body.items)) {
        return reply.code(400).send({ error: 'items must be an array' });
      }
      const dataset = await updateDataset(session.tenantDbName, id, session.userId, {
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        items: body.items as IEvaluationDatasetItem[] | undefined,
      });
      if (!dataset) return reply.code(404).send({ error: 'Dataset not found' });
      return reply.code(200).send({ dataset });
    } catch (error) {
      logger.error('Update evaluation dataset error', { error });
      return internalError(reply, error);
    }
  }));

  app.delete('/evaluation/datasets/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const deleted = await deleteDataset(session.tenantDbName, id);
      if (!deleted) return reply.code(404).send({ error: 'Dataset not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── Suites ─────────────────────────────────────────────────────────

  app.get('/evaluation/suites', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string };
      const suites = await listSuites(session.tenantDbName, { projectId, search: query.search });
      return reply.code(200).send({ suites });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.post('/evaluation/suites', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }
      if (typeof body.targetKey !== 'string' || typeof body.datasetKey !== 'string') {
        return reply.code(400).send({ error: 'targetKey and datasetKey are required' });
      }
      const scorers = sanitizeScorers(body.scorers);
      if (!scorers || scorers.length === 0) {
        return reply.code(400).send({ error: 'scorers must be a non-empty array of { type: "assertion" | "llm-judge" }' });
      }
      const runConfig = body.runConfig && typeof body.runConfig === 'object'
        ? { concurrency: Number((body.runConfig as Record<string, unknown>).concurrency) || undefined }
        : undefined;
      const suite = await createSuite(session.tenantDbName, session.tenantId, session.userId, {
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description : undefined,
        targetKey: body.targetKey,
        datasetKey: body.datasetKey,
        scorers,
        judgeModelKey: typeof body.judgeModelKey === 'string' ? body.judgeModelKey : undefined,
        embeddingModelKey: typeof body.embeddingModelKey === 'string' ? body.embeddingModelKey : undefined,
        runConfig,
        projectId,
      });
      return reply.code(201).send({ suite });
    } catch (error) {
      logger.error('Create evaluation suite error', { error });
      return internalError(reply, error);
    }
  }));

  app.get('/evaluation/suites/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const suite = await getSuite(session.tenantDbName, id);
      if (!suite) return reply.code(404).send({ error: 'Suite not found' });
      return reply.code(200).send({ suite });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.patch('/evaluation/suites/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const scorers = body.scorers !== undefined ? sanitizeScorers(body.scorers) : undefined;
      if (body.scorers !== undefined && !scorers) {
        return reply.code(400).send({ error: 'scorers must be an array of { type: "assertion" | "llm-judge" }' });
      }
      const suite = await updateSuite(session.tenantDbName, id, session.userId, {
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        targetKey: body.targetKey as string | undefined,
        datasetKey: body.datasetKey as string | undefined,
        scorers: scorers ?? undefined,
        judgeModelKey: body.judgeModelKey as string | undefined,
        embeddingModelKey: body.embeddingModelKey as string | undefined,
      });
      if (!suite) return reply.code(404).send({ error: 'Suite not found' });
      return reply.code(200).send({ suite });
    } catch (error) {
      logger.error('Update evaluation suite error', { error });
      return internalError(reply, error);
    }
  }));

  app.delete('/evaluation/suites/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const deleted = await deleteSuite(session.tenantDbName, id);
      if (!deleted) return reply.code(404).send({ error: 'Suite not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── Runs ───────────────────────────────────────────────────────────

  app.post('/evaluation/suites/:key/run', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      // Enqueue + return immediately (status 'pending'); the queue consumer runs
      // it in the background so the dashboard never blocks on a long run. The UI
      // polls the run detail endpoint to watch progress.
      const run = await enqueueSuiteRun({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        createdBy: session.userId,
        suiteKey: key,
      });
      return reply.code(202).send({ run });
    } catch (error) {
      logger.error('Run evaluation suite error', { error });
      if (error instanceof Error && error.message.toLowerCase().includes('not found')) {
        return reply.code(404).send({ error: error.message });
      }
      if (error instanceof Error && error.message.toLowerCase().includes('already in progress')) {
        return reply.code(409).send({ error: error.message });
      }
      return internalError(reply, error);
    }
  }));

  app.get('/evaluation/runs', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { suiteKey?: string; limit?: string; skip?: string };
      const runs = await listRuns(session.tenantDbName, {
        projectId,
        suiteKey: query.suiteKey,
        limit: query.limit ? Math.min(Number.parseInt(query.limit, 10), 200) : undefined,
        skip: query.skip ? Number.parseInt(query.skip, 10) : undefined,
      });
      return reply.code(200).send({ runs });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.get('/evaluation/runs/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const run = await getRun(session.tenantDbName, id);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      return reply.code(200).send({ run });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.get('/evaluation/runs/:id/compare', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const { baseline } = (request.query ?? {}) as { baseline?: string };
      if (!baseline) return reply.code(400).send({ error: 'baseline run id is required' });
      const comparison = await compareRuns(session.tenantDbName, id, baseline);
      if (!comparison) return reply.code(404).send({ error: 'Run or baseline not found' });
      return reply.code(200).send({ comparison });
    } catch (error) {
      return internalError(reply, error);
    }
  }));
};
