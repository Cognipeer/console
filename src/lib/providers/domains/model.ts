import type { ModelCategory } from '@/lib/database';
import type { SttRuntime, TtsRuntime } from './audio';
import type { OcrRuntime } from './ocr';
import type { ImageRuntime } from './image';
import type { ModerationRuntime } from './moderation';

export type ModelRuntimeCategory = ModelCategory;

export interface ModelRuntimeOptions {
  streaming?: boolean;
  disableStreaming?: boolean;
  /**
   * Retries the provider SDK may perform on its own. The gateway sets 0 because
   * `withResilience` already owns retry and circuit-breaking there; callers that
   * hand the model to something else (the agent runtime) leave it unset and keep
   * a small budget, since nothing else would retry for them.
   */
  maxRetries?: number;
}

export interface ModelRuntimeConfig {
  modelId: string;
  category: ModelRuntimeCategory;
  /**
   * Resolved per-call settings. Beyond the sampling knobs, contracts read two
   * operator-controlled keys from here:
   * - `extraBody` / `requestDefaults` — extra request-body fields forwarded
   *   verbatim to the upstream (vLLM `chat_template_kwargs`, `top_k`, …).
   * - `unsupportedParams` — wire names to strip before the call, for models
   *   that reject them (the OpenAI reasoning family rejects `temperature`).
   */
  modelSettings?: Record<string, unknown>;
  options?: ModelRuntimeOptions;
}

export interface ModelProviderRuntime {
  createChatModel?(config: ModelRuntimeConfig): Promise<unknown> | unknown;
  createEmbeddingModel?(config: ModelRuntimeConfig): Promise<unknown> | unknown;
  createSttRuntime?(config: ModelRuntimeConfig): Promise<SttRuntime> | SttRuntime;
  createTtsRuntime?(config: ModelRuntimeConfig): Promise<TtsRuntime> | TtsRuntime;
  createOcrRuntime?(config: ModelRuntimeConfig): Promise<OcrRuntime> | OcrRuntime;
  createImageRuntime?(config: ModelRuntimeConfig): Promise<ImageRuntime> | ImageRuntime;
  createModerationRuntime?(config: ModelRuntimeConfig): Promise<ModerationRuntime> | ModerationRuntime;
  getCapabilities?(): Record<string, unknown>;
}

export interface ModelProviderCapabilityFlags {
  'model.categories'?: ModelCategory[];
  'model.supports.tool_calls'?: boolean;
  'model.supports.streaming'?: boolean;
  'model.supports.multimodal'?: boolean;
  // STT / TTS / OCR specific capability flags
  'stt.formats.input'?: string[];
  'stt.supports.timestamps'?: boolean;
  'stt.supports.diarization'?: boolean;
  'stt.supports.translate'?: boolean;
  'tts.voices'?: string[];
  'tts.formats.output'?: string[];
  'tts.supports.streaming'?: boolean;
  'ocr.modes'?: Array<'native' | 'vlm'>;
  'ocr.supports.tables'?: boolean;
  'ocr.supports.kv_pairs'?: boolean;
  'ocr.formats.input'?: string[];
  'image.sizes'?: string[];
  'image.formats.output'?: string[];
  'image.supports.edit'?: boolean;
  [key: string]: unknown;
}
