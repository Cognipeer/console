/**
 * Model discovery: the models a provider can serve, asked from the provider itself.
 *
 * Each driver is listed from its own "list models" API with the provider's stored credentials (live), from the market
 * reference catalog when the API has no list route (Vertex), or from a short built-in list (rerank vendors, decision
 * APIs). The calls follow the rules of "Test connection" (`providerConnectionTest.ts`): every endpoint is vetted by the
 * outbound guard before anything is dialled, every request goes through `safeFetch` with the organization's guard
 * options, no redirect is followed, and the body of a failed request is never read (an upstream error page can echo
 * what was sent). Messages are scrubbed of every credential value.
 *
 * The listing is then filtered to the categories the driver serves, sorted, capped and enriched from the reference
 * catalog (prices, limits, capability flags) where the provider said nothing itself.
 */
import type { ModelCategory, ProviderDomain } from '@/lib/database';
import {
  OutboundNetworkError,
  OutboundPrivateTargetError,
  readResponseText,
  ResponseTooLargeError,
  safeFetch,
} from '@/lib/security/outboundFetch';
import {
  assertProviderTestEndpointsAllowed,
  endpointGuardOptions,
  ProviderEndpointError,
  toProviderEndpointError,
} from '@/lib/services/providers/providerEndpointGuard';
import { scrubMessage, secretsOf } from '@/lib/services/providers/providerConnectionTest';
import {
  getCatalogEntries,
  indexCatalogEntries,
  matchCatalogEntry,
  type CatalogEntryMatch,
  type ModelPriceCatalogEntry,
  type ModelPriceCatalogIndex,
} from '@/lib/services/modelPriceCatalog/modelPriceCatalog';
import { normalizeAnthropicBaseUrl } from '@/lib/providers/contracts/anthropicBaseUrl';
import { awsQuery, signAwsGetRequest } from './awsSigV4';
import { constrainCategory, inferCatalogCategory } from './inferCategory';
import {
  defaultModelName,
  parseAnthropicModels,
  parseAzureDeployments,
  parseAzureDocumentModels,
  parseBedrockFoundationModels,
  parseBedrockInferenceProfiles,
  parseCohereModels,
  parseOpenAiCompatibleModels,
  parseOpenAiModels,
  parseTogetherModels,
  type ParsedModel,
} from './parsers';
import { staticCatalogFor } from './staticCatalog';
import {
  CATALOG_MAX_MODELS,
  type CatalogError,
  type CatalogErrorCode,
  type CatalogModel,
  type CatalogNotice,
  type CatalogSource,
  type ProviderModelCatalog,
} from './types';

/** One request of a listing never waits longer than this. */
export const CATALOG_REQUEST_TIMEOUT_MS = 15_000;
/** A whole listing (every page and request together) never takes longer than this. */
export const CATALOG_OVERALL_TIMEOUT_MS = 20_000;
/**
 * How long the enrichment waits for the reference catalog. Its first load is a large download; when it takes longer
 * the listing is answered without reference prices and the download goes on, so the next listing has them.
 */
export const CATALOG_REFERENCE_WAIT_MS = 2_500;
/** OpenRouter and Bedrock lists are a few MB at most; anything far beyond that is not a model list. */
export const CATALOG_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Paged lists (Anthropic, Bedrock inference profiles, Azure Document Intelligence) are read up to this many pages. */
const MAX_PAGES = 5;
/**
 * How many raw entries a listing reads, across all its pages. Real lists (OpenRouter, Together, Bedrock) hold well under
 * 1000 models; past this the rest of an answer is not parsed, sorted or paged through, since the catalog would cut it
 * to `CATALOG_MAX_MODELS` anyway and the work runs on the shared event loop.
 */
const MAX_LISTED_ENTRIES = CATALOG_MAX_MODELS * 4;
/**
 * Fuzzy reference matching scans every catalog key per name. Past this many names a listing keeps its exact and
 * normalized matches only, which keeps the CPU time of a very long list bounded.
 */
const MAX_FUZZY_LOOKUPS = 500;

export interface DiscoveryInput {
  driver: string;
  type: ProviderDomain;
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
  tenantId: string;
  /** The categories the driver serves (`model.categories` of its contract); everything else is left out. */
  allowedCategories: ModelCategory[];
}

/** Seams for tests; production uses the guarded fetch and the market reference catalog. */
export interface DiscoveryDeps {
  fetchImpl?: typeof safeFetch;
  /** The reference catalog entries (default: the LiteLLM price catalog, loaded lazily and cached for a day). */
  referenceEntries?: () => Promise<ModelPriceCatalogEntry[]>;
  /** How long the enrichment waits for the reference catalog (default `CATALOG_REFERENCE_WAIT_MS`). */
  referenceWaitMs?: number;
  /** Limit of one request (default `CATALOG_REQUEST_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Limit of the whole listing (default `CATALOG_OVERALL_TIMEOUT_MS`). */
  overallTimeoutMs?: number;
  /** The clock of `fetchedAt` and of request signing. */
  now?: () => Date;
}

