import { enforceServiceQuota, isQuotaExceededError, quotaExceededBody } from '@/lib/quota/serviceQuota';
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
import type { CloneDatasetFilter, UpdateSuiteInput, UpdateTargetInput } from '@/lib/services/evaluation/service';
import {
  appendDatasetItems,
  cancelRun,
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
  listRunSummaries,
  listSuites,
  listTargets,
  patchDatasetMetadata,
  updateDataset,
  updateDatasetItem,
  updateSuite,
  updateTarget,
} from '@/lib/services/evaluation/service';
import { enqueueSuiteRun } from '@/lib/services/evaluation/evaluationRunJob';
import { EvaluationConflictError, EvaluationInputError } from '@/lib/services/evaluation/errors';
import { normalizeDatasetItem, normalizeDatasetItems } from '@/lib/services/evaluation/itemValidation';
import { AgentRevisionError } from '@/lib/services/agents/agentRevision';
import { parseAgentRevision, parseAgentRunOverride, toStoredAgentVersion } from '@/lib/shared/agentRevision';
import { summarizeLabels } from '@/lib/services/evaluation/labelSummary';
import { SUPPORTED_SCORERS } from '@/lib/services/evaluation/scorers';
import { enqueueDefinitionRun } from '@/lib/services/analysis/analysisRunJob';
import type { RunSelection } from '@/lib/services/analysis/service';
import {
  readJsonBody,
  readOptionalJsonObjectBody,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import { withoutRestrictedRunItems } from '../restrictedKnowledgeRequest';
import { requireAgentTestAccess, sendAgentTestRefusal } from './agent-test-permission';
import { readClearableText, readRequiredText } from './partial-update';

const logger = createLogger('api:evaluations');

const RUN_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
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
  // Typed service errors: a refused state is the caller's to fix, never a 500.
  if (error instanceof EvaluationConflictError) return reply.code(409).send({ error: error.message });
  if (error instanceof EvaluationInputError) return reply.code(400).send({ error: error.message });
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
  // Clamped like the runner does (EVAL_MAX_CONCURRENCY): a stored 5000 would otherwise look like a setting that
  // is honoured while every run quietly used the cap.
  const requested = Math.trunc(Number(config.concurrency));
  const concurrency = Number.isFinite(requested) && requested !== 0
    ? Math.min(Math.max(requested, 1), MAX_RUN_CONCURRENCY)
    : undefined;
  const turnMode = config.turnMode === 'perTurn' ? 'perTurn' : config.turnMode === 'single' ? 'single' : undefined;
  if (concurrency === undefined && turnMode === undefined) return undefined;
  return { ...(concurrency !== undefined ? { concurrency } : {}), ...(turnMode ? { turnMode } : {}) };
}

/** Mirrors the runner's EVAL_MAX_CONCURRENCY. */
const MAX_RUN_CONCURRENCY = 32;

/** Upper bounds for dataset generation requests (D1). */
const GENERATE_MAX_COUNT = 200;
const GENERATE_MAX_CHUNKS = 500;
/** Pasted text and uploaded files are both capped at 5 MB of source. */
const GENERATE_MAX_SOURCE_BYTES = 5 * 1024 * 1024;

/**
 * Strict integer query parameter. A non-numeric value is the caller's mistake
 * (400); it used to fall through to NaN and a 500 from the database layer.
 * `undefined` means the parameter was not sent.
 */
function parseIntParam(raw: unknown, name: string): number | undefined | { error: string } {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) return { error: `${name} must be an integer` };
  return Number.parseInt(raw, 10);
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

/** Map dataset-item service errors onto 409 (duplicate) / 404 (gone). */
function sendItemError(reply: import('fastify').FastifyReply, error: unknown) {
  if (!(error instanceof Error)) return null;
  if (error.message.includes('already exists')) return reply.code(409).send({ error: error.message });
  if (error.message.includes('not found')) return reply.code(404).send({ error: error.message });
  return null;
}

const APPLY_WHEN_VALUES = ['has-reference', 'has-expected-tool-calls'] as const;

/**
 * Returns the scorers, or an error naming the offending entry: a weight or
 * threshold that is silently kept as NaN/negative/out of range poisons every
 * score of every later run of the suite.
 */
