/**
 * Client Realtime API plugin (WebSocket).
 *
 *   GET /client/v1/realtime          – realtime event protocol (apps/SDK/playground)
 *   GET /client/v1/realtime/twilio   – Twilio Media Streams bridge (phone calls)
 *
 * `?model=` accepts either a **realtime model key** (named preset created in
 * the Realtime service: chat + STT + TTS + voice + instructions bundled) or a
 * raw chat model key for ad-hoc sessions.
 *
 * Auth, in order: `Authorization: Bearer <token>`, `?api_key=<token>`, or —
 * for the dashboard playground — the session cookie (same-origin upgrade
 * carries it). The global client-API auth hook skips this path; failures
 * close the socket with 4401.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { createLogger } from '@/lib/core/logger';
import type { LicenseType } from '@/lib/license/license-manager';
import { TokenManager } from '@/lib/license/token-manager';
import {
  ApiTokenAuthError,
  requireApiTokenFromHeader,
  type ApiTokenContext,
} from '@/lib/services/apiTokenAuth';
import {
  RealtimeModelValidationError,
  RealtimeSession,
  TwilioMediaBridge,
  createRealtimeModel,
  deleteRealtimeModel,
  getRealtimeModel,
  getRealtimeModelByKey,
  listRealtimeModels,
  updateRealtimeModel,
} from '@/lib/services/realtime';
import type { CreateRealtimeModelInput } from '@/lib/services/realtime';
import type { RealtimeClientEvent, RealtimeContext } from '@/lib/services/realtime';
import type { IRealtimeModel } from '@/lib/database';
import {
  getApiTokenContextForRequest,
  safeReadJsonBody,
  sendApiTokenError,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-realtime');

/** Max websocket frame size — sized for base64 audio chunks. */
const MAX_PAYLOAD_BYTES = Math.max(
  64 * 1024,
  Number(process.env.REALTIME_MAX_FRAME_BYTES ?? 32 * 1024 * 1024) || 32 * 1024 * 1024,
);

const PING_INTERVAL_MS = 30_000;

function resolveAuthHeader(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header;
  }
  const query = request.query as { api_key?: string } | undefined;
  if (query?.api_key && typeof query.api_key === 'string') {
    return `Bearer ${query.api_key}`;
  }
  return null;
}

function toRealtimeContext(auth: ApiTokenContext): RealtimeContext {
  return {
    tenantDbName: auth.tenantDbName,
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    userId: auth.tokenRecord.userId ? String(auth.tokenRecord.userId) : undefined,
    licenseType: auth.tenant.licenseType as LicenseType,
    tokenId: auth.tokenRecord._id ? String(auth.tokenRecord._id) : undefined,
  };
}

/**
 * Resolve the caller: API token first, then the dashboard session cookie
 * (playground connects same-origin, so the upgrade request carries it).
 */
async function authenticate(request: FastifyRequest): Promise<RealtimeContext> {
  const header = resolveAuthHeader(request);
  if (header) {
    return toRealtimeContext(await requireApiTokenFromHeader(header));
  }

  const cookieToken = request.cookies?.token;
  if (cookieToken) {
    const payload = await TokenManager.verifyToken(cookieToken);
    if (payload) {
      const tenantDbName = payload.tenantDbName
        || (payload.tenantSlug ? `tenant_${payload.tenantSlug}` : undefined);
      if (tenantDbName) {
        return {
          tenantDbName,
          tenantId: payload.tenantId,
          projectId: request.cookies?.active_project_id || undefined,
          userId: payload.userId,
          licenseType: payload.licenseType as LicenseType,
        };
      }
    }
  }

  throw new ApiTokenAuthError('Missing or invalid credentials', 401);
}

/** Resolve `?model=` into a realtime preset, or null for raw chat keys. */
async function resolvePreset(
  ctx: RealtimeContext,
  modelKey: string | undefined,
): Promise<IRealtimeModel | null> {
  if (!modelKey) return null;
  const preset = await getRealtimeModelByKey(
    { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId },
    modelKey,
  );
  if (preset && preset.status !== 'active') {
    throw new ApiTokenAuthError(`Realtime model "${modelKey}" is disabled`, 403);
  }
  return preset;
}

function clientInfoFrom(request: FastifyRequest): Record<string, unknown> {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'],
  };
}

/** Shape a realtime model as the snake_case client view. */
function toClientRealtimeModel(model: IRealtimeModel): Record<string, unknown> {
  return {
    id: model._id ? String(model._id) : null,
    object: 'realtime.model',
    key: model.key,
    name: model.name,
    description: model.description ?? null,
    status: model.status,
    chat_model_key: model.chatModelKey,
    instructions: model.instructions ?? null,
    temperature: model.temperature ?? null,
    max_output_tokens: model.maxOutputTokens ?? null,
    stt_model_key: model.sttModelKey ?? null,
    input_audio_format: model.inputAudioFormat ?? null,
    tts_model_key: model.ttsModelKey ?? null,
    voice: model.voice ?? null,
    tts_format: model.ttsFormat ?? null,
    turn_silence_ms: model.turnSilenceMs ?? null,
    turn_silence_threshold: model.turnSilenceThreshold ?? null,
    greeting: model.greeting ?? null,
    metadata: model.metadata ?? {},
    created_at: model.createdAt ?? null,
    updated_at: model.updatedAt ?? null,
  };
}

