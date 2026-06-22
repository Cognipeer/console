import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { LicenseType } from '@/lib/license/license-manager';
import { createLogger } from '@/lib/core/logger';
import { isShuttingDown } from '@/lib/core/lifecycle';
import { runWithRequestContext } from '@/lib/core/requestContext';
import { getDatabase } from '@/lib/database';
import {
  ApiTokenAuthError,
  type ApiTokenContext,
} from '@/lib/services/apiTokenAuth';
import {
  handleOcrRequest,
  handleSpeechRequest,
  handleTranscriptionRequest,
} from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import {
  checkBudget,
  checkPerRequestLimits,
  checkRateLimit,
} from '@/lib/quota/quotaGuard';
import { readJsonBody, requireApiTokenContext } from '../fastify-utils';
import type {
  OcrExtractInput,
  OcrFeature,
  SttResponseFormat,
  SttTimestampGranularity,
  SttTranscribeInput,
  SttTranslateInput,
  TtsOutputFormat,
  TtsSynthesizeInput,
} from '@/lib/providers';

const logger = createLogger('api:client-audio-ocr');

const VALID_OCR_FEATURES: OcrFeature[] = [
  'text',
  'tables',
  'kv_pairs',
  'layout',
  'reading_order',
  'handwriting',
];

const VALID_TTS_FORMATS: TtsOutputFormat[] = [
  'mp3',
  'opus',
  'aac',
  'flac',
  'wav',
  'pcm',
];

function unauthorizedPayload(message = 'Invalid API token') {
  return { error: { message, type: 'invalid_request_error' } };
}

function quotaExceededPayload(message = 'Quota exceeded') {
  return { error: { message, type: 'rate_limit_error' } };
}

function sanitize(value: unknown, max = 20_000) {
  if (value === null || value === undefined) return value;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= max) return value;
    return { preview: serialized.slice(0, max), truncated: true };
  } catch {
    return '[unserializable]';
  }
}

function withClientContext<TRequest extends FastifyRequest = FastifyRequest>(
  handler: (
    request: TRequest,
    reply: FastifyReply,
    auth: ApiTokenContext,
  ) => Promise<unknown> | unknown,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (isShuttingDown()) {
      return reply
        .code(503)
        .header('Retry-After', '5')
        .send({ error: { message: 'Service is shutting down', type: 'server_error' } });
    }

    let auth: ApiTokenContext;
    try {
      auth = await requireApiTokenContext(request);
      request.apiTokenContext = auth;
    } catch (error) {
      if (error instanceof ApiTokenAuthError) {
        return reply.code(401).send(unauthorizedPayload(error.message));
      }
      logger.error('Audio/OCR auth error', { error });
      return reply.code(401).send(unauthorizedPayload());
    }

    return runWithRequestContext(
      {
        requestId: request.apiRequestId,
        tenantId: auth.tenantId,
        tenantSlug: auth.tenantSlug,
        userId: auth.user?._id ? String(auth.user._id) : undefined,
      },
      async () => {
        // Bind the tenant DB for the whole request via AsyncLocalStorage so
        // downstream model/provider lookups can't fall back to the process-global
        // tenant DB that a concurrent request for another tenant overwrote. See
        // withOpenAiClientContext for the full rationale.
        const db = await getDatabase();
        if (auth.tenantDbName && typeof db.runWithTenant === 'function') {
          return db.runWithTenant(auth.tenantDbName, () =>
            handler(request as TRequest, reply, auth),
          );
        }
        return handler(request as TRequest, reply, auth);
      },
    );
  };
}

function getContentType(request: FastifyRequest): string {
  const h = request.headers['content-type'];
  return Array.isArray(h) ? h[0] ?? '' : (h ?? '');
}

async function getRawBuffer(request: FastifyRequest): Promise<Buffer> {
  const body = request.body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body && typeof body === 'object') {
    return Buffer.from(JSON.stringify(body), 'utf8');
  }
  return Buffer.alloc(0);
}

