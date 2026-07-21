import type { FastifyPluginAsync } from 'fastify';
import type { GuardrailAction, GuardrailType } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  createGuardrail,
  deleteGuardrail,
  evaluateGuardrail,
  getGuardrailByKey,
  updateGuardrail,
} from '@/lib/services/guardrail';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  sendApiTokenError,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-guardrails');

const VALID_ACTIONS: GuardrailAction[] = ['block', 'warn', 'flag'];
const VALID_TYPES: GuardrailType[] = ['preset', 'custom'];
const VALID_FAIL_MODES = ['open', 'closed'];

/**
 * LLM-backed checks silently no-op without a model, which reads as "guardrail
 * active" while nothing runs. Reject configurations that enable an LLM check
 * with no model to run it on. (Mirrors the dashboard `guardrails` plugin.)
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

function buildUserMessage(findings: Array<{ block: boolean; category: string; message: string }>) {
  const blocking = findings.filter((finding) => finding.block);
  if (blocking.length === 0) {
    return 'Content flagged by guardrail.';
  }

  return `Content blocked by guardrail:\n${blocking
    .map((finding) => `• ${formatCategory(finding.category)}: ${finding.message}`)
    .join('\n')}`;
}

function formatCategory(category: string): string {
  return category
    .replace(/[_/-]+/g, ' ')
    .replace(/(^|\s)\w/g, (segment) => segment.toUpperCase())
    .trim();
}

export const clientGuardrailsApiPlugin: FastifyPluginAsync = async (app) => {
  app.post('/client/v1/guardrails/evaluate', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.guardrail_key !== 'string') {
        return reply.code(400).send({ error: 'guardrail_key is required' });
      }

      if (typeof body.text !== 'string') {
        return reply.code(400).send({ error: 'text is required' });
      }

      const result = await evaluateGuardrail({
        guardrailKey: body.guardrail_key,
        projectId: ctx.projectId,
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        text: body.text,
        source: 'client-api',
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
      logger.error('Evaluate client guardrail error', { error });
      const message = error instanceof Error ? error.message : 'Internal error';
      return reply.code(message.toLowerCase().includes('not found') ? 404 : 500).send({
        error: message,
      });
    }
  }));

  // ── Create a guardrail definition ──
  app.post('/client/v1/guardrails', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
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

      const guardrail = await createGuardrail(ctx.tenantDbName, ctx.tenantId, ctx.tokenRecord.userId, {
        action: (body.action as GuardrailAction | undefined) ?? 'block',
        customPrompt: body.customPrompt as string | undefined,
        description: typeof body.description === 'string' ? body.description.trim() : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
        failMode: body.failMode as 'open' | 'closed' | undefined,
        modelKey: body.modelKey as string | undefined,
        name: body.name.trim(),
        policy: body.policy as Record<string, unknown> | undefined,
        projectId: ctx.projectId,
        type: body.type as GuardrailType,
      });

      return reply.code(201).send({ guardrail });
    } catch (error) {
      logger.error('Create client guardrail error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Update a guardrail definition (resolve by key, scoped to project) ──
  app.patch('/client/v1/guardrails/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (body.action !== undefined && !VALID_ACTIONS.includes(body.action as GuardrailAction)) {
        return reply.code(400).send({ error: 'action must be "block", "warn", or "flag"' });
      }
      if (body.failMode !== undefined && !VALID_FAIL_MODES.includes(body.failMode as string)) {
        return reply.code(400).send({ error: 'failMode must be "open" or "closed"' });
      }

      const existing = await getGuardrailByKey(ctx.tenantDbName, key, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      const guardrail = await updateGuardrail(ctx.tenantDbName, existing.id, ctx.tokenRecord.userId, {
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
      logger.error('Update client guardrail error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Delete a guardrail definition (resolve by key, scoped to project) ──
  app.delete('/client/v1/guardrails/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };

      const existing = await getGuardrailByKey(ctx.tenantDbName, key, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      const deleted = await deleteGuardrail(ctx.tenantDbName, existing.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete client guardrail error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));
};
