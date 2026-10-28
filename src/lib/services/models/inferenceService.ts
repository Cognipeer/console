import crypto from 'crypto';
import { AGENT_REASONING_OVERRIDE } from '@/lib/services/models/reasoning';
import { createLogger } from '@/lib/core/logger';
import { abortErrorFrom, withResilience } from '@/lib/core/resilience';
import { fireAndForget } from '@/lib/core/asyncTask';

const logger = createLogger('inference');
import { IModel } from '@/lib/database';
import type {
  SttRuntime,
  SttResult,
  SttStream,
  SttStreamOptions,
  SttTranscribeInput,
  SttTranslateInput,
  TtsRuntime,
  TtsResult,
  TtsSynthesizeInput,
  TtsOutputFormat,
  OcrRuntime,
  OcrExtractInput,
  OcrResult,
  ImageGenerateInput,
} from '@/lib/providers';
import { InvalidRequestError } from '@/lib/providers/contracts/upstreamError';
import {
  TTS_PCM_SAMPLE_RATE,
  alignPcm16Chunks,
  pcmContentType,
  ttsMimeType,
} from '@/lib/providers/contracts/audioStream';
import { getModelByKey } from './modelService';
import { primaryReplicaModel } from './replicaPool';
import {
  openAIStreamRoleChunk,
  openAIStreamStopChunk,
  openAIStreamUsageChunk,
  openAiBodyToNative,
  OpenAiStreamFramer,
} from './openaiAdapter';
import { normalizeInferenceError } from './openaiErrors';

export { OutputTokenLimitError } from './openaiErrors';

import { logModelUsage, TokenUsage, UsageCostResult } from './usageLogger';
import type { IModelUsageRouting } from '@/lib/database';
import type { RoutingCallerContext } from './routingCallerContext';
import { buildModelRuntime } from './runtimeService';
import { executeModelCall } from './gatewayCore';
import { sanitizeForLogging } from './gatewayRequest';
import type { ModelCallInput, ModelCallOutcome } from './gatewayTypes';

// The pieces the chat pipeline is made of live in their own modules; they stay
// importable from here, where every caller has always found them.
export {
  GuardrailBlockError,
  clientSafeFindings,
  enforceModelGuardrailChain,
} from './gatewayGuardrails';
export { DynamicRoutingBudgetError } from './gatewayRouting';
export { describeRequestContract, resolveModelInvocationConfig } from './gatewayRequest';
export type { LoggedRequestContract } from './gatewayRequest';
export { executeModelCall } from './gatewayCore';

import type { NativeEmbedOptions } from '@/lib/providers/domains/model';

const encoder = new TextEncoder();

interface EmbeddingRequestBody extends Record<string, unknown> {
  input?: string | string[];
  request_id?: string;
  input_tokens?: number;
  inputTokenCount?: number;
  dimensions?: number;
  encoding_format?: string;
  input_type?: string;
}

function ensureModerationModel(model: IModel) {
  if (model.category !== 'moderation') {
    throw new InvalidRequestError('Model is not configured for moderation');
  }
}

function ensureImageModel(model: IModel) {
  if (model.category !== 'image') {
    throw new InvalidRequestError('Model is not configured for image generation');
  }
}

function ensureEmbeddingModel(model: IModel) {
  if (model.category !== 'embedding') {
    throw new InvalidRequestError('Model is not configured for embeddings');
  }
}

/**
 * Unified result shape for chat completions. A single object (not a union) so
 * callers can probe `stream` / `response` / `usage` without narrowing - exactly
 * how every existing call site already uses it. `routing` is present only on
 * Dynamic LLM responses.
 */
export interface ChatCompletionOutcome {
  response?: Record<string, unknown>;
  usage?: TokenUsage;
  latencyMs?: number;
  requestId: string;
  cacheHit?: boolean;
  stream?: ReadableStream<Uint8Array>;
  routing?: IModelUsageRouting;
  /**
   * Verdict headers for a STREAMED answer, filled in as the stream unfolds -
   * so it is only complete once the stream is.
   *
   * A guardrail block on a stream is discovered mid-response, long after the
   * response headers were flushed, which is why the same facts are also written
   * in-band (the `{ guardrail: { blocked, discardPrior } }` frame). A transport
   * that can send trailers should announce these here and send them as
   * trailers; one that cannot should ignore it and let the in-band frame do the
   * talking. Present only on the streaming path.
   */
  streamHeaders?: Record<string, string>;
}

export interface ChatCompletionRequestBody extends Record<string, unknown> {
  messages?: unknown;
  stream?: unknown;
  request_id?: string;
}

