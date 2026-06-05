import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type {
  IAnalysisFieldDef,
  IAnalysisModes,
  IAnalysisTranscriptMessage,
  AnalysisFieldType,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  createDefinition,
  deleteConversation,
  deleteDefinition,
  getConversation,
  getDefinition,
  getRun,
  ingestConversations,
  listConversations,
  listDefinitions,
  listRuns,
  updateDefinition,
  type CreateConversationInput,
} from '@/lib/services/analysis/service';
import { enqueueDefinitionRun } from '@/lib/services/analysis/analysisRunJob';
import { validateCron } from '@/lib/services/analysis/schedulePlanner';
import {
  readJsonBody,
  safeReadJsonBody,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import type { RunSelection, RunSelectionStrategy } from '@/lib/services/analysis/service';

const logger = createLogger('api:analysis');

const VALID_FIELD_TYPES: AnalysisFieldType[] = ['string', 'number', 'boolean', 'enum'];

function internalError(reply: FastifyReply, error: unknown) {
  return (
    sendProjectContextError(reply, error)
    ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' })
  );
}

function sanitizeFieldSet(raw: unknown): IAnalysisFieldDef[] | null {
  if (!Array.isArray(raw)) return null;
  const fields: IAnalysisFieldDef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.key !== 'string' || !e.key.trim()) return null;
    if (typeof e.type !== 'string' || !VALID_FIELD_TYPES.includes(e.type as AnalysisFieldType)) return null;
    if (e.type === 'enum' && (!Array.isArray(e.enumValues) || e.enumValues.length === 0)) return null;
    fields.push({
      key: e.key.trim(),
      type: e.type as AnalysisFieldType,
      description: typeof e.description === 'string' ? e.description : undefined,
      enumValues: Array.isArray(e.enumValues) ? (e.enumValues as string[]).map(String) : undefined,
      required: typeof e.required === 'boolean' ? e.required : undefined,
    });
  }
  return fields;
}

function sanitizeModes(raw: unknown): IAnalysisModes {
  const modes: IAnalysisModes = {};
  if (!raw || typeof raw !== 'object') return modes;
  const m = raw as Record<string, unknown>;
  if (m.store === true) modes.store = true;
  if (m.accuracy === true) modes.accuracy = true;
  if (m.judge && typeof m.judge === 'object') {
    const j = m.judge as Record<string, unknown>;
    if (typeof j.rubric === 'string' && j.rubric.trim()) {
      modes.judge = { rubric: j.rubric, threshold: typeof j.threshold === 'number' ? j.threshold : undefined };
    }
  }
  return modes;
}

function sanitizeSchedule(raw: unknown): { schedule?: { cron: string; enabled: boolean }; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object') return { error: 'schedule must be an object' };
  const s = raw as Record<string, unknown>;
  if (typeof s.cron !== 'string') return { error: 'schedule.cron is required' };
  const cronError = validateCron(s.cron);
  if (cronError) return { error: cronError };
  return { schedule: { cron: s.cron, enabled: s.enabled !== false } };
}

function sanitizeTranscript(raw: unknown): IAnalysisTranscriptMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const messages: IAnalysisTranscriptMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.role !== 'string' || typeof e.content !== 'string') return null;
    messages.push({ role: e.role, content: e.content });
  }
  return messages;
}

function sanitizeTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tags = raw
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  // de-dupe, preserve order
  const seen = new Set<string>();
  const unique = tags.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
  return unique.length > 0 ? unique : undefined;
}

function toConversationInput(raw: Record<string, unknown>, defaultTags?: string[]): CreateConversationInput | null {
  const transcript = sanitizeTranscript(raw.transcript);
  if (!transcript) return null;
  const ownTags = sanitizeTags(raw.tags);
  const merged = sanitizeTags([...(defaultTags ?? []), ...(ownTags ?? [])]);
  return {
    key: typeof raw.key === 'string' ? raw.key : undefined,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    transcript,
    source: raw.source === 'platform' || raw.source === 'manual' ? raw.source : 'imported',
    tags: merged,
    metadata: raw.metadata && typeof raw.metadata === 'object' ? (raw.metadata as Record<string, unknown>) : undefined,
    occurredAt: typeof raw.occurredAt === 'string' ? new Date(raw.occurredAt) : undefined,
    referenceFields: raw.referenceFields && typeof raw.referenceFields === 'object' ? (raw.referenceFields as Record<string, unknown>) : undefined,
  };
}

