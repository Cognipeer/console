/**
 * The provider model catalog's entries turned into what the model create flow uses: the values the create form
 * opens with, and the request body the catalog's bulk "Add N models" posts.
 *
 * Pure functions, shared by the catalog overlay, the create form and their tests. A model added in bulk must be the
 * same record as one added through the form with nothing edited, so `catalogModelToCreatePayload` builds the body
 * `CreateModelModal`'s submit builds, field by field and with the same defaults and provider clamps. The provider
 * rules the form applies (allowed categories, tool calls, OCR and decision modes) live here so both paths read
 * them from one place.
 */
import type { ModelCategory } from '@/lib/database';
import type { CatalogModel } from '@/lib/services/models/catalog/types';
import {
  getDefaultModelOutputModalities,
  type ModelInputModality,
  type ModelOutputModality,
} from '@/lib/services/models/modelCapabilities';
import {
  INPUT_MODALITY_OPTIONS,
  inferredInputModalities,
  inputModalitiesPayload,
  isMultimodalFor,
  shownInputModalities,
} from '@/components/models/inputModalities';
import { EMPTY_REASONING_FORM, reasoningSettingsPatch } from '@/components/models/reasoningForm';

/** The order categories are listed in by the catalog (chips, counts). */
export const CATALOG_CATEGORY_ORDER: readonly ModelCategory[] = [
  'llm',
  'embedding',
  'rerank',
  'stt',
  'tts',
  'image',
  'moderation',
  'ocr',
  'decision',
];

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(CATALOG_CATEGORY_ORDER);

/**
 * Categories whose models are addressed by tokens in and tokens out: the only ones the form's capability block
 * (tool calls, reasoning, structured outputs, input types) and limit fields describe.
 */
const CAPABILITY_CATEGORIES: ReadonlyArray<ModelCategory> = ['llm'];

export type OcrMode = 'native' | 'vlm';
export type DecisionMode = 'structured' | 'native';

/** What the create rules read from a provider: its key, driver and the driver's capability flags. */
export interface CatalogProviderRef {
  key: string;
  driver?: string;
  driverCapabilities?: Record<string, unknown>;
}

/** The categories the provider's driver serves; a driver that does not say serves chat and embedding models. */
export function resolveProviderCategories(provider?: Pick<CatalogProviderRef, 'driverCapabilities'>): ModelCategory[] {
  const raw = provider?.driverCapabilities?.['model.categories'];
  if (!Array.isArray(raw)) return ['llm', 'embedding'];
  return raw.filter((item): item is ModelCategory => typeof item === 'string' && KNOWN_CATEGORIES.has(item));
}

export function resolveOcrModes(provider?: Pick<CatalogProviderRef, 'driverCapabilities'>): OcrMode[] {
  const raw = provider?.driverCapabilities?.['ocr.modes'];
  if (Array.isArray(raw)) {
    const modes = raw.filter((m): m is OcrMode => m === 'native' || m === 'vlm');
    if (modes.length > 0) return modes;
  }
  return ['vlm'];
}

/**
 * Structured needs a chat model on the provider; native needs the provider's own decision endpoint
 * (`decision.native`). A provider can offer either or both.
 */
export function resolveDecisionModes(provider?: Pick<CatalogProviderRef, 'driverCapabilities'>): DecisionMode[] {
  const modes: DecisionMode[] = [];
  if (resolveProviderCategories(provider).includes('llm')) modes.push('structured');
  if (provider?.driverCapabilities?.['decision.native'] === true) modes.push('native');
  return modes.length > 0 ? modes : ['structured'];
}

export function providerSupportsToolCalls(provider?: Pick<CatalogProviderRef, 'driverCapabilities'>): boolean {
  return Boolean(provider?.driverCapabilities?.['model.supports.tool_calls']);
}

/**
 * The catalog categories whose ids the Model ID field of a model of this category (and OCR / decision mode) can take.
 * OCR in VLM mode and structured decision run on a chat model of the provider, and listings name those as chat
 * models (`llm`), so they fit as well as the category's own entries (mistral-ocr, a native decision model ...).
 */
export function modelIdSuggestionCategories(category: ModelCategory, mode?: string): ModelCategory[] {
  if (category === 'ocr' && mode === 'vlm') return ['ocr', 'llm'];
  if (category === 'decision' && mode === 'structured') return ['decision', 'llm'];
  return [category];
}