export type DiscoveryResult = Omit<ProviderModelCatalog, 'provider'>;

/** A listing that failed, with the code the dashboard translates. The message is scrubbed before it leaves. */
class ListingError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ListingError';
  }
}

/** What a driver's lister found, before filtering. */
interface Listing {
  source: CatalogSource | 'none';
  supported: boolean;
  models: ParsedModel[];
  error?: ListingError;
  notices: CatalogNotice[];
  /** Candidate keys a model is looked up under in the reference catalog, best first. */
  referenceKeys?: (model: ParsedModel) => string[];
  /** Whether a reference entry may price this listing's models (Bedrock: not another region's key). Default: any. */
  acceptsReference?: (entry: ModelPriceCatalogEntry) => boolean;
}

interface Context {
  input: DiscoveryInput;
  fetchImpl: typeof safeFetch;
  timeoutMs: number;
  /** The limit of the whole listing, and the `Date.now()` past which nothing is dialled any more. */
  overallMs: number;
  deadline: number;
  now: () => Date;
  reference: ReferenceLoader;
}

const CATEGORY_ORDER: readonly ModelCategory[] = ['llm', 'embedding', 'rerank', 'stt', 'tts', 'image', 'moderation', 'ocr', 'decision'];
const ENRICHED_CATEGORIES: ReadonlySet<ModelCategory> = new Set(['llm', 'embedding']);
const CHAT_MODES: ReadonlySet<string> = new Set(['chat', 'completion', 'responses']);

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const trimSlash = (value: string): string => value.replace(/\/+$/, '');

/* ------------------------------------------------------------------ */
/* Reference catalog                                                   */
/* ------------------------------------------------------------------ */

/**
 * The reference catalog, asked for at most once per listing. The load starts when the listing starts (so it runs
 * alongside the provider call) and is never cancelled: a load that outlives the wait fills the module cache of the
 * price catalog for the next listing.
 */
interface ReferenceLoader {
  start(): void;
  /** The entries, or `null` when they are not there within `ms` (or failed to load). */
  wait(ms: number): Promise<ModelPriceCatalogEntry[] | null>;
}

