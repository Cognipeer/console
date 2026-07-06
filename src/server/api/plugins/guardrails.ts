import type { FastifyPluginAsync } from 'fastify';
import type { GuardrailAction, GuardrailType } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import {
  buildDefaultPresetPolicy,
  createGuardrail,
  deleteGuardrail,
  evaluateGuardrail,
  getGuardrail,
  listGuardrails,
  MODERATION_CATEGORIES,
  PII_CATEGORIES,
  PROMPT_SHIELD_ISSUES,
  WORD_FILTER_BUILTIN_LISTS,
  updateGuardrail,
  createWordList,
  updateWordList,
  deleteWordList,
  getWordList,
  listWordLists,
  parseWordListContent,
  normalizeWordArray,
  WordListValidationError,
} from '@/lib/services/guardrail';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';
import {
  parseBooleanQuery,
  readJsonBody,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:guardrails');

type GuardrailsQuery = {
  enabled?: string;
  includeTemplates?: string;
  search?: string;
  type?: GuardrailType;
};

type EvaluationsQuery = {
  from?: string;
  groupBy?: 'hour' | 'day' | 'month';
  limit?: string;
  passed?: string;
  skip?: string;
  to?: string;
};

const VALID_ACTIONS: GuardrailAction[] = ['block', 'warn', 'flag'];
const VALID_TYPES: GuardrailType[] = ['preset', 'custom'];
const VALID_FAIL_MODES = ['open', 'closed'];

/**
 * LLM-backed checks silently no-op without a model, which reads as "guardrail
 * active" while nothing runs. Reject configurations that enable an LLM check
 * with no model to run it on.
 */
function findLlmModelConfigError(body: Record<string, unknown>): string | null {
  const modelKey = typeof body.modelKey === 'string' && body.modelKey.trim() !== '' ? body.modelKey : undefined;
  if (body.type === 'custom' && !modelKey) {
    return 'modelKey is required for custom guardrails (the rule is evaluated by an LLM)';
  }
  const policy = body.policy as {
    moderation?: { enabled?: boolean; modelKey?: string };
    promptShield?: { enabled?: boolean; modelKey?: string };
  } | undefined;
  if (policy?.moderation?.enabled && !policy.moderation.modelKey && !modelKey) {
    return 'Content moderation is enabled but no model is configured (set policy.moderation.modelKey or the guardrail modelKey)';
  }
  if (policy?.promptShield?.enabled && !policy.promptShield.modelKey && !modelKey) {
    return 'Prompt shield is enabled but no model is configured (set policy.promptShield.modelKey or the guardrail modelKey)';
  }
  return null;
}

export const guardrailsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/guardrails', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as GuardrailsQuery;

      const guardrails = await listGuardrails(session.tenantDbName, {
        enabled: parseBooleanQuery(query.enabled),
        projectId,
        search: query.search,
        type: query.type,
      });

      const payload: Record<string, unknown> = { guardrails };

      if (query.includeTemplates === 'true') {
        payload.templates = {
          defaultPresetPolicy: buildDefaultPresetPolicy(),
          moderationCategories: MODERATION_CATEGORIES,
          piiCategories: PII_CATEGORIES,
          promptShieldIssues: PROMPT_SHIELD_ISSUES,
          wordFilterLists: WORD_FILTER_BUILTIN_LISTS,
        };
      }

      return reply.code(200).send(payload);
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/guardrails', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }

      if (!VALID_TYPES.includes(body.type as GuardrailType)) {
        return reply.code(400).send({ error: 'type must be "preset" or "custom"' });
      }

      if (body.action !== undefined && !VALID_ACTIONS.includes(body.action as GuardrailAction)) {
        return reply.code(400).send({ error: 'action must be "block", "warn", or "flag"' });
      }

      if (body.type === 'custom' && (typeof body.customPrompt !== 'string' || body.customPrompt.trim() === '')) {
        return reply.code(400).send({ error: 'customPrompt is required for custom guardrails' });
      }

      if (body.failMode !== undefined && !VALID_FAIL_MODES.includes(body.failMode as string)) {
        return reply.code(400).send({ error: 'failMode must be "open" or "closed"' });
      }

      const modelConfigError = findLlmModelConfigError(body);
      if (modelConfigError) {
        return reply.code(400).send({ error: modelConfigError });
      }

      const guardrail = await createGuardrail(
        session.tenantDbName,
        session.tenantId,
        session.userId,
        {
          action: (body.action as GuardrailAction | undefined) ?? 'block',
          customPrompt: body.customPrompt as string | undefined,
          description: typeof body.description === 'string' ? body.description.trim() : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
          failMode: body.failMode as 'open' | 'closed' | undefined,
          modelKey: body.modelKey as string | undefined,
          name: body.name.trim(),
          policy: body.policy as Record<string, unknown> | undefined,
          projectId,
          type: body.type as GuardrailType,
        },
      );

      return reply.code(201).send({ guardrail });
    } catch (error) {
      logger.error('Create guardrail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/guardrails/evaluate', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.guardrail_key !== 'string') {
        return reply.code(400).send({ error: 'guardrail_key is required' });
      }

      if (typeof body.text !== 'string') {
        return reply.code(400).send({ error: 'text is required' });
      }

      const result = await evaluateGuardrail({
        guardrailKey: body.guardrail_key,
        projectId,
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        text: body.text,
        source: 'dashboard-evaluate',
      });

      return reply.code(200).send({
        action: result.action,
        findings: result.findings,
        guardrail_key: result.guardrailKey,
        guardrail_name: result.guardrailName,
        message: result.passed ? null : buildUserMessage(result.findings),
        passed: result.passed,
        disabled: result.disabled ?? false,
        redacted_text: result.redactedText ?? null,
      });
    } catch (error) {
      logger.error('Evaluate guardrail error', { error });
      if (error instanceof Error && error.message.toLowerCase().includes('not found')) {
        return reply.code(404).send({ error: error.message });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  // ── Word lists (tenant-managed banned-word lists) ──
  // Registered as static /guardrails/word-lists* paths; Fastify prefers
  // static segments over :id params, so these never shadow guardrail ids.

  app.get('/guardrails/word-lists', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string };
      const lists = await listWordLists(session.tenantDbName, {
        projectId,
        search: query.search,
      });
      return reply.code(200).send({ wordLists: lists });
    } catch (error) {
      logger.error('List word lists error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/guardrails/word-lists', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }

      // Accept either a parsed `words` array or raw CSV/TXT `content`.
      let words: string[];
      if (typeof body.content === 'string') {
        words = parseWordListContent(body.content);
      } else if (body.words !== undefined) {
        words = normalizeWordArray(body.words);
      } else {
        return reply.code(400).send({ error: 'Provide `words` (string array) or `content` (raw CSV/TXT)' });
      }

      if (words.length === 0) {
        return reply.code(400).send({ error: 'The list contains no usable entries' });
      }

      const wordList = await createWordList(
        session.tenantDbName,
        session.tenantId,
        session.userId,
        {
          name: body.name.trim(),
          description: typeof body.description === 'string' ? body.description.trim() : undefined,
          language: typeof body.language === 'string' ? body.language.trim() : undefined,
          words,
          projectId,
        },
      );

      return reply.code(201).send({ wordList });
    } catch (error) {
      if (error instanceof WordListValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Create word list error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/guardrails/word-lists/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const wordList = await getWordList(session.tenantDbName, id);
      if (!wordList) {
        return reply.code(404).send({ error: 'Word list not found' });
      }
      return reply.code(200).send({ wordList });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.patch('/guardrails/word-lists/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      let words: string[] | undefined;
      if (typeof body.content === 'string') {
        words = parseWordListContent(body.content);
      } else if (body.words !== undefined) {
        words = normalizeWordArray(body.words);
      }
      if (words !== undefined && words.length === 0) {
        return reply.code(400).send({ error: 'The list contains no usable entries' });
      }

      const wordList = await updateWordList(session.tenantDbName, id, session.userId, {
        name: typeof body.name === 'string' ? body.name.trim() : undefined,
        description: typeof body.description === 'string' ? body.description.trim() : undefined,
        language: typeof body.language === 'string' ? body.language.trim() : undefined,
        words,
      });

      if (!wordList) {
        return reply.code(404).send({ error: 'Word list not found' });
      }
      return reply.code(200).send({ wordList });
    } catch (error) {
      if (error instanceof WordListValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Update word list error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.delete('/guardrails/word-lists/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const deleted = await deleteWordList(session.tenantDbName, id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Word list not found' });
      }
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete word list error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/guardrails/:id', withApiRequestContext(async (request, reply) => {
    try {
      requireSessionContext(request);
      const { id } = request.params as { id: string };
      const guardrail = await getGuardrail(requireSessionContext(request).tenantDbName, id);

      if (!guardrail) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      return reply.code(200).send({ guardrail });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.patch('/guardrails/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (body.action !== undefined && !VALID_ACTIONS.includes(body.action as GuardrailAction)) {
        return reply.code(400).send({ error: 'action must be "block", "warn", or "flag"' });
      }

      if (body.failMode !== undefined && !VALID_FAIL_MODES.includes(body.failMode as string)) {
        return reply.code(400).send({ error: 'failMode must be "open" or "closed"' });
      }

      const guardrail = await updateGuardrail(session.tenantDbName, id, session.userId, {
        action: body.action as GuardrailAction | undefined,
        customPrompt: body.customPrompt as string | undefined,
        description: body.description as string | undefined,
        enabled: body.enabled as boolean | undefined,
        failMode: body.failMode as 'open' | 'closed' | undefined,
        modelKey: body.modelKey as string | undefined,
        name: body.name as string | undefined,
        policy: body.policy as Record<string, unknown> | undefined,
      });

      if (!guardrail) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      return reply.code(200).send({ guardrail });
    } catch (error) {
      logger.error('Update guardrail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.delete('/guardrails/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const deleted = await deleteGuardrail(session.tenantDbName, id);

      if (!deleted) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete guardrail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/guardrails/:id/evaluations', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const query = (request.query ?? {}) as EvaluationsQuery;

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const guardrail = await db.findGuardrailById(id);
      if (!guardrail) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      const filter = parseDashboardDateFilterFromSearchParams(
        new URLSearchParams(query as Record<string, string>),
      );
      const limit = Math.min(Number.parseInt(query.limit ?? '50', 10), 200);
      const skip = Number.parseInt(query.skip ?? '0', 10);
      const from = query.from ?? filter.from?.toISOString();
      const to = query.to ?? filter.to?.toISOString();
      const passed = parseBooleanQuery(query.passed);
      const groupBy = query.groupBy ?? 'day';

      const [logs, aggregate] = await Promise.all([
        db.listGuardrailEvaluationLogs(id, {
          from: from ? new Date(from) : undefined,
          limit,
          passed,
          skip,
          to: to ? new Date(to) : undefined,
        }),
        db.aggregateGuardrailEvaluations(id, {
          from: from ? new Date(from) : undefined,
          groupBy,
          to: to ? new Date(to) : undefined,
        }),
      ]);

      return reply.code(200).send({ aggregate, logs });
    } catch (error) {
      logger.error('List guardrail evaluations error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));
};

function buildUserMessage(findings: Array<{ block: boolean; category: string; message: string }>) {
  const blocking = findings.filter((finding) => finding.block);
  if (blocking.length === 0) {
    return 'Content flagged by guardrail.';
  }

  const lines = blocking.map((finding) => {
    const category = finding.category
      .replace(/[_/-]+/g, ' ')
      .replace(/(^|\s)\w/g, (segment) => segment.toUpperCase());

    return `• ${category}: ${finding.message}`;
  });

  return `Content blocked by guardrail:\n${lines.join('\n')}`;
}