/** What the create form opens with when a model is picked from the catalog. */
export interface CreateModelPrefill {
  providerKey: string;
  modelId: string;
  name: string;
  category: ModelCategory;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** An explicit choice of input types; null / absent = detected from the model id, as for a typed-in model. */
  inputModalities?: ModelInputModality[] | null;
  supportsToolCalls?: boolean;
  supportsReasoning?: boolean;
  supportsStructuredOutputs?: boolean;
  /** Per-1M token prices; absent when the catalog has no price it trusts for this model. */
  pricing?: {
    inputTokenPer1M: number;
    outputTokenPer1M: number;
    cachedTokenPer1M?: number;
    cacheWriteTokenPer1M?: number;
  };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A cache price of 0 means the source has none (as in "Fill from catalog"): the field stays blank. */
function positivePrice(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The prices the form may be filled with: the provider's own, or a reference match by exact or normalized id. A
 * fuzzy reference match is only shown in the catalog (marked "≈"); filling it in would bill one model at another's
 * price without anyone having looked.
 */
export function trustedCatalogPricing(model: Pick<CatalogModel, 'pricing'>): CreateModelPrefill['pricing'] | undefined {
  const pricing = model.pricing;
  if (!pricing) return undefined;
  const trusted = pricing.source === 'provider'
    || (pricing.source === 'reference' && (pricing.confidence === 'exact' || pricing.confidence === 'normalized'));
  if (!trusted) return undefined;
  const input = nonNegative(pricing.inputTokenPer1M);
  const output = nonNegative(pricing.outputTokenPer1M);
  if (input === undefined || output === undefined) return undefined;
  const cached = positivePrice(pricing.cachedTokenPer1M);
  const cacheWrite = positivePrice(pricing.cacheWriteTokenPer1M);
  return {
    inputTokenPer1M: input,
    outputTokenPer1M: output,
    ...(cached !== undefined ? { cachedTokenPer1M: cached } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokenPer1M: cacheWrite } : {}),
  };
}

/**
 * The input types to store for a catalog entry, or null to leave them to the detection from the model id. Only a
 * listing that says the model takes more than text sets them, and only when the detection would not already say the
 * same: the form stores a choice only when someone (here: the provider's own listing) made one.
 */
function catalogInputModalities(model: CatalogModel): ModelInputModality[] | null {
  const listed = Array.isArray(model.inputModalities) ? model.inputModalities : [];
  const beyondText = listed.filter((modality) => modality !== 'text' && INPUT_MODALITY_OPTIONS.includes(modality));
  if (beyondText.length === 0) return null;
  const chosen = INPUT_MODALITY_OPTIONS.filter((option) => option === 'text' || beyondText.includes(option));
  const detected = inferredInputModalities(model.category, model.id);
  const same = detected.length === chosen.length && detected.every((modality) => chosen.includes(modality));
  return same ? null : chosen;
}

/** The create form's values for a catalog entry (the form applies them over its defaults when it opens). */
export function catalogModelToPrefill(model: CatalogModel, providerKey: string): CreateModelPrefill {
  const isLlm = CAPABILITY_CATEGORIES.includes(model.category);
  const prefill: CreateModelPrefill = {
    providerKey,
    modelId: model.id,
    name: model.name?.trim() || model.id,
    category: model.category,
  };
  // Limits and capability toggles exist on the form for chat models only; for other categories they would be
  // values nobody can see stored on the record.
  if (isLlm) {
    const contextWindow = positiveInt(model.contextWindow);
    let maxOutputTokens = positiveInt(model.maxOutputTokens);
    // The form refuses a maximum output above the context window; a listing that says so is dropped, not saved.
    if (contextWindow !== undefined && maxOutputTokens !== undefined && maxOutputTokens > contextWindow) {
      maxOutputTokens = undefined;
    }
    if (contextWindow !== undefined) prefill.contextWindow = contextWindow;
    if (maxOutputTokens !== undefined) prefill.maxOutputTokens = maxOutputTokens;
    const modalities = catalogInputModalities(model);
    if (modalities) prefill.inputModalities = modalities;
    if (typeof model.supportsToolCalls === 'boolean') prefill.supportsToolCalls = model.supportsToolCalls;
    if (typeof model.supportsReasoning === 'boolean') prefill.supportsReasoning = model.supportsReasoning;
    if (typeof model.supportsStructuredOutputs === 'boolean') {
      prefill.supportsStructuredOutputs = model.supportsStructuredOutputs;
    }
  }
  const pricing = trustedCatalogPricing(model);
  if (pricing) prefill.pricing = pricing;
  return prefill;
}

/** The JSON body `POST /api/models` receives from the create form. */
export interface CreateModelRequestBody {
  providerKey: string;
  name: string;
  key: string;
  description: string;
  category: ModelCategory;
  modelId: string;
  isMultimodal: boolean;
  supportsToolCalls: boolean;
  capabilities: {
    contextWindow?: number;
    maxOutputTokens?: number;
    inputModalities?: ModelInputModality[];
    outputModalities: ModelOutputModality[];
    supportsReasoning: boolean;
    supportsStructuredOutputs: boolean;
    supportsToolCalls: boolean;
  };
  pricing: {
    currency: string;
    inputTokenPer1M: number;
    outputTokenPer1M: number;
    cachedTokenPer1M?: number;
    cacheWriteTokenPer1M?: number;
  };
  settings: Record<string, unknown>;
}

export interface CatalogCreatePayload {
  body: CreateModelRequestBody;
  /** False when the catalog had no price it trusts: the model is created with 0 prices. */
  priced: boolean;
}

const definedOnly = (patch: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));

