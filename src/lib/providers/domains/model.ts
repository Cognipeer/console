import type { ModelCategory } from '@/lib/database';
import type { SttRuntime, TtsRuntime } from './audio';
import type { OcrRuntime } from './ocr';
import type { ImageRuntime } from './image';
import type { ModerationRuntime } from './moderation';
import type { DecisionRuntime } from './decision';
import type { ProviderConfig } from '@cognipeer/agent-sdk';

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

/**
 * What an agent-sdk native provider needs to talk to the same upstream this
 * runtime talks to: credentials and endpoint, read from the SAME decrypted
 * provider record the LangChain-backed methods use. The caller adds the
 * transport (`fetch`, `timeoutMs`) and the per-model request settings.
 */
export interface NativeProviderSpec {
  /** agent-sdk provider config, credentials and endpoint included. */
  provider: ProviderConfig;
  /**
   * The upstream returns inline reasoning markup in `content` (OpenAI-compatible
   * servers such as Bedrock's /openai/v1): the transport must normalize the
   * response body before the SDK parses it.
   */
  normalizeInlineReasoning?: boolean;
}

export interface ModelProviderRuntime {
  /** Native (agent-sdk) provider for an agent's chat model. See `NativeProviderSpec`. */
  createNativeProviderSpec?(config: ModelRuntimeConfig): NativeProviderSpec;
  createChatModel?(config: ModelRuntimeConfig): Promise<unknown> | unknown;
  createEmbeddingModel?(config: ModelRuntimeConfig): Promise<unknown> | unknown;
  createSttRuntime?(config: ModelRuntimeConfig): Promise<SttRuntime> | SttRuntime;
  createTtsRuntime?(config: ModelRuntimeConfig): Promise<TtsRuntime> | TtsRuntime;
  createOcrRuntime?(config: ModelRuntimeConfig): Promise<OcrRuntime> | OcrRuntime;
  createImageRuntime?(config: ModelRuntimeConfig): Promise<ImageRuntime> | ImageRuntime;
  createModerationRuntime?(config: ModelRuntimeConfig): Promise<ModerationRuntime> | ModerationRuntime;
  createDecisionRuntime?(config: ModelRuntimeConfig): Promise<DecisionRuntime> | DecisionRuntime;
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
  // Decision (typed answers with probabilities)
  'decision.question_types'?: Array<'choice' | 'boolean' | 'score'>;
  'decision.supports.image'?: boolean;
  'decision.max_context'?: number;
  /** True when the driver reaches a vendor-native decision endpoint (reserved; P1 is structured only). */
  'decision.native'?: boolean;
  [key: string]: unknown;
}
