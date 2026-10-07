import WebSocket from 'ws';
import { LinearPcm16Resampler } from './audioStream';
import type { SttResult, SttStream, SttStreamOptions, SttUsage } from '../domains/audio';

/**
 * Streaming speech-to-text over OpenAI's Realtime API in a dedicated
 * TRANSCRIPTION session (EXPERIMENTAL).
 *
 * Protocol (OpenAI GA Realtime API — "Realtime transcription" guide and the
 * Realtime reference; the connection URL is the one OpenAI's own Agents SDK
 * opens for streamed STT):
 *
 *   connect  wss://api.openai.com/v1/realtime?intent=transcription
 *            (Authorization: Bearer …)
 *   ←        session.created
 *   →        session.update { session: { type: 'transcription', audio: { input: {
 *              format: { type: 'audio/pcm', rate: 24000 },
 *              transcription: { model, language | languages, prompt },
 *              turn_detection: null } } } }
 *   ←        session.updated
 *   →        input_audio_buffer.append { audio: <base64 s16le 24 kHz mono> } …
 *   →        input_audio_buffer.commit { event_id }
 *   ←        input_audio_buffer.committed { item_id }
 *   ←        conversation.item.input_audio_transcription.delta { item_id, delta } …
 *   ←        conversation.item.input_audio_transcription.completed { item_id, transcript, usage }
 *            | conversation.item.input_audio_transcription.failed { item_id, error }
 *            | error { error: { code, message, event_id } }
 *
 * Turn detection is off: the voice engine owns end-of-turn (Silero VAD +
 * Smart Turn), so one stream is one utterance and `finish()` is the commit.
 * Transcription sessions take 24 kHz PCM only — 16 kHz input is resampled here.
 */

/** OpenAI's endpoint for a dedicated transcription session. */
export const OPENAI_REALTIME_TRANSCRIPTION_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

/** Transcription sessions accept PCM at this rate only. */
export const REALTIME_TRANSCRIPTION_SAMPLE_RATE = 24000;

/** Models that take `languages: [...]` instead of the singular `language`. */
const MODELS_WITH_LANGUAGES = new Set(['gpt-transcribe', 'gpt-live-transcribe']);

/** Models that reject `prompt` in a GA transcription session. */
const MODELS_WITHOUT_PROMPT = new Set(['gpt-realtime-whisper']);

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_FINISH_TIMEOUT_MS = 15_000;

export interface OpenAiRealtimeTranscriptionClientOptions {
  /** Full WebSocket URL, e.g. `wss://api.openai.com/v1/realtime?intent=transcription`. */
  url: string;
  /** Handshake headers (auth, organization). */
  headers: Record<string, string>;
  /** Transcription model id (`gpt-4o-mini-transcribe`, `gpt-live-transcribe`, …). */
  modelId: string;
  /** Socket open → session configured. */
  connectTimeoutMs?: number;
  /** `finish()` → final transcript. */
  finishTimeoutMs?: number;
}

/** The `session.update` that turns the connection into a manual-commit transcription session. */
export function buildTranscriptionSessionUpdate(
  modelId: string,
  opts: { language?: string; prompt?: string },
): Record<string, unknown> {
  const transcription: Record<string, unknown> = { model: modelId };
  if (opts.language) {
    if (MODELS_WITH_LANGUAGES.has(modelId)) transcription.languages = [opts.language];
    else transcription.language = opts.language;
  }
  if (opts.prompt && !MODELS_WITHOUT_PROMPT.has(modelId)) {
    transcription.prompt = opts.prompt;
  }
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: REALTIME_TRANSCRIPTION_SAMPLE_RATE },
          transcription,
          turn_detection: null,
        },
      },
    },
  };
}

/** Maps the completed event's `usage` (token- or duration-billed) onto `SttUsage`. */
export function mapRealtimeTranscriptionUsage(raw: unknown, durationSec: number): SttUsage {
  const usage = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  const num = (value: unknown) => (typeof value === 'number' ? value : undefined);
  if (usage?.type === 'duration') {
    return { inputSeconds: num(usage.seconds) ?? durationSec };
  }
  if (usage?.type === 'tokens' || usage?.input_tokens !== undefined) {
    return {
      inputSeconds: durationSec,
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      totalTokens: num(usage.total_tokens),
    };
  }
  return { inputSeconds: durationSec };
}

function abortError(): Error {
  const error = new Error('Transcription stream was closed');
  error.name = 'AbortError';
  return error;
}

function eventError(prefix: string, error: unknown): Error {
  const details = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const message = typeof details.message === 'string' ? details.message : 'unknown error';
  const wrapped = new Error(`${prefix}: ${message}`) as Error & { code?: string };
  if (typeof details.code === 'string') wrapped.code = details.code;
  return wrapped;
}

