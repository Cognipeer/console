import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDashboardData } from '@/lib/services/dashboard/dashboardService';
import {
  GuardrailBlockError,
  handleChatCompletion,
} from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:dashboard');

type MessageContentPart = string | { text?: string };
type ChatMessage = {
  content?: string | MessageContentPart[];
  role?: string;
};
type PlaygroundChatRequest = {
  [key: string]: unknown;
  max_tokens?: number;
  messages?: ChatMessage[];
  model?: string;
  stream?: boolean;
  temperature?: number;
};

function sanitize(value: unknown, max = 20000) {
  if (value === null || value === undefined) return value;
  try {
    const str = JSON.stringify(value);
    if (str.length <= max) return value;
    return { preview: str.slice(0, max), truncated: true };
  } catch {
    return '[unserializable]';
  }
}

export const dashboardApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/dashboard', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const filter = parseDashboardDateFilterFromSearchParams(
        new URLSearchParams(request.query as Record<string, string>),
      );

      const data = await getDashboardData(
        session.tenantDbName,
        session.tenantId,
        projectId,
        {
          from: filter.from,
          to: filter.to,
        },
      );

      return reply.code(200).send({
        ...data,
        user: {
          email: session.userEmail,
          licenseType: session.licenseType || 'FREE',
        },
      });
    } catch (error) {
      logger.error('Dashboard data error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch dashboard data',
        });
    }
  }));

  app.post('/dashboard/playground/chat', withApiRequestContext(async (request, reply) => {
    const startedAt = Date.now();
    let body: PlaygroundChatRequest | undefined;
    let projectId: string;
    let tenantDbName: string;
    let modelKey = '';

    try {
      const context = await requireProjectContextForRequest(request);
      projectId = context.projectId;
      tenantDbName = context.session.tenantDbName;

      body = readJsonBody<PlaygroundChatRequest>(request);
      if (!body.model || typeof body.model !== 'string') {
        return reply.code(400).send({ error: '`model` is required' });
      }
      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return reply.code(400).send({ error: '`messages` is required' });
      }

      modelKey = body.model;
      const requestId = crypto.randomUUID();
      const model = await getModelByKey(tenantDbName, modelKey, projectId);
      if (!model) {
        return reply.code(404).send({ error: 'Model not found' });
      }
      if (model.category !== 'llm') {
        return reply.code(400).send({ error: 'Model is not an LLM model' });
      }

      const result = await handleChatCompletion({
        body: {
          ...body,
          request_id: requestId,
        },
        modelKey,
        projectId,
        stream: Boolean(body.stream),
        tenantDbName,
      });

      if (result.stream) {
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Request-Id', result.requestId);
        return reply.send(
          Readable.fromWeb(result.stream as unknown as NodeReadableStream<Uint8Array>),
        );
      }

      return reply.code(200).send({
        ...result.response,
        request_id: result.requestId,
      });
    } catch (error) {
      logger.error('Playground chat error', { error });

      if (error instanceof GuardrailBlockError) {
        return reply.code(400).send({
          action: error.action,
          error: error.message,
          findings: error.findings,
          guardrail_key: error.guardrailKey,
        });
      }

      try {
        const model = modelKey ? await getModelByKey(tenantDbName!, modelKey, projectId!) : null;
        if (model) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await logModelUsage(tenantDbName!, model, {
            errorMessage,
            latencyMs: Date.now() - startedAt,
            providerRequest: sanitize({ messages: body?.messages, model: modelKey }),
            providerResponse: sanitize({ error: errorMessage }),
            requestId: crypto.randomUUID(),
            route: 'playground.chat',
            status: 'error',
            usage: {},
          });
        }
      } catch (logError) {
        logger.error('Failed to log playground error', { error: logError });
      }

      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Chat completion failed',
        });
    }
  }));
};
