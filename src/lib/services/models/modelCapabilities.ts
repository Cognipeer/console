import type { IModel, ModelCategory } from '@/lib/database';

export const MODEL_CAPABILITY_SCHEMA_VERSION = '1.0' as const;

export type ModelInputModality = 'text' | 'image' | 'audio' | 'video' | 'file';
export type ModelOutputModality = 'text' | 'image' | 'audio' | 'embeddings';

export type ModelCapabilityOverrides = {
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: ModelInputModality[];
  outputModalities?: ModelOutputModality[];
  supportsReasoning?: boolean;
  supportsStructuredOutputs?: boolean;
  supportsToolCalls?: boolean;
};

export type ResolvedModelCapabilities = {
  schemaVersion: typeof MODEL_CAPABILITY_SCHEMA_VERSION;
  canonicalModelId: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities: ModelInputModality[];
  outputModalities: ModelOutputModality[];
  supportsReasoning?: boolean;
  supportsStructuredOutputs?: boolean;
  supportsToolCalls?: boolean;
};

export class ModelCapabilityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCapabilityValidationError';
  }
}

const INPUT_MODALITIES = new Set<ModelInputModality>([
  'text',
  'image',
  'audio',
  'video',
  'file',
]);
const OUTPUT_MODALITIES = new Set<ModelOutputModality>([
  'text',
  'image',
  'audio',
  'embeddings',
]);

export function getDefaultModelInputModalities(
  category: ModelCategory,
  isMultimodal = false,
): ModelInputModality[] {
  switch (category) {
    case 'stt':
      return ['audio'];
    case 'ocr':
      return ['image', 'file'];
    default:
      return isMultimodal ? ['text', 'image'] : ['text'];
  }
}

export function getDefaultModelOutputModalities(
  category: ModelCategory,
): ModelOutputModality[] {
  switch (category) {
    case 'embedding':
      return ['embeddings'];
    case 'tts':
      return ['audio'];
    case 'image':
      return ['image'];
    default:
      return ['text'];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPositiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function readBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === 'boolean');
}

function readModalities<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const modalities = value.filter(
    (candidate): candidate is T => typeof candidate === 'string' && allowed.has(candidate as T),
  );
  return modalities.length > 0 ? [...new Set(modalities)] : undefined;
}

function readOverrides(model: IModel): Record<string, unknown> {
  const capabilities = model.metadata?.capabilities;
  return isRecord(capabilities) ? capabilities : {};
}

function parseOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = readPositiveInteger(value);
  if (parsed === undefined) {
    throw new ModelCapabilityValidationError(`${field} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ModelCapabilityValidationError(`${field} must be a boolean`);
  }
  return value;
}

function parseModalities<T extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<T>,
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ModelCapabilityValidationError(`${field} must be a non-empty array`);
  }

  const invalid = value.find(
    (candidate) => typeof candidate !== 'string' || !allowed.has(candidate as T),
  );
  if (invalid !== undefined) {
    throw new ModelCapabilityValidationError(`${field} contains an unsupported modality`);
  }

  return [...new Set(value as T[])];
}

export function parseModelCapabilityOverrides(
  value: unknown,
): ModelCapabilityOverrides | null | undefined {
  if (value === undefined || value === null) return value;
  if (!isRecord(value)) {
    throw new ModelCapabilityValidationError('capabilities must be an object or null');
  }

  const contextWindow = parseOptionalPositiveInteger(value.contextWindow, 'capabilities.contextWindow');
  const maxOutputTokens = parseOptionalPositiveInteger(
    value.maxOutputTokens,
    'capabilities.maxOutputTokens',
  );
  if (
    contextWindow !== undefined
    && maxOutputTokens !== undefined
    && maxOutputTokens > contextWindow
  ) {
    throw new ModelCapabilityValidationError(
      'capabilities.maxOutputTokens cannot exceed capabilities.contextWindow',
    );
  }

  return {
    contextWindow,
    maxOutputTokens,
    inputModalities: parseModalities(
      value.inputModalities,
      'capabilities.inputModalities',
      INPUT_MODALITIES,
    ),
    outputModalities: parseModalities(
      value.outputModalities,
      'capabilities.outputModalities',
      OUTPUT_MODALITIES,
    ),
    supportsReasoning: parseOptionalBoolean(
      value.supportsReasoning,
      'capabilities.supportsReasoning',
    ),
    supportsStructuredOutputs: parseOptionalBoolean(
      value.supportsStructuredOutputs,
      'capabilities.supportsStructuredOutputs',
    ),
    supportsToolCalls: parseOptionalBoolean(
      value.supportsToolCalls,
      'capabilities.supportsToolCalls',
    ),
  };
}

export function applyModelCapabilityOverrides(
  metadata: Record<string, unknown> | undefined,
  capabilities: ModelCapabilityOverrides | null | undefined,
): Record<string, unknown> {
  const nextMetadata = { ...metadata };
  if (capabilities === undefined) return nextMetadata;

  if (capabilities === null) {
    delete nextMetadata.capabilities;
  } else {
    nextMetadata.capabilities = capabilities;
  }
  return nextMetadata;
}

export function resolveModelCapabilities(model: IModel): ResolvedModelCapabilities {
  const metadata = model.metadata ?? {};
  const settings = model.settings ?? {};
  const overrides = readOverrides(model);

  const inputModalities = readModalities(overrides.inputModalities, INPUT_MODALITIES)
    ?? getDefaultModelInputModalities(model.category, model.isMultimodal);
  const outputModalities = readModalities(overrides.outputModalities, OUTPUT_MODALITIES)
    ?? getDefaultModelOutputModalities(model.category);

  return {
    schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
    canonicalModelId: model.modelId,
    contextWindow: readPositiveInteger(
      overrides.contextWindow,
      metadata.contextLength,
      metadata.context_length,
      metadata.maxInputTokens,
      metadata.max_input_tokens,
      settings.contextLength,
      settings.context_length,
      settings.maxInputTokens,
      settings.max_input_tokens,
    ),
    maxOutputTokens: readPositiveInteger(
      overrides.maxOutputTokens,
      metadata.maxOutputTokens,
      metadata.max_output_tokens,
      settings.maxOutputTokens,
      settings.max_output_tokens,
      settings.maxTokens,
      settings.max_tokens,
    ),
    inputModalities,
    outputModalities,
    supportsReasoning: readBoolean(
      overrides.supportsReasoning,
      metadata.supportsReasoning,
      metadata.supports_reasoning,
    ),
    supportsStructuredOutputs: readBoolean(
      overrides.supportsStructuredOutputs,
      metadata.supportsStructuredOutputs,
      metadata.supports_structured_outputs,
    ),
    supportsToolCalls: readBoolean(overrides.supportsToolCalls, model.supportsToolCalls),
  };
}
