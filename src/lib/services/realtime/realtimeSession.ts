/**
 * Realtime session – one instance per websocket connection.
 *
 * Implements a simplified OpenAI-Realtime-style event protocol over any
 * message transport (the API plugin wires it to a websocket):
 *
 *   client → server: session.update, conversation.item.create,
 *                    input_audio_buffer.append/clear/commit,
 *                    response.create, response.cancel
 *   server → client: session.created/updated, conversation.item.created,
 *                    input_audio_buffer.committed, response.created,
 *                    response.output_text.delta/done,
 *                    response.audio.delta/done, response.done, error
 *
 * Latency posture:
 *  - text deltas stream straight off the chat-completion SSE stream;
 *  - TTS is sentence-chunked: synthesis starts on the first completed
 *    sentence while the model is still generating (see SentenceChunker);
 *  - model runtimes are pre-warmed into the runtime pool the moment the
 *    session learns which models it will use, so the first response never
 *    pays the SDK-construction cost.
 *
 * Every connection writes a `realtime_sessions` log row (fire-and-forget)
 * for the dashboard: response counts, token usage, audio seconds, first
 * token latency, duration, and final status.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { fireAndForget } from '@/lib/core/asyncTask';
import type { IRealtimeModel, RealtimeSessionTransport } from '@/lib/database';
import {
  GuardrailBlockError,
  handleChatCompletion,
  handleSpeechRequest,
  handleTranscriptionRequest,
} from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { calculateCost } from '@/lib/services/models/usageLogger';
import { checkBudget, checkRateLimit } from '@/lib/quota/quotaGuard';
import { SentenceChunker } from './sentenceChunker';
import { RealtimeSessionLogger } from './sessionLogger';
import type {
  RealtimeClientEvent,
  RealtimeContext,
  RealtimeMessage,
  RealtimeSender,
  RealtimeSessionConfig,
} from './types';

const logger = createLogger('realtime:session');

/** Max buffered input audio per commit (env-overridable, default 25 MB). */
const MAX_AUDIO_BUFFER_BYTES = Math.max(
  1024,
  Number(process.env.REALTIME_MAX_AUDIO_BYTES ?? 25 * 1024 * 1024) || 25 * 1024 * 1024,
);

/** Max retained conversation messages (oldest user/assistant turns drop first). */
const MAX_HISTORY_MESSAGES = Math.max(
  4,
  Number(process.env.REALTIME_MAX_HISTORY ?? 200) || 200,
);

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Extract plain text from an item's `content` (string or content parts). */
function extractItemText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** Parse an OpenAI-format SSE stream, invoking onDelta per text delta. */
export async function consumeChatSseStream(
  stream: ReadableStream<Uint8Array>,
  handlers: {
    onDelta: (text: string) => void;
    isCancelled: () => boolean;
  },
): Promise<{ text: string; usage?: Record<string, number>; cancelled: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage: Record<string, number> | undefined;
  let cancelled = false;

  try {
    for (;;) {
      if (handlers.isCancelled()) {
        cancelled = true;
        await reader.cancel();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        separatorIndex = buffer.indexOf('\n\n');

        for (const line of rawEvent.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const chunk = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: unknown } }>;
              usage?: Record<string, number>;
            };
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              text += delta;
              handlers.onDelta(delta);
            }
            if (chunk.usage) usage = chunk.usage;
          } catch {
            // Ignore malformed keep-alive/comment frames.
          }
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  return { text, usage, cancelled };
}

export interface RealtimeSessionOptions {
  /** Transport label for the session log (default 'websocket'). */
  transport?: RealtimeSessionTransport;
  /** Named realtime model preset applied as the initial config. */
  realtimeModel?: IRealtimeModel | null;
  /** Raw initial config (used when no preset matched). */
  initialConfig?: Partial<RealtimeSessionConfig>;
  clientInfo?: Record<string, unknown>;
}

export class RealtimeSession {
  readonly id = `rt_${randomUUID()}`;

  private readonly ctx: RealtimeContext;
  private readonly send: RealtimeSender;
  private readonly log: RealtimeSessionLogger;
  private config: RealtimeSessionConfig = {
    inputAudioFormat: 'audio/webm',
    ttsFormat: 'mp3',
  };

  private messages: RealtimeMessage[] = [];
  private audioChunks: Buffer[] = [];
  private audioBytes = 0;
  private activeResponseId: string | null = null;
  private cancelRequested = false;
  private closed = false;
  private prewarmedModels = new Set<string>();