function sse(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * The OpenAI Chat Completions facade over the gateway core.
 *
 * The body is translated to native types, the core (`executeModelCall`) runs the
 * model-level pipeline, and the native answer is rendered back as an OpenAI
 * `chat.completion` or as a `text/event-stream` of `chat.completion.chunk`s.
 * Callers that speak OpenAI JSON keep calling this; the pipeline itself knows no
 * wire format.
 */
export async function handleChatCompletion(params: {
  tenantDbName: string;
  tenantId?: string;
  modelKey: string;
  projectId: string;
  body: ChatCompletionRequestBody;
  stream?: boolean;
  /** Internal: recursion depth when a Dynamic LLM resolves to another model. */
  _routingDepth?: number;
  /** Internal: the Dynamic LLM decision this call serves, recorded on its usage rows. */
  _routedBy?: ModelCallInput['context'] extends infer C ? (C extends { routedBy?: infer R } ? R : never) : never;
  /** Who is asking and through which door - feeds Dynamic LLM caller conditions. Merged over the ambient `runWithRoutingCaller` scope. */
  callerContext?: RoutingCallerContext;
  /**
   * Called with the REALIZED cost of this call, once usage is known - for a
   * streaming response that is long after this function has already returned
   * the (still-open) stream to the caller. That's the only reason this
   * exists: the caller's `quotaContext` (license type, token id, per-user vs
   * per-tenant budget key) isn't reconstructible from inside this module, but
   * a plain closure over it costs the caller nothing to provide. Computed
   * here (not by the caller) so a Dynamic LLM child model's own pricing is
   * always what gets charged, never the router's. Fires for every call that
   * billed tokens: success, an output-limit hit, a stream whose upstream sent no
   * usage (estimated), a cancelled stream with partial usage and a stream cut
   * after it produced output; never for a request that produced nothing.
   */
  onUsageSettled?: (cost: UsageCostResult, usage?: TokenUsage) => void;
  /** Aborts the upstream request. A streamed call that is aborted is logged `cancelled`. */
  signal?: AbortSignal;
  /** Usage row route and attribution for an in-process caller. Defaults to the gateway's own route. */
  route?: string;
  attribution?: NonNullable<ModelCallInput['context']>['attribution'];
}): Promise<ChatCompletionOutcome> {
  const { tenantDbName, tenantId, modelKey, projectId, stream, body } = params;

  if (!Array.isArray(body?.messages)) {
    throw new Error('`messages` array is required');
  }

  // Cancelling the readable - which Fastify does when the response socket closes -
  // aborts the upstream call; a caller's own signal does the same.
  const hangUp = new AbortController();
  const signal = params.signal ? AbortSignal.any([hangUp.signal, params.signal]) : hangUp.signal;

  const outcome = await executeModelCall({
    tenantDbName,
    tenantId,
    projectId,
    modelKey,
    request: openAiBodyToNative(body),
    wire: body,
    stream,
    context: {
      callerContext: params.callerContext,
      onUsageSettled: params.onUsageSettled,
      signal,
      route: params.route,
      attribution: params.attribution,
      reasoningOverride: (body as { [AGENT_REASONING_OVERRIDE]?: unknown })[AGENT_REASONING_OVERRIDE],
      routingDepth: params._routingDepth,
      routedBy: params._routedBy,
    },
  });

  if (!outcome.stream) return plainOutcome(outcome);
  return { stream: sseStream(outcome, hangUp), requestId: outcome.requestId, streamHeaders: outcome.streamHeaders, routing: outcome.routing };
}

function plainOutcome(outcome: ModelCallOutcome): ChatCompletionOutcome {
  return {
    response: outcome.wire,
    usage: outcome.usage,
    latencyMs: outcome.latencyMs,
    requestId: outcome.requestId,
    cacheHit: outcome.cacheHit,
    ...(outcome.routing ? { routing: outcome.routing } : {}),
  };
}

/** Renders the core's stream events as OpenAI `text/event-stream` frames. */
function sseStream(outcome: ModelCallOutcome, hangUp: AbortController): ReadableStream<Uint8Array> {
  const events = outcome.stream!;
  const requestId = outcome.requestId;
  const options = {
    model: outcome.wireModel ?? '',
    completionId: outcome.wireCompletion?.id,
    created: outcome.wireCompletion?.created,
    includeReasoning: outcome.includeReasoning,
  };
  const framer = new OpenAiStreamFramer(options);
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };
      const send = (payload: unknown) => write(sse(payload));
      const finish = () => {
        // `[DONE]` terminates every stream, including one that ended in an error
        // frame. Withholding it leaves a client that reads until the sentinel -
        // the OpenAI SDK, and everything built on it - blocked on the socket
        // instead of returning the error it was just handed.
        write(encoder.encode('data: [DONE]\n\n'));
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed by a hang-up */
          }
        }
      };

      try {
        // The loop keeps consuming after a hang-up: the core sees the abort on its
        // next read, logs the cancellation with the usage it can estimate, and ends.
        for await (const event of events) {
          switch (event.type) {
            case 'start':
              // OpenAI opens every stream with the assistant role before any content.
              send(openAIStreamRoleChunk(options));
              break;
            case 'delta': {
              const frame = framer.delta(event);
              if (frame) send(frame);
              break;
            }
            case 'usage':
              send(openAIStreamUsageChunk(options, event.wire));
              break;
            case 'finish':
              send(openAIStreamStopChunk(options, event.finishReason));
              break;
            case 'output_limit':
              send({ error: event.error, request_id: requestId });
              break;
            case 'blocked':
              // 1. The OpenAI-native signal every SDK already understands. A client
              //    that reads nothing else still learns the answer was filtered.
              send(openAIStreamStopChunk(options, 'content_filter'));
              // 2. Characters already rendered cannot be recalled, so say so.
              if (event.discardPrior) send({ guardrail: { blocked: true, discardPrior: true } });
              // 3. The same error-frame shape the output-limit path emits, so a
              //    caller has one place to look for "the gateway ended this".
              send({
                error: {
                  type: 'guardrail_block',
                  code: event.code,
                  message: event.message,
                  guardrail_key: event.guardrailKey,
                },
                request_id: requestId,
              });
              // 4. ALWAYS [DONE], and close BEFORE the core aborts the upstream
              //    (it resumes when this loop asks for the next event).
              finish();
              break;
            case 'failed':
              send({ error: event.error, request_id: requestId });
              finish();
              break;
            case 'done':
              finish();
              break;
            case 'cancelled':
              closed = true;
              break;
            default:
              break;
          }
        }
        if (!closed) finish();
      } catch (error) {
        const normalized = normalizeInferenceError(error);
        send({ error: normalized.error, request_id: requestId });
        finish();
      }
    },
    cancel(reason) {
      closed = true;
      hangUp.abort(reason);
    },
  });
}


