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
  handleEmbeddingRequest,
  handleImageRequest,
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
  applyStreamHeaders,
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
        applyStreamHeaders(reply, result.requestId);
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

  // ─── Image generation playground ────────────────────────────────────
  app.post('/dashboard/playground/images', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      const modelKey = typeof body.model === 'string' ? body.model : '';
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      if (!modelKey) return reply.code(400).send({ error: '`model` is required' });
      if (!prompt.trim()) return reply.code(400).send({ error: '`prompt` is required' });

      const result = await handleImageRequest({
        tenantDbName: session.tenantDbName,
        modelKey,
        projectId,
        input: {
          prompt,
          n: typeof body.n === 'number' ? body.n : undefined,
          size: typeof body.size === 'string' && body.size ? body.size : undefined,
          quality: typeof body.quality === 'string' && body.quality ? body.quality : undefined,
          style: typeof body.style === 'string' && body.style ? body.style : undefined,
          background: typeof body.background === 'string' && body.background
            ? body.background
            : undefined,
          outputFormat: typeof body.output_format === 'string' && body.output_format
            ? body.output_format
            : undefined,
        },
      });

      return reply.code(200).send({ ...result.response, latencyMs: result.latencyMs });
    } catch (error) {
      logger.error('Playground image error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Image generation failed',
        });
    }
  }));

  // ─── Embeddings playground ──────────────────────────────────────────
  // Returns the vector's shape and a short preview rather than thousands of
  // floats, plus pairwise cosine similarity — which is the thing an operator is
  // actually trying to eyeball when they open this.
  app.post('/dashboard/playground/embeddings', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      const modelKey = typeof body.model === 'string' ? body.model : '';
      const rawInputs = Array.isArray(body.input)
        ? body.input.filter((entry): entry is string => typeof entry === 'string')
        : typeof body.input === 'string'
          ? [body.input]
          : [];
      const inputs = rawInputs.map((entry) => entry.trim()).filter(Boolean);

      if (!modelKey) return reply.code(400).send({ error: '`model` is required' });
      if (inputs.length === 0) return reply.code(400).send({ error: '`input` text is required' });

      const startedAt = Date.now();
      const result = await handleEmbeddingRequest({
        tenantDbName: session.tenantDbName,
        modelKey,
        projectId,
        body: { model: modelKey, input: inputs },
      });

      const response = result.response as {
        data?: Array<{ embedding?: number[] }>;
        usage?: Record<string, unknown>;
      };
      const vectors = (response.data ?? []).map((entry) =>
        Array.isArray(entry.embedding) ? entry.embedding : [],
      );

      const cosine = (a: number[], b: number[]) => {
        const length = Math.min(a.length, b.length);
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < length; i += 1) {
          dot += a[i] * b[i];
          normA += a[i] * a[i];
          normB += b[i] * b[i];
        }
        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        return denominator === 0 ? 0 : dot / denominator;
      };

      const similarities: Array<{ a: number; b: number; score: number }> = [];
      for (let i = 0; i < vectors.length; i += 1) {
        for (let j = i + 1; j < vectors.length; j += 1) {
          similarities.push({ a: i, b: j, score: cosine(vectors[i], vectors[j]) });
        }
      }

      return reply.code(200).send({
        model: modelKey,
        latencyMs: Date.now() - startedAt,
        usage: response.usage,
        vectors: vectors.map((vector, index) => ({
          index,
          input: inputs[index] ?? '',
          dimensions: vector.length,
          preview: vector.slice(0, 8),
          magnitude: Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)),
        })),
        similarities,
      });
    } catch (error) {
      logger.error('Playground embeddings error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Embedding request failed',
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
