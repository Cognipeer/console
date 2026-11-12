import type { FastifyInstance } from 'fastify';
import {
  AgentTracingService,
} from '@/lib/services/agentTracing';
import { offsetPageOf, pageOfVisibleRows, refuseTracingThread, sendClientListUnavailable, sendClientSessionRefusal } from '../agent-session-access';
import {
  withClientApiRequestContext,
} from '../../fastify-utils';

import { logger } from './logger';

export const registerThreadRoutes = (app: FastifyInstance): void => {
  // ── Read: list threads (grouped sessions) ──
  app.get('/client/v1/tracing/threads', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const query = request.query as {
        agent?: string; status?: string; threadId?: string;
        from?: string; to?: string; limit?: string; skip?: string;
      };

      // A thread of an agent is its session: the ones of an agent whose other people's sessions the token's
      // owner may not view are left out. The default caller gets one plain read; a restricted caller's page is
      // filled from further reads, and has no total (it cannot be known without reading everything).
      const actor = { tenantDbName: auth.tenantDbName, projectId: auth.projectId, userId: String(auth.tokenRecord.userId ?? '') };
      const { skip, limit } = offsetPageOf(query);
      let latest: Awaited<ReturnType<typeof AgentTracingService.listThreads>> | undefined;
      const page = await pageOfVisibleRows(request, {
        start: skip,
        limit,
        minBatch: 25,
        threadIdOf: (row: { threadId?: unknown }) => (typeof row.threadId === 'string' ? row.threadId : null),
        actor,
        fetchPage: async (position, size) => {
          latest = await AgentTracingService.listThreads(auth.tenantDbName, auth.projectId, {
            agent: query.agent,
            status: query.status,
            threadId: query.threadId,
            from: query.from,
            to: query.to,
            limit: String(size),
            skip: String(position),
          });
          const total = latest.total;
          return { rows: latest.threads, after: (consumed) => (position + consumed >= total ? null : position + consumed) };
        },
      });
      if (!page.restricted && latest) return reply.code(200).send(latest);
      return reply.code(200).send({ threads: page.rows, hasMore: page.next !== null, nextSkip: page.next });
    } catch (error) {
      const unavailable = sendClientListUnavailable(reply, request, error);
      if (unavailable) return unavailable;
      logger.error('Client tracing threads list error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to list tracing threads',
      });
    }
  }));

  // ── Read: single thread detail ──
  app.get('/client/v1/tracing/threads/:threadId', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const { threadId } = request.params as { threadId: string };
      const actor = { tenantDbName: auth.tenantDbName, projectId: auth.projectId, userId: String(auth.tokenRecord.userId ?? '') };
      const refusal = await refuseTracingThread(request, threadId, { actor });
      if (refusal) return sendClientSessionRefusal(reply, request, refusal);
      const result = await AgentTracingService.getThreadDetail(
        auth.tenantDbName,
        auth.projectId,
        threadId,
      );
      if (!result) {
        return reply.code(404).send({ error: 'Thread not found' });
      }
      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Client tracing thread detail error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to get tracing thread',
      });
    }
  }));
};
