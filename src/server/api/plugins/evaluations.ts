import { Buffer } from 'node:buffer';
import type { FastifyPluginAsync } from 'fastify';
import type {
  EvaluationTargetKind,
  EvaluationTurnMode,
  IEvaluationScorerConfig,
  IEvaluationDataset,
  IEvaluationDatasetItem,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import type { DatasetGenerationSource } from '@/lib/services/evaluation/datasetGeneration';
import { enqueueDatasetGeneration } from '@/lib/services/evaluation/datasetGenerationJob';
import { convertFileToText } from '@/lib/services/rag/ragService';
import type { CloneDatasetFilter } from '@/lib/services/evaluation/service';
import {
  appendDatasetItems,
  cloneDataset,
  compareRuns,
  createDataset,
  createSuite,
  createTarget,
  deleteDataset,
  deleteDatasetItem,
  deleteSuite,
  deleteTarget,
  getDataset,
  getDatasetItem,
  getRun,
  getSuite,
  getTarget,
  listAllDatasetItemLabels,
  listDatasetItems,
  listDatasets,
  listRuns,
  listSuites,
  listTargets,
  updateDataset,
  updateDatasetItem,
  updateSuite,
  updateTarget,
} from '@/lib/services/evaluation/service';
import { enqueueSuiteRun } from '@/lib/services/evaluation/evaluationRunJob';
import { summarizeLabels } from '@/lib/services/evaluation/labelSummary';
import { SUPPORTED_SCORERS } from '@/lib/services/evaluation/scorers';
import { enqueueDefinitionRun } from '@/lib/services/analysis/analysisRunJob';
import type { RunSelection } from '@/lib/services/analysis/service';
import {
  readJsonBody,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:evaluations');

const VALID_KINDS: EvaluationTargetKind[] = ['agent', 'model', 'external', 'rag'];
// Mirror the scorer registry rather than a hand-kept copy: this list drifted
// behind `SUPPORTED_SCORERS` and left 'tool-call' unreachable — the scorer, its
// tests, and the snapshot builder's `expected.toolCalls` all shipped, but no
// client could ever create a suite that used them.
const VALID_SCORERS: readonly string[] = SUPPORTED_SCORERS;

/**
 * Retrieval knobs for a `rag` target. An out-of-range value is DROPPED rather
 * than clamped, so the target falls back to the Knowledge Engine module's own
 * defaults instead of quietly running under a number nobody chose.
 */
function sanitizeTopK(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const topK = Math.trunc(raw);
  return topK >= 1 && topK <= 200 ? topK : undefined;
}

function sanitizeMinScore(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return raw >= 0 && raw <= 1 ? raw : undefined;
}

function internalError(reply: import('fastify').FastifyReply, error: unknown) {
  return (
    sendProjectContextError(reply, error)
    ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' })
  );
}

/**
 * Project-boundary guard for id-addressed dataset routes: knowing a dataset's
 * id must not grant access to another project's data (datasets can hold
 * anonymized production traffic). Legacy datasets without a projectId stay
 * reachable from any project of the tenant.
 */
function datasetInProject(dataset: { projectId?: string }, projectId: string | undefined): boolean {
  return !dataset.projectId || dataset.projectId === projectId;
}

/**
 * Label keys become a MongoDB dotted path / SQLite JSON path, so only simple
 * field-key characters are accepted — a key with a dot or `$` would address a
 * different document field entirely.
 */
function sanitizeLabelKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(key) ? key : null;
}

/**
 * Suite run settings. `turnMode` decides how a multi-turn item is replayed:
 * `single` (default) sends the recorded prefix and calls the model once,
 * `perTurn` drives the conversation and feeds the model its own answers back.
 * An unrecognised value falls back to the default rather than failing the
 * request — the field is additive and old clients omit it.
 */
function sanitizeRunConfig(raw: unknown): { concurrency?: number; turnMode?: EvaluationTurnMode } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const config = raw as Record<string, unknown>;
  const concurrency = Number(config.concurrency) || undefined;
  const turnMode = config.turnMode === 'perTurn' ? 'perTurn' : config.turnMode === 'single' ? 'single' : undefined;
  if (concurrency === undefined && turnMode === undefined) return undefined;
  return { ...(concurrency !== undefined ? { concurrency } : {}), ...(turnMode ? { turnMode } : {}) };
}

