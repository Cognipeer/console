import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  createSupportHandoff,
  isSupportConfigured,
  type SupportLocale,
} from '@/lib/services/support/supportHandoff';
import { readJsonBody, requireSessionContext, withApiRequestContext } from '../fastify-utils';

const logger = createLogger('api:support');

type HandoffBody = {
  locale?: unknown;
  summary?: unknown;
  diagnostics?: unknown;
};

function parseLocale(value: unknown): SupportLocale {
  return value === 'en' ? 'en' : 'tr';
}

export const supportApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/support/status', withApiRequestContext(async (request, reply) => {
    try {
      requireSessionContext(request);
      return reply.code(200).send({ enabled: isSupportConfigured() });
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  }));

  app.post('/support/handoff', withApiRequestContext(async (request, reply) => {
    let session;
    try {
      session = requireSessionContext(request);
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const body = readJsonBody<HandoffBody>(request);
    if (body.locale !== undefined && body.locale !== 'tr' && body.locale !== 'en') {
      return reply.code(400).send({ error: 'Invalid Support locale' });
    }
    if (
      body.diagnostics !== undefined
      && (typeof body.diagnostics !== 'object' || body.diagnostics === null || Array.isArray(body.diagnostics))
    ) {
      return reply.code(400).send({ error: 'Invalid Support diagnostics' });
    }

    try {
      const result = await createSupportHandoff({
        tenantId: session.tenantId,
        userId: session.userId,
        userEmail: session.userEmail ?? '',
        locale: parseLocale(body.locale),
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        diagnostics: body.diagnostics as Record<string, unknown> | undefined,
      });

      if (!result.ok) {
        return reply.code(result.status).send({ error: result.message });
      }

      reply.header('Cache-Control', 'no-store');
      return reply.code(200).send({
        url: result.url,
        ...(result.diagnosticsUnavailable ? { diagnosticsUnavailable: true } : {}),
      });
    } catch (error) {
      logger.error('Support handoff error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
