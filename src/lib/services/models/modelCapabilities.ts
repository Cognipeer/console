import type { IModel, ModelCategory } from '@/lib/database';
import { inferModelAcceptsImages } from '@/lib/providers/contracts/modelCapabilityInference';

export const MODEL_CAPABILITY_SCHEMA_VERSION = '1.0' as const;

export type ModelInputModality = 'text' | 'image' | 'audio' | 'video' | 'file';
export type ModelOutputModality = 'text' | 'image' | 'audio' | 'embeddings';

export type ModelCapabilityOverrides = {
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: ModelInputModality[];
  /**
   * Set whenever `inputModalities` is written (every write goes through
   * `parseModelCapabilityOverrides`): the stored list is somebody's choice. A
   * list stored WITHOUT it predates the flag — see `isLegacyTextOnlyDefault`.
   */
  inputModalitiesExplicit?: boolean;
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

/** A create named a key (not just a name) that another model in the project already has. */
export class ModelKeyConflictError extends Error {
  readonly code = 'model_key_conflict';
  constructor(readonly key: string) {
    super(`A model with key "${key}" already exists in this project`);
    this.name = 'ModelKeyConflictError';
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

/**
 * What a model accepts when nothing explicit is stored for it. A chat model is
 * `text`, plus `image` when the model is flagged multimodal OR — with `modelId`
 * given — belongs to a known vision family (`modelCapabilityInference.ts`). The
 * model forms prefill their input-modality boxes from this, and store an
 * override only when the person changes it.
 */
export function getDefaultModelInputModalities(
  category: ModelCategory,
  isMultimodal = false,
  modelId?: string,
): ModelInputModality[] {
  switch (category) {
    case 'stt':
      return ['audio'];
    case 'ocr':
      return ['image', 'file'];
    case 'llm':
      return isMultimodal || inferModelAcceptsImages(modelId) ? ['text', 'image'] : ['text'];
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

/**
 * Whether a stored `inputModalities` is the value the model forms of earlier
 * releases wrote back on EVERY save, not a choice: exactly `['text']` on a chat
 * model not flagged multimodal, with nothing marking it as chosen
 * (`inputModalitiesExplicit`). Nearly every model created or edited in the
 * dashboard carries one, and read as a choice it beat the vision-family table
 * for models that read images perfectly well. Treated as "nothing stored".
 *
 * The cost: a "text only" choice made BEFORE the flag existed, on a model whose
 * id is a known vision family, reads as unset until it is chosen again in the
 * model's page (a choice made now is flagged and always wins).
 */
export function isLegacyTextOnlyDefault(
  category: ModelCategory,
  isMultimodal: boolean | undefined,
  stored: readonly string[] | undefined,
  explicit?: unknown,
): boolean {
  return category === 'llm'
    && isMultimodal !== true
    && explicit !== true
    && stored !== undefined
    && stored.length === 1
    && stored[0] === 'text';
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

  const inputModalities = parseModalities(
    value.inputModalities,
    'capabilities.inputModalities',
    INPUT_MODALITIES,
  );

  return {
    contextWindow,
    maxOutputTokens,
    inputModalities,
    // Whoever writes the list is choosing it (the forms store one only when the person picks).
    ...(inputModalities ? { inputModalitiesExplicit: true } : {}),
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

/**
 * What "Fill from catalog" writes into the Limits fields: the catalog entry's max input tokens as the context
 * window and its max output tokens as the model maximum — each only while the form's field is EMPTY (a value
 * somebody typed is never overwritten). The maximum output is skipped when it would exceed the context window
 * the form will hold, because the save would be refused (`maxOutputTokens cannot exceed contextWindow`).
 * Returns only the fields to set.
 */
export function limitsFromCatalogFill(
  current: { contextWindow: number | '' | undefined; maxOutputTokens: number | '' | undefined },
  catalog: { maxInputTokens?: number; maxOutputTokens?: number },
): { contextWindow?: number; maxOutputTokens?: number } {
  const fill: { contextWindow?: number; maxOutputTokens?: number } = {};
  const catalogContext = readPositiveInteger(catalog.maxInputTokens);
  const catalogMaxOutput = readPositiveInteger(catalog.maxOutputTokens);

  if ((current.contextWindow === '' || current.contextWindow === undefined) && catalogContext !== undefined) {
    fill.contextWindow = catalogContext;
  }
  if ((current.maxOutputTokens === '' || current.maxOutputTokens === undefined) && catalogMaxOutput !== undefined) {
    const contextWindow = fill.contextWindow ?? (typeof current.contextWindow === 'number' ? current.contextWindow : undefined);
    if (contextWindow === undefined || catalogMaxOutput <= contextWindow) {
      fill.maxOutputTokens = catalogMaxOutput;
    }
  }
  return fill;
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

  const stored = readModalities(overrides.inputModalities, INPUT_MODALITIES);
  const chosen = isLegacyTextOnlyDefault(model.category, model.isMultimodal, stored, overrides.inputModalitiesExplicit)
    ? undefined
    : stored;
  const inputModalities = chosen
    ?? getDefaultModelInputModalities(model.category, model.isMultimodal, model.modelId);
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
      // No `settings.maxTokens` / `max_tokens` here: that is the DEFAULT per-request limit ("Default max tokens"),
      // not what the model can produce. Advertising it as the maximum capped clients, defaults and the
      // raised retry at an operator's convenience value.
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
