/**
 * Readers of the "list models" answers of the providers the catalog calls, one per upstream shape.
 *
 * Every reader is pure and tolerant: an answer is somebody else's JSON, so a field of the wrong type is skipped, an
 * entry without a string id is dropped, a repeated id keeps its first entry, and nothing here throws on an odd shape
 * (it lists what it could read). Each entry carries what the provider said about the model; the discovery service
 * filters, sorts and enriches the result.
 */
import type { ModelCategory } from '@/lib/database';
import type { ModelInputModality } from '@/lib/services/models/modelCapabilities';
import { inferCatalogCategory } from './inferCategory';
import type { CatalogModel, CatalogModelPricing } from './types';

/** One listed model before filtering. `category: null` marks a model no driver of this console can serve. */
export interface ParsedModel extends Omit<CatalogModel, 'category' | 'source' | 'registeredModelKeys'> {
  category: ModelCategory | null;
}

type JsonObject = Record<string, unknown>;

/** A description is a hint on a row, not documentation: long upstream texts are cut. */
const MAX_DESCRIPTION = 500;

const INPUT_MODALITIES: ReadonlySet<ModelInputModality> = new Set(['text', 'image', 'audio', 'video', 'file']);

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** A token count: a positive whole number. Anything else (0, negative, a string, NaN) is "not said". */
function positiveInt(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return undefined;
  return Math.floor(number);
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function description(value: unknown): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 3)}...` : flat;
}

/**
 * An ISO timestamp from a Unix time (seconds, or milliseconds when the number is that large) or a date string. Values
 * outside 2000-2100 are taken for garbage rather than a date.
 */
function timestamp(value: unknown): string | undefined {
  let ms: number | undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    ms = value > 1e12 ? value : value * 1000;
  } else if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed)) ms = parsed;
  }
  if (ms === undefined) return undefined;
  const year = new Date(ms).getUTCFullYear();
  return year >= 2000 && year <= 2100 ? new Date(ms).toISOString() : undefined;
}

/** The suggested display name when the provider gives none: the id, without the path in front of it. */
export function defaultModelName(id: string): string {
  const slash = id.lastIndexOf('/');
  const tail = slash >= 0 ? id.slice(slash + 1) : id;
  return tail || id;
}

/** Drops entries with a repeated id (the first one stays), so every reader returns each id once. */
function dedupe(models: ParsedModel[]): ParsedModel[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

/** The list of an answer: `{ data: [...] }`, or a bare array (Together). */
function listOf(body: unknown, key = 'data'): unknown[] {
  if (Array.isArray(body)) return body;
  const list = isObject(body) ? body[key] : undefined;
  return Array.isArray(list) ? list : [];
}

/** Rounds a price to 6 decimals, which sheds the float noise of per-token × 1e6. */
function roundPrice(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** A price the provider states, as a number >= 0. A negative one (OpenRouter's "-1" for a router) is "not said". */
function price(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) return undefined;
  return number;
}

/**
 * OpenRouter: `pricing.prompt` / `completion` / `input_cache_read` / `input_cache_write`, USD per token as strings.
 * A free model says "0", which is a real price there.
 */
function openRouterPricing(pricing: JsonObject): CatalogModelPricing | undefined {
  const input = price(pricing.prompt);
  const output = price(pricing.completion);
  if (input === undefined || output === undefined) return undefined;
  const cached = price(pricing.input_cache_read);
  const cacheWrite = price(pricing.input_cache_write);
  return {
    currency: 'USD',
    inputTokenPer1M: roundPrice(input * 1_000_000),
    outputTokenPer1M: roundPrice(output * 1_000_000),
    ...(cached !== undefined && cached > 0 ? { cachedTokenPer1M: roundPrice(cached * 1_000_000) } : {}),
    ...(cacheWrite !== undefined && cacheWrite > 0 ? { cacheWriteTokenPer1M: roundPrice(cacheWrite * 1_000_000) } : {}),
    source: 'provider',
  };
}

/**
 * Together: `pricing.input` / `output`, already USD per 1M tokens. Models that are not billed per token (images,
 * dedicated endpoints) say 0 for both, which is not a price of a token, so that is "not said".
 */
function togetherPricing(pricing: JsonObject): CatalogModelPricing | undefined {
  const input = price(pricing.input);
  const output = price(pricing.output);
  if (input === undefined || output === undefined || (input === 0 && output === 0)) return undefined;
  return { currency: 'USD', inputTokenPer1M: roundPrice(input), outputTokenPer1M: roundPrice(output), source: 'provider' };
}

/** Together's `type`, as a category. `undefined` for a value that is not a category (Mistral's `base`, `fine-tuned`). */
function categoryOfType(type: string | undefined, id: string): ModelCategory | null | undefined {
  switch (type?.toLowerCase()) {
    case 'chat':
    case 'language':
    case 'code':
    // LM Studio's own listing.
    case 'llm':
    case 'vlm':
      return 'llm';
    case 'embedding':
    case 'embeddings':
      return 'embedding';
    case 'rerank':
      return 'rerank';
    case 'image':
      return 'image';
    case 'moderation':
      return 'moderation';
    case 'transcribe':
    case 'stt':
      return 'stt';
    case 'audio': {
      // Together lists its speech models as `audio`; a transcription model there reads as one by its id.
      const inferred = inferCatalogCategory(id);
      return inferred === 'stt' ? 'stt' : 'tts';
    }
    case 'video':
      return null;
    default:
      return undefined;
  }
}

function inputModalitiesOf(values: string[]): ModelInputModality[] | undefined {
  const modalities = [...new Set(values.map((value) => value.trim().toLowerCase()))].filter(
    (value): value is ModelInputModality => INPUT_MODALITIES.has(value as ModelInputModality),
  );
  return modalities.length > 0 ? modalities : undefined;
}

/**
 * One entry of an OpenAI-shaped list, reading the extra fields the OpenAI-compatible servers add:
 * - OpenRouter: `name`, `description`, `context_length`, `pricing` (per token), `architecture.*_modalities`,
 *   `top_provider.max_completion_tokens`, `supported_parameters`.
 * - Together: `type`, `display_name`, `organization`, `context_length`, `pricing` (per 1M).
 * - Groq: `context_window`, `max_completion_tokens`, `active`.
 * - Mistral: `max_context_length`, `capabilities.{completion_chat,function_calling,vision}`, `deprecation`.
 * - vLLM: `max_model_len`. Fireworks: `supports_chat`, `supports_tools`, `supports_image_input`, `context_length`.
 * - DeepInfra: `metadata.{description,context_length,max_tokens}`.
 */
function parseOpenAiShapedEntry(item: unknown): ParsedModel | null {
  if (!isObject(item)) return null;
  const id = str(item.id);
  if (!id) return null;

  const architecture = isObject(item.architecture) ? item.architecture : undefined;
  const topProvider = isObject(item.top_provider) ? item.top_provider : undefined;
  const capabilities = isObject(item.capabilities) ? item.capabilities : undefined;
  const metadata = isObject(item.metadata) ? item.metadata : undefined;
  const pricing = isObject(item.pricing) ? item.pricing : undefined;
  const supportedParameters = Array.isArray(item.supported_parameters) ? strings(item.supported_parameters) : undefined;
  const outputModalities = strings(architecture?.output_modalities);

  let category: ModelCategory | null;
  const typed = categoryOfType(str(item.type), id);
  if (typed !== undefined) {
    category = typed;
  } else {
    category = inferCatalogCategory(id, outputModalities.length > 0 ? { outputModalities } : undefined);
    // The provider says the model does not chat (Mistral's OCR and embedding models, a Fireworks base model): an id
    // that reads as a chat model is then one no route here can serve.
    const chats = bool(capabilities?.completion_chat) ?? bool(item.supports_chat);
    if (category === 'llm' && chats === false) category = null;
  }

  const contextWindow = positiveInt(item.context_length)
    ?? positiveInt(item.context_window)
    ?? positiveInt(item.max_context_length)
    ?? positiveInt(item.max_model_len)
    ?? positiveInt(topProvider?.context_length)
    ?? positiveInt(metadata?.context_length);
  const maxOutputTokens = positiveInt(topProvider?.max_completion_tokens)
    ?? positiveInt(item.max_completion_tokens)
    ?? positiveInt(item.max_output_tokens)
    ?? positiveInt(metadata?.max_tokens);

  let inputModalities = inputModalitiesOf(strings(architecture?.input_modalities));
  const vision = bool(capabilities?.vision) ?? bool(item.supports_image_input);
  if (!inputModalities && vision !== undefined && category === 'llm') {
    inputModalities = vision ? ['text', 'image'] : ['text'];
  }

  const has = (...names: string[]) => (supportedParameters ? names.some((name) => supportedParameters.includes(name)) : undefined);
  const supportsToolCalls = has('tools') ?? bool(capabilities?.function_calling) ?? bool(item.supports_tools);
  const supportsReasoning = has('reasoning', 'include_reasoning');
  const supportsStructuredOutputs = has('structured_outputs', 'response_format');

  let providerPricing: CatalogModelPricing | undefined;
  if (pricing && 'prompt' in pricing) providerPricing = openRouterPricing(pricing);
  else if (pricing && 'input' in pricing) providerPricing = togetherPricing(pricing);

  const deprecated = str(item.deprecation) !== undefined || item.active === false || item.is_deprecated === true;
  const about = description(item.description) ?? description(metadata?.description);
  const ownedBy = str(item.owned_by) ?? str(item.organization);
  const createdAt = timestamp(item.created);

  return {
    id,
    name: str(item.display_name) ?? str(item.name) ?? defaultModelName(id),
    ...(about ? { description: about } : {}),
    category,
    ...(ownedBy ? { ownedBy } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(supportsToolCalls !== undefined ? { supportsToolCalls } : {}),
    ...(supportsReasoning !== undefined ? { supportsReasoning } : {}),
    ...(supportsStructuredOutputs !== undefined ? { supportsStructuredOutputs } : {}),
    ...(deprecated ? { deprecated: true } : {}),
    ...(providerPricing ? { pricing: providerPricing } : {}),
  };
}

/**
 * Any OpenAI-shaped list: `{ data: [...] }` or a bare array, with whatever extra fields the server adds (see
 * `parseOpenAiShapedEntry`). Used for OpenAI, Together and every OpenAI-compatible server.
 */
export function parseOpenAiCompatibleModels(body: unknown): ParsedModel[] {
  return dedupe(listOf(body).map(parseOpenAiShapedEntry).filter((model): model is ParsedModel => model !== null));
}

/** OpenAI: `{ data: [{ id, created, owned_by }] }`. */
export function parseOpenAiModels(body: unknown): ParsedModel[] {
  return parseOpenAiCompatibleModels(isObject(body) ? body : {});
}

/** Together: a bare array of `{ id, type, display_name, context_length, pricing: { input, output } }`. */
export function parseTogetherModels(body: unknown): ParsedModel[] {
  return parseOpenAiCompatibleModels(body);
}

export interface AnthropicModelPage {
  models: ParsedModel[];
  hasMore: boolean;
  lastId?: string;
}

/** Anthropic: `{ data: [{ id, display_name, created_at, type }], has_more, last_id }`. */
export function parseAnthropicModels(body: unknown): AnthropicModelPage {
  const models: ParsedModel[] = [];
  for (const item of listOf(body)) {
    if (!isObject(item)) continue;
    const id = str(item.id);
    if (!id) continue;
    const contextWindow = positiveInt(item.max_input_tokens);
    const maxOutputTokens = positiveInt(item.max_tokens);
    models.push({
      id,
      name: str(item.display_name) ?? defaultModelName(id),
      category: inferCatalogCategory(id),
      ...(timestamp(item.created_at) ? { createdAt: timestamp(item.created_at) } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    });
  }
  const record = isObject(body) ? body : {};
  return { models: dedupe(models), hasMore: record.has_more === true, lastId: str(record.last_id) };
}

/**
 * Azure OpenAI deployments: `{ data: [{ id, model, status, created_at, object: 'deployment' }] }`. The deployment
 * name is what a request addresses, so it is the id; the model it serves is `upstreamModel` and decides the category.
 * A deployment that is still being created or failed (`status` other than `succeeded`) is left out.
 */
export function parseAzureDeployments(body: unknown): ParsedModel[] {
  const models: ParsedModel[] = [];
  for (const item of listOf(body)) {
    if (!isObject(item)) continue;
    const id = str(item.id);
    if (!id) continue;
    const status = str(item.status);
    if (status !== undefined && status.toLowerCase() !== 'succeeded') continue;
    const upstreamModel = str(item.model);
    models.push({
      id,
      name: id,
      category: inferCatalogCategory(upstreamModel ?? id),
      ...(upstreamModel ? { upstreamModel } : {}),
      ...(timestamp(item.created_at) ? { createdAt: timestamp(item.created_at) } : {}),
    });
  }
  return dedupe(models);
}

export interface BedrockFoundationModels {
  /** The models callable on demand by their own id: what the catalog lists. */
  onDemand: ParsedModel[];
  /** Every listed model by id, on-demand or not: inference profiles read their category and vision from here. */
  byId: Map<string, ParsedModel>;
}

/**
 * Bedrock `ListFoundationModels`: `{ modelSummaries: [{ modelId, modelName, providerName, inputModalities,
 * outputModalities, inferenceTypesSupported, modelLifecycle: { status } }] }`.
 *
 * Only `ON_DEMAND` models are listed: a model offered only through inference profiles (`INFERENCE_PROFILE`) is
 * reachable through those, which are listed separately, and a `PROVISIONED`-only variant (`…:28k`) needs a purchased
 * throughput. Text output is a chat model, embedding output an embedding model; image, video and speech generators
 * are not served by the Converse route.
 */
export function parseBedrockFoundationModels(body: unknown): BedrockFoundationModels {
  const byId = new Map<string, ParsedModel>();
  const onDemand: ParsedModel[] = [];
  for (const item of listOf(body, 'modelSummaries')) {
    if (!isObject(item)) continue;
    const id = str(item.modelId);
    if (!id || byId.has(id)) continue;
    const inputs = strings(item.inputModalities).map((value) => value.toUpperCase());
    const outputs = strings(item.outputModalities).map((value) => value.toUpperCase());

    let category: ModelCategory | null;
    if (outputs.includes('EMBEDDING')) {
      category = 'embedding';
    } else if (outputs.includes('TEXT') && !outputs.some((value) => value === 'SPEECH' || value === 'VIDEO' || value === 'IMAGE')
      && !inputs.includes('SPEECH')) {
      // Text output: a chat model, unless the id says otherwise (`cohere.rerank-…`, `amazon.rerank-…`).
      category = inferCatalogCategory(id);
    } else {
      category = null;
    }

    const lifecycle = isObject(item.modelLifecycle) ? str(item.modelLifecycle.status) : undefined;
    const model: ParsedModel = {
      id,
      name: str(item.modelName) ?? defaultModelName(id),
      category,
      ...(str(item.providerName) ? { ownedBy: str(item.providerName) } : {}),
      ...(category === 'llm' && inputs.length > 0
        ? { inputModalities: inputs.includes('IMAGE') ? ['text', 'image'] as ModelInputModality[] : ['text'] as ModelInputModality[] }
        : {}),
      ...(lifecycle?.toUpperCase() === 'LEGACY' ? { deprecated: true } : {}),
    };
    byId.set(id, model);
    if (strings(item.inferenceTypesSupported).map((value) => value.toUpperCase()).includes('ON_DEMAND')) {
      onDemand.push(model);
    }
  }
  return { onDemand, byId };
}

export interface BedrockInferenceProfilePage {
  models: ParsedModel[];
  nextToken?: string;
}

/** The foundation model id inside a model ARN (`arn:aws:bedrock:<region>::foundation-model/<id>`). */
export function foundationModelIdOfArn(arn: string): string | undefined {
  const match = /:foundation-model\/(.+)$/.exec(arn.trim());
  return match ? match[1] : undefined;
}

/**
 * Bedrock `ListInferenceProfiles`: `{ inferenceProfileSummaries: [{ inferenceProfileId, inferenceProfileName,
 * description, status, type, models: [{ modelArn }] }], nextToken }`. A profile id (`us.anthropic.claude-…`) is what a
 * request names; the foundation model behind it (from the first model ARN) gives the category and vision when the
 * foundation-model list knows it, otherwise the id is read like any other.
 */
export function parseBedrockInferenceProfiles(
  body: unknown,
  foundation: ReadonlyMap<string, ParsedModel> = new Map(),
): BedrockInferenceProfilePage {
  const models: ParsedModel[] = [];
  for (const item of listOf(body, 'inferenceProfileSummaries')) {
    if (!isObject(item)) continue;
    const id = str(item.inferenceProfileId);
    if (!id) continue;
    const status = str(item.status);
    if (status !== undefined && status.toUpperCase() !== 'ACTIVE') continue;

    const firstModel = Array.isArray(item.models) ? item.models.find(isObject) : undefined;
    const arn = firstModel ? str(firstModel.modelArn) : undefined;
    const upstreamModel = arn ? foundationModelIdOfArn(arn) : undefined;
    const known = upstreamModel ? foundation.get(upstreamModel) : undefined;

    models.push({
      id,
      name: str(item.inferenceProfileName) ?? defaultModelName(id),
      ...(description(item.description) ? { description: description(item.description) } : {}),
      category: known ? known.category : inferCatalogCategory(upstreamModel ?? id),
      ...(known?.ownedBy ? { ownedBy: known.ownedBy } : {}),
      ...(timestamp(item.createdAt) ? { createdAt: timestamp(item.createdAt) } : {}),
      ...(known?.inputModalities ? { inputModalities: known.inputModalities } : {}),
      ...(upstreamModel ? { upstreamModel } : {}),
      ...(known?.deprecated ? { deprecated: true } : {}),
    });
  }
  const record = isObject(body) ? body : {};
  return { models: dedupe(models), nextToken: str(record.nextToken) };
}

/**
 * Cohere: `{ models: [{ name, endpoints: [...], context_length }] }`. The Cohere driver here serves reranking only,
 * so only models whose `endpoints` include `rerank` are kept.
 */
export function parseCohereModels(body: unknown): ParsedModel[] {
  const models: ParsedModel[] = [];
  for (const item of listOf(body, 'models')) {
    if (!isObject(item)) continue;
    const id = str(item.name);
    if (!id) continue;
    if (!strings(item.endpoints).map((value) => value.toLowerCase()).includes('rerank')) continue;
    const contextWindow = positiveInt(item.context_length);
    models.push({
      id,
      name: id,
      category: 'rerank',
      ...(contextWindow ? { contextWindow } : {}),
      ...(item.is_deprecated === true ? { deprecated: true } : {}),
    });
  }
  return dedupe(models);
}

export interface AzureDocumentModelPage {
  models: ParsedModel[];
  nextLink?: string;
}

/** Azure Document Intelligence: `{ value: [{ modelId, description, createdDateTime }], nextLink }`, all OCR models. */
export function parseAzureDocumentModels(body: unknown): AzureDocumentModelPage {
  const models: ParsedModel[] = [];
  for (const item of listOf(body, 'value')) {
    if (!isObject(item)) continue;
    const id = str(item.modelId);
    if (!id) continue;
    models.push({
      id,
      name: id,
      ...(description(item.description) ? { description: description(item.description) } : {}),
      category: 'ocr',
      ...(timestamp(item.createdDateTime) ? { createdAt: timestamp(item.createdDateTime) } : {}),
    });
  }
  const record = isObject(body) ? body : {};
  return { models: dedupe(models), nextLink: str(record.nextLink) };
}
