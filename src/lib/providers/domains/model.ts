import type { ModelCategory } from '@/lib/database';
import type { SttRuntime, TtsRuntime } from './audio';
import type { OcrRuntime } from './ocr';
import type { ImageRuntime } from './image';
import type { ModerationRuntime } from './moderation';
import type { DecisionRuntime } from './decision';
import type {
  BaseProvider,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingResponse,
  ProviderConfig,
} from '@cognipeer/agent-sdk';

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
 * provider record every runtime method uses. The caller adds the
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

/** Transport of a native client: the same fetch behaviour the caller has today (default: the global `fetch`). */
export interface NativeTransport {
  fetch?: typeof fetch;
  /** Time to the response headers, per request; an open stream is never cut by it. */
  timeoutMs?: number;
}

/** The normalized reasoning value (`unset = send nothing`). */
export interface NativeReasoning {
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  budgetTokens?: number;
  includeThoughts?: boolean;
}

/** A unified request; `model` defaults to the client's model, unset sampling fields to the model record's. */
export type NativeChatRequest = Omit<ChatCompletionRequest, 'model' | 'stream'> & { model?: string };

/**
 * A request-level chat client over an agent-sdk native provider. Per-model
 * rules (requestDefaults / extraBody, unsupportedParams incl. the rules that
 * depend on tools, the reasoning default, token-param naming) are applied to
 * every request; what the request itself sets always wins.
 */
export interface NativeChatClient {
  readonly driver: string;
  readonly modelId: string;
  readonly provider: BaseProvider;
  /** The upstream may leak a reasoning block into `content` (Bedrock /openai/v1): the caller splits it. */
  readonly normalizeInlineReasoning: boolean;
  /** The finished request as the provider receives it (defaults folded in, made legal for the model). */
  prepare(request: NativeChatRequest, options?: { stream?: boolean }): Promise<ChatCompletionRequest>;
  complete(request: NativeChatRequest): Promise<ChatCompletionResponse>;
  stream(request: NativeChatRequest): AsyncGenerator<ChatCompletionChunk, void, unknown>;
}

export interface NativeEmbedOptions {
  dimensions?: number;
  encodingFormat?: 'float' | 'base64';
  inputType?: string;
  batchSize?: number;
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface NativeEmbedder {
  readonly driver: string;
  readonly modelId: string;
  readonly provider: BaseProvider;
  embed(texts: string[], options?: NativeEmbedOptions): Promise<EmbeddingResponse>;
}

export interface ModelProviderRuntime {
  /** Native (agent-sdk) chat client: the gateway core's way to call the model. */
  createNativeChatClient?(config: ModelRuntimeConfig, transport?: NativeTransport): Promise<NativeChatClient>;
  /** Native (agent-sdk) embedder. */
  createNativeEmbedder?(config: ModelRuntimeConfig, transport?: NativeTransport): Promise<NativeEmbedder>;
  /** The provider an agent-sdk native client is built from. See `NativeProviderSpec`. */
  createNativeProviderSpec?(config: ModelRuntimeConfig): NativeProviderSpec;
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