/**
 * Non-chat paths do not balance across replicas, but they must still skip a
 * replica the operator switched off, so they serve from the first enabled one.
 */
async function getServingModel(
  tenantDbName: string,
  modelKey: string,
  projectId: string,
): Promise<IModel | null> {
  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  return model ? primaryReplicaModel(model) : null;
}

export async function handleEmbeddingRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  body: EmbeddingRequestBody;
  /** Cancels the upstream embedding call (e.g. the agent turn was stopped). */
  signal?: AbortSignal;
}) {
  const { tenantDbName, modelKey, projectId, body, signal } = params;

  if (!body?.input) {
    throw new Error('`input` is required');
  }

  const requestId = body?.request_id || crypto.randomUUID();
  const start = Date.now();

  const model = await getServingModel(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }

  ensureEmbeddingModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createNativeEmbedder) {
    throw new Error('Model provider does not support embeddings');
  }

  const embedder = await runtime.createNativeEmbedder({
    modelId: model.modelId,
    category: model.category,
    modelSettings: model.settings,
    // `withResilience` owns retry and circuit-breaking here.
    options: { maxRetries: 0 },
  });
  if (!embedder || typeof embedder.embed !== 'function') {
    throw new Error('Model provider returned an invalid embedding runtime.');
  }
  const rawInput = body.input;
  const inputsArray = Array.isArray(rawInput) ? rawInput : [rawInput];
  const inputs = inputsArray.map((value) => {
    if (typeof value !== 'string') {
      throw new Error('`input` must be a string or an array of strings');
    }
    return value;
  });

  const embedOptions: NativeEmbedOptions = signal ? { signal } : {};
  if (typeof body.dimensions === 'number' && body.dimensions > 0) embedOptions.dimensions = body.dimensions;
  if (body.encoding_format === 'float' || body.encoding_format === 'base64') embedOptions.encodingFormat = body.encoding_format;
  if (typeof body.input_type === 'string' && body.input_type) embedOptions.inputType = body.input_type;

  const embedded = await withResilience(
    () => embedder.embed(inputs, embedOptions),
    { key: `embedding:${tenantDbName}:${model.providerKey}`, ...(signal ? { signal } : {}) },
  );
  const embeddings = embedded.vectors;
  const latencyMs = Date.now() - start;

  // Token count: the caller-supplied count wins; then the provider's own
  // usage; otherwise (Bedrock/Vertex report none) the input is estimated at
  // ~4 chars/token, the rule the chat gateway uses for its pre-flight
  // estimate. Never 0, which showed embedding calls with no usage in Model Hub.
  const providerTokens = embedded.usage?.inputTokens || embedded.usage?.totalTokens || 0;
  const tokenEstimate =
    typeof body.input_tokens === 'number'
      ? body.input_tokens
      : typeof body.inputTokenCount === 'number'
        ? body.inputTokenCount
        : providerTokens > 0
          ? providerTokens
          : inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);

  const usage: TokenUsage = {
    inputTokens: tokenEstimate,
    outputTokens: 0,
    totalTokens: tokenEstimate,
  };

  fireAndForget('log-embedding-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'embeddings',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        input: inputs.slice(0, 5),
      }),
      providerResponse: sanitizeForLogging({
        embeddingsLength: embeddings.length,
      }),
      latencyMs,
      usage,
    }),
  );

  return {
    response: {
      object: 'list',
      data: embeddings.map((vector, index) => ({
        object: 'embedding',
        index,
        embedding: vector,
      })),
      model: model.modelId,
      usage: {
        prompt_tokens: usage.inputTokens ?? 0,
        total_tokens: usage.totalTokens ?? 0,
      },
    },
    latencyMs,
    requestId,
  };
}

// ── STT / TTS / OCR ─────────────────────────────────────────────────────────

function ensureSttModel(model: IModel) {
  if (model.category !== 'stt') {
    throw new InvalidRequestError('Model is not configured for speech-to-text');
  }
}

function ensureTtsModel(model: IModel) {
  if (model.category !== 'tts') {
    throw new InvalidRequestError('Model is not configured for text-to-speech');
  }
}

function ensureOcrModel(model: IModel) {
  if (model.category !== 'ocr') {
    throw new Error('Model is not configured for OCR');
  }
}

function getOcrMode(model: IModel): 'native' | 'vlm' {
  const settings = (model.settings ?? {}) as Record<string, unknown>;
  const ocrSettings = settings.ocr as Record<string, unknown> | undefined;
  const mode = ocrSettings?.mode;
  if (mode === 'native' || mode === 'vlm') return mode;
  // Default: if provider supports native OCR, prefer native; else vlm.
  return 'native';
}

function ensureSttRuntime(value: unknown): SttRuntime {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid STT runtime.');
  }
  const candidate = value as Partial<SttRuntime>;
  if (typeof candidate.transcribe !== 'function') {
    throw new Error('Model provider returned an invalid STT runtime.');
  }
  return candidate as SttRuntime;
}