/** Item ceiling for the label-distribution scan (see the endpoint's note). */
const LABEL_SUMMARY_SCAN_CAP = 20000;

const VALID_LABEL_STRATEGIES = ['all', 'unanalyzed', 'random', 'tag', 'keys'] as const;

/** Which items a labeling run covers (mirrors the analysis run selection). */
function sanitizeLabelSelection(raw: unknown): RunSelection | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.strategy !== 'string' || !VALID_LABEL_STRATEGIES.includes(s.strategy as (typeof VALID_LABEL_STRATEGIES)[number])) {
    return undefined;
  }
  const sampleSize = Number(s.sampleSize);
  const itemIds = Array.isArray(s.itemIds)
    ? (s.itemIds as unknown[]).filter((k): k is string => typeof k === 'string')
    : undefined;
  return {
    strategy: s.strategy as RunSelection['strategy'],
    tag: typeof s.tag === 'string' && s.tag.trim() ? s.tag.trim() : undefined,
    sampleSize: Number.isFinite(sampleSize) && sampleSize > 0 ? Math.floor(sampleSize) : undefined,
    // Dataset items are addressed by item id; the run selection calls the
    // field `conversationKeys` because it predates dataset targets.
    conversationKeys: itemIds,
  };
}

/** Accept only plain scalar label values (the shapes an extraction produces). */
function sanitizeLabels(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const labels: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const safeKey = sanitizeLabelKey(key);
    if (!safeKey) return null;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) labels[safeKey] = value;
    else return null;
  }
  return labels;
}

/**
 * Validate an incoming dataset-items payload: every item needs an object
 * shape, an `input` message array and a non-empty unique string `id` (items
 * are addressed by id under a unique (dataset, id) constraint — catching
 * duplicates here turns a would-be destructive 409/500 into a clean 400).
 * Returns an error string or null.
 */
function validateItemsPayload(items: unknown[]): string | null {
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as Record<string, unknown> | null;
    if (!item || typeof item !== 'object' || !Array.isArray(item.input)) {
      return `items[${i}] must be an object with an "input" message array`;
    }
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      return `items[${i}] must have a non-empty string "id"`;
    }
    if (seen.has(item.id)) {
      return `items[${i}] duplicates item id "${item.id}"`;
    }
    seen.add(item.id);
  }
  return null;
}

/** Map dataset-item service errors onto 409 (duplicate) / 404 (gone). */
function sendItemError(reply: import('fastify').FastifyReply, error: unknown) {
  if (!(error instanceof Error)) return null;
  if (error.message.includes('already exists')) return reply.code(409).send({ error: error.message });
  if (error.message.includes('not found')) return reply.code(404).send({ error: error.message });
  return null;
}

