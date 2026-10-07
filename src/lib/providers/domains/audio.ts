import type { ModelRuntimeConfig } from './model';

export type SttResponseFormat =
  | 'json'
  | 'text'
  | 'srt'
  | 'verbose_json'
  | 'vtt';

export type SttTimestampGranularity = 'word' | 'segment';

export interface SttAudioInput {
  /** Raw audio bytes. */
  data: Buffer;
  /** Original file name (helps providers infer format). */
  fileName?: string;
  /** MIME type, e.g. audio/mpeg, audio/wav, audio/webm. */
  contentType?: string;
}

export interface SttTranscribeInput {
  audio: SttAudioInput;
  language?: string;
  prompt?: string;
  responseFormat?: SttResponseFormat;
  temperature?: number;
  timestampGranularities?: SttTimestampGranularity[];
  /** Provider-specific extra fields forwarded as-is. */
  extra?: Record<string, unknown>;
  /**
   * Cancels the upstream request (e.g. a speculative realtime transcription
   * that turned stale). Never sent to the provider (it is not part of `extra`).
   */
  signal?: AbortSignal;
}

export interface SttTranslateInput {
  audio: SttAudioInput;
  prompt?: string;
  responseFormat?: SttResponseFormat;
  temperature?: number;
  extra?: Record<string, unknown>;
}

export interface SttWord {
  start: number;
  end: number;
  word: string;
}

export interface SttSegment {
  id?: number;
  start: number;
  end: number;
  text: string;
  avgLogprob?: number;
  compressionRatio?: number;
  noSpeechProb?: number;
}

export interface SttUsage {
  /** Duration of input audio in seconds (used for billing). */
  inputSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface SttResult {
  text: string;
  language?: string;
  duration?: number;
  segments?: SttSegment[];
  words?: SttWord[];
  usage?: SttUsage;
  /** Raw provider response (for debugging / passthrough). */
  raw?: unknown;
}

export interface SttStreamOptions {
  /** Rate of the PCM pushed into the stream; the runtime resamples to what its provider needs. */
  sampleRate: 16000 | 24000;
  language?: string;
  prompt?: string;
  /** Aborting closes the stream (same as `close()`); a pending `finish()` rejects with an AbortError. */
  signal?: AbortSignal;
}

/**
 * One utterance transcribed while it is being spoken (EXPERIMENTAL — only the
 * realtime engine's `stt_mode: 'streaming'` uses it). Audio is pushed as it
 * arrives; `finish()` ends the utterance and resolves with the final transcript.
 */
export interface SttStream {
  /** s16le mono samples at `SttStreamOptions.sampleRate`. Ignored after `finish()`/`close()`. */
  push(pcm16: Int16Array): void;
  /** Ends the utterance; resolves with the final transcript (`text` is '' when no audio was pushed). */
  finish(): Promise<SttResult>;
  /** Interim transcript: `text` is everything so far, `delta` the newly added piece. */
  onPartial(cb: (text: string, delta: string) => void): void;
  /** Drops the stream and releases the connection. Safe to call more than once. */
  close(): void;
}

export interface SttRuntime {
  transcribe(input: SttTranscribeInput): Promise<SttResult>;
  translate?(input: SttTranslateInput): Promise<SttResult>;
  /** Streaming transcription (EXPERIMENTAL). Absent when the provider cannot stream. */
  createStream?(opts: SttStreamOptions): SttStream | Promise<SttStream>;
}

export type TtsOutputFormat =
  | 'mp3'
  | 'opus'
  | 'aac'
  | 'flac'
  | 'wav'
  | 'pcm';

export interface TtsSynthesizeInput {
  text: string;
  /** Voice name. Optional — the provider runtime falls back to its default voice. */
  voice?: string;
  format?: TtsOutputFormat;
  /** Playback speed multiplier (1.0 = normal). */
  speed?: number;
  /** Free-text voice style instructions (OpenAI gpt-4o-mini-tts supports this). */
  instructions?: string;
  extra?: Record<string, unknown>;
  /**
   * Cancels the upstream request — before the response arrives and, for
   * `synthesizeStream`, while the body is still streaming. Never sent to the
   * provider (it is not part of `extra`).
   */
  signal?: AbortSignal;
}

export interface TtsUsage {
  inputCharacters?: number;
  outputSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface TtsResult {
  audio: Buffer;
  contentType: string;
  format: TtsOutputFormat;
  usage?: TtsUsage;
  raw?: unknown;
}

export interface TtsRuntime {
  synthesize(input: TtsSynthesizeInput): Promise<TtsResult>;
  /**
   * Streams the synthesized audio as the provider produces it: raw bytes in
   * `input.format`. Upstream rejections (4xx/5xx) reject the returned promise —
   * before any byte is yielded — so the caller can retry or fall back; a fault
   * after that surfaces from the iterator. For `pcm` (s16le mono, 24 kHz on
   * OpenAI/Azure) every chunk holds whole samples (even byte length), so a
   * consumer can decode chunks independently. Optional: callers fall back to
   * `synthesize` when a runtime cannot stream.
   */
  synthesizeStream?(
    input: TtsSynthesizeInput,
  ): Promise<AsyncIterable<Uint8Array>> | AsyncIterable<Uint8Array>;
}

// Re-exported so providers don't need to import from two places.
export type { ModelRuntimeConfig };
