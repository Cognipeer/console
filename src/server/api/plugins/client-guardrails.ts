import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { evaluateGuardrail } from '@/lib/services/guardrail';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-guardrails');

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
      logger.error('Evaluate client guardrail error', { error });
      const message = error instanceof Error ? error.message : 'Internal error';
      return reply.code(message.toLowerCase().includes('not found') ? 404 : 500).send({
        error: message,
      });
    }
  }));
};