/** Parse the snake_case client payload into a service input. */
function clientModelInput(body: Record<string, unknown>): CreateRealtimeModelInput {
  const str = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : undefined);
  const num = (value: unknown) => (value === undefined || value === null ? undefined : Number(value));
  return {
    key: str(body.key),
    name: String(body.name ?? ''),
    description: str(body.description),
    chatModelKey: String(body.chat_model_key ?? body.chatModelKey ?? ''),
    instructions: str(body.instructions),
    temperature: num(body.temperature),
    maxOutputTokens: num(body.max_output_tokens ?? body.maxOutputTokens),
    sttModelKey: str(body.stt_model_key ?? body.sttModelKey),
    inputAudioFormat: str(body.input_audio_format ?? body.inputAudioFormat),
    ttsModelKey: str(body.tts_model_key ?? body.ttsModelKey),
    voice: str(body.voice),
    ttsFormat: str(body.tts_format ?? body.ttsFormat),
    turnSilenceMs: num(body.turn_silence_ms ?? body.turnSilenceMs),
    turnSilenceThreshold: num(body.turn_silence_threshold ?? body.turnSilenceThreshold),
    greeting: str(body.greeting),
    metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata as Record<string, unknown>
      : undefined,
  };
}

export const clientRealtimeApiPlugin: FastifyPluginAsync = async (app) => {
  await app.register(websocket, {
    options: { maxPayload: MAX_PAYLOAD_BYTES },
  });

  // ── Standard realtime protocol ─────────────────────────────────────
  app.get('/client/v1/realtime', { websocket: true }, async (socket: WebSocket, request) => {
    let ctx: RealtimeContext;
    let preset: IRealtimeModel | null = null;
    const query = request.query as { model?: string } | undefined;
    try {
      ctx = await authenticate(request);
      preset = await resolvePreset(ctx, query?.model);
    } catch (error) {
      const message = error instanceof ApiTokenAuthError ? error.message : 'Unauthorized';
      socket.send(JSON.stringify({ type: 'error', error: { message, code: 'unauthorized' } }));
      socket.close(4401, 'Unauthorized');
      return;
    }

    const session = new RealtimeSession(
      ctx,
      (event) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(event));
        }
      },
      {
        transport: 'websocket',
        realtimeModel: preset,
        initialConfig: !preset && query?.model ? { model: query.model } : undefined,
        clientInfo: clientInfoFrom(request),
      },
    );

    logger.info('Realtime session opened', {
      sessionId: session.id,
      tenantId: ctx.tenantId,
      realtimeModel: preset?.key,
    });

    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, PING_INTERVAL_MS);

    // Serialize event handling so conversation state mutates in order even
    // when the client fires events back-to-back.
    let chain: Promise<void> = Promise.resolve();

    socket.on('message', (raw: Buffer | string) => {
      let event: RealtimeClientEvent;
      try {
        event = JSON.parse(raw.toString()) as RealtimeClientEvent;
      } catch {
        socket.send(JSON.stringify({
          type: 'error',
          error: { message: 'Events must be JSON objects', code: 'invalid_json' },
        }));
        return;
      }
      chain = chain.then(() => session.handleEvent(event)).catch((error) => {
        logger.error('Realtime event chain error', { error, sessionId: session.id });
      });
    });

    socket.on('close', () => {
      clearInterval(ping);
      session.close();
      logger.info('Realtime session closed', { sessionId: session.id });
    });

    socket.on('error', (error: Error) => {
      logger.warn('Realtime socket error', { error: error.message, sessionId: session.id });
    });
  });

  // ── Realtime model CRUD (API-token surface for the SDK) ───────────
  app.get('/client/v1/realtime/models', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      const models = await listRealtimeModels(
        { tenantDbName: auth.tenantDbName, tenantId: auth.tenantId, projectId: auth.projectId },
      );
      return reply.code(200).send({ object: 'list', data: models.map(toClientRealtimeModel) });
    } catch (error) {
      logger.error('Client realtime models list error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.post('/client/v1/realtime/models', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      const body = safeReadJsonBody<Record<string, unknown>>(request);
      const model = await createRealtimeModel(
        {
          tenantDbName: auth.tenantDbName,
          tenantId: auth.tenantId,
          projectId: auth.projectId,
          userId: auth.tokenRecord.userId ? String(auth.tokenRecord.userId) : undefined,
        },
        clientModelInput(body),
      );
      return reply.code(201).send(toClientRealtimeModel(model));
    } catch (error) {
      if (error instanceof RealtimeModelValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Client realtime model create error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.get('/client/v1/realtime/models/:id', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      const { id } = request.params as { id: string };
      const model = await getRealtimeModel(
        { tenantDbName: auth.tenantDbName, tenantId: auth.tenantId, projectId: auth.projectId },
        id,
      );
      if (!model) return reply.code(404).send({ error: 'Realtime model not found' });
      return reply.code(200).send(toClientRealtimeModel(model));
    } catch (error) {
      logger.error('Client realtime model get error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.patch('/client/v1/realtime/models/:id', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = safeReadJsonBody<Record<string, unknown>>(request);
      const parsed = clientModelInput({ name: 'placeholder', chat_model_key: 'placeholder', ...body });
      const patch: Partial<CreateRealtimeModelInput> = { ...parsed };
      if (body.name === undefined) delete patch.name;
      if (body.chat_model_key === undefined && body.chatModelKey === undefined) {
        delete patch.chatModelKey;
      }
      delete patch.key;
      const model = await updateRealtimeModel(
        {
          tenantDbName: auth.tenantDbName,
          tenantId: auth.tenantId,
          projectId: auth.projectId,
          userId: auth.tokenRecord.userId ? String(auth.tokenRecord.userId) : undefined,
        },
        id,
        {
          ...patch,
          status: body.status === 'active' || body.status === 'disabled' ? body.status : undefined,
        },
      );
      if (!model) return reply.code(404).send({ error: 'Realtime model not found' });
      return reply.code(200).send(toClientRealtimeModel(model));
    } catch (error) {
      if (error instanceof RealtimeModelValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Client realtime model update error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.delete('/client/v1/realtime/models/:id', withClientApiRequestContext(async (request, reply) => {
    try {
      const auth = await getApiTokenContextForRequest(request);
      const { id } = request.params as { id: string };
      const deleted = await deleteRealtimeModel(
        { tenantDbName: auth.tenantDbName, tenantId: auth.tenantId, projectId: auth.projectId },
        id,
      );
      if (!deleted) return reply.code(404).send({ error: 'Realtime model not found' });
      return reply.code(200).send({ deleted: true, id });
    } catch (error) {
      logger.error('Client realtime model delete error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Twilio Media Streams bridge ────────────────────────────────────
  // TwiML:
  //   <Connect>
  //     <Stream url="wss://console.example.com/api/client/v1/realtime/twilio?api_key=KEY&model=support-line"/>
  //   </Connect>
  app.get('/client/v1/realtime/twilio', { websocket: true }, async (socket: WebSocket, request) => {
    let ctx: RealtimeContext;
    let preset: IRealtimeModel | null;
    const query = request.query as { model?: string } | undefined;
    try {
      ctx = await authenticate(request);
      preset = await resolvePreset(ctx, query?.model);
      if (!preset) {
        throw new ApiTokenAuthError(
          'Twilio bridge requires `model` to be a realtime model key (with chat + STT + TTS configured)',
          400,
        );
      }
      if (!preset.sttModelKey || !preset.ttsModelKey || !preset.voice) {
        throw new ApiTokenAuthError(
          `Realtime model "${preset.key}" needs stt_model_key, tts_model_key and voice for telephony`,
          400,
        );
      }
    } catch (error) {
      const message = error instanceof ApiTokenAuthError ? error.message : 'Unauthorized';
      socket.close(4401, message.slice(0, 120));
      return;
    }

    // Telephony needs raw PCM out of TTS so the bridge can transcode to
    // G.711 — override whatever the preset uses for browser sessions.
    const session = new RealtimeSession(
      ctx,
      (event) => bridge.onSessionEvent(event),
      {
        transport: 'twilio',
        realtimeModel: preset,
        initialConfig: { ttsFormat: 'pcm' },
        clientInfo: clientInfoFrom(request),
      },
    );

    const bridge = new TwilioMediaBridge(
      session,
      (message) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      },
      {
        turnSilenceMs: preset.turnSilenceMs,
        turnSilenceThreshold: preset.turnSilenceThreshold,
        greeting: preset.greeting,
        transcriptionModel: preset.sttModelKey,
      },
    );

    logger.info('Twilio realtime stream opened', {
      sessionId: session.id,
      tenantId: ctx.tenantId,
      realtimeModel: preset.key,
    });

    socket.on('message', (raw: Buffer | string) => {
      try {
        bridge.handleMessage(JSON.parse(raw.toString()));
      } catch {
        // Twilio only sends JSON; ignore anything else.
      }
    });

    socket.on('close', () => {
      bridge.close();
      session.close();
      logger.info('Twilio realtime stream closed', { sessionId: session.id });
    });

    socket.on('error', (error: Error) => {
      logger.warn('Twilio stream socket error', { error: error.message, sessionId: session.id });
    });
  });
};