  constructor(ctx: RealtimeContext, send: RealtimeSender, options?: RealtimeSessionOptions) {
    this.ctx = ctx;
    this.send = send;

    const preset = options?.realtimeModel;
    if (preset) {
      this.config = {
        ...this.config,
        model: preset.chatModelKey,
        instructions: preset.instructions,
        temperature: preset.temperature,
        maxOutputTokens: preset.maxOutputTokens,
        transcriptionModel: preset.sttModelKey,
        inputAudioFormat: preset.inputAudioFormat ?? this.config.inputAudioFormat,
        ttsModel: preset.ttsModelKey,
        voice: preset.voice,
        ttsFormat: (preset.ttsFormat as RealtimeSessionConfig['ttsFormat']) ?? this.config.ttsFormat,
      };
    }
    if (options?.initialConfig) {
      this.config = { ...this.config, ...options.initialConfig };
    }

    this.log = new RealtimeSessionLogger(ctx, {
      sessionId: this.id,
      transport: options?.transport ?? 'websocket',
      realtimeModelKey: preset?.key,
      chatModelKey: this.config.model,
      clientInfo: options?.clientInfo,
    });

    this.prewarmRuntimes();
    this.emit({ type: 'session.created', session: this.sessionView() });
  }

  /** Latest applied config (used by transport bridges). */
  getConfig(): Readonly<RealtimeSessionConfig> {
    return this.config;
  }

  close(status: 'ended' | 'error' = 'ended', errorMessage?: string): void {
    this.closed = true;
    this.cancelRequested = true;
    this.log.finalize(status, errorMessage);
  }

