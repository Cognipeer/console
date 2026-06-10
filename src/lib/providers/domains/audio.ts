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

export interface SttRuntime {
  transcribe(input: SttTranscribeInput): Promise<SttResult>;
  translate?(input: SttTranslateInput): Promise<SttResult>;
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
  synthesizeStream?(
    input: TtsSynthesizeInput,
  ): Promise<AsyncIterable<Uint8Array>> | AsyncIterable<Uint8Array>;
}

// Re-exported so providers don't need to import from two places.
export type { ModelRuntimeConfig };