/**
 * The body the create form posts for `prefill` when nothing else is touched: its defaults (tool calls, reasoning and
 * structured outputs on, blank key and description, no request settings), the provider clamps its effects apply
 * (category, tool calls, OCR and decision mode) and its submit's shape.
 */
export function createModelBodyFromPrefill(prefill: CreateModelPrefill, provider: CatalogProviderRef): CreateModelRequestBody {
  const categories = resolveProviderCategories(provider);
  const category = categories.length && !categories.includes(prefill.category) ? categories[0] : prefill.category;
  const isLlm = CAPABILITY_CATEGORIES.includes(category);
  const inputModalities = prefill.inputModalities ?? null;
  const effectiveModalities = shownInputModalities(inputModalities, inferredInputModalities(category, prefill.modelId));
  const supportsToolCalls = (prefill.supportsToolCalls ?? true) && providerSupportsToolCalls(provider);
  const ocrModes = resolveOcrModes(provider);
  const decisionModes = resolveDecisionModes(provider);
  const ocrMode: OcrMode = ocrModes.includes('vlm') ? 'vlm' : ocrModes[0];
  const decisionMode: DecisionMode = decisionModes.includes('structured') ? 'structured' : decisionModes[0];

  return {
    providerKey: provider.key,
    name: prefill.name,
    key: '',
    description: '',
    category,
    modelId: prefill.modelId,
    isMultimodal: isLlm ? isMultimodalFor(effectiveModalities) : false,
    supportsToolCalls,
    capabilities: {
      ...(prefill.contextWindow !== undefined ? { contextWindow: prefill.contextWindow } : {}),
      ...(prefill.maxOutputTokens !== undefined ? { maxOutputTokens: prefill.maxOutputTokens } : {}),
      ...(isLlm ? inputModalitiesPayload(inputModalities) : {}),
      outputModalities: getDefaultModelOutputModalities(category),
      supportsReasoning: prefill.supportsReasoning ?? true,
      supportsStructuredOutputs: prefill.supportsStructuredOutputs ?? true,
      supportsToolCalls,
    },
    pricing: {
      currency: 'USD',
      inputTokenPer1M: prefill.pricing?.inputTokenPer1M ?? 0,
      outputTokenPer1M: prefill.pricing?.outputTokenPer1M ?? 0,
      ...(prefill.pricing?.cachedTokenPer1M !== undefined ? { cachedTokenPer1M: prefill.pricing.cachedTokenPer1M } : {}),
      ...(prefill.pricing?.cacheWriteTokenPer1M !== undefined
        ? { cacheWriteTokenPer1M: prefill.pricing.cacheWriteTokenPer1M }
        : {}),
    },
    settings: {
      // The form's blank reasoning section, the way its submit writes it (nothing, today). A blank prompt-caching
      // choice and the other request settings at their defaults are not written either.
      ...(isLlm ? definedOnly(reasoningSettingsPatch(EMPTY_REASONING_FORM, undefined)) : {}),
      ...(category === 'decision' ? { decision: { mode: decisionMode, supports: { image: false } } } : {}),
      ...(category === 'ocr' ? { ocr: { mode: ocrMode } } : {}),
    },
  };
}

/** The body the bulk "Add N models" posts for one catalog entry: the create form's, with nothing edited. */
export function catalogModelToCreatePayload(model: CatalogModel, provider: CatalogProviderRef): CatalogCreatePayload {
  const prefill = catalogModelToPrefill(model, provider.key);
  return { body: createModelBodyFromPrefill(prefill, provider), priced: prefill.pricing !== undefined };
}

export type CatalogCategoryFilter = 'all' | ModelCategory;

export interface CatalogFilter {
  query?: string;
  category?: CatalogCategoryFilter;
  hideRegistered?: boolean;
}

export function isCatalogModelRegistered(model: Pick<CatalogModel, 'registeredModelKeys'>): boolean {
  return Array.isArray(model.registeredModelKeys) && model.registeredModelKeys.length > 0;
}

/** Every word of the query must appear in the id, name, description, owner or upstream model (any case). */
export function filterCatalogModels(models: readonly CatalogModel[], filter: CatalogFilter): CatalogModel[] {
  const terms = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const category = filter.category ?? 'all';
  return models.filter((model) => {
    if (category !== 'all' && model.category !== category) return false;
    if (filter.hideRegistered && isCatalogModelRegistered(model)) return false;
    if (terms.length === 0) return true;
    const haystack = [model.id, model.name, model.description, model.ownedBy, model.upstreamModel]
      .filter((part): part is string => typeof part === 'string')
      .join('\n')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** How many entries each category has, in catalog order, leaving out the categories with none. */
export function catalogCategoryCounts(models: readonly CatalogModel[]): Array<{ category: ModelCategory; count: number }> {
  const counts = new Map<ModelCategory, number>();
  for (const model of models) counts.set(model.category, (counts.get(model.category) ?? 0) + 1);
  return CATALOG_CATEGORY_ORDER.filter((category) => counts.has(category)).map((category) => ({
    category,
    count: counts.get(category) ?? 0,
  }));
}