function ensureTtsRuntime(value: unknown): TtsRuntime {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid TTS runtime.');
  }
  const candidate = value as Partial<TtsRuntime>;
  if (typeof candidate.synthesize !== 'function') {
    throw new Error('Model provider returned an invalid TTS runtime.');
  }
  return candidate as TtsRuntime;
}

function ensureOcrRuntime(value: unknown): OcrRuntime {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid OCR runtime.');
  }
  const candidate = value as Partial<OcrRuntime>;
  if (typeof candidate.extract !== 'function') {
    throw new Error('Model provider returned an invalid OCR runtime.');
  }
  return candidate as OcrRuntime;
}

export async function handleTranscriptionRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  input: SttTranscribeInput;
  /** When true, calls the provider's translate() instead of transcribe(). */
  translate?: boolean;
  requestId?: string;
  /**
   * Cancels the request (merged with `input.signal`). An aborted call rejects
   * with an `AbortError`, is never retried, does not count against the
   * circuit breaker and logs no usage row — the realtime engine aborts
   * speculative transcriptions that went stale this way.
   */
  signal?: AbortSignal;
}) {
  const { tenantDbName, modelKey, projectId, translate } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();
  const { signal: inputSignal, ...input } = params.input;
  const callerSignals = [params.signal, inputSignal].filter(
    (signal): signal is AbortSignal => signal instanceof AbortSignal,
  );
  const callerSignal =
    callerSignals.length > 1 ? AbortSignal.any(callerSignals) : callerSignals[0];
  const throwIfCallerAborted = () => {
    if (callerSignal?.aborted) throw abortErrorFrom(callerSignal);
  };
  throwIfCallerAborted();

  const model = await getServingModel(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureSttModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createSttRuntime) {
    throw new Error('Model provider does not support speech-to-text');
  }

  const sttRuntime = ensureSttRuntime(
    await runtime.createSttRuntime({
      modelId: model.modelId,
      category: model.category,
      modelSettings: model.settings,
    }),
  );

  const operation = translate ? sttRuntime.translate : sttRuntime.transcribe;
  if (typeof operation !== 'function') {
    throw new Error(
      translate
        ? 'Model provider does not support audio translation'
        : 'Model provider does not support audio transcription',
    );
  }

  throwIfCallerAborted();
  // A caller abort while the request is in flight is not a provider failure
  // (speculative realtime STT is aborted routinely): handing the signal to
  // `withResilience` keeps it out of the retries and out of the circuit
  // breaker's books — neither a failure nor, as an attempt that resolved
  // would be, a success that resets what other callers of the key have
  // recorded. The attempt's own signal aborts with it.
  const result = await withResilience(
    (attemptSignal) =>
      operation.call(sttRuntime, { ...input, signal: attemptSignal } as SttTranscribeInput & SttTranslateInput),
    {
      key: `${translate ? 'stt-translate' : 'stt'}:${model.providerKey}`,
      ...(callerSignal ? { signal: callerSignal } : {}),
    },
  );
  // Transcribed, but the caller has stopped waiting: nothing to hand over.
  throwIfCallerAborted();

  const latencyMs = Date.now() - start;

  const usage: TokenUsage = {
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    totalTokens:
      result.usage?.totalTokens ??
      (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
    inputSeconds: result.usage?.inputSeconds,
  };

  fireAndForget('log-stt-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: translate ? 'audio.translations' : 'audio.transcriptions',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        language: input.language,
        responseFormat: input.responseFormat,
        audioBytes: input.audio.data.byteLength,
      }),
      providerResponse: sanitizeForLogging({
        text: result.text.slice(0, 500),
        language: result.language,
        duration: result.duration,
      }),
      latencyMs,
      usage,
    }),
  );

  return {
    response: {
      text: result.text,
      language: result.language,
      duration: result.duration,
      segments: result.segments,
      words: result.words,
      usage: result.usage,
    },
    rawUsage: result.usage,
    // The normalized usage this function itself billed against above — the
    // one a caller needs to settle a budget with the same numbers that went
    // into the usage-log row, not the provider's raw (differently-shaped)
    // usage object.
    usage,
    latencyMs,
    requestId,
    model,
  };
}

export async function handleSpeechRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  input: TtsSynthesizeInput;
  requestId?: string;
}) {
  const { tenantDbName, modelKey, projectId, input } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();

  const model = await getServingModel(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureTtsModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createTtsRuntime) {
    throw new Error('Model provider does not support text-to-speech');
  }

  const ttsRuntime = ensureTtsRuntime(
    await runtime.createTtsRuntime({
      modelId: model.modelId,
      category: model.category,
      modelSettings: model.settings,
    }),
  );

  const result = await withResilience(
    () => ttsRuntime.synthesize(input),
    { key: `tts:${model.providerKey}` },
  );

  const latencyMs = Date.now() - start;

  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputCharacters: result.usage?.inputCharacters ?? input.text.length,
    outputSeconds: result.usage?.outputSeconds,
  };

  fireAndForget('log-tts-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'audio.speech',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        voice: input.voice,
        format: input.format,
        speed: input.speed,
        characterCount: input.text.length,
      }),
      providerResponse: sanitizeForLogging({
        contentType: result.contentType,
        format: result.format,
        audioBytes: result.audio.byteLength,
      }),
      latencyMs,
      usage,
    }),
  );

  return {
    audio: result.audio,
    contentType: result.contentType,
    format: result.format,
    rawUsage: result.usage,
    // The normalized usage this function itself billed against above — see
    // the matching comment on handleTranscriptionRequest's return.
    usage,
    latencyMs,
    requestId,
    model,
  };
}