async function parseFormData(request: FastifyRequest): Promise<FormData> {
  const buf = await getRawBuffer(request);
  const contentType = getContentType(request);
  const req = new Request('http://internal.local/_multipart', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: new Uint8Array(buf),
  });
  return req.formData();
}

function parsePages(value: unknown): number[] | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  return undefined;
}

function parseFeatures(value: unknown): OcrFeature[] | undefined {
  if (typeof value === 'string' && value.trim()) {
    const arr = value
      .split(',')
      .map((v) => v.trim())
      .filter((v): v is OcrFeature => (VALID_OCR_FEATURES as string[]).includes(v));
    return arr.length ? arr : undefined;
  }
  if (Array.isArray(value)) {
    const arr = value
      .map((v) => String(v))
      .filter((v): v is OcrFeature => (VALID_OCR_FEATURES as string[]).includes(v));
    return arr.length ? arr : undefined;
  }
  return undefined;
}

async function buildSttInput(
  request: FastifyRequest,
): Promise<{ modelKey: string; input: SttTranscribeInput }> {
  const contentType = getContentType(request);

  if (contentType.startsWith('multipart/form-data')) {
    const form = await parseFormData(request);
    const modelKey = String(form.get('model') ?? '').trim();
    if (!modelKey) throw new Error('`model` field is required.');
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      throw new Error('`file` field is required.');
    }
    const blob = file as Blob & { name?: string };
    const data = Buffer.from(await blob.arrayBuffer());
    const responseFormatRaw = form.get('response_format');
    const granularities = form
      .getAll('timestamp_granularities[]')
      .map((v) => String(v))
      .filter((v): v is SttTimestampGranularity => v === 'word' || v === 'segment');

    return {
      modelKey,
      input: {
        audio: { data, fileName: blob.name, contentType: blob.type || undefined },
        language: form.get('language') ? String(form.get('language')) : undefined,
        prompt: form.get('prompt') ? String(form.get('prompt')) : undefined,
        responseFormat:
          typeof responseFormatRaw === 'string' && responseFormatRaw
            ? (responseFormatRaw as SttResponseFormat)
            : undefined,
        temperature: form.get('temperature')
          ? Number(form.get('temperature'))
          : undefined,
        timestampGranularities: granularities.length ? granularities : undefined,
      },
    };
  }

  if (contentType.includes('application/json')) {
    const body = readJsonBody<Record<string, unknown>>(request);
    const modelKey = typeof body.model === 'string' ? body.model : '';
    if (!modelKey) throw new Error('`model` field is required.');
    const audio = body.audio as Record<string, unknown> | undefined;
    if (!audio || typeof audio.data !== 'string') {
      throw new Error('`audio.data` must be a base64-encoded string.');
    }
    return {
      modelKey,
      input: {
        audio: {
          data: Buffer.from(audio.data, 'base64'),
          fileName: typeof audio.fileName === 'string' ? audio.fileName : undefined,
          contentType:
            typeof audio.contentType === 'string' ? audio.contentType : undefined,
        },
        language: typeof body.language === 'string' ? body.language : undefined,
        prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
        responseFormat:
          typeof body.response_format === 'string'
            ? (body.response_format as SttResponseFormat)
            : undefined,
        temperature:
          typeof body.temperature === 'number' ? body.temperature : undefined,
        timestampGranularities: Array.isArray(body.timestamp_granularities)
          ? (body.timestamp_granularities as string[]).filter(
              (v): v is SttTimestampGranularity => v === 'word' || v === 'segment',
            )
          : undefined,
      },
    };
  }

  throw new Error('Content-Type must be multipart/form-data or application/json.');
}