function referenceLoader(load: () => Promise<ModelPriceCatalogEntry[]>): ReferenceLoader {
  let pending: Promise<ModelPriceCatalogEntry[] | null> | undefined;
  let settled: { value: ModelPriceCatalogEntry[] | null } | undefined;
  const start = () => {
    if (pending) return;
    // A failed load is "not available"; the rejection is handled here so it is never left unobserved.
    pending = Promise.resolve()
      .then(load)
      .then((entries) => (Array.isArray(entries) ? entries : null), () => null)
      .then((value) => {
        settled = { value };
        return value;
      });
  };
  return {
    start,
    async wait(ms) {
      start();
      if (settled) return settled.value;
      if (ms <= 0) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      });
      try {
        return await Promise.race([pending as Promise<ModelPriceCatalogEntry[] | null>, expired]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

interface HttpAnswer {
  status: number;
  /** The parsed body of a 2xx; a failure's body is never read. */
  body?: unknown;
}

function seconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

function timeoutError(ms: number): ListingError {
  return new ListingError('timeout', `The provider did not answer within ${seconds(ms)} s.`);
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Any failure of a request, as the error a person is shown. */
function toListingError(error: unknown, limitMs: number, aborted: boolean): ListingError {
  if (error instanceof ListingError) return error;
  if (aborted || isAbortError(error)) return timeoutError(limitMs);
  if (error instanceof ResponseTooLargeError) {
    return new ListingError('upstream_error', 'The model list is larger than this console reads; it was not loaded.');
  }
  if (error instanceof ProviderEndpointError) return new ListingError('endpoint_not_allowed', error.message);
  if (error instanceof OutboundPrivateTargetError) {
    const refused = toProviderEndpointError('endpoint', error);
    return new ListingError('endpoint_not_allowed', refused instanceof Error ? refused.message : 'The endpoint is not allowed.');
  }
  if (error instanceof OutboundNetworkError) return new ListingError('unreachable', error.message);
  const message = error instanceof Error ? error.message : '';
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const detail = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : '';
  return new ListingError(
    'unreachable',
    `The provider could not be reached${message || detail ? `: ${[message, detail].filter(Boolean).join(' - ')}` : '.'}`,
  );
}

/** A non-2xx answer the lister did not handle itself. */
function statusError(status: number): ListingError {
  if (status === 401 || status === 403) {
    return new ListingError('auth_failed', `The provider rejected the credentials (HTTP ${status}).`, status);
  }
  if (status >= 300 && status < 400) {
    return new ListingError('upstream_error', `The endpoint redirected the request (HTTP ${status}); check the base URL.`, status);
  }
  if (status === 429) {
    return new ListingError('upstream_error', 'The provider is limiting requests (HTTP 429); try again shortly.', status);
  }
  return new ListingError('upstream_error', `The provider answered HTTP ${status}.`, status);
}

/**
 * GET `url` as JSON: one request, bounded by the request limit and what is left of the listing's, with the guard
 * options of the organization and no redirect followed. A non-2xx comes back as its status only.
 */
async function getJson(ctx: Context, url: string, headers: Record<string, string>): Promise<HttpAnswer> {
  const limit = Math.min(ctx.timeoutMs, ctx.deadline - Date.now());
  if (limit <= 0) throw timeoutError(ctx.overallMs);
  const controller = new AbortController();
  // Covers the body as well: `safeFetch`'s own limit ends when the headers arrive.
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    const response = await ctx.fetchImpl(
      url,
      { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal: controller.signal },
      { ...endpointGuardOptions(ctx.input.tenantId), timeoutMs: limit, followRedirects: false },
    );
    if (response.status < 200 || response.status >= 300) {
      // The body of a failure is never read; it is released unread.
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status };
    }
    const text = await readResponseText(response, { maxBytes: CATALOG_MAX_RESPONSE_BYTES, signal: controller.signal });
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      throw new ListingError(
        'upstream_error',
        'The provider answered with something that is not a model list; check the endpoint address.',
        response.status,
      );
    }
  } catch (error) {
    throw toListingError(error, limit, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}

/** `getJson` for listers that accept a 2xx only. */
async function getListJson(ctx: Context, url: string, headers: Record<string, string>): Promise<unknown> {
  const answer = await getJson(ctx, url, headers);
  if (answer.status < 200 || answer.status >= 300) throw statusError(answer.status);
  return answer.body;
}

/* ------------------------------------------------------------------ */
/* Listers                                                             */
/* ------------------------------------------------------------------ */

const live = (models: ParsedModel[], extra: Partial<Listing> = {}): Listing => ({
  source: 'live',
  supported: true,
  models,
  notices: [],
  ...extra,
});

const unsupported = (): Listing => ({ source: 'none', supported: false, models: [], notices: [] });

function staticModels(driver: string): ParsedModel[] {
  return (staticCatalogFor(driver) ?? []).map((entry) => ({
    id: entry.id,
    name: entry.name,
    category: entry.category,
    ...(entry.description ? { description: entry.description } : {}),
  }));
}

function staticListing(driver: string, notice: CatalogNotice['code'] = 'static_listing'): Listing {
  return { source: 'static', supported: true, models: staticModels(driver), notices: [{ code: notice }] };
}

/** A key the driver cannot do without; its absence is reported instead of sending an empty credential. */
function requireCredential(ctx: Context, name: string): string {
  const value = asString(ctx.input.credentials[name]);
  if (!value) {
    throw new ListingError('credentials_unavailable', `The provider has no ${name === 'apiKey' ? 'API key' : name} stored.`);
  }
  return value;
}

/** Runs a live lister and answers with the driver's built-in list (plus the error) when it fails or finds nothing. */
async function withStaticFallback(ctx: Context, run: () => Promise<Listing>): Promise<Listing> {
  try {
    const listing = await run();
    if (listing.models.length > 0) return listing;
    return staticListing(ctx.input.driver, 'listing_fallback');
  } catch (error) {
    const failure = toListingError(error, ctx.timeoutMs, false);
    // A refused endpoint or unusable settings are not a failed listing: the models could not be used either.
    if (failure.code === 'endpoint_not_allowed' || failure.code === 'invalid_settings') throw failure;
    return { ...staticListing(ctx.input.driver, 'listing_fallback'), error: failure };
  }
}

async function listOpenAi(ctx: Context): Promise<Listing> {
  const apiKey = requireCredential(ctx, 'apiKey');
  const organization = asString(ctx.input.settings.organization);
  const body = await getListJson(ctx, 'https://api.openai.com/v1/models', {
    Authorization: `Bearer ${apiKey}`,
    ...(organization ? { 'OpenAI-Organization': organization } : {}),
  });
  return live(parseOpenAiModels(body, MAX_LISTED_ENTRIES));
}

/**
 * Hosts of OpenAI-compatible services whose prices the reference catalog keeps under a prefix of its own
 * (`groq/llama-…`): the prefixed key is looked up first, so a model gets that vendor's price rather than another's.
 */
const COMPATIBLE_REFERENCE_PREFIXES: ReadonlyMap<string, string> = new Map([
  ['api.groq.com', 'groq'],
  ['api.mistral.ai', 'mistral'],
  ['api.deepseek.com', 'deepseek'],
  ['api.x.ai', 'xai'],
  ['api.together.xyz', 'together_ai'],
  ['api.fireworks.ai', 'fireworks_ai'],
  ['api.deepinfra.com', 'deepinfra'],
  ['api.perplexity.ai', 'perplexity'],
  ['api.cerebras.ai', 'cerebras'],
  ['openrouter.ai', 'openrouter'],
  ['generativelanguage.googleapis.com', 'gemini'],
]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Azure's OpenAI base (`https://<res>.openai.azure.com/openai[/v1]`), the same shape `azureAudioOverrides` serves in
 * modelContracts.ts. There `model` is a deployment name, and `/models` lists the resource's base-model catalog
 * (`gpt-4o-2024-08-06`, `dall-e-3-3.0` …), not its deployments: none of those ids would answer a request.
 */
const AZURE_OPENAI_BASE = /^(https:\/\/[^/]+\.(?:openai\.azure\.com|cognitiveservices\.azure\.com))\/openai(?:\/v1)?$/i;

/** The deployments route of an Azure OpenAI resource; it only exists in this preview version, newer ones dropped it. */
const azureDeploymentsUrl = (origin: string) => `${origin}/openai/deployments?api-version=2023-03-15-preview`;

/** An Azure deployment is priced as the model it serves, under Azure's own key first. */
const azureReferenceKeys = (model: ParsedModel): string[] => [
  `azure/${model.upstreamModel ?? model.id}`,
  model.id,
  ...(model.upstreamModel ? [model.upstreamModel] : []),
];

async function listOpenAiCompatible(ctx: Context): Promise<Listing> {
  const base = trimSlash(asString(ctx.input.settings.baseUrl));
  if (!base) throw new ListingError('invalid_settings', 'The provider has no base URL.');
  // A local server may run without a key; the headers are sent only when one is stored.
  const apiKey = asString(ctx.input.credentials.apiKey);

  const azure = AZURE_OPENAI_BASE.exec(base);
  if (azure) {
    // The deployments are what a request can name; the resource's `/models` is never offered in their place.
    if (!apiKey) return unsupported();
    const deployments = await getJson(ctx, azureDeploymentsUrl(azure[1]), { 'api-key': apiKey });
    // A resource that does not list deployments (the route was dropped, or is not offered here): custom entry.
    if (deployments.status === 400 || deployments.status === 404 || deployments.status === 405) return unsupported();
    if (deployments.status < 200 || deployments.status >= 300) throw statusError(deployments.status);
    return live(parseAzureDeployments(deployments.body, MAX_LISTED_ENTRIES), { referenceKeys: azureReferenceKeys });
  }

  const answer = await getJson(ctx, `${base}/models`, apiKey ? { Authorization: `Bearer ${apiKey}`, 'api-key': apiKey } : {});
  // No list route on this server: the dashboard goes straight to custom entry.
  if (answer.status === 404 || answer.status === 405 || answer.status === 501) return unsupported();
  if (answer.status < 200 || answer.status >= 300) throw statusError(answer.status);

  const prefix = COMPATIBLE_REFERENCE_PREFIXES.get(hostOf(base));
  return live(parseOpenAiCompatibleModels(answer.body, MAX_LISTED_ENTRIES), {
    referenceKeys: (model) => {
      // Gemini's OpenAI endpoint names models `models/gemini-…`; the catalog keys them without the path.
      const bare = prefix === 'gemini' ? model.id.replace(/^models\//, '') : model.id;
      return [...(prefix ? [`${prefix}/${bare}`] : []), model.id];
    },
  });
}

async function listTogether(ctx: Context): Promise<Listing> {
  const apiKey = requireCredential(ctx, 'apiKey');
  const body = await getListJson(ctx, 'https://api.together.xyz/v1/models', { Authorization: `Bearer ${apiKey}` });
  return live(parseTogetherModels(body, MAX_LISTED_ENTRIES), { referenceKeys: (model) => [`together_ai/${model.id}`, model.id] });
}

async function listAnthropic(ctx: Context): Promise<Listing> {
  const apiKey = requireCredential(ctx, 'apiKey');
  const base = normalizeAnthropicBaseUrl(asString(ctx.input.settings.baseUrl)) ?? 'https://api.anthropic.com';
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const models: ParsedModel[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${base}/v1/models?limit=1000${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`;
    const answer = await getJson(ctx, url, headers);
    // A gateway that serves the Messages API without the models route (Azure AI Foundry).
    if (page === 0 && answer.status === 404) return unsupported();
    if (answer.status < 200 || answer.status >= 300) throw statusError(answer.status);
    const parsed = parseAnthropicModels(answer.body, MAX_LISTED_ENTRIES - models.length);
    // One by one: spreading a very long page into `push` overflows the call stack.
    for (const model of parsed.models) models.push(model);
    // A listing this long is cut by the catalog anyway: no further page is fetched.
    if (models.length >= MAX_LISTED_ENTRIES) break;
    if (!parsed.hasMore || !parsed.lastId || parsed.lastId === afterId) break;
    afterId = parsed.lastId;
  }
  return live(models);
}

const AZURE_RESOURCE_NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/i;

/** The Azure resource name, which becomes the host name: anything but a plain DNS label is refused. */
function azureInstanceOf(ctx: Context): string {
  const instance = asString(ctx.input.settings.instanceName);
  if (!AZURE_RESOURCE_NAME.test(instance)) {
    throw new ListingError('invalid_settings', 'The instance name must be the plain name of the Azure OpenAI resource.');
  }
  return instance;
}

async function listAzure(ctx: Context): Promise<Listing> {
  const instance = azureInstanceOf(ctx);
  const apiKey = requireCredential(ctx, 'apiKey');
  const answer = await getJson(ctx, azureDeploymentsUrl(`https://${instance}.openai.azure.com`), { 'api-key': apiKey });
  if (answer.status === 404 || answer.status === 400) {
    // The resource does not list deployments: the one the provider is configured with is all that is known.
    const deployment = asString(ctx.input.settings.deploymentName);
    const models: ParsedModel[] = deployment
      ? [{ id: deployment, name: deployment, category: inferCatalogCategory(deployment) ?? 'llm' }]
      : [];
    return {
      source: 'static',
      supported: true,
      models,
      notices: [{ code: 'azure_deployments_unlisted' }],
      referenceKeys: (model) => [`azure/${model.id}`, model.id],
    };
  }
  if (answer.status < 200 || answer.status >= 300) throw statusError(answer.status);
  return live(parseAzureDeployments(answer.body, MAX_LISTED_ENTRIES), { referenceKeys: azureReferenceKeys });
}

const AWS_REGION_ID = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

/** The AWS region, which becomes part of the host name. */
function bedrockRegionOf(ctx: Context): string {
  const region = asString(ctx.input.settings.region);
  if (!AWS_REGION_ID.test(region)) {
    throw new ListingError('invalid_settings', 'The region must be an AWS region id such as us-east-1.');
  }
  return region;
}

async function listBedrock(ctx: Context): Promise<Listing> {
  const region = bedrockRegionOf(ctx);
  const accessKeyId = requireCredential(ctx, 'accessKeyId');
  const secretAccessKey = requireCredential(ctx, 'secretAccessKey');
  const sessionToken = asString(ctx.input.credentials.sessionToken) || undefined;
  const origin = `https://bedrock.${region}.${region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`;

  const signedGet = async (url: string) => {
    const signed = signAwsGetRequest({ url, region, service: 'bedrock', accessKeyId, secretAccessKey, sessionToken, now: ctx.now() });
    // `host` is signed but not sent by hand: the HTTP client sets it from the URL, to the same value.
    const headers = Object.fromEntries(Object.entries(signed).filter(([name]) => name !== 'host'));
    return getListJson(ctx, url, headers);
  };

  const profilePages = async (): Promise<unknown[]> => {
    const pages: unknown[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      // The API's `typeEquals` member is the `type` query parameter on the wire.
      const query = awsQuery({ maxResults: '1000', type: 'SYSTEM_DEFINED', nextToken });
      const body = await signedGet(`${origin}/inference-profiles?${query}`);
      pages.push(body);
      const token = parseBedrockInferenceProfiles(body).nextToken;
      if (!token || token === nextToken) break;
      nextToken = token;
    }
    return pages;
  };

  // Both lists at once; a failure of the profiles alone still lists the foundation models.
  const [foundationBody, profiles] = await Promise.all([
    signedGet(`${origin}/foundation-models`),
    // Without the profiles (an IAM policy that allows ListFoundationModels only) the on-demand models still list.
    profilePages().catch(() => [] as unknown[]),
  ]);
  const foundation = parseBedrockFoundationModels(foundationBody);
  const models = [...foundation.onDemand];
  for (const page of profiles) {
    for (const model of parseBedrockInferenceProfiles(page, foundation.byId).models) models.push(model);
  }
  return live(models, {
    // The reference catalog keeps regional prices as `bedrock/<region>/<id>`; the bare key is the us-east-1 price.
    referenceKeys: (model) => [
      `bedrock/${region}/${model.id}`,
      ...(model.upstreamModel ? [`bedrock/${region}/${model.upstreamModel}`] : []),
      model.id,
      ...(model.upstreamModel ? [model.upstreamModel] : []),
    ],
    // A price kept for another region (GovCloud, eu-…) or a commitment price never stands in for this region's.
    acceptsReference: (entry) => {
      const scoped = /^bedrock\/([^/]+)\//.exec(entry.key);
      return !scoped || (scoped[1] === region && !entry.key.includes('-commitment/'));
    },
  });
}

async function listCohere(ctx: Context): Promise<Listing> {
  const apiKey = requireCredential(ctx, 'apiKey');
  const body = await getListJson(ctx, 'https://api.cohere.com/v1/models?endpoint=rerank&page_size=1000', {
    Authorization: `Bearer ${apiKey}`,
  });
  return live(parseCohereModels(body));
}

async function listMistralOcr(ctx: Context): Promise<Listing> {
  const apiKey = requireCredential(ctx, 'apiKey');
  const base = trimSlash(asString(ctx.input.settings.baseUrl) || 'https://api.mistral.ai/v1');
  const body = await getListJson(ctx, `${base}/models`, { Authorization: `Bearer ${apiKey}` });
  // The OCR endpoint takes the OCR models only; Mistral's list holds every model of the account.
  const models = parseOpenAiCompatibleModels(body, MAX_LISTED_ENTRIES)
    .filter((model) => model.id.toLowerCase().includes('ocr'))
    .map((model) => ({ ...model, category: 'ocr' as const }));
  return live(models);
}

async function listAzureDocumentIntelligence(ctx: Context): Promise<Listing> {
  const endpoint = trimSlash(asString(ctx.input.settings.endpoint));
  let origin: string;
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('not http');
    origin = parsed.origin;
  } catch {
    throw new ListingError('invalid_settings', 'The endpoint must be the https URL of the Document Intelligence resource.');
  }
  const apiKey = requireCredential(ctx, 'apiKey');
  const apiVersion = asString(ctx.input.settings.apiVersion) || '2024-11-30';
  const headers = { 'Ocp-Apim-Subscription-Key': apiKey };

  const models: ParsedModel[] = [];
  let url: string | undefined = `${endpoint}/documentintelligence/documentModels?api-version=${encodeURIComponent(apiVersion)}`;
  for (let page = 0; page < MAX_PAGES && url; page += 1) {
    const parsed = parseAzureDocumentModels(await getListJson(ctx, url, headers), MAX_LISTED_ENTRIES - models.length);
    // One by one: spreading a very long page into `push` overflows the call stack.
    for (const model of parsed.models) models.push(model);
    url = undefined;
    // A listing this long is cut by the catalog anyway: no further page is fetched.
    if (parsed.nextLink && models.length < MAX_LISTED_ENTRIES) {
      // The key goes only where it was configured to go: a next page on another origin is not fetched.
      try {
        const next = new URL(parsed.nextLink, origin);
        if (next.origin === origin) url = next.toString();
      } catch {
        /* an unreadable link ends the listing */
      }
    }
  }
  return live(models);
}

/**
 * The reference catalog's providers of Vertex's own Google models. Newer Gemini entries (`vertex_ai/gemini-3-pro-preview`)
 * carry plain `vertex_ai`; partner models under it (`vertex_ai/deepseek-ai/…`) are left out by their path below.
 */
const VERTEX_REFERENCE_PROVIDERS: ReadonlySet<string> = new Set(['vertex_ai', 'vertex_ai-language-models', 'vertex_ai-embedding-models']);

/** Vertex has no list route the console can call with a key: the reference catalog's Vertex models are the list. */
async function listVertex(ctx: Context): Promise<Listing> {
  const entries = await ctx.reference.wait(Math.min(ctx.timeoutMs, ctx.deadline - Date.now()));
  if (!entries) return staticListing('vertex');

  const models: ParsedModel[] = [];
  for (const entry of entries) {
    if (!entry.provider || !VERTEX_REFERENCE_PROVIDERS.has(entry.provider)) continue;
    const id = entry.key.replace(/^vertex_ai\//, '');
    // Region- or publisher-scoped keys and pinned `@version` keys are not model ids a Vertex request names.
    if (!id || id.includes('/') || id.includes('@')) continue;
    models.push({
      id,
      name: defaultModelName(id),
      category: entry.mode === 'embedding' ? 'embedding' : inferCatalogCategory(id),
      // PaLM (bison, gecko) and Gemini 1.x are retired on Vertex; the feed still carries their prices.
      ...(/bison|gecko|^gemini-1\.|^gemini-pro/.test(id) ? { deprecated: true } : {}),
    });
  }
  if (models.length === 0) return staticListing('vertex');
  return {
    source: 'reference',
    supported: true,
    models,
    notices: [{ code: 'reference_listing' }],
    referenceKeys: (model) => [`vertex_ai/${model.id}`, model.id],
  };
}

function listGoogleDocumentAi(ctx: Context): Listing {
  const processorId = asString(ctx.input.settings.processorId);
  if (!processorId) return unsupported();
  return { source: 'static', supported: true, models: [{ id: processorId, name: processorId, category: 'ocr' }], notices: [] };
}

/** Drivers whose listing dials nothing. */
const STATIC_DRIVERS = new Set(['jina-ai', 'voyage-ai', 'alibaba-modelstudio', 'typesafe', 'aws-textract']);

const LIVE_LISTERS: ReadonlyMap<string, (ctx: Context) => Promise<Listing>> = new Map([
  ['openai', listOpenAi],
  ['openai-compatible', listOpenAiCompatible],
  ['together', listTogether],
  ['anthropic', listAnthropic],
  ['azure', listAzure],
  ['bedrock', listBedrock],
  ['cohere', (ctx: Context) => withStaticFallback(ctx, () => listCohere(ctx))],
  ['mistral-ocr', (ctx: Context) => withStaticFallback(ctx, () => listMistralOcr(ctx))],
  ['azure-document-intelligence', (ctx: Context) => withStaticFallback(ctx, () => listAzureDocumentIntelligence(ctx))],
]);

/* ------------------------------------------------------------------ */
/* Filtering, ordering, enrichment                                     */
/* ------------------------------------------------------------------ */

function categoryRank(category: ModelCategory): number {
  const index = CATEGORY_ORDER.indexOf(category);
  return index >= 0 ? index : CATEGORY_ORDER.length;
}

/** Current models first, then by category, newest first where the provider dates them, then by id. */
function compareModels(a: CatalogModel, b: CatalogModel): number {
  return (Number(a.deprecated === true) - Number(b.deprecated === true))
    || (categoryRank(a.category) - categoryRank(b.category))
    // ISO timestamps order as plain strings.
    || ((a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : (a.createdAt ?? '') > (b.createdAt ?? '') ? -1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Whether a reference entry describes the same kind of model: a chat price is no embedding price. */
function modeFits(category: ModelCategory, entry: ModelPriceCatalogEntry): boolean {
  if (!entry.mode) return true;
  return category === 'embedding' ? entry.mode === 'embedding' : CHAT_MODES.has(entry.mode);
}

/** The vendor segment of a catalog key or candidate name (`groq/llama-…` → `groq`), '' for a bare one. */
function vendorOf(key: string): string {
  const slash = key.indexOf('/');
  return slash > 0 ? key.slice(0, slash).toLowerCase() : '';
}

/** The best match among the candidate keys: the best tier wins, and within a tier the earlier key. */
function findReference(
  index: ModelPriceCatalogIndex,
  category: ModelCategory,
  keys: readonly string[],
  allowFuzzy: boolean,
  accepts?: (entry: ModelPriceCatalogEntry) => boolean,
): CatalogEntryMatch | undefined {
  const fitting = (match: CatalogEntryMatch | undefined) =>
    (match && modeFits(category, match.entry) && (accepts?.(match.entry) ?? true) ? match : undefined);
  const strict: CatalogEntryMatch[] = [];
  for (const key of keys) {
    const match = fitting(matchCatalogEntry(index, key, { fuzzy: false }));
    if (!match) continue;
    // A normalized hit under another vendor's prefix is some other host's price for the model (`kyma/gpt-oss-120b` for
    // a vLLM `openai/gpt-oss-120b`, `ovhcloud/Qwen3-32B` on Groq): shown as approximate, never filled in.
    strict.push(match.confidence === 'normalized' && vendorOf(match.entry.key) !== vendorOf(key)
      ? { ...match, confidence: 'fuzzy' }
      : match);
  }
  const best = strict.find((match) => match.confidence === 'exact')
    ?? strict.find((match) => match.confidence === 'normalized')
    ?? strict[0];
  if (best || !allowFuzzy) return best;
  for (const key of keys) {
    const match = fitting(matchCatalogEntry(index, key));
    if (match) return match;
  }
  return undefined;
}

/**
 * Adds what the reference catalog knows and the provider did not say. The provider's own price always wins; limits
 * and capability flags are taken from exact and normalized matches only, since a fuzzy match may be a sibling model.
 */
function enrich(model: CatalogModel, match: CatalogEntryMatch): CatalogModel {
  const { entry, confidence } = match;
  const next: CatalogModel = { ...model };
  if (!next.pricing) {
    next.pricing = {
      currency: 'USD',
      inputTokenPer1M: entry.pricing.inputTokenPer1M,
      outputTokenPer1M: entry.pricing.outputTokenPer1M,
      ...(entry.pricing.cachedTokenPer1M ? { cachedTokenPer1M: entry.pricing.cachedTokenPer1M } : {}),
      ...(entry.pricing.cacheWriteTokenPer1M ? { cacheWriteTokenPer1M: entry.pricing.cacheWriteTokenPer1M } : {}),
      source: 'reference',
      confidence,
      catalogKey: entry.key,
    };
  }
  if (confidence === 'fuzzy') return next;
  if (next.contextWindow === undefined && entry.maxInputTokens && entry.maxInputTokens > 0) next.contextWindow = entry.maxInputTokens;
  if (model.category !== 'llm') return next;
  if (next.maxOutputTokens === undefined && entry.maxOutputTokens && entry.maxOutputTokens > 0) next.maxOutputTokens = entry.maxOutputTokens;
  if (next.supportsToolCalls === undefined && entry.supportsFunctionCalling !== undefined) next.supportsToolCalls = entry.supportsFunctionCalling;
  if (next.supportsStructuredOutputs === undefined && entry.supportsResponseSchema !== undefined) {
    next.supportsStructuredOutputs = entry.supportsResponseSchema;
  }
  if (next.inputModalities === undefined && entry.supportsVision === true) next.inputModalities = ['text', 'image'];
  return next;
}

function needsReference(model: CatalogModel): boolean {
  return ENRICHED_CATEGORIES.has(model.category) && (!model.pricing || model.contextWindow === undefined);
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

function mayEnrich(input: DiscoveryInput): boolean {
  return input.allowedCategories.some((category) => ENRICHED_CATEGORIES.has(category));
}

async function runLister(ctx: Context): Promise<Listing> {
  const { driver } = ctx.input;
  if (STATIC_DRIVERS.has(driver)) return staticListing(driver);
  if (driver === 'google-document-ai') return listGoogleDocumentAi(ctx);
  if (driver === 'vertex') return listVertex(ctx);
  const lister = LIVE_LISTERS.get(driver);
  if (!lister) return unsupported();
  // Settings that name a host are checked first, so a malformed one reads as a settings problem, not a refused endpoint.
  if (driver === 'azure') azureInstanceOf(ctx);
  if (driver === 'bedrock') bedrockRegionOf(ctx);
  // Every endpoint the listing could dial is vetted before the first request.
  await assertProviderTestEndpointsAllowed(ctx.input.type, { tenantId: ctx.input.tenantId }, ctx.input.credentials, ctx.input.settings);
  return lister(ctx);
}

/**
 * Lists the models a provider can serve. Never throws for an upstream or settings problem: the answer carries an
 * `error` (scrubbed of every credential value) instead, with a fallback list where the driver has one.
 */
export async function discoverProviderModels(input: DiscoveryInput, deps: DiscoveryDeps = {}): Promise<DiscoveryResult> {
  const started = Date.now();
  const timeoutMs = deps.timeoutMs ?? CATALOG_REQUEST_TIMEOUT_MS;
  const overallMs = deps.overallTimeoutMs ?? CATALOG_OVERALL_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date());
  const secrets = secretsOf(input.credentials);
  const ctx: Context = {
    input,
    fetchImpl: deps.fetchImpl ?? safeFetch,
    timeoutMs,
    overallMs,
    deadline: started + overallMs,
    now,
    reference: referenceLoader(deps.referenceEntries ?? getCatalogEntries),
  };
  // The reference catalog loads alongside the provider call when the listing may need it.
  if (mayEnrich(input) && !STATIC_DRIVERS.has(input.driver)) ctx.reference.start();

  let listing: Listing;
  try {
    listing = await runLister(ctx);
  } catch (error) {
    listing = { source: 'live', supported: true, models: [], notices: [], error: toListingError(error, timeoutMs, false) };
  }

  const notices: CatalogNotice[] = [...listing.notices];
  const source: CatalogSource = listing.source === 'none' ? 'live' : listing.source;

  // Only what the driver can serve, each id once.
  let excluded = 0;
  const seen = new Set<string>();
  const kept: CatalogModel[] = [];
  for (const parsed of listing.models) {
    const category = constrainCategory(parsed.category, input.allowedCategories);
    if (!category) {
      excluded += 1;
      continue;
    }
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    kept.push({ ...parsed, category, source });
  }
  if (excluded > 0) notices.push({ code: 'excluded_unsupported', count: excluded });

  kept.sort(compareModels);
  let models = kept;
  if (models.length > CATALOG_MAX_MODELS) {
    models = models.slice(0, CATALOG_MAX_MODELS);
    notices.push({ code: 'truncated', count: CATALOG_MAX_MODELS });
  }

  if (models.some(needsReference)) {
    const remaining = ctx.deadline - Date.now();
    const entries = await ctx.reference.wait(Math.min(deps.referenceWaitMs ?? CATALOG_REFERENCE_WAIT_MS, remaining));
    if (!entries) {
      notices.push({ code: 'pricing_reference_unavailable' });
    } else {
      const index = indexCatalogEntries(entries);
      const keysOf = listing.referenceKeys ?? ((model: ParsedModel) => [model.id]);
      let fuzzyLookups = 0;
      models = models.map((model) => {
        if (!needsReference(model)) return model;
        const keys = [...new Set(keysOf(model))];
        const allowFuzzy = fuzzyLookups < MAX_FUZZY_LOOKUPS;
        const match = findReference(index, model.category, keys, allowFuzzy, listing.acceptsReference);
        if (!match || match.confidence === 'fuzzy') fuzzyLookups += allowFuzzy ? 1 : 0;
        return match ? enrich(model, match) : model;
      });
    }
  }

  const error: CatalogError | undefined = listing.error
    ? {
      code: listing.error.code,
      message: scrubMessage(listing.error.message, secrets) || 'The model list could not be loaded.',
      ...(listing.error.status !== undefined ? { status: listing.error.status } : {}),
    }
    : undefined;

  return {
    source: listing.supported ? source : 'none',
    supported: listing.supported,
    models,
    fetchedAt: now().toISOString(),
    latencyMs: Date.now() - started,
    ...(error ? { error } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
}
