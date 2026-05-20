import type { ModelCategory } from '@/lib/database';
import type { SttRuntime, TtsRuntime } from './audio';
import type { OcrRuntime } from './ocr';

export type ModelRuntimeCategory = ModelCategory;

export interface ModelRuntimeOptions {
  streaming?: boolean;
}

export interface ModelRuntimeConfig {
  modelId: string;
  category: ModelRuntimeCategory;
  modelSettings?: Record<string, unknown>;
  options?: ModelRuntimeOptions;
}

export interface ModelProviderRuntime {
  createChatModel?(config: ModelRuntimeConfig): Promise<unknown> | unknown;
  createEmbeddingModel?(config: ModelRuntimeConfig): Promise<unknown> | unknown;
  createSttRuntime?(config: ModelRuntimeConfig): Promise<SttRuntime> | SttRuntime;
  createTtsRuntime?(config: ModelRuntimeConfig): Promise<TtsRuntime> | TtsRuntime;
  createOcrRuntime?(config: ModelRuntimeConfig): Promise<OcrRuntime> | OcrRuntime;
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
  [key: string]: unknown;
}
