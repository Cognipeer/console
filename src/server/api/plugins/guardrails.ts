import type { FastifyPluginAsync } from 'fastify';
import type { GuardrailAction, GuardrailTarget, GuardrailType } from '@/lib/database';
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
  updateGuardrail,
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
const VALID_TARGETS: GuardrailTarget[] = ['input', 'output', 'both'];
const VALID_TYPES: GuardrailType[] = ['preset', 'custom'];

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

      if (body.target !== undefined && !VALID_TARGETS.includes(body.target as GuardrailTarget)) {
        return reply.code(400).send({ error: 'target must be "input", "output", or "both"' });
      }

      if (body.type === 'custom' && (typeof body.customPrompt !== 'string' || body.customPrompt.trim() === '')) {
        return reply.code(400).send({ error: 'customPrompt is required for custom guardrails' });
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
          modelKey: body.modelKey as string | undefined,
          name: body.name.trim(),
          policy: body.policy as Record<string, unknown> | undefined,
          projectId,
          target: (body.target as GuardrailTarget | undefined) ?? 'input',
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
      });

      return reply.code(200).send({
        action: result.action,
        findings: result.findings,
        guardrail_key: result.guardrailKey,
        guardrail_name: result.guardrailName,
        message: result.passed ? null : buildUserMessage(result.findings),
        passed: result.passed,
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

      if (body.target !== undefined && !VALID_TARGETS.includes(body.target as GuardrailTarget)) {
        return reply.code(400).send({ error: 'target must be "input", "output", or "both"' });
      }

      const guardrail = await updateGuardrail(session.tenantDbName, id, session.userId, {
        action: body.action as GuardrailAction | undefined,
        customPrompt: body.customPrompt as string | undefined,
        description: body.description as string | undefined,
        enabled: body.enabled as boolean | undefined,
        modelKey: body.modelKey as string | undefined,
        name: body.name as string | undefined,
        policy: body.policy as Record<string, unknown> | undefined,
        target: body.target as GuardrailTarget | undefined,
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
