import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDashboardData } from '@/lib/services/dashboard/dashboardService';
import {
  GuardrailBlockError,
  handleChatCompletion,
  handleOcrRequest,
  handleSpeechRequest,
  handleTranscriptionRequest,
} from '@/lib/services/models/inferenceService';
import type {
  OcrExtractInput,
  SttResponseFormat,
  SttTranscribeInput,
  TtsOutputFormat,
  TtsSynthesizeInput,
} from '@/lib/providers';
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

  // ─── STT playground ─────────────────────────────────────────────────
  app.post('/dashboard/playground/transcription', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const contentType = (Array.isArray(request.headers['content-type'])
        ? request.headers['content-type'][0]
        : request.headers['content-type']) ?? '';

      let modelKey = '';
      let input: SttTranscribeInput | null = null;
      let translate = false;

      if (contentType.startsWith('multipart/form-data')) {
        const buf = Buffer.isBuffer(request.body)
          ? request.body
          : Buffer.from(String(request.body ?? ''), 'utf8');
        const fetchReq = new Request('http://internal.local/_mp', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: new Uint8Array(buf),
        });
        const form = await fetchReq.formData();
        modelKey = String(form.get('model') ?? '');
        const file = form.get('file');
        translate = String(form.get('translate') ?? '') === 'true';
        if (!modelKey) {
          return reply.code(400).send({ error: '`model` is required' });
        }
        if (!file || typeof file === 'string') {
          return reply.code(400).send({ error: '`file` is required' });
        }
        const blob = file as Blob & { name?: string };
        const responseFormatRaw = form.get('response_format');
        input = {
          audio: {
            data: Buffer.from(await blob.arrayBuffer()),
            fileName: blob.name,
            contentType: blob.type || undefined,
          },
          language: form.get('language') ? String(form.get('language')) : undefined,
          prompt: form.get('prompt') ? String(form.get('prompt')) : undefined,
          responseFormat:
            typeof responseFormatRaw === 'string' && responseFormatRaw
              ? (responseFormatRaw as SttResponseFormat)
              : undefined,
        };
      } else {
        const body = readJsonBody<Record<string, unknown>>(request);
        modelKey = typeof body.model === 'string' ? body.model : '';
        translate = body.translate === true;
        const audio = body.audio as Record<string, unknown> | undefined;
        if (!modelKey) {
          return reply.code(400).send({ error: '`model` is required' });
        }
        if (!audio || typeof audio.data !== 'string') {
          return reply.code(400).send({ error: '`audio.data` (base64) is required' });
        }
        input = {
          audio: {
            data: Buffer.from(audio.data, 'base64'),
            fileName: typeof audio.fileName === 'string' ? audio.fileName : undefined,
            contentType: typeof audio.contentType === 'string' ? audio.contentType : undefined,
          },
          language: typeof body.language === 'string' ? body.language : undefined,
          prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
          responseFormat:
            typeof body.response_format === 'string'
              ? (body.response_format as SttResponseFormat)
              : undefined,
        };
      }

      const result = await handleTranscriptionRequest({
        tenantDbName: session.tenantDbName,
        modelKey,
        projectId,
        input,
        translate,
      });

      return reply.code(200).send({ ...result.response, request_id: result.requestId });
    } catch (error) {
      logger.error('Playground transcription error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Transcription failed',
        });
    }
  }));

  // ─── TTS playground ─────────────────────────────────────────────────
  app.post('/dashboard/playground/speech', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      const modelKey = typeof body.model === 'string' ? body.model : '';
      const text = typeof body.input === 'string' ? body.input : '';
      const voice = typeof body.voice === 'string' ? body.voice : '';
      if (!modelKey) return reply.code(400).send({ error: '`model` is required' });
      if (!text) return reply.code(400).send({ error: '`input` text is required' });

      const responseFormat: TtsOutputFormat | undefined =
        typeof body.response_format === 'string' &&
        ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].includes(body.response_format)
          ? (body.response_format as TtsOutputFormat)
          : undefined;

      const input: TtsSynthesizeInput = {
        text,
        voice: voice || undefined,
        format: responseFormat,
        speed: typeof body.speed === 'number' ? body.speed : undefined,
        instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
      };

      const result = await handleSpeechRequest({
        tenantDbName: session.tenantDbName,
        modelKey,
        projectId,
        input,
      });

      reply.raw.setHeader('Content-Type', result.contentType);
      reply.raw.setHeader('Content-Length', String(result.audio.byteLength));
      reply.raw.setHeader('X-Request-Id', result.requestId);
      return reply.send(result.audio);
    } catch (error) {
      logger.error('Playground speech error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Speech synthesis failed',
        });
    }
  }));

  // ─── OCR playground ─────────────────────────────────────────────────
  app.post('/dashboard/playground/ocr', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const contentType = (Array.isArray(request.headers['content-type'])
        ? request.headers['content-type'][0]
        : request.headers['content-type']) ?? '';

      let modelKey = '';
      let input: OcrExtractInput | null = null;

      if (contentType.startsWith('multipart/form-data')) {
        const buf = Buffer.isBuffer(request.body)
          ? request.body
          : Buffer.from(String(request.body ?? ''), 'utf8');
        const fetchReq = new Request('http://internal.local/_mp', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: new Uint8Array(buf),
        });
        const form = await fetchReq.formData();
        modelKey = String(form.get('model') ?? '');
        if (!modelKey) return reply.code(400).send({ error: '`model` is required' });

        const file = form.get('file');
        const docUrl = form.get('document_url');
        let document: OcrExtractInput['document'];
        if (file && typeof file !== 'string') {
          const blob = file as Blob & { name?: string };
          document = {
            kind: 'bytes',
            data: Buffer.from(await blob.arrayBuffer()),
            fileName: blob.name,
            contentType: blob.type || undefined,
          };
        } else if (typeof docUrl === 'string' && docUrl) {
          document = { kind: 'url', url: docUrl };
        } else {
          return reply.code(400).send({ error: 'Either `file` or `document_url` is required' });
        }

        input = {
          document,
          language: form.get('language') ? String(form.get('language')) : undefined,
          prompt: form.get('prompt') ? String(form.get('prompt')) : undefined,
        };
      } else {
        const body = readJsonBody<Record<string, unknown>>(request);
        modelKey = typeof body.model === 'string' ? body.model : '';
        if (!modelKey) return reply.code(400).send({ error: '`model` is required' });
        const doc = body.document as Record<string, unknown> | undefined;
        if (!doc) return reply.code(400).send({ error: '`document` is required' });

        let document: OcrExtractInput['document'];
        if (typeof doc.url === 'string') {
          document = {
            kind: 'url',
            url: doc.url,
            contentType: typeof doc.contentType === 'string' ? doc.contentType : undefined,
          };
        } else if (typeof doc.data === 'string') {
          document = {
            kind: 'bytes',
            data: Buffer.from(doc.data, 'base64'),
            fileName: typeof doc.fileName === 'string' ? doc.fileName : undefined,
            contentType: typeof doc.contentType === 'string' ? doc.contentType : undefined,
          };
        } else {
          return reply.code(400).send({
            error: '`document` must include either `url` or `data` (base64)',
          });
        }

        input = {
          document,
          language: typeof body.language === 'string' ? body.language : undefined,
          prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
        };
      }

      const result = await handleOcrRequest({
        tenantDbName: session.tenantDbName,
        modelKey,
        projectId,
        input,
      });

      return reply.code(200).send({ ...result.response, request_id: result.requestId });
    } catch (error) {
      logger.error('Playground OCR error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'OCR failed',
        });
    }
  }));
};