const VALID_SELECTION_STRATEGIES: RunSelectionStrategy[] = ['all', 'tag', 'random', 'unanalyzed', 'keys'];

function sanitizeSelection(raw: unknown): RunSelection | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.strategy !== 'string' || !VALID_SELECTION_STRATEGIES.includes(s.strategy as RunSelectionStrategy)) return undefined;
  const conversationKeys = Array.isArray(s.conversationKeys)
    ? (s.conversationKeys as unknown[]).filter((k): k is string => typeof k === 'string')
    : undefined;
  const sampleSize = Number(s.sampleSize);
  return {
    strategy: s.strategy as RunSelectionStrategy,
    tag: typeof s.tag === 'string' && s.tag.trim() ? s.tag.trim() : undefined,
    sampleSize: Number.isFinite(sampleSize) && sampleSize > 0 ? Math.floor(sampleSize) : undefined,
    conversationKeys,
  };
}

export const analysisApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Definitions ────────────────────────────────────────────────────

  app.get('/analysis/definitions', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string };
      const definitions = await listDefinitions(session.tenantDbName, { projectId, search: query.search });
      return reply.code(200).send({ definitions });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.post('/analysis/definitions', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }
      const fieldSet = sanitizeFieldSet(body.fieldSet);
      if (!fieldSet || fieldSet.length === 0) {
        return reply.code(400).send({ error: 'fieldSet must be a non-empty array of { key, type }' });
      }
      const modes = sanitizeModes(body.modes);
      if (modes.judge && typeof body.judgeModelKey !== 'string') {
        return reply.code(400).send({ error: 'judgeModelKey is required when the judge mode is enabled' });
      }
      const runConfig = body.runConfig && typeof body.runConfig === 'object'
        ? { concurrency: Number((body.runConfig as Record<string, unknown>).concurrency) || undefined }
        : undefined;
      const scheduleResult = sanitizeSchedule(body.schedule);
      if (scheduleResult.error) return reply.code(400).send({ error: scheduleResult.error });
      const definition = await createDefinition(session.tenantDbName, session.tenantId, session.userId, {
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description : undefined,
        fieldSet,
        extractionInstructions: typeof body.extractionInstructions === 'string' ? body.extractionInstructions : undefined,
        modes,
        extractionModelKey: typeof body.extractionModelKey === 'string' ? body.extractionModelKey : undefined,
        judgeModelKey: typeof body.judgeModelKey === 'string' ? body.judgeModelKey : undefined,
        runConfig,
        schedule: scheduleResult.schedule,
        projectId,
      });
      return reply.code(201).send({ definition });
    } catch (error) {
      logger.error('Create analysis definition error', { error });
      return internalError(reply, error);
    }
  }));

  app.get('/analysis/definitions/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const definition = await getDefinition(session.tenantDbName, id);
      if (!definition) return reply.code(404).send({ error: 'Definition not found' });
      return reply.code(200).send({ definition });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.patch('/analysis/definitions/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const fieldSet = body.fieldSet !== undefined ? sanitizeFieldSet(body.fieldSet) : undefined;
      if (body.fieldSet !== undefined && (!fieldSet || fieldSet.length === 0)) {
        return reply.code(400).send({ error: 'fieldSet must be a non-empty array of { key, type }' });
      }
      const scheduleResult = sanitizeSchedule(body.schedule);
      if (scheduleResult.error) return reply.code(400).send({ error: scheduleResult.error });
      const definition = await updateDefinition(session.tenantDbName, id, session.userId, {
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        fieldSet: fieldSet ?? undefined,
        extractionInstructions: body.extractionInstructions as string | undefined,
        modes: body.modes !== undefined ? sanitizeModes(body.modes) : undefined,
        extractionModelKey: body.extractionModelKey as string | undefined,
        judgeModelKey: body.judgeModelKey as string | undefined,
        schedule: body.schedule !== undefined ? scheduleResult.schedule : undefined,
      });
      if (!definition) return reply.code(404).send({ error: 'Definition not found' });
      return reply.code(200).send({ definition });
    } catch (error) {
      logger.error('Update analysis definition error', { error });
      return internalError(reply, error);
    }
  }));

  app.delete('/analysis/definitions/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const deleted = await deleteDefinition(session.tenantDbName, id);
      if (!deleted) return reply.code(404).send({ error: 'Definition not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── Conversations ──────────────────────────────────────────────────

  app.get('/analysis/conversations', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string; tag?: string; limit?: string; skip?: string };
      const conversations = await listConversations(session.tenantDbName, {
        projectId,
        search: query.search,
        tag: query.tag,
        limit: query.limit ? Math.min(Number.parseInt(query.limit, 10), 10000) : 5000,
        skip: query.skip ? Number.parseInt(query.skip, 10) : undefined,
      });
      return reply.code(200).send({ conversations });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.post('/analysis/conversations', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      // Optional top-level `tags` applies to every conversation in the batch
      // (merged with any per-conversation tags) — handy for the ingest modal.
      const defaultTags = sanitizeTags(body.tags);
      const rawList = Array.isArray(body.conversations) ? body.conversations : [body];
      const inputs: CreateConversationInput[] = [];
      for (const raw of rawList) {
        const input = toConversationInput(raw as Record<string, unknown>, defaultTags);
        if (!input) {
          return reply.code(400).send({ error: 'each conversation needs a transcript array of { role, content }' });
        }
        inputs.push(input);
      }
      if (inputs.length === 0) {
        return reply.code(400).send({ error: 'no conversations to ingest' });
      }
      const conversations = await ingestConversations(session.tenantDbName, session.tenantId, session.userId, inputs, projectId);
      return reply.code(201).send({ conversations });
    } catch (error) {
      logger.error('Ingest analysis conversations error', { error });
      return internalError(reply, error);
    }
  }));

  app.get('/analysis/conversations/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const conversation = await getConversation(session.tenantDbName, id);
      if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
      return reply.code(200).send({ conversation });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.delete('/analysis/conversations/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const deleted = await deleteConversation(session.tenantDbName, id);
      if (!deleted) return reply.code(404).send({ error: 'Conversation not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── Runs ───────────────────────────────────────────────────────────

  app.post('/analysis/definitions/:key/run', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      // Body is optional (a bare "run everything" POST sends none), so use the
      // non-throwing reader — readJsonBody would 500 on an empty body.
      const body = safeReadJsonBody<Record<string, unknown>>(request);
      const selection = sanitizeSelection(body.selection);
      const conversationKeys = Array.isArray(body.conversationKeys)
        ? (body.conversationKeys as unknown[]).filter((k): k is string => typeof k === 'string')
        : undefined;
      // Enqueue + return immediately (status 'pending'); the queue consumer runs
      // it in the background so the dashboard never blocks. The UI polls the run
      // detail endpoint to watch progress.
      const run = await enqueueDefinitionRun({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        createdBy: session.userId,
        definitionKey: key,
        selection,
        conversationKeys,
      });
      return reply.code(202).send({ run });
    } catch (error) {
      logger.error('Run analysis definition error', { error });
      if (error instanceof Error && error.message.toLowerCase().includes('not found')) {
        return reply.code(404).send({ error: error.message });
      }
      if (error instanceof Error && error.message.toLowerCase().includes('no conversations')) {
        return reply.code(400).send({ error: error.message });
      }
      if (error instanceof Error && error.message.toLowerCase().includes('already in progress')) {
        return reply.code(409).send({ error: error.message });
      }
      return internalError(reply, error);
    }
  }));

  app.get('/analysis/runs', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { definitionKey?: string; limit?: string; skip?: string };
      const runs = await listRuns(session.tenantDbName, {
        projectId,
        definitionKey: query.definitionKey,
        limit: query.limit ? Math.min(Number.parseInt(query.limit, 10), 200) : undefined,
        skip: query.skip ? Number.parseInt(query.skip, 10) : undefined,
      });
      return reply.code(200).send({ runs });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.get('/analysis/runs/:id', withApiRequestContext(async (request, reply) => {
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
};