export function createOpenAiRealtimeTranscriptionStream(
  client: OpenAiRealtimeTranscriptionClientOptions,
  opts: SttStreamOptions,
): SttStream {
  const resampler = new LinearPcm16Resampler(opts.sampleRate, REALTIME_TRANSCRIPTION_SAMPLE_RATE);
  const partialListeners: Array<(text: string, delta: string) => void> = [];

  let ready = false;
  let closed = false;
  let settled = false;
  let failure: Error | null = null;
  let finishing: Promise<SttResult> | null = null;
  let resolveFinish: ((result: SttResult) => void) | null = null;
  let rejectFinish: ((error: Error) => void) | null = null;
  let commitEventId: string | null = null;
  let itemId: string | null = null;
  let pushedSamples = 0;
  let partialText = '';
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  /** Audio that arrived before the session was configured, sent once it is. */
  const pending: string[] = [];

  const durationSec = () => pushedSamples / opts.sampleRate;

  const socket = new WebSocket(client.url, { headers: client.headers });

  const connectTimer = setTimeout(() => {
    fail(new Error('OpenAI realtime transcription: session was not ready in time'));
  }, client.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  connectTimer.unref?.();

  const send = (event: Record<string, unknown>) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  };

  const release = () => {
    clearTimeout(connectTimer);
    if (finishTimer) clearTimeout(finishTimer);
    opts.signal?.removeEventListener('abort', onAbort);
    pending.length = 0;
    if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  };

  function fail(error: Error) {
    if (settled) return;
    settled = true;
    failure = error;
    rejectFinish?.(error);
    release();
  }

  const succeed = (result: SttResult) => {
    if (settled) return;
    settled = true;
    resolveFinish?.(result);
    release();
  };

  const commit = () => {
    commitEventId = `evt_commit_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    send({ type: 'input_audio_buffer.commit', event_id: commitEventId });
  };

  function onAbort() {
    close();
  }

  socket.on('message', (data: WebSocket.RawData) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (event.type) {
      case 'session.created':
      case 'transcription_session.created':
        send(buildTranscriptionSessionUpdate(client.modelId, opts));
        return;

      case 'session.updated':
      case 'transcription_session.updated': {
        if (ready) return;
        ready = true;
        clearTimeout(connectTimer);
        for (const audio of pending.splice(0)) send({ type: 'input_audio_buffer.append', audio });
        if (finishing) commit();
        return;
      }

      case 'input_audio_buffer.committed':
        if (commitEventId && !itemId && typeof event.item_id === 'string') itemId = event.item_id;
        return;

      case 'conversation.item.input_audio_transcription.delta': {
        if (itemId && event.item_id !== itemId) return;
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (!delta) return;
        partialText += delta;
        for (const listener of partialListeners) {
          try {
            listener(partialText, delta);
          } catch {
            // A listener's failure must not break the transcription.
          }
        }
        return;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        if (!commitEventId || (itemId && event.item_id !== itemId)) return;
        const transcript = typeof event.transcript === 'string' ? event.transcript : partialText;
        const languages = Array.isArray(event.languages)
          ? (event.languages as Array<Record<string, unknown>>)
          : [];
        const detected = typeof languages[0]?.code === 'string' ? (languages[0].code as string) : undefined;
        const duration = durationSec();
        succeed({
          text: transcript,
          language: detected ?? opts.language,
          duration,
          usage: mapRealtimeTranscriptionUsage(event.usage, duration),
          raw: event,
        });
        return;
      }

      case 'conversation.item.input_audio_transcription.failed':
        if (itemId && event.item_id !== itemId) return;
        fail(eventError('OpenAI realtime transcription failed', event.error));
        return;

      case 'error': {
        const details = (event.error ?? {}) as Record<string, unknown>;
        // Committing an empty buffer is "no speech", not a failure.
        if (
          commitEventId &&
          details.event_id === commitEventId &&
          details.code === 'input_audio_buffer_commit_empty'
        ) {
          succeed({ text: '', language: opts.language, duration: durationSec(), usage: { inputSeconds: 0 } });
          return;
        }
        fail(eventError('OpenAI realtime transcription error', event.error));
        return;
      }

      default:
        return;
    }
  });

  socket.on('error', (error: Error) => {
    fail(new Error(`OpenAI realtime transcription connection failed: ${error.message}`));
  });

  socket.on('close', (code: number) => {
    if (closed) return;
    fail(new Error(`OpenAI realtime transcription connection closed before the transcript arrived (${code})`));
  });

  if (opts.signal?.aborted) {
    queueMicrotask(() => close());
  } else {
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  }

  function close() {
    if (closed) return;
    closed = true;
    fail(abortError());
  }

  return {
    push(pcm16: Int16Array) {
      if (closed || settled || finishing || pcm16.length === 0) return;
      pushedSamples += pcm16.length;
      const resampled = resampler.process(pcm16);
      if (resampled.length === 0) return;
      const audio = Buffer.from(
        resampled.buffer,
        resampled.byteOffset,
        resampled.byteLength,
      ).toString('base64');
      if (ready) send({ type: 'input_audio_buffer.append', audio });
      else pending.push(audio);
    },

    finish() {
      if (finishing) return finishing;
      if (failure) {
        finishing = Promise.reject(failure);
        return finishing;
      }
      finishing = new Promise<SttResult>((resolve, reject) => {
        resolveFinish = resolve;
        rejectFinish = reject;
      });

      if (pushedSamples === 0) {
        // Nothing to transcribe — committing an empty buffer is an error upstream.
        succeed({ text: '', language: opts.language, duration: 0, usage: { inputSeconds: 0 } });
        return finishing;
      }

      finishTimer = setTimeout(() => {
        fail(new Error('OpenAI realtime transcription: no final transcript in time'));
      }, client.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS);
      finishTimer.unref?.();

      if (ready) commit();
      return finishing;
    },

    onPartial(cb) {
      partialListeners.push(cb);
    },

    close,
  };
}