/** How a streamed speech request ended — see `handleSpeechStreamRequest`. */
export type SpeechStreamStatus = 'completed' | 'cancelled' | 'error';

export interface SpeechStreamDone {
  /** Audio bytes handed to the consumer (for `pcm`: whole samples only). */
  bytes: number;
  /** Call start → end of the stream (or cancellation). */
  latencyMs: number;
  /** Call start → first audio chunk; null when none arrived. */
  firstByteMs: number | null;
  status: SpeechStreamStatus;
  /** The normalized usage written to the usage log — settle budgets with this. */
  usage: TokenUsage;
}

export interface SpeechStreamResult {
  /** Raw bytes in `format`; a single chunk when the runtime cannot stream. */
  stream: AsyncIterable<Buffer>;
  contentType: string;
  format: TtsOutputFormat;
  /** 24000 for `pcm`; null for container formats. */
  sampleRate: number | null;
  /** False when the runtime has no `synthesizeStream` and `synthesize` was used. */
  streamed: boolean;
  /** Resolves (never rejects) once the stream ended, failed or was cancelled; usage is logged then. */
  done: Promise<SpeechStreamDone>;
  requestId: string;
  model: IModel;
}

/**
 * Streaming counterpart of `handleSpeechRequest`, for the realtime voice
 * engine: the provider's audio is relayed chunk by chunk as it is generated,
 * so playback starts at the first byte instead of after the whole sentence.
 *
 * Failover and retries cover OPENING the stream only (connection, upstream
 * 4xx/5xx before any byte) — once audio has been handed out, a retry would
 * replay the start of the sentence. A runtime without `synthesizeStream`
 * falls back to `synthesize`, delivered as one chunk (`streamed: false`).
 *
 * Cancellation is not an error. Aborting `signal` (or `input.signal`) — a
 * barge-in — cancels the upstream request, ends the stream quietly and
 * resolves `done` with `status: 'cancelled'`; the same happens when the
 * consumer stops iterating early. A consumer must either drain the stream or
 * abort it: an abandoned, never-read stream holds the upstream socket open.
 *
 * Usage is logged once, when the stream ends, on the same `audio.speech` route
 * and with the same character billing as `handleSpeechRequest`. Characters are
 * billed whenever the text reached the provider — also for a cancelled or
 * failed stream, since the provider charges for the request regardless of how
 * much of the audio was read.
 */