function sanitizeScorers(raw: unknown): IEvaluationScorerConfig[] | null {
  if (!Array.isArray(raw)) return null;
  const scorers: IEvaluationScorerConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.type !== 'string' || !VALID_SCORERS.includes(e.type)) return null;
    // Every field a scorer can be configured with has to be listed here: an
    // unlisted key is dropped silently and the scorer runs on its defaults,
    // which is indistinguishable from the knob having no effect.
    scorers.push({
      type: e.type as IEvaluationScorerConfig['type'],
      weight: typeof e.weight === 'number' ? e.weight : undefined,
      rubric: typeof e.rubric === 'string' ? e.rubric : undefined,
      threshold: typeof e.threshold === 'number' ? e.threshold : undefined,
      selectionWeight: typeof e.selectionWeight === 'number' ? e.selectionWeight : undefined,
      sequenceWeight: typeof e.sequenceWeight === 'number' ? e.sequenceWeight : undefined,
      argsWeight: typeof e.argsWeight === 'number' ? e.argsWeight : undefined,
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
        return reply.code(400).send({ error: `kind must be one of ${VALID_KINDS.map((k) => `"${k}"`).join(', ')}` });
      }
      if (body.kind === 'model' && typeof body.modelKey !== 'string') {
        return reply.code(400).send({ error: 'modelKey is required for model targets' });
      }
      if (body.kind === 'agent' && typeof body.agentKey !== 'string') {
        return reply.code(400).send({ error: 'agentKey is required for agent targets' });
      }
      if (body.kind === 'rag' && typeof body.ragModuleKey !== 'string') {
        return reply.code(400).send({ error: 'ragModuleKey is required for Knowledge Engine targets' });
      }
      const target = await createTarget(session.tenantDbName, session.tenantId, session.userId, {
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description : undefined,
        kind: body.kind as EvaluationTargetKind,
        agentKey: body.agentKey as string | undefined,
        modelKey: body.modelKey as string | undefined,
        external: body.external as never,
        ragModuleKey: typeof body.ragModuleKey === 'string' ? body.ragModuleKey : undefined,
        retrievalTopK: sanitizeTopK(body.retrievalTopK),
        retrievalMinScore: sanitizeMinScore(body.retrievalMinScore),
        systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : undefined,
        promptKey: typeof body.promptKey === 'string' ? body.promptKey : undefined,
        promptVersion: typeof body.promptVersion === 'number' ? body.promptVersion : undefined,
        responseFormat: body.responseFormat && typeof body.responseFormat === 'object' ? body.responseFormat as Record<string, unknown> : undefined,
        maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
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
        ragModuleKey: body.ragModuleKey as string | undefined,
        retrievalTopK: sanitizeTopK(body.retrievalTopK),
        retrievalMinScore: sanitizeMinScore(body.retrievalMinScore),
        systemPrompt: body.systemPrompt as string | undefined,
        promptKey: body.promptKey as string | undefined,
        promptVersion: body.promptVersion as number | undefined,
        responseFormat: body.responseFormat as Record<string, unknown> | undefined,
        maxTokens: body.maxTokens as number | undefined,
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
      if (Array.isArray(body.items)) {
        const invalid = validateItemsPayload(body.items);
        if (invalid) return reply.code(400).send({ error: invalid });
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
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const dataset = await getDataset(session.tenantDbName, id);
      if (!dataset || !datasetInProject(dataset, projectId)) {
        return reply.code(404).send({ error: 'Dataset not found' });
      }
      return reply.code(200).send({ dataset });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.patch('/evaluation/datasets/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const existing = await getDataset(session.tenantDbName, id);
      if (!existing || !datasetInProject(existing, projectId)) {
        return reply.code(404).send({ error: 'Dataset not found' });
      }
      const body = readJsonBody<Record<string, unknown>>(request);
      if (body.items !== undefined && !Array.isArray(body.items)) {
        return reply.code(400).send({ error: 'items must be an array' });
      }
      if (Array.isArray(body.items)) {
        const invalid = validateItemsPayload(body.items);
        if (invalid) return reply.code(400).send({ error: invalid });
      }
      // Only include provided fields: a `$set` with an explicit `undefined`
      // would null the field in Mongo, so an items-only PATCH must not touch
      // name/description.
      const data: Partial<Pick<IEvaluationDataset, 'name' | 'description' | 'items'>> = {};
      if (typeof body.name === 'string' && body.name.trim() !== '') data.name = body.name;
      if (typeof body.description === 'string') data.description = body.description;
      if (Array.isArray(body.items)) data.items = body.items as IEvaluationDatasetItem[];
      const dataset = await updateDataset(session.tenantDbName, id, session.userId, data);
      if (!dataset) return reply.code(404).send({ error: 'Dataset not found' });
      return reply.code(200).send({ dataset });
    } catch (error) {
      logger.error('Update evaluation dataset error', { error });
      return sendItemError(reply, error) ?? internalError(reply, error);
    }
  }));

  app.delete('/evaluation/datasets/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const existing = await getDataset(session.tenantDbName, id);
      if (!existing || !datasetInProject(existing, projectId)) {
        return reply.code(404).send({ error: 'Dataset not found' });
      }
      const deleted = await deleteDataset(session.tenantDbName, id);
      if (!deleted) return reply.code(404).send({ error: 'Dataset not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── Dataset items (paginated; items live in their own collection) ──

  app.get('/evaluation/datasets/:id/items', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const dataset = await getDataset(session.tenantDbName, id);
      if (!dataset || !datasetInProject(dataset, projectId)) {
        return reply.code(404).send({ error: 'Dataset not found' });
      }
      const query = (request.query ?? {}) as {
        limit?: string;
        skip?: string;
        search?: string;
        label?: string;
        labelValue?: string;
        labeled?: string;
      };
      const limit = query.limit ? Math.min(Math.max(Number.parseInt(query.limit, 10) || 50, 1), 500) : 50;
      const skip = query.skip ? Math.max(Number.parseInt(query.skip, 10) || 0, 0) : 0;
      const search = typeof query.search === 'string' && query.search.trim() !== '' ? query.search.trim() : undefined;
      const labelKey = sanitizeLabelKey(query.label);
      if (query.label !== undefined && !labelKey) {
        return reply.code(400).send({ error: 'label must be a simple field key' });
      }
      const { items, total } = await listDatasetItems(session.tenantDbName, id, {
        skip,
        limit,
        search,
        ...(labelKey
          ? { label: { key: labelKey, value: typeof query.labelValue === 'string' && query.labelValue !== '' ? query.labelValue : undefined } }
          : {}),
        ...(query.labeled === 'true' ? { labeled: true } : query.labeled === 'false' ? { labeled: false } : {}),
      });
      return reply.code(200).send({ items, total });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.post('/evaluation/datasets/:id/items', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const dataset = await getDataset(session.tenantDbName, id);
      if (!dataset || !datasetInProject(dataset, projectId)) {
        return reply.code(404).send({ error: 'Dataset not found' });
      }
      const body = readJsonBody<Record<string, unknown>>(request);
      const rawItems = Array.isArray(body.items) ? body.items : undefined;
      if (!rawItems || rawItems.length === 0) {
        return reply.code(400).send({ error: 'items must be a non-empty array' });
      }
      const invalid = validateItemsPayload(rawItems);
      if (invalid) return reply.code(400).send({ error: invalid });
      const { added, total } = await appendDatasetItems(
        session.tenantDbName,
        id,
        rawItems as IEvaluationDatasetItem[],
      );
      return reply.code(201).send({ added, total });
    } catch (error) {
      const mapped = sendItemError(reply, error);
      if (mapped) return mapped;
      logger.error('Append evaluation dataset items error', { error });
      return internalError(reply, error);
    }
  }));

  app.patch('/evaluation/datasets/:id/items/:itemId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id, itemId } = request.params as { id: string; itemId: string };
      const dataset = await getDataset(session.tenantDbName, id);
      if (!dataset || !datasetInProject(dataset, projectId)) {
        return reply.code(404).send({ error: 'Dataset not found' });
      }
      const body = readJsonBody<Record<string, unknown>>(request);
      if (body.input !== undefined && !Array.isArray(body.input)) {
        return reply.code(400).send({ error: 'input must be a message array' });
      }
      const data: Partial<Omit<IEvaluationDatasetItem, 'id'>> = {};
      if (Array.isArray(body.input)) data.input = body.input as IEvaluationDatasetItem['input'];
      if (body.expected !== undefined) data.expected = body.expected as IEvaluationDatasetItem['expected'];
      if (body.tools !== undefined) data.tools = body.tools as IEvaluationDatasetItem['tools'];
      if (body.toolResults !== undefined) data.toolResults = body.toolResults as IEvaluationDatasetItem['toolResults'];
      if (body.responseFormat !== undefined) data.responseFormat = body.responseFormat as IEvaluationDatasetItem['responseFormat'];
      if (body.tags !== undefined) data.tags = body.tags as string[];
      // A label edit through this route is a human decision: stamp the
      // provenance server-side so a later AI labeling run leaves it alone.
      if (body.labels !== undefined) {
        if (body.labels === null) {
          data.labels = null as unknown as IEvaluationDatasetItem['labels'];
          data.labelMeta = null as unknown as IEvaluationDatasetItem['labelMeta'];
        } else {
          const labels = sanitizeLabels(body.labels);
          if (!labels) {
            return reply.code(400).send({ error: 'labels must be an object of simple key → string/number/boolean values' });
          }
          const existing = await getDatasetItem(session.tenantDbName, id, itemId);
          data.labels = labels;
          data.labelMeta = {
            source: 'human',
            labeledBy: session.userId,
            labeledAt: new Date().toISOString(),
            ...(existing?.labelMeta?.definitionKey ? { definitionKey: existing.labelMeta.definitionKey } : {}),
          };
        }
      }
      const item = await updateDatasetItem(session.tenantDbName, id, itemId, data);
      if (!item) return reply.code(404).send({ error: 'Dataset item not found' });
      return reply.code(200).send({ item });
    } catch (error) {
      const mapped = sendItemError(reply, error);
      if (mapped) return mapped;
      logger.error('Update evaluation dataset item error', { error });
      return internalError(reply, error);
    }
  }));

  /**
   * Copy a filtered slice of this dataset into a new one — how a labeled
   * corpus becomes a GOLDEN SET: label with an analysis run, correct what
   * matters by hand, then clone the reviewed slice into a small stable dataset
   * a suite runs against on every change.
   */
  app.post('/evaluation/datasets/:id/clone', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const dataset = await getDataset(session.tenantDbName, id);
      if (!dataset || !datasetInProject(dataset, projectId)) {
        return reply.code(404).send({ error: 'Dataset not found' });
      }
      const body = readJsonBody<Record<string, unknown>>(request);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return reply.code(400).send({ error: 'name is required' });

      const rawFilter = (body.filter && typeof body.filter === 'object' ? body.filter : {}) as Record<string, unknown>;
      const rawLabel = (rawFilter.label && typeof rawFilter.label === 'object' ? rawFilter.label : null) as Record<string, unknown> | null;
      const labelKey = rawLabel ? sanitizeLabelKey(rawLabel.key) : null;
      if (rawLabel && !labelKey) {
        return reply.code(400).send({ error: 'filter.label.key must be a simple field key' });
      }
      const limit = Number(rawFilter.limit);
      const filter: CloneDatasetFilter = {
        ...(labelKey
          ? { label: { key: labelKey, ...(typeof rawLabel?.value === 'string' && rawLabel.value !== '' ? { value: rawLabel.value } : {}) } }
          : {}),
        ...(rawFilter.labeled === true ? { labeled: true } : rawFilter.labeled === false ? { labeled: false } : {}),
        ...(rawFilter.labelSource === 'human' || rawFilter.labelSource === 'ai'
          ? { labelSource: rawFilter.labelSource }
          : {}),
        ...(Array.isArray(rawFilter.tags)
          ? { tags: (rawFilter.tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim() !== '') }
          : {}),
        ...(rawFilter.requireExpected === true ? { requireExpected: true } : {}),
        ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.floor(limit) } : {}),
      };

      const result = await cloneDataset(session.tenantDbName, session.tenantId, session.userId, id, {
        name,
        description: typeof body.description === 'string' ? body.description : undefined,
        projectId,
        filter,
        tags: Array.isArray(body.tags)
          ? (body.tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim() !== '')
          : undefined,
      });
      return reply.code(201).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('Dataset not found')) return reply.code(404).send({ error: message });
      // An empty result is a filter the user can fix, not a server fault.
      if (message.includes('No items matched')) return reply.code(400).send({ error: message });
      logger.error('Clone dataset error', { error });
      return internalError(reply, error);
    }
  }));

  // ── Labels (AI labeling via the analysis engine) ───────────────────

  /**
   * Label distribution across the dataset — the segment view the labeling
   * feature exists for. Computed over the whole item set (capped) rather than
   * the current page, because a per-page breakdown would be meaningless.
   */
  app.get('/evaluation/datasets/:id/labels', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const dataset = await getDataset(session.tenantDbName, id);
      if (!dataset || !datasetInProject(dataset, projectId)) {
        return reply.code(404).send({ error: 'Dataset not found' });
      }
      const items = await listAllDatasetItemLabels(session.tenantDbName, id, LABEL_SUMMARY_SCAN_CAP);
      const summary = summarizeLabels(items);
      return reply.code(200).send({
        summary,
        // Be explicit when the scan was truncated: a silently partial
        // distribution reads as the whole picture.
        truncated: items.length >= LABEL_SUMMARY_SCAN_CAP,
      });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  /**
   * Kick off an AI labeling run: an analysis definition executed against this
   * dataset's items. Returns the pending analysis run so the UI can poll it.
   */
  app.post('/evaluation/datasets/:id/label', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const dataset = await getDataset(session.tenantDbName, id);
      if (!dataset || !datasetInProject(dataset, projectId)) {
        return reply.code(404).send({ error: 'Dataset not found' });
      }
      const body = readJsonBody<Record<string, unknown>>(request);
      const definitionKey = typeof body.definitionKey === 'string' ? body.definitionKey.trim() : '';
      if (!definitionKey) return reply.code(400).send({ error: 'definitionKey is required' });
      const selection = sanitizeLabelSelection(body.selection);

      const run = await enqueueDefinitionRun({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        createdBy: session.userId,
        definitionKey,
        selection,
        target: { kind: 'dataset', datasetId: id, datasetKey: dataset.key, datasetName: dataset.name },
      });

      // Mirror the snapshot/generation convention: park the job handle on the
      // dataset so a reloaded page can pick the progress banner back up.
      await updateDataset(session.tenantDbName, id, session.userId, {
        metadata: {
          ...(dataset.metadata ?? {}),
          labeling: { runId: run.id, definitionKey, status: run.status, startedAt: new Date().toISOString() },
        },
      });

      return reply.code(202).send({ run });
    } catch (error) {
      logger.error('Label dataset error', { error });
      const message = error instanceof Error ? error.message : '';
      if (message.toLowerCase().includes('not found')) return reply.code(404).send({ error: message });
      if (message.toLowerCase().includes('already in progress')) return reply.code(409).send({ error: message });
      if (message.toLowerCase().includes('no dataset items')) return reply.code(400).send({ error: message });
      return internalError(reply, error);
    }
  }));

  app.delete('/evaluation/datasets/:id/items/:itemId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id, itemId } = request.params as { id: string; itemId: string };
      const dataset = await getDataset(session.tenantDbName, id);
      if (!dataset || !datasetInProject(dataset, projectId)) {
        return reply.code(404).send({ error: 'Dataset not found' });
      }
      const deleted = await deleteDatasetItem(session.tenantDbName, id, itemId);
      if (!deleted) return reply.code(404).send({ error: 'Dataset item not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return sendItemError(reply, error) ?? internalError(reply, error);
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
        return reply.code(400).send({
          error: `scorers must be a non-empty array of { type: ${VALID_SCORERS.map((s) => `"${s}"`).join(' | ')} }`,
        });
      }
      const runConfig = sanitizeRunConfig(body.runConfig);
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
        ...(body.runConfig !== undefined ? { runConfig: sanitizeRunConfig(body.runConfig) } : {}),
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