async function buildOcrInput(
  request: FastifyRequest,
): Promise<{ modelKey: string; input: OcrExtractInput }> {
  const contentType = getContentType(request);

  if (contentType.startsWith('multipart/form-data')) {
    const form = await parseFormData(request);
    const modelKey = String(form.get('model') ?? '').trim();
    if (!modelKey) throw new Error('`model` field is required.');

    const file = form.get('file');
    const documentUrl = form.get('document_url');

    let document: OcrExtractInput['document'];
    if (file && typeof file !== 'string') {
      const blob = file as Blob & { name?: string };
      document = {
        kind: 'bytes',
        data: Buffer.from(await blob.arrayBuffer()),
        fileName: blob.name,
        contentType: blob.type || undefined,
      };
    } else if (typeof documentUrl === 'string' && documentUrl) {
      document = { kind: 'url', url: documentUrl };
    } else {
      throw new Error('Either `file` or `document_url` is required.');
    }

    return {
      modelKey,
      input: {
        document,
        pages: parsePages(form.get('pages')),
        language: form.get('language') ? String(form.get('language')) : undefined,
        features: parseFeatures(form.get('features')),
        prompt: form.get('prompt') ? String(form.get('prompt')) : undefined,
      },
    };
  }

  if (contentType.includes('application/json')) {
    const body = readJsonBody<Record<string, unknown>>(request);
    const modelKey = typeof body.model === 'string' ? body.model : '';
    if (!modelKey) throw new Error('`model` field is required.');

    const documentField = body.document as Record<string, unknown> | undefined;
    if (!documentField || typeof documentField !== 'object') {
      throw new Error('`document` object is required.');
    }

    let document: OcrExtractInput['document'];
    if (typeof documentField.url === 'string') {
      document = {
        kind: 'url',
        url: documentField.url,
        contentType:
          typeof documentField.contentType === 'string'
            ? documentField.contentType
            : undefined,
      };
    } else if (typeof documentField.data === 'string') {
      document = {
        kind: 'bytes',
        data: Buffer.from(documentField.data, 'base64'),
        fileName:
          typeof documentField.fileName === 'string'
            ? documentField.fileName
            : undefined,
        contentType:
          typeof documentField.contentType === 'string'
            ? documentField.contentType
            : undefined,
      };
    } else {
      throw new Error('`document` must include either `url` or `data` (base64).');
    }

    return {
      modelKey,
      input: {
        document,
        pages: parsePages(body.pages),
        language: typeof body.language === 'string' ? body.language : undefined,
        features: parseFeatures(body.features),
        prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
      },
    };
  }

  throw new Error('Content-Type must be multipart/form-data or application/json.');
}

async function runQuotaGuard(
  auth: ApiTokenContext,
  domain: 'stt' | 'tts' | 'ocr',
  modelKey: string,
): Promise<string | null> {
  const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
  const ctx = {
    tenantDbName: auth.tenantDbName,
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    licenseType: auth.tenant.licenseType as LicenseType,
    userId: auth.tokenRecord.userId,
    tokenId,
    domain,
    resourceKey: modelKey,
  };

  const perRequest = await checkPerRequestLimits(ctx, {});
  if (!perRequest.allowed) return perRequest.reason || 'Quota exceeded';

  const rate = await checkRateLimit(ctx, { requests: 1 });
  if (!rate.allowed) return rate.reason || 'Rate limit exceeded';

  const budget = await checkBudget(ctx);
  if (!budget.allowed) return budget.reason || 'Budget exceeded';

  return null;
}