export async function handleSpeechStreamRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  input: TtsSynthesizeInput;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<SpeechStreamResult> {
  const { tenantDbName, modelKey, projectId, input } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();

  const model = await getServingModel(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureTtsModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createTtsRuntime) {
    throw new Error('Model provider does not support text-to-speech');
  }

  const ttsRuntime = ensureTtsRuntime(
    await runtime.createTtsRuntime({
      modelId: model.modelId,
      category: model.category,
      modelSettings: model.settings,
    }),
  );

  const synthesizeStream = ttsRuntime.synthesizeStream?.bind(ttsRuntime);
  const streamed = synthesizeStream !== undefined;
  // The same default the OpenAI runtime applies, made explicit so the format
  // reported here is the one the provider was asked for.
  let format: TtsOutputFormat = input.format ?? 'mp3';
  let contentType = format === 'pcm' ? pcmContentType() : ttsMimeType(format);

  // One controller carries every reason to stop the upstream call: the
  // caller's signal(s) and a consumer that stopped reading. The runtime gets it
  // combined with the resilience attempt signal, so a per-attempt timeout still
  // aborts a provider that never answers.
  const abort = new AbortController();
  const callerSignals = [params.signal, input.signal].filter(
    (signal): signal is AbortSignal => signal instanceof AbortSignal,
  );

  let bytes = 0;
  let firstByteMs: number | null = null;
  let dispatched = false;
  let settled = false;
  let providerUsage: { inputCharacters?: number; outputSeconds?: number } | undefined;
  let resolveDone!: (value: SpeechStreamDone) => void;
  const done = new Promise<SpeechStreamDone>((resolve) => {
    resolveDone = resolve;
  });

  const detach = () => {
    for (const signal of callerSignals) signal.removeEventListener('abort', onCallerAbort);
  };

  const finish = (status: SpeechStreamStatus, error?: unknown) => {
    if (settled) return;
    settled = true;
    detach();

    const latencyMs = Date.now() - start;
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputCharacters: dispatched
        ? providerUsage?.inputCharacters ?? input.text.length
        : 0,
      outputSeconds: providerUsage?.outputSeconds,
    };

    if (dispatched) {
      const errorMessage =
        status === 'error'
          ? error instanceof Error
            ? error.message
            : String(error)
          : undefined;
      fireAndForget(
        status === 'cancelled' ? 'log-tts-stream-cancelled' : 'log-tts-stream-usage',
        () =>
          logModelUsage(tenantDbName, model, {
            requestId,
            route: 'audio.speech',
            status: status === 'completed' ? 'success' : status,
            providerRequest: sanitizeForLogging({
              model: modelKey,
              voice: input.voice,
              format,
              speed: input.speed,
              characterCount: input.text.length,
              stream: true,
            }),
            providerResponse: sanitizeForLogging({
              contentType,
              format,
              audioBytes: bytes,
              streamed,
              firstByteMs,
              ...(status === 'cancelled' ? { cancelled: true } : {}),
              ...(errorMessage ? { error: errorMessage } : {}),
            }),
            ...(errorMessage ? { errorMessage } : {}),
            latencyMs,
            usage,
          }),
      );
    }

    resolveDone({ bytes, latencyMs, firstByteMs, status, usage });
  };

  // A barge-in can land while nobody is pulling from the stream (between two
  // reads, or before the first) — settle right away rather than waiting for a
  // read that may never come. The iterator then ends quietly.
  function onCallerAbort() {
    abort.abort();
    finish('cancelled');
  }

  const resultWith = (stream: AsyncIterable<Buffer>): SpeechStreamResult => ({
    stream,
    contentType,
    format,
    sampleRate: format === 'pcm' ? TTS_PCM_SAMPLE_RATE : null,
    streamed,
    done,
    requestId,
    model,
  });
  const cancelledResult = () => {
    finish('cancelled');
    return resultWith((async function* () {})());
  };

  // Cancelled before anything was sent: nothing to bill, nothing to log.
  if (callerSignals.some((signal) => signal.aborted)) return cancelledResult();
  for (const signal of callerSignals) {
    signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  // A caller abort while the request is in flight must not count as a provider
  // failure — barge-ins are routine in a voice session — so `abort.signal` goes
  // to `withResilience` as the call's own cancellation: no retry, and neither a
  // failure nor a success is recorded against the circuit breaker (an attempt
  // that merely resolved would reset the failure count of every other caller
  // of the key). Either call below then rejects with an AbortError, which ends
  // the stream as cancelled.
  //
  // The runtime still gets `abort.signal` combined with the attempt's signal
  // itself: a streamed response outlives its attempt, and must stay abortable
  // after `withResilience` has returned.
  dispatched = true;

  if (!synthesizeStream) {
    let result: TtsResult;
    try {
      result = await withResilience(
        (attemptSignal) =>
          ttsRuntime.synthesize({ ...input, signal: AbortSignal.any([abort.signal, attemptSignal]) }),
        { key: `tts:${model.providerKey}`, signal: abort.signal },
      );
    } catch (error) {
      if (abort.signal.aborted) return cancelledResult();
      // Same as handleSpeechRequest: a request the provider refused is the
      // caller's error to report, not a usage row.
      detach();
      throw error;
    }

    if (abort.signal.aborted) return cancelledResult();

    format = result.format;
    contentType = format === 'pcm' ? pcmContentType() : result.contentType;
    providerUsage = result.usage;
    const audio = format === 'pcm' && result.audio.byteLength % 2 === 1
      ? result.audio.subarray(0, result.audio.byteLength - 1)
      : result.audio;
    bytes = audio.byteLength;
    firstByteMs = bytes > 0 ? Date.now() - start : null;
    finish('completed');

    return resultWith((async function* () {
      if (audio.byteLength > 0 && !abort.signal.aborted) yield audio;
    })());
  }

  let source: AsyncIterable<Uint8Array>;
  try {
    source = await withResilience(
      async (attemptSignal) =>
        synthesizeStream({ ...input, format, signal: AbortSignal.any([abort.signal, attemptSignal]) }),
      { key: `tts-stream:${model.providerKey}`, signal: abort.signal },
    );
  } catch (error) {
    if (abort.signal.aborted) return cancelledResult();
    detach();
    throw error;
  }

  if (abort.signal.aborted) return cancelledResult();

  // Runtimes are asked to keep `pcm` chunks sample-aligned; re-aligning is a
  // no-op for those and protects the realtime encoder from one that does not.
  const chunks: AsyncIterable<Uint8Array> =
    format === 'pcm' ? alignPcm16Chunks(source) : source;

  async function* relay(): AsyncGenerator<Buffer, void, undefined> {
    try {
      for await (const chunk of chunks) {
        if (abort.signal.aborted) break;
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        if (buffer.byteLength === 0) continue;
        if (firstByteMs === null) firstByteMs = Date.now() - start;
        bytes += buffer.byteLength;
        yield buffer;
      }
      finish(abort.signal.aborted ? 'cancelled' : 'completed');
    } catch (error) {
      // The abort we (or the caller) raised surfaces as a failed read; it is
      // the requested outcome, so the stream just ends.
      if (abort.signal.aborted) {
        finish('cancelled');
        return;
      }
      logger.warn('TTS stream failed mid-stream', {
        requestId,
        modelKey,
        bytes,
        error: error instanceof Error ? error.message : String(error),
      });
      finish('error', error);
      throw error;
    } finally {
      if (!settled) {
        // The consumer stopped reading (break / return): stop the provider
        // instead of letting it generate audio nobody plays.
        abort.abort();
        finish('cancelled');
      }
    }
  }

  return resultWith(relay());
}

/** The STT provider has no streaming transcription — use `handleTranscriptionRequest`. */
export class TranscriptionStreamUnsupportedError extends Error {
  constructor(message = 'Model provider does not support streaming transcription') {
    super(message);
    this.name = 'TranscriptionStreamUnsupportedError';
  }
}

