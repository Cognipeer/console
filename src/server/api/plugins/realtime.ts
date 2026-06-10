/**
 * Realtime admin API plugin (dashboard, session-cookie auth).
 *
 *   GET    /api/realtime/models        – list realtime models
 *   POST   /api/realtime/models        – create
 *   GET    /api/realtime/models/:id    – detail
 *   PATCH  /api/realtime/models/:id    – update
 *   DELETE /api/realtime/models/:id    – delete
 *   GET    /api/realtime/sessions      – session logs (filters: model, transport, status, from/to)
 *   GET    /api/realtime/overview      – aggregate cards for the dashboard
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { IRealtimeSessionLog } from '@/lib/database';
import {
  RealtimeModelValidationError,
  createRealtimeModel,
  deleteRealtimeModel,
  getRealtimeModel,
  listRealtimeModels,
  updateRealtimeModel,
} from '@/lib/services/realtime';
import type { CreateRealtimeModelInput, UpdateRealtimeModelInput } from '@/lib/services/realtime';
import {
  requireProjectContextForRequest,
  safeReadJsonBody,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:realtime');

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function pickModelInput(body: Record<string, unknown>): CreateRealtimeModelInput {
  return {
    key: typeof body.key === 'string' ? body.key : undefined,
    name: String(body.name ?? ''),
    description: typeof body.description === 'string' ? body.description : undefined,
    chatModelKey: String(body.chatModelKey ?? body.chat_model_key ?? ''),
    instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
    temperature: body.temperature === undefined || body.temperature === null ? undefined : Number(body.temperature),
    maxOutputTokens: body.maxOutputTokens === undefined && body.max_output_tokens === undefined
      ? undefined
      : Number(body.maxOutputTokens ?? body.max_output_tokens),
    sttModelKey: typeof (body.sttModelKey ?? body.stt_model_key) === 'string'
      ? String(body.sttModelKey ?? body.stt_model_key) || undefined
      : undefined,
    inputAudioFormat: typeof (body.inputAudioFormat ?? body.input_audio_format) === 'string'
      ? String(body.inputAudioFormat ?? body.input_audio_format) || undefined
      : undefined,
    ttsModelKey: typeof (body.ttsModelKey ?? body.tts_model_key) === 'string'
      ? String(body.ttsModelKey ?? body.tts_model_key) || undefined
      : undefined,
    voice: typeof body.voice === 'string' ? body.voice || undefined : undefined,
    ttsFormat: typeof (body.ttsFormat ?? body.tts_format) === 'string'
      ? String(body.ttsFormat ?? body.tts_format) || undefined
      : undefined,
    turnSilenceMs: body.turnSilenceMs === undefined && body.turn_silence_ms === undefined
      ? undefined
      : Number(body.turnSilenceMs ?? body.turn_silence_ms),
    turnSilenceThreshold: body.turnSilenceThreshold === undefined && body.turn_silence_threshold === undefined
      ? undefined
      : Number(body.turnSilenceThreshold ?? body.turn_silence_threshold),
    greeting: typeof body.greeting === 'string' ? body.greeting || undefined : undefined,
    metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata as Record<string, unknown>
      : undefined,
  };
}

function aggregateSessions(sessions: IRealtimeSessionLog[]) {
  const total = sessions.length;
  const active = sessions.filter((entry) => entry.status === 'active').length;
  const errored = sessions.filter((entry) => entry.status === 'error').length;
  const totalResponses = sessions.reduce((sum, entry) => sum + entry.responseCount, 0);
  const totalTokens = sessions.reduce((sum, entry) => sum + entry.usageTotalTokens, 0);
  const totalAudioSeconds = sessions.reduce((sum, entry) => sum + entry.inputAudioSeconds, 0);
  const durations = sessions
    .map((entry) => entry.durationMs)
    .filter((value): value is number => typeof value === 'number' && value > 0);
  const latencies = sessions
    .map((entry) => entry.firstTokenLatencyMs)
    .filter((value): value is number => typeof value === 'number' && value > 0);
  const byTransport: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  for (const entry of sessions) {
    byTransport[entry.transport] = (byTransport[entry.transport] ?? 0) + 1;
    if (entry.realtimeModelKey) {
      byModel[entry.realtimeModelKey] = (byModel[entry.realtimeModelKey] ?? 0) + 1;
    }
  }
  const avg = (values: number[]) =>
    values.length > 0 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  return {
    totalSessions: total,
    activeSessions: active,
    erroredSessions: errored,
    totalResponses,
    totalTokens,
    totalAudioSeconds: Math.round(totalAudioSeconds * 10) / 10,
    avgDurationMs: avg(durations),
    avgFirstTokenLatencyMs: avg(latencies),
    byTransport,
    byModel,
  };
}

export const realtimeApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Models ──────────────────────────────────────────────────────────
  app.get('/realtime/models', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { status?: string };
      const models = await listRealtimeModels(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { status: query.status },
      );
      return reply.code(200).send({ models });
    } catch (error) {
      logger.error('List realtime models error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/realtime/models', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = safeReadJsonBody<Record<string, unknown>>(request);
      const model = await createRealtimeModel(
        {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId,
          userId: session.userId,
        },
        pickModelInput(body),
      );
      return reply.code(201).send({ model });
    } catch (error) {
      if (error instanceof RealtimeModelValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Create realtime model error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/realtime/models/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const model = await getRealtimeModel(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        id,
      );
      if (!model) return reply.code(404).send({ error: 'Realtime model not found' });
      return reply.code(200).send({ model });
    } catch (error) {
      logger.error('Get realtime model error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/realtime/models/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = safeReadJsonBody<Record<string, unknown>>(request);
      const patch: UpdateRealtimeModelInput = {
        ...pickModelInput({ name: 'placeholder', chat_model_key: 'placeholder', ...body }),
      };
      // pickModelInput coerces missing name/chatModelKey to placeholders;
      // strip anything the caller did not actually send.
      if (body.name === undefined) delete patch.name;
      if (body.chatModelKey === undefined && body.chat_model_key === undefined) delete patch.chatModelKey;
      if (body.key === undefined) delete patch.key;
      if (typeof body.status === 'string' && (body.status === 'active' || body.status === 'disabled')) {
        patch.status = body.status;
      }
      const model = await updateRealtimeModel(
        {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId,
          userId: session.userId,
        },
        id,
        patch,
      );
      if (!model) return reply.code(404).send({ error: 'Realtime model not found' });
      return reply.code(200).send({ model });
    } catch (error) {
      if (error instanceof RealtimeModelValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Update realtime model error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/realtime/models/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const deleted = await deleteRealtimeModel(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        id,
      );
      if (!deleted) return reply.code(404).send({ error: 'Realtime model not found' });
      return reply.code(200).send({ deleted: true });
    } catch (error) {
      logger.error('Delete realtime model error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── Session logs ────────────────────────────────────────────────────
  app.get('/realtime/sessions', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as {
        model?: string;
        transport?: string;
        status?: string;
        from?: string;
        to?: string;
        limit?: string;
        skip?: string;
      };
      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);
      const sessions = await db.listRealtimeSessionLogs(session.tenantId, {
        projectId,
        realtimeModelKey: query.model,
        transport: query.transport,
        status: query.status,
        from: parseDate(query.from),
        to: parseDate(query.to),
        limit: query.limit ? Math.max(1, Math.min(Number(query.limit) || 100, 500)) : 100,
        skip: query.skip ? Math.max(0, Number(query.skip) || 0) : undefined,
      });
      return reply.code(200).send({ sessions });
    } catch (error) {
      logger.error('List realtime sessions error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── Overview (dashboard cards) ──────────────────────────────────────
  app.get('/realtime/overview', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { from?: string; to?: string };
      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);
      const sessions = await db.listRealtimeSessionLogs(session.tenantId, {
        projectId,
        from: parseDate(query.from),
        to: parseDate(query.to),
        limit: 1000,
      });
      return reply.code(200).send({
        overview: aggregateSessions(sessions),
        recentSessions: sessions.slice(0, 10),
      });
    } catch (error) {
      logger.error('Realtime overview error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