export const clientAudioOcrApiPlugin: FastifyPluginAsync = async (app) => {
  // ─── POST /client/v1/audio/transcriptions ───────────────────────────
  app.post(
    '/client/v1/audio/transcriptions',
    withClientContext(async (request, reply, auth) => {
      const startedAt = Date.now();
      let modelKey = '';
      try {
        const parsed = await buildSttInput(request);
        modelKey = parsed.modelKey;

        const quotaError = await runQuotaGuard(auth, 'stt', modelKey);
        if (quotaError) return reply.code(429).send(quotaExceededPayload(quotaError));

        const result = await handleTranscriptionRequest({
          tenantDbName: auth.tenantDbName,
          modelKey,
          projectId: auth.projectId,
          input: parsed.input,
        });

        return reply.code(200).send({ ...result.response, request_id: result.requestId });
      } catch (error) {
        logger.error('STT route error', { error });
        try {
          const model = modelKey
            ? await getModelByKey(auth.tenantDbName, modelKey, auth.projectId)
            : null;
          if (model) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            await logModelUsage(auth.tenantDbName, model, {
              requestId: crypto.randomUUID(),
              route: 'audio.transcriptions',
              status: 'error',
              providerRequest: sanitize({ model: modelKey }),
              providerResponse: sanitize({ error: message }),
              errorMessage: message,
              latencyMs: Date.now() - startedAt,
              usage: {},
            });
          }
        } catch (logError) {
          logger.error('Failed to log STT error', { error: logError });
        }
        const code = error instanceof Error && /required|must/i.test(error.message) ? 400 : 500;
        return reply.code(code).send({
          error: {
            message: error instanceof Error ? error.message : 'Inference error',
            type: code === 400 ? 'invalid_request_error' : 'server_error',
          },
        });
      }
    }),
  );

  // ─── POST /client/v1/audio/translations ─────────────────────────────
  app.post(
    '/client/v1/audio/translations',
    withClientContext(async (request, reply, auth) => {
      const startedAt = Date.now();
      let modelKey = '';
      try {
        const parsed = await buildSttInput(request);
        modelKey = parsed.modelKey;

        const quotaError = await runQuotaGuard(auth, 'stt', modelKey);
        if (quotaError) return reply.code(429).send(quotaExceededPayload(quotaError));

        const translateInput: SttTranslateInput = {
          audio: parsed.input.audio,
          prompt: parsed.input.prompt,
          responseFormat: parsed.input.responseFormat,
          temperature: parsed.input.temperature,
        };

        const result = await handleTranscriptionRequest({
          tenantDbName: auth.tenantDbName,
          modelKey,
          projectId: auth.projectId,
          input: translateInput as SttTranscribeInput,
          translate: true,
        });

        return reply.code(200).send({ ...result.response, request_id: result.requestId });
      } catch (error) {
        logger.error('STT translate route error', { error });
        try {
          const model = modelKey
            ? await getModelByKey(auth.tenantDbName, modelKey, auth.projectId)
            : null;
          if (model) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            await logModelUsage(auth.tenantDbName, model, {
              requestId: crypto.randomUUID(),
              route: 'audio.translations',
              status: 'error',
              providerRequest: sanitize({ model: modelKey }),
              providerResponse: sanitize({ error: message }),
              errorMessage: message,
              latencyMs: Date.now() - startedAt,
              usage: {},
            });
          }
        } catch (logError) {
          logger.error('Failed to log STT translate error', { error: logError });
        }
        const code = error instanceof Error && /required|must/i.test(error.message) ? 400 : 500;
        return reply.code(code).send({
          error: {
            message: error instanceof Error ? error.message : 'Inference error',
            type: code === 400 ? 'invalid_request_error' : 'server_error',
          },
        });
      }
    }),
  );

  // ─── POST /client/v1/audio/speech ───────────────────────────────────
  app.post(
    '/client/v1/audio/speech',
    withClientContext(async (request, reply, auth) => {
      const startedAt = Date.now();
      let modelKey = '';
      try {
        let body: Record<string, unknown>;
        try {
          body = readJsonBody<Record<string, unknown>>(request);
        } catch {
          return reply.code(400).send({
            error: { message: 'Invalid JSON body', type: 'invalid_request_error' },
          });
        }

        modelKey = typeof body.model === 'string' ? body.model : '';
        const text = typeof body.input === 'string' ? body.input : '';
        const voice = typeof body.voice === 'string' ? body.voice : '';

        if (!modelKey) {
          return reply.code(400).send({
            error: { message: '`model` is required', type: 'invalid_request_error' },
          });
        }
        if (!text) {
          return reply.code(400).send({
            error: { message: '`input` text is required', type: 'invalid_request_error' },
          });
        }
        const responseFormat =
          typeof body.response_format === 'string' &&
          (VALID_TTS_FORMATS as string[]).includes(body.response_format)
            ? (body.response_format as TtsOutputFormat)
            : undefined;

        const input: TtsSynthesizeInput = {
          text,
          // Optional — the provider runtime falls back to its default voice.
          voice: voice || undefined,
          format: responseFormat,
          speed: typeof body.speed === 'number' ? body.speed : undefined,
          instructions:
            typeof body.instructions === 'string' ? body.instructions : undefined,
        };

        const quotaError = await runQuotaGuard(auth, 'tts', modelKey);
        if (quotaError) return reply.code(429).send(quotaExceededPayload(quotaError));

        const result = await handleSpeechRequest({
          tenantDbName: auth.tenantDbName,
          modelKey,
          projectId: auth.projectId,
          input,
        });

        reply.raw.setHeader('Content-Type', result.contentType);
        reply.raw.setHeader('Content-Length', String(result.audio.byteLength));
        reply.raw.setHeader('X-Request-Id', result.requestId);
        return reply.send(result.audio);
      } catch (error) {
        logger.error('TTS route error', { error });
        try {
          const model = modelKey
            ? await getModelByKey(auth.tenantDbName, modelKey, auth.projectId)
            : null;
          if (model) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            await logModelUsage(auth.tenantDbName, model, {
              requestId: crypto.randomUUID(),
              route: 'audio.speech',
              status: 'error',
              providerRequest: sanitize({ model: modelKey }),
              providerResponse: sanitize({ error: message }),
              errorMessage: message,
              latencyMs: Date.now() - startedAt,
              usage: {},
            });
          }
        } catch (logError) {
          logger.error('Failed to log TTS error', { error: logError });
        }
        return reply.code(500).send({
          error: {
            message: error instanceof Error ? error.message : 'Inference error',
            type: 'server_error',
          },
        });
      }
    }),
  );

  // ─── POST /client/v1/ocr ────────────────────────────────────────────
  app.post(
    '/client/v1/ocr',
    withClientContext(async (request, reply, auth) => {
      const startedAt = Date.now();
      let modelKey = '';
      try {
        const parsed = await buildOcrInput(request);
        modelKey = parsed.modelKey;

        const quotaError = await runQuotaGuard(auth, 'ocr', modelKey);
        if (quotaError) return reply.code(429).send(quotaExceededPayload(quotaError));

        const result = await handleOcrRequest({
          tenantDbName: auth.tenantDbName,
          modelKey,
          projectId: auth.projectId,
          input: parsed.input,
        });

        return reply.code(200).send({ ...result.response, request_id: result.requestId });
      } catch (error) {
        logger.error('OCR route error', { error });
        try {
          const model = modelKey
            ? await getModelByKey(auth.tenantDbName, modelKey, auth.projectId)
            : null;
          if (model) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            await logModelUsage(auth.tenantDbName, model, {
              requestId: crypto.randomUUID(),
              route: 'ocr',
              status: 'error',
              providerRequest: sanitize({ model: modelKey }),
              providerResponse: sanitize({ error: message }),
              errorMessage: message,
              latencyMs: Date.now() - startedAt,
              usage: {},
            });
          }
        } catch (logError) {
          logger.error('Failed to log OCR error', { error: logError });
        }
        const code = error instanceof Error && /required|must/i.test(error.message) ? 400 : 500;
        return reply.code(code).send({
          error: {
            message: error instanceof Error ? error.message : 'Inference error',
            type: code === 400 ? 'invalid_request_error' : 'server_error',
          },
        });
      }
    }),
  );
};