/**
 * Streaming counterpart of `handleTranscriptionRequest` (EXPERIMENTAL): one
 * utterance is transcribed while it is spoken, with interim text through
 * `onPartial`. Used by the realtime engine only when a preset sets
 * `stt_mode: 'streaming'`; it falls back to batch transcription on
 * `TranscriptionStreamUnsupportedError` or a failed `finish()`.
 *
 * Usage is logged once per stream, on the `audio.transcriptions` route like
 * the batch call: on `finish()` with the provider's usage, as `cancelled` when
 * the stream is closed or aborted after audio was sent (the audio streamed so
 * far is recorded as `inputSeconds`), as `error` when the provider fails.
 */
export async function handleTranscriptionStreamRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  options: SttStreamOptions;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<{ stream: SttStream; requestId: string; model: IModel }> {
  const { tenantDbName, modelKey, projectId, options } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();

  const model = await getServingModel(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureSttModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createSttRuntime) {
    throw new Error('Model provider does not support speech-to-text');
  }

  const sttRuntime = ensureSttRuntime(
    await runtime.createSttRuntime({
      modelId: model.modelId,
      category: model.category,
      modelSettings: model.settings,
    }),
  );

  if (typeof sttRuntime.createStream !== 'function') {
    throw new TranscriptionStreamUnsupportedError();
  }

  const signals = [params.signal, options.signal].filter(
    (signal): signal is AbortSignal => signal instanceof AbortSignal,
  );
  const signal =
    signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  const inner = await sttRuntime.createStream({ ...options, signal });

  let pushedSamples = 0;
  let logged = false;
  let finishing: Promise<SttResult> | null = null;

  const providerRequest = () =>
    sanitizeForLogging({
      model: modelKey,
      language: options.language,
      sampleRate: options.sampleRate,
      audioSeconds: pushedSamples / options.sampleRate,
      stream: true,
    });

  const logOnce = (
    status: 'success' | 'cancelled' | 'error',
    usage: TokenUsage,
    providerResponse: unknown,
    errorMessage?: string,
  ) => {
    if (logged) return;
    logged = true;
    signal?.removeEventListener('abort', onAbort);
    fireAndForget(`log-stt-stream-${status}`, () =>
      logModelUsage(tenantDbName, model, {
        requestId,
        route: 'audio.transcriptions',
        status,
        providerRequest: providerRequest(),
        providerResponse: sanitizeForLogging(providerResponse),
        ...(errorMessage ? { errorMessage } : {}),
        latencyMs: Date.now() - start,
        usage,
      }),
    );
  };

  const logCancelled = () => {
    // Nothing reached the provider — nothing to record.
    if (pushedSamples === 0) {
      logged = true;
      signal?.removeEventListener('abort', onAbort);
      return;
    }
    logOnce(
      'cancelled',
      { inputSeconds: pushedSamples / options.sampleRate },
      { cancelled: true },
    );
  };

  function onAbort() {
    if (!finishing) logCancelled();
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  const stream: SttStream = {
    push(pcm16) {
      if (!finishing && !logged) pushedSamples += pcm16.length;
      inner.push(pcm16);
    },

    finish() {
      if (finishing) return finishing;
      finishing = (async () => {
        try {
          const result = await inner.finish();
          const usage: TokenUsage = {
            inputTokens: result.usage?.inputTokens ?? 0,
            outputTokens: result.usage?.outputTokens ?? 0,
            totalTokens:
              result.usage?.totalTokens ??
              (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
            inputSeconds: result.usage?.inputSeconds,
          };
          if (pushedSamples > 0) {
            logOnce('success', usage, {
              text: result.text.slice(0, 500),
              language: result.language,
              duration: result.duration,
            });
          } else {
            logCancelled();
          }
          return result;
        } catch (error) {
          if ((error instanceof Error && error.name === 'AbortError') || signal?.aborted) {
            logCancelled();
          } else {
            const message = error instanceof Error ? error.message : String(error);
            logOnce('error', {}, { error: message }, message);
          }
          throw error;
        }
      })();
      return finishing;
    },

    onPartial(cb) {
      inner.onPartial(cb);
    },

    close() {
      if (!finishing) logCancelled();
      inner.close();
    },
  };

  return { stream, requestId, model };
}

/**
 * `POST /v1/images/generations`.
 *
 * Same shape as the other non-chat handlers: resolve the model, build the
 * provider runtime, run it under the shared resilience wrapper, and log usage.
 * Image models bill per IMAGE rather than per token, so `usage.images` is what
 * the usage row carries; token counts are recorded only when the upstream
 * reports them (gpt-image does, dall-e does not).
 */
export async function handleImageRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  input: ImageGenerateInput;
  requestId?: string;
}) {
  const { tenantDbName, modelKey, projectId, input } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();

  const model = await getServingModel(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureImageModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createImageRuntime) {
    throw new Error('Model provider does not support image generation');
  }

  const imageRuntime = await runtime.createImageRuntime({
    modelId: model.modelId,
    category: model.category,
    modelSettings: model.settings,
  });

  const result = await withResilience(
    () => imageRuntime.generate(input),
    { key: `image:${model.providerKey}:${model.modelId}` },
  );

  const latencyMs = Date.now() - start;

  fireAndForget('log-image-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'images.generations',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        n: input.n,
        size: input.size,
        quality: input.quality,
        promptCharacters: input.prompt.length,
      }),
      // The base64 payload is megabytes; only its shape is worth a trace row.
      providerResponse: sanitizeForLogging({
        images: result.images.length,
        withUrl: result.images.filter((image) => Boolean(image.url)).length,
        revisedPrompt: result.images[0]?.revisedPrompt,
      }),
      latencyMs,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens: result.usage?.totalTokens ?? 0,
        images: result.usage?.images ?? result.images.length,
      },
    }),
  );

  return {
    response: {
      created: Math.floor(Date.now() / 1000),
      data: result.images.map((image) => ({
        ...(image.b64Json !== undefined ? { b64_json: image.b64Json } : {}),
        ...(image.url !== undefined ? { url: image.url } : {}),
        ...(image.revisedPrompt !== undefined ? { revised_prompt: image.revisedPrompt } : {}),
      })),
      usage: result.usage,
    },
    latencyMs,
    requestId,
    model,
  };
}