function sanitizeScorers(raw: unknown): { scorers: IEvaluationScorerConfig[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'scorers must be an array' };
  const scorers: IEvaluationScorerConfig[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry: unknown = raw[i];
    if (!entry || typeof entry !== 'object') return { error: `scorers[${i}] must be an object` };
    const e = entry as Record<string, unknown>;
    if (typeof e.type !== 'string' || !VALID_SCORERS.includes(e.type)) {
      return { error: `scorers[${i}].type must be one of ${VALID_SCORERS.map((s) => `"${s}"`).join(', ')}` };
    }
    if (e.weight !== undefined && e.weight !== null && (typeof e.weight !== 'number' || !Number.isFinite(e.weight) || e.weight < 0)) {
      return { error: `scorers[${i}].weight must be a finite number >= 0` };
    }
    if (
      e.threshold !== undefined
      && e.threshold !== null
      && (typeof e.threshold !== 'number' || !Number.isFinite(e.threshold) || e.threshold < 0 || e.threshold > 1)
    ) {
      return { error: `scorers[${i}].threshold must be a number between 0 and 1` };
    }
    if (
      e.applyWhen !== undefined
      && e.applyWhen !== null
      && !(APPLY_WHEN_VALUES as readonly string[]).includes(e.applyWhen as string)
    ) {
      return { error: `scorers[${i}].applyWhen must be one of ${APPLY_WHEN_VALUES.map((v) => `"${v}"`).join(', ')}` };
    }
    for (const flag of ['allowExtraCalls', 'strict'] as const) {
      if (e[flag] !== undefined && e[flag] !== null && typeof e[flag] !== 'boolean') {
        return { error: `scorers[${i}].${flag} must be a boolean` };
      }
    }
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
      applyWhen: typeof e.applyWhen === 'string' ? (e.applyWhen as IEvaluationScorerConfig['applyWhen']) : undefined,
      allowExtraCalls: typeof e.allowExtraCalls === 'boolean' ? e.allowExtraCalls : undefined,
      strict: typeof e.strict === 'boolean' ? e.strict : undefined,
    });
  }
  return { scorers };
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
      const revision = parseAgentRevision(body.agentVersion);
      if (!revision.ok) return reply.code(400).send({ error: revision.error });
      // A saved agent target is run later, so whoever saves one may spend the agent.
      if (body.kind === 'agent') await requireAgentTestAccess(request);
      const target = await createTarget(session.tenantDbName, session.tenantId, session.userId, {
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description : undefined,
        kind: body.kind as EvaluationTargetKind,
        agentKey: body.agentKey as string | undefined,
        agentVersion: revision.revision === undefined ? undefined : toStoredAgentVersion(revision.revision),
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
      const refused = sendAgentTestRefusal(reply, error);
      if (refused) return refused;
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
      const revision = parseAgentRevision(body.agentVersion);
      if (!revision.ok) return reply.code(400).send({ error: revision.error });
      // Only the keys the body carries reach the update: an absent key leaves the stored value alone, `null`
      // clears an optional one, and a key that cannot be cleared must hold text (see partial-update.ts).
      const data: UpdateTargetInput = {
        // Optional knobs go through as sent; `null` clears.
        ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt as string | null } : {}),
        ...(body.promptKey !== undefined ? { promptKey: body.promptKey as string | null } : {}),
        ...(body.promptVersion !== undefined ? { promptVersion: body.promptVersion as number | null } : {}),
        ...(body.responseFormat !== undefined ? { responseFormat: body.responseFormat as Record<string, unknown> | null } : {}),
        ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens as number | null } : {}),
        ...(body.defaultParams !== undefined ? { defaultParams: body.defaultParams as Record<string, unknown> | null } : {}),
        // `null` drops the pin: both providers treat an absent key as "leave the pin alone".
        ...(revision.revision !== undefined ? { agentVersion: toStoredAgentVersion(revision.revision) } : {}),
      };
      const invalid =
        readRequiredText(body, 'name', data)
        ?? readRequiredText(body, 'agentKey', data)
        ?? readRequiredText(body, 'modelKey', data)
        ?? readRequiredText(body, 'ragModuleKey', data)
        ?? readClearableText(body, 'description', data);
      if (invalid) return reply.code(400).send({ error: invalid });
      // `null` puts the module's own default back; an out-of-range number is dropped, as on create.
      const topK = body.retrievalTopK === null ? null : sanitizeTopK(body.retrievalTopK);
      if (topK !== undefined) data.retrievalTopK = topK;
      const minScore = body.retrievalMinScore === null ? null : sanitizeMinScore(body.retrievalMinScore);
      if (minScore !== undefined) data.retrievalMinScore = minScore;
      const existing = await getTarget(session.tenantDbName, id);
      if (!existing) return reply.code(404).send({ error: 'Target not found' });
      // The stored kind decides, not the body: a PATCH cannot move a target between kinds, and a saved agent
      // target is run later by whoever (or whatever) holds it.
      if (existing.kind === 'agent') await requireAgentTestAccess(request);
      // A version number belongs to one agent: moving the target to another agent without naming a version puts
      // it back on the published one, as the form does.
      if (
        existing.kind === 'agent'
        && revision.revision === undefined
        && data.agentKey !== undefined
        && data.agentKey !== existing.agentKey
      ) {
        data.agentVersion = null;
      }
      const target = await updateTarget(session.tenantDbName, id, session.userId, data);
      if (!target) return reply.code(404).send({ error: 'Target not found' });
      return reply.code(200).send({ target });
    } catch (error) {
      const refused = sendAgentTestRefusal(reply, error);
      if (refused) return refused;
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
      let items: IEvaluationDatasetItem[] | undefined;
      if (Array.isArray(body.items)) {
        const parsed = normalizeDatasetItems(body.items);
        if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
        items = parsed.items as unknown as IEvaluationDatasetItem[];
      }
      const dataset = await createDataset(session.tenantDbName, session.tenantId, session.userId, {
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description : undefined,
        items,
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

      // The request enqueues a chain of model calls billed to the tenant, so every size knob is bounded: `count`
      // is a whole number of pairs, `maxChunks` a whole number of chunks, the source text a fixed number of bytes.
      let count = 10;
      if (body.count !== undefined && body.count !== null) {
        if (typeof body.count !== 'number' || !Number.isInteger(body.count) || body.count < 1 || body.count > GENERATE_MAX_COUNT) {
          return reply.code(400).send({ error: `count must be an integer between 1 and ${GENERATE_MAX_COUNT}` });
        }
        count = body.count;
      }
      let maxChunks: number | undefined;
      if (body.maxChunks !== undefined && body.maxChunks !== null) {
        if (typeof body.maxChunks !== 'number' || !Number.isInteger(body.maxChunks) || body.maxChunks < 1 || body.maxChunks > GENERATE_MAX_CHUNKS) {
          return reply.code(400).send({ error: `maxChunks must be an integer between 1 and ${GENERATE_MAX_CHUNKS}` });
        }
        maxChunks = body.maxChunks;
      }
      if (sourceType === 'text' && typeof body.text === 'string' && Buffer.byteLength(body.text, 'utf8') > GENERATE_MAX_SOURCE_BYTES) {
        return reply.code(400).send({ error: `text must be at most ${GENERATE_MAX_SOURCE_BYTES / (1024 * 1024)} MB` });
      }
      if (sourceType === 'file' && typeof body.fileData === 'string') {
        // Base64 inflates by 4/3; check the encoded length before decoding it into a buffer.
        if (Math.ceil((body.fileData.length * 3) / 4) > GENERATE_MAX_SOURCE_BYTES) {
          return reply.code(400).send({ error: `file must be at most ${GENERATE_MAX_SOURCE_BYTES / (1024 * 1024)} MB` });
        }
      }
      // Required source fields are checked before the quota is charged, so a malformed request costs nothing.
      if (sourceType === 'rag' && (typeof body.ragModuleKey !== 'string' || body.ragModuleKey === '')) {
        return reply.code(400).send({ error: 'ragModuleKey is required for sourceType "rag"' });
      }
      if (sourceType === 'text' && (typeof body.text !== 'string' || body.text.trim() === '')) {
        return reply.code(400).send({ error: 'text is required for sourceType "text"' });
      }
      if (sourceType === 'file' && (typeof body.fileData !== 'string' || typeof body.fileName !== 'string')) {
        return reply.code(400).send({ error: 'fileName and fileData are required for sourceType "file"' });
      }
      // Same quota as a run: generation spends the tenant's models just as a run does. Charged before the
      // file conversion below, which is itself real work.
      await enforceServiceQuota(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { domain: 'jobs', resourceKey: 'evaluation', cost: { requests: 1 } },
      );

      let source: DatasetGenerationSource;
      if (sourceType === 'rag') {
        if (typeof body.ragModuleKey !== 'string' || body.ragModuleKey === '') {
          return reply.code(400).send({ error: 'ragModuleKey is required for sourceType "rag"' });
        }
        source = {
          type: 'rag',
          ragModuleKey: body.ragModuleKey,
          maxChunks,
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
          // Guarded conversion; no OCR (a dataset source is read as the file's own text).
          {
            scope: { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, userId: session.userId },
            source: 'evaluation',
          },
        );
        // The converted text counts against the same cap (a small PDF can expand a lot).
        if (Buffer.byteLength(text, 'utf8') > GENERATE_MAX_SOURCE_BYTES) {
          return reply.code(400).send({ error: `the file's text must be at most ${GENERATE_MAX_SOURCE_BYTES / (1024 * 1024)} MB` });
        }
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
        count,
        language: typeof body.language === 'string' ? body.language : undefined,
      });

      return reply.code(202).send({ dataset, status: 'pending' });
    } catch (error) {
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
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
      let normalizedItems: IEvaluationDatasetItem[] | undefined;
      if (Array.isArray(body.items)) {
        const parsed = normalizeDatasetItems(body.items);
        if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
        normalizedItems = parsed.items as unknown as IEvaluationDatasetItem[];
      }
      // Only include provided fields: a `$set` with an explicit `undefined`
      // would null the field in Mongo, so an items-only PATCH must not touch
      // name/description.
      const data: Partial<Pick<IEvaluationDataset, 'name' | 'description' | 'items'>> = {};
      if (typeof body.name === 'string' && body.name.trim() !== '') data.name = body.name;
      if (typeof body.description === 'string') data.description = body.description;
      if (normalizedItems) data.items = normalizedItems;
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
      const rawLimit = parseIntParam(query.limit, 'limit');
      if (typeof rawLimit === 'object') return reply.code(400).send({ error: rawLimit.error });
      const rawSkip = parseIntParam(query.skip, 'skip');
      if (typeof rawSkip === 'object') return reply.code(400).send({ error: rawSkip.error });
      const limit = rawLimit === undefined ? 50 : Math.min(Math.max(rawLimit, 1), 500);
      const skip = rawSkip === undefined ? 0 : Math.max(rawSkip, 0);
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
      const parsed = normalizeDatasetItems(rawItems);
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
      const { added, total } = await appendDatasetItems(
        session.tenantDbName,
        id,
        parsed.items as unknown as IEvaluationDatasetItem[],
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
      // Messages and tool blocks are validated and normalised (OpenAI spellings mapped to the canonical ones);
      // `labelMeta` is never taken from the client — it is stamped below.
      const parsed = normalizeDatasetItem(body, 'item', { partial: true });
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
      const data: Partial<Omit<IEvaluationDatasetItem, 'id'>> = {};
      for (const key of ['input', 'expected', 'tools', 'toolResults', 'responseFormat', 'tags'] as const) {
        if (parsed.value[key] !== undefined) (data as Record<string, unknown>)[key] = parsed.value[key];
      }
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

      await enforceServiceQuota(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { domain: 'jobs', resourceKey: 'analysis', cost: { requests: 1 } },
      );
      // Mirror the snapshot/generation convention: park the job handle on the dataset so a reloaded page can
      // pick the progress banner back up. The block is written BEFORE the run is enqueued (a run that finishes
      // quickly must not find its handle missing, and a failed write must not leave a started run behind) and
      // only that one key is patched, so a concurrent writer of another metadata block is not overwritten.
      const startedAt = new Date().toISOString();
      await patchDatasetMetadata(session.tenantDbName, id, {
        labeling: { definitionKey, status: 'pending', startedAt },
      });
      let run: Awaited<ReturnType<typeof enqueueDefinitionRun>>;
      try {
        run = await enqueueDefinitionRun({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId,
          createdBy: session.userId,
          definitionKey,
          selection,
          target: { kind: 'dataset', datasetId: id, datasetKey: dataset.key, datasetName: dataset.name },
        });
      } catch (enqueueError) {
        // Do not leave a banner that says "labeling" for a run that never started.
        await patchDatasetMetadata(session.tenantDbName, id, {
          labeling: {
            definitionKey,
            status: 'failed',
            startedAt,
            error: enqueueError instanceof Error ? enqueueError.message : 'Could not start labeling',
          },
        }).catch((patchError) => logger.warn('Could not mark labeling as failed', { error: patchError }));
        throw enqueueError;
      }
      try {
        await patchDatasetMetadata(session.tenantDbName, id, {
          labeling: { runId: run.id, definitionKey, status: run.status, startedAt },
        });
      } catch (patchError) {
        // The run is already started: report it rather than failing the request over the handle.
        logger.warn('Could not record the labeling run on the dataset', { error: patchError });
      }

      return reply.code(202).send({ run });
    } catch (error) {
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
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
      const parsedScorers = sanitizeScorers(body.scorers);
      if ('error' in parsedScorers) return reply.code(400).send({ error: parsedScorers.error });
      const scorers = parsedScorers.scorers;
      if (scorers.length === 0) {
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
      // Only the keys the body carries reach the update: an absent key leaves the stored value alone, `null`
      // clears the description or a model key, and a key that cannot be cleared must hold text.
      const data: UpdateSuiteInput = {};
      const invalid =
        readRequiredText(body, 'name', data)
        ?? readRequiredText(body, 'targetKey', data)
        ?? readRequiredText(body, 'datasetKey', data)
        ?? readClearableText(body, 'description', data)
        ?? readClearableText(body, 'judgeModelKey', data, { blankClears: true })
        ?? readClearableText(body, 'embeddingModelKey', data, { blankClears: true });
      if (invalid) return reply.code(400).send({ error: invalid });
      if (body.scorers !== undefined) {
        const parsedScorers = sanitizeScorers(body.scorers);
        if ('error' in parsedScorers) return reply.code(400).send({ error: parsedScorers.error });
        data.scorers = parsedScorers.scorers;
      }
      const runConfig = body.runConfig !== undefined ? sanitizeRunConfig(body.runConfig) : undefined;
      if (runConfig) data.runConfig = runConfig;
      const suite = await updateSuite(session.tenantDbName, id, session.userId, data);
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
      // The body is optional: existing callers POST with none. One that is
      // sent must parse, or the run would quietly test the default revision.
      let body: Record<string, unknown>;
      try {
        body = readOptionalJsonObjectBody(request);
      } catch {
        return reply.code(400).send({ error: 'Request body must be a JSON object' });
      }
      const revision = parseAgentRunOverride(body.agentVersion);
      if (!revision.ok) return reply.code(400).send({ error: revision.error });
      // Enqueue + return immediately (status 'pending'); the queue consumer runs
      // it in the background so the dashboard never blocks on a long run. The UI
      // polls the run detail endpoint to watch progress.
      await enforceServiceQuota(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { domain: 'jobs', resourceKey: 'evaluation', cost: { requests: 1 } },
      );
      const run = await enqueueSuiteRun({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        createdBy: session.userId,
        suiteKey: key,
        agentVersion: revision.revision,
        // Asked by the service once it knows the suite's target is an agent, before a run row exists.
        authorizeAgentRun: () => requireAgentTestAccess(request),
      });
      return reply.code(202).send({ run });
    } catch (error) {
      // Before the message checks below: a refusal must never be read as a 404 or a 409.
      const refused = sendAgentTestRefusal(reply, error);
      if (refused) return refused;
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
      if (error instanceof EvaluationConflictError || error instanceof EvaluationInputError) return internalError(reply, error);
      logger.error('Run evaluation suite error', { error });
      if (error instanceof AgentRevisionError) return reply.code(400).send({ error: error.message });
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
      const query = (request.query ?? {}) as { suiteKey?: string; status?: string; limit?: string; skip?: string };
      const rawLimit = parseIntParam(query.limit, 'limit');
      if (typeof rawLimit === 'object') return reply.code(400).send({ error: rawLimit.error });
      const rawSkip = parseIntParam(query.skip, 'skip');
      if (typeof rawSkip === 'object') return reply.code(400).send({ error: rawSkip.error });
      if (query.status !== undefined && !RUN_STATUSES.includes(query.status as (typeof RUN_STATUSES)[number])) {
        return reply.code(400).send({ error: `status must be one of ${RUN_STATUSES.map((v) => `"${v}"`).join(', ')}` });
      }
      // The list never carries per-item detail (a run can hold thousands of items and a page of them is megabytes);
      // the run page loads one run in full. Summaries have no items, so there is nothing to withhold per viewer.
      const { runs, total } = await listRunSummaries(session.tenantDbName, {
        projectId,
        suiteKey: query.suiteKey,
        status: query.status as (typeof RUN_STATUSES)[number] | undefined,
        limit: rawLimit === undefined ? 50 : Math.min(Math.max(rawLimit, 1), 200),
        skip: rawSkip === undefined ? 0 : Math.max(rawSkip, 0),
      });
      return reply.code(200).send({ runs, total });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // Stop a run: a pending run is cancelled on the spot, a running one is asked to stop (the worker notices on its
  // next heartbeat and finalises the items processed so far).
  app.post('/evaluation/runs/:id/cancel', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const result = await cancelRun(session.tenantDbName, id, projectId);
      if (!result) return reply.code(404).send({ error: 'Run not found' });
      const run = await withoutRestrictedRunItems(
        request,
        { tenantDbName: session.tenantDbName, viewerUserId: session.userId },
        result.run,
      );
      if (result.outcome === 'already_finished') {
        return reply.code(409).send({ error: 'Run already finished', run });
      }
      return reply.code(200).send({ run, outcome: result.outcome });
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
      return reply.code(200).send({ run: await withoutRestrictedRunItems(request, { tenantDbName: session.tenantDbName, viewerUserId: session.userId }, run) });
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