  /** Entry point for every parsed client event. */
  async handleEvent(event: RealtimeClientEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'session.update':
          this.applySessionUpdate(event.session ?? {});
          this.prewarmRuntimes();
          this.emit({ type: 'session.updated', session: this.sessionView() });
          return;
        case 'conversation.item.create':
          this.handleItemCreate(event.item ?? {});
          return;
        case 'input_audio_buffer.append':
          this.appendAudio(event.audio);
          return;
        case 'input_audio_buffer.clear':
          this.audioChunks = [];
          this.audioBytes = 0;
          this.emit({ type: 'input_audio_buffer.cleared' });
          return;
        case 'input_audio_buffer.commit':
          await this.commitAudio();
          return;
        case 'response.create':
          await this.createResponse(event.response ?? {});
          return;
        case 'response.cancel':
          this.cancelRequested = true;
          return;
        default:
          this.emitError(`Unknown event type: ${(event as { type?: string }).type ?? 'undefined'}`, 'unknown_event');
      }
    } catch (error) {
      logger.error('Realtime event failed', { error, sessionId: this.id });
      this.emitError(error instanceof Error ? error.message : 'Internal error');
    }
  }

  /**
   * Transport-bridge helper: push a user turn and generate the response in
   * one call (used by the Twilio bridge after turn detection).
   */
  async respondToUserText(text: string): Promise<void> {
    this.pushMessage({ role: 'user', content: text });
    await this.createResponse({});
  }

  /**
   * Transport-bridge helper: speak a fixed line (e.g. a telephony greeting)
   * through the configured TTS without involving the chat model. The text is
   * recorded as an assistant turn so the model knows it was said.
   */
  async speak(text: string): Promise<void> {
    if (!this.config.ttsModel || !this.config.voice) return;
    this.pushMessage({ role: 'assistant', content: text });
    const responseId = `resp_${randomUUID()}`;
    await this.synthesizeChunk(responseId, text);
    this.emit({ type: 'response.audio.done', response_id: responseId });
  }

  /** Whether a response is currently being generated (barge-in detection). */
  isResponding(): boolean {
    return this.activeResponseId !== null;
  }

  /** Request cancellation of the in-flight response (barge-in). */
  cancelActiveResponse(): void {
    if (this.activeResponseId) this.cancelRequested = true;
  }

  // ── Latency: pre-warm provider runtimes ─────────────────────────────

  /**
   * Build the LangChain runtimes for the session's models ahead of first
   * use. `buildModelRuntime` caches per provider+credentials in the runtime
   * pool, so the first real request skips SDK construction entirely.
   */
  private prewarmRuntimes(): void {
    const keys = [this.config.model, this.config.transcriptionModel, this.config.ttsModel]
      .filter((key): key is string => Boolean(key))
      .filter((key) => !this.prewarmedModels.has(key));
    for (const key of keys) {
      this.prewarmedModels.add(key);
      fireAndForget('realtime-prewarm', async () => {
        try {
          const model = await getModelByKey(this.ctx.tenantDbName, key, this.ctx.projectId ?? '');
          if (!model) return;
          await buildModelRuntime(
            this.ctx.tenantDbName,
            model.tenantId,
            model.providerKey,
            this.ctx.projectId ?? '',
          );
        } catch (error) {
          logger.debug?.('Realtime prewarm failed', { error, modelKey: key });
        }
      });
    }
  }

  // ── Session config ──────────────────────────────────────────────────

  private applySessionUpdate(patch: Record<string, unknown>): void {
    const next: RealtimeSessionConfig = { ...this.config };
    const model = asString(patch.model);
    if (model) next.model = model;
    if (patch.instructions !== undefined) next.instructions = asString(patch.instructions);
    if (patch.temperature !== undefined) next.temperature = asNumber(patch.temperature);
    const maxTokens = patch.max_output_tokens ?? patch.maxOutputTokens;
    if (maxTokens !== undefined) next.maxOutputTokens = asNumber(maxTokens);
    const sttModel = patch.transcription_model ?? patch.transcriptionModel;
    if (sttModel !== undefined) next.transcriptionModel = asString(sttModel);
    const inputFormat = patch.input_audio_format ?? patch.inputAudioFormat;
    if (inputFormat !== undefined) next.inputAudioFormat = asString(inputFormat) ?? next.inputAudioFormat;
    const ttsModel = patch.tts_model ?? patch.ttsModel;
    if (ttsModel !== undefined) next.ttsModel = asString(ttsModel);
    if (patch.voice !== undefined) next.voice = asString(patch.voice);
    const ttsFormat = patch.tts_format ?? patch.ttsFormat;
    if (ttsFormat !== undefined) {
      next.ttsFormat = (asString(ttsFormat) as RealtimeSessionConfig['ttsFormat']) ?? next.ttsFormat;
    }
    if (next.model && next.model !== this.config.model) {
      this.log.setChatModel(next.model);
    }
    this.config = next;
  }

  private sessionView(): Record<string, unknown> {
    return {
      id: this.id,
      model: this.config.model ?? null,
      instructions: this.config.instructions ?? null,
      temperature: this.config.temperature ?? null,
      max_output_tokens: this.config.maxOutputTokens ?? null,
      transcription_model: this.config.transcriptionModel ?? null,
      input_audio_format: this.config.inputAudioFormat ?? null,
      tts_model: this.config.ttsModel ?? null,
      voice: this.config.voice ?? null,
      tts_format: this.config.ttsFormat ?? null,
    };
  }

  // ── Conversation items ──────────────────────────────────────────────

  private handleItemCreate(item: Record<string, unknown>): void {
    const role = asString(item.role) ?? 'user';
    if (role !== 'user' && role !== 'system' && role !== 'assistant') {
      this.emitError('item.role must be user, system, or assistant', 'invalid_item');
      return;
    }
    const text = extractItemText(item.content);
    if (!text) {
      this.emitError('item.content must contain text', 'invalid_item');
      return;
    }
    this.pushMessage({ role, content: text });
    this.emit({
      type: 'conversation.item.created',
      item: { id: `item_${randomUUID()}`, role, content: text },
    });
  }

  private pushMessage(message: RealtimeMessage): void {
    this.messages.push(message);
    if (this.messages.length > MAX_HISTORY_MESSAGES) {
      this.messages = this.messages.slice(this.messages.length - MAX_HISTORY_MESSAGES);
    }
  }

  // ── Audio input ─────────────────────────────────────────────────────

  private appendAudio(audio: string): void {
    if (typeof audio !== 'string' || audio.length === 0) {
      this.emitError('input_audio_buffer.append requires base64 `audio`', 'invalid_audio');
      return;
    }
    let chunk: Buffer;
    try {
      chunk = Buffer.from(audio, 'base64');
    } catch {
      this.emitError('`audio` is not valid base64', 'invalid_audio');
      return;
    }
    if (this.audioBytes + chunk.length > MAX_AUDIO_BUFFER_BYTES) {
      this.emitError(`Audio buffer exceeds ${MAX_AUDIO_BUFFER_BYTES} bytes`, 'audio_buffer_full');
      return;
    }
    this.audioChunks.push(chunk);
    this.audioBytes += chunk.length;
  }

  private async commitAudio(): Promise<void> {
    if (this.audioBytes === 0) {
      this.emitError('Audio buffer is empty', 'audio_buffer_empty');
      return;
    }
    const modelKey = this.config.transcriptionModel;
    if (!modelKey) {
      this.emitError('Set `transcription_model` via session.update before committing audio', 'config_missing');
      return;
    }

    const audio = Buffer.concat(this.audioChunks);
    this.audioChunks = [];
    this.audioBytes = 0;

    const transcript = await this.transcribe(modelKey, audio, this.config.inputAudioFormat);
    this.emit({
      type: 'input_audio_buffer.committed',
      transcript: transcript.text,
      language: transcript.language ?? null,
      duration: transcript.duration ?? null,
    });
  }

  /** Shared STT path (websocket commits + telephony bridge turns). */
  async transcribe(
    modelKey: string,
    audio: Buffer,
    contentType?: string,
    fileName = 'realtime-input',
  ): Promise<{ text: string; language?: string; duration?: number }> {
    const result = await handleTranscriptionRequest({
      tenantDbName: this.ctx.tenantDbName,
      modelKey,
      projectId: this.ctx.projectId ?? '',
      input: {
        audio: { data: audio, fileName, contentType },
      },
    });
    const text = result.response.text ?? '';
    if (text) this.pushMessage({ role: 'user', content: text });
    if (result.response.duration) {
      this.log.increment({ inputAudioSeconds: result.response.duration });
    }
    return {
      text,
      language: result.response.language,
      duration: result.response.duration,
    };
  }

  // ── Response generation ─────────────────────────────────────────────

  private async createResponse(overrides: Record<string, unknown>): Promise<void> {
    if (this.activeResponseId) {
      this.emitError('A response is already in progress', 'response_in_progress');
      return;
    }
    const modelKey = this.config.model;
    if (!modelKey) {
      this.emitError('Set `model` via session.update before creating a response', 'config_missing');
      return;
    }
    if (this.messages.length === 0) {
      this.emitError('Conversation is empty; create an item or commit audio first', 'conversation_empty');
      return;
    }

    const responseId = `resp_${randomUUID()}`;
    this.activeResponseId = responseId;
    this.cancelRequested = false;
    this.emit({ type: 'response.created', response: { id: responseId } });
    const responseStart = Date.now();

    try {
      const quotaContext = this.ctx.licenseType
        ? {
            domain: 'llm' as const,
            licenseType: this.ctx.licenseType,
            projectId: this.ctx.projectId ?? '',
            resourceKey: modelKey,
            tenantDbName: this.ctx.tenantDbName,
            tenantId: this.ctx.tenantId,
            tokenId: this.ctx.tokenId,
            userId: this.ctx.userId,
          }
        : null;
      if (quotaContext) {
        const [rate, budget] = await Promise.all([
          checkRateLimit(quotaContext, { requests: 1 }),
          checkBudget(quotaContext),
        ]);
        const denied = !rate.allowed ? rate : !budget.allowed ? budget : null;
        if (denied) {
          this.emitError(denied.reason ?? 'Quota exceeded', 'quota_exceeded');
          return;
        }
      }

      const instructions = asString(overrides.instructions) ?? this.config.instructions;
      const body: Record<string, unknown> = {
        messages: [
          ...(instructions ? [{ role: 'system', content: instructions }] : []),
          ...this.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
        stream: true,
      };
      if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
      if (this.config.maxOutputTokens !== undefined) body.max_tokens = this.config.maxOutputTokens;

      const result = await handleChatCompletion({
        tenantDbName: this.ctx.tenantDbName,
        tenantId: this.ctx.tenantId,
        modelKey,
        projectId: this.ctx.projectId ?? '',
        body,
        stream: true,
      });

      // Sentence-chunked TTS: synthesis starts on the first completed
      // sentence while the chat stream is still running. Chunks are
      // serialized so audio arrives in order.
      const speak = Boolean(this.config.ttsModel && this.config.voice);
      const chunker = speak ? new SentenceChunker() : null;
      let ttsChain: Promise<void> = Promise.resolve();
      const enqueueSpeech = (sentence: string) => {
        ttsChain = ttsChain.then(() => this.synthesizeChunk(responseId, sentence));
      };

      let firstDelta = true;
      let text = '';
      let usage: Record<string, number> | undefined;
      let cancelled = false;

      if (result.stream) {
        const consumed = await consumeChatSseStream(result.stream, {
          onDelta: (delta) => {
            if (firstDelta) {
              firstDelta = false;
              this.log.setFirstTokenLatency(Date.now() - responseStart);
            }
            this.emit({ type: 'response.output_text.delta', response_id: responseId, delta });
            if (chunker) {
              for (const sentence of chunker.push(delta)) enqueueSpeech(sentence);
            }
          },
          isCancelled: () => this.cancelRequested || this.closed,
        });
        text = consumed.text;
        usage = consumed.usage;
        cancelled = consumed.cancelled;
      } else if (result.response) {
        // Some providers may answer non-streaming even when asked to stream.
        const content = (result.response as {
          choices?: Array<{ message?: { content?: unknown } }>;
        }).choices?.[0]?.message?.content;
        text = typeof content === 'string' ? content : '';
        if (text) {
          this.log.setFirstTokenLatency(Date.now() - responseStart);
          this.emit({ type: 'response.output_text.delta', response_id: responseId, delta: text });
          if (chunker) {
            for (const sentence of chunker.push(text)) enqueueSpeech(sentence);
          }
        }
        usage = result.usage as unknown as Record<string, number> | undefined;
      }

      if (text) this.pushMessage({ role: 'assistant', content: text });
      this.emit({ type: 'response.output_text.done', response_id: responseId, text });

      if (chunker && !cancelled) {
        const rest = chunker.flush();
        if (rest) enqueueSpeech(rest);
        await ttsChain;
        this.emit({ type: 'response.audio.done', response_id: responseId });
      }

      const normalizedUsage = usage
        ? {
            usageInputTokens: usage.inputTokens ?? usage.prompt_tokens ?? 0,
            usageOutputTokens: usage.outputTokens ?? usage.completion_tokens ?? 0,
            usageTotalTokens: usage.totalTokens ?? usage.total_tokens ?? 0,
          }
        : {};
      this.log.increment({ responseCount: 1, ...normalizedUsage });

      if (quotaContext && usage) {
        void this.consumeBudget(quotaContext, modelKey, usage);
      }

      this.emit({
        type: 'response.done',
        response_id: responseId,
        status: cancelled ? 'cancelled' : 'completed',
        usage: usage ?? null,
      });
    } catch (error) {
      if (error instanceof GuardrailBlockError) {
        this.emit({
          type: 'response.done',
          response_id: responseId,
          status: 'blocked',
          error: { message: error.message, code: 'guardrail_block', findings: error.findings },
        });
        return;
      }
      logger.error('Realtime response failed', { error, sessionId: this.id });
      this.emit({
        type: 'response.done',
        response_id: responseId,
        status: 'failed',
        error: { message: error instanceof Error ? error.message : 'Response failed' },
      });
    } finally {
      this.activeResponseId = null;
      this.cancelRequested = false;
    }
  }

  private async synthesizeChunk(responseId: string, text: string): Promise<void> {
    if (this.cancelRequested || this.closed) return;
    try {
      const result = await handleSpeechRequest({
        tenantDbName: this.ctx.tenantDbName,
        modelKey: this.config.ttsModel!,
        projectId: this.ctx.projectId ?? '',
        input: {
          text,
          voice: this.config.voice!,
          format: this.config.ttsFormat,
        },
      });
      this.emit({
        type: 'response.audio.delta',
        response_id: responseId,
        audio: result.audio.toString('base64'),
        content_type: result.contentType,
        text,
      });
    } catch (error) {
      logger.error('Realtime TTS failed', { error, sessionId: this.id });
      this.emitError(error instanceof Error ? error.message : 'Speech synthesis failed', 'tts_failed');
    }
  }

  private async consumeBudget(
    quotaContext: NonNullable<Parameters<typeof checkBudget>[0]>,
    modelKey: string,
    usage: Record<string, number>,
  ): Promise<void> {
    try {
      const model = await getModelByKey(this.ctx.tenantDbName, modelKey, this.ctx.projectId ?? '');
      if (!model) return;
      const normalized = {
        inputTokens: usage.inputTokens ?? usage.prompt_tokens ?? 0,
        outputTokens: usage.outputTokens ?? usage.completion_tokens ?? 0,
        totalTokens: usage.totalTokens ?? usage.total_tokens ?? 0,
      };
      const cost = calculateCost(model.pricing, normalized);
      if (cost.currency === 'USD' && Number.isFinite(cost.totalCost) && cost.totalCost > 0) {
        await checkBudget(quotaContext, { usd: cost.totalCost });
      }
    } catch (error) {
      logger.warn('Realtime budget usage update failed', { error, sessionId: this.id });
    }
  }

  // ── Emit helpers ────────────────────────────────────────────────────

  private emit(event: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.send({ event_id: `evt_${randomUUID()}`, ...event });
    } catch (error) {
      logger.warn('Realtime send failed', { error, sessionId: this.id });
    }
  }

  private emitError(message: string, code = 'invalid_request'): void {
    this.emit({ type: 'error', error: { message, code } });
  }
}