/**
 * Native moderation: one call to a purpose-built classifier.
 *
 * The guardrail engine's LLM-judge path stays where it is — this is the other
 * half of the story (see `providers/domains/moderation.ts`), used both by
 * `/v1/moderations` when the caller names a moderation MODEL and by a guardrail
 * whose moderation policy selects the model detector.
 */
export async function handleModerationRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  texts: string[];
  requestId?: string;
}) {
  const { tenantDbName, modelKey, projectId, texts } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();

  const model = await getServingModel(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureModerationModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createModerationRuntime) {
    throw new Error('Model provider does not support moderation');
  }

  const moderationRuntime = await runtime.createModerationRuntime({
    modelId: model.modelId,
    category: model.category,
    modelSettings: model.settings,
  });

  const result = await withResilience(
    () => moderationRuntime.classify(texts),
    { key: `moderation:${model.providerKey}:${model.modelId}` },
  );

  const latencyMs = Date.now() - start;

  fireAndForget('log-moderation-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'moderations',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        inputs: texts.length,
        characters: texts.reduce((total, text) => total + text.length, 0),
      }),
      // The texts themselves are the thing being moderated; only the verdict
      // shape belongs in a trace row.
      providerResponse: sanitizeForLogging({
        results: result.results.length,
        flagged: result.results.filter((entry) => entry.flagged).length,
      }),
      latencyMs,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: 0,
        totalTokens: result.usage?.totalTokens ?? result.usage?.inputTokens ?? 0,
      },
    }),
  );

  return { result, latencyMs, requestId, model };
}

export async function handleOcrRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  input: OcrExtractInput;
  requestId?: string;
}) {
  const { tenantDbName, modelKey, projectId, input } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();

  const model = await getServingModel(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureOcrModel(model);

  const mode = getOcrMode(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createOcrRuntime) {
    throw new Error('Model provider does not support OCR');
  }

  // The OCR factory itself decides native vs VLM based on the contract. We pass
  // the requested mode through modelSettings.ocr.mode so VLM-only providers can
  // refuse a native request explicitly if they wanted to.
  const ocrSettings = {
    ...((model.settings ?? {}) as Record<string, unknown>),
    ocr: {
      ...(((model.settings ?? {}) as Record<string, unknown>).ocr as
        | Record<string, unknown>
        | undefined),
      mode,
    },
  };

  const ocrRuntime = ensureOcrRuntime(
    await runtime.createOcrRuntime({
      modelId: model.modelId,
      category: model.category,
      modelSettings: ocrSettings,
    }),
  );

  const result: OcrResult = await withResilience(
    () => ocrRuntime.extract(input),
    { key: `ocr:${model.providerKey}` },
  );

  const latencyMs = Date.now() - start;

  // VLM OCR bills like a chat call: the cached read/write slice and the reasoning are
  // subsets the cost needs.
  const ocrUsage = result.usage;
  const usage: TokenUsage = {
    inputTokens: ocrUsage?.inputTokens ?? 0,
    outputTokens: ocrUsage?.outputTokens ?? 0,
    totalTokens:
      ocrUsage?.totalTokens ??
      (ocrUsage?.inputTokens ?? 0) + (ocrUsage?.outputTokens ?? 0),
    pages: ocrUsage?.pages,
    ...(ocrUsage?.cachedInputTokens ? { cachedInputTokens: ocrUsage.cachedInputTokens } : {}),
    ...(ocrUsage?.cachedWriteTokens ? { cachedWriteTokens: ocrUsage.cachedWriteTokens } : {}),
    ...(ocrUsage?.reasoningTokens ? { reasoningTokens: ocrUsage.reasoningTokens } : {}),
  };

  fireAndForget('log-ocr-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'ocr',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        mode,
        documentKind: input.document.kind,
        documentBytes:
          input.document.kind === 'bytes' ? input.document.data.byteLength : undefined,
        documentUrl: input.document.kind === 'url' ? input.document.url : undefined,
        pages: input.pages,
        features: input.features,
      }),
      providerResponse: sanitizeForLogging({
        text: result.text.slice(0, 500),
        pageCount: result.pages?.length,
        tableCount: result.tables?.length,
        invokedVia: result.invokedVia,
      }),
      latencyMs,
      usage,
    }),
  );

  return {
    response: {
      text: result.text,
      pages: result.pages,
      tables: result.tables,
      keyValuePairs: result.keyValuePairs,
      language: result.language,
      invokedVia: result.invokedVia ?? mode,
      usage: result.usage,
    },
    // The normalized usage this function itself billed against above — see
    // the matching comment on handleTranscriptionRequest's return.
    usage,
    latencyMs,
    requestId,
    model,
  };
}
