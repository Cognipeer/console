/**
 * Provider model catalog: what a provider of the active project can serve, for the "Add model" catalog and the Model
 * ID autocomplete of the Model Hub.
 *
 * The provider is looked up in the project (a provider of another project, or of a domain that cannot back a model,
 * is "not found"), its stored credentials are opened, and `discoverProviderModels` asks the provider. Models of the
 * project that already serve an id of this provider are marked on the entry.
 */
import type { ModelCategory } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { providerRegistry } from '@/lib/providers';
import {
  getProviderConfigByKey,
  loadProviderRuntimeData,
  ProviderCredentialDecryptError,
} from '@/lib/services/providers/providerService';
import { listModels } from '@/lib/services/models/modelService';
import { discoverProviderModels, type DiscoveryDeps, type DiscoveryResult } from './discovery';
import type { ProviderModelCatalog } from './types';

export * from './types';
export {
  discoverProviderModels,
  CATALOG_MAX_RESPONSE_BYTES,
  CATALOG_OVERALL_TIMEOUT_MS,
  CATALOG_REFERENCE_WAIT_MS,
  CATALOG_REQUEST_TIMEOUT_MS,
  type DiscoveryDeps,
  type DiscoveryInput,
  type DiscoveryResult,
} from './discovery';
export { inferCatalogCategory, constrainCategory, type CategoryHints } from './inferCategory';

const logger = createLogger('model-catalog');

/** The provider does not exist in the project, or cannot back a model. Maps to HTTP 404. */
export class ProviderCatalogNotFoundError extends Error {
  readonly providerKey: string;

  constructor(providerKey: string) {
    super(`Model provider "${providerKey}" is not available in this project.`);
    this.name = 'ProviderCatalogNotFoundError';
    this.providerKey = providerKey;
  }
}

/** The provider is switched off: nothing is listed with its credentials. Maps to HTTP 409. */
export class ProviderCatalogDisabledError extends Error {
  readonly code = 'provider_disabled';
  readonly providerKey: string;

  constructor(providerKey: string) {
    super(`Model provider "${providerKey}" is disabled.`);
    this.name = 'ProviderCatalogDisabledError';
    this.providerKey = providerKey;
  }
}

/**
 * The provider domains that can back a Model Hub entry. Mirrors `MODEL_PROVIDER_TYPES` of `modelService.ts`, which
 * lists the providers the Model Hub offers.
 */
const MODEL_PROVIDER_TYPES: ReadonlySet<string> = new Set(['model', 'stt', 'tts', 'ocr']);

const MODEL_CATEGORIES: ReadonlySet<ModelCategory> = new Set([
  'llm',
  'embedding',
  'rerank',
  'stt',
  'tts',
  'ocr',
  'image',
  'moderation',
  'decision',
]);

/** When a driver does not declare its categories, the Model Hub forms offer chat and embedding models. */
const DEFAULT_CATEGORIES: ModelCategory[] = ['llm', 'embedding'];

/** The categories a driver serves (`model.categories` of its contract). */
function allowedCategoriesOf(driver: string): ModelCategory[] {
  let raw: unknown;
  try {
    raw = providerRegistry.getContract(driver).capabilities?.['model.categories'];
  } catch {
    return DEFAULT_CATEGORIES;
  }
  if (!Array.isArray(raw)) return DEFAULT_CATEGORIES;
  const categories = raw.filter(
    (value): value is ModelCategory => typeof value === 'string' && MODEL_CATEGORIES.has(value as ModelCategory),
  );
  return categories.length > 0 ? categories : DEFAULT_CATEGORIES;
}

/** Model keys of the project per `modelId` of this provider; a failed read leaves the catalog unmarked. */
async function registeredKeysByModelId(
  tenantDbName: string,
  projectId: string,
  providerKey: string,
): Promise<Map<string, string[]>> {
  const byModelId = new Map<string, string[]>();
  try {
    const models = await listModels(tenantDbName, projectId, { providerKey });
    for (const model of models) {
      // The filter is the query's; checked again so a looser store never marks another provider's model.
      if (model.providerKey !== providerKey) continue;
      const modelId = typeof model.modelId === 'string' ? model.modelId.trim() : '';
      if (!modelId || !model.key) continue;
      const keys = byModelId.get(modelId);
      if (keys) keys.push(model.key);
      else byModelId.set(modelId, [model.key]);
    }
  } catch (error) {
    logger.warn('Could not read the project models for the catalog', {
      providerKey,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
  return byModelId;
}

/** What a platform provider offers: the platform models the hosting layer registered for it. No discovery is run. */
export interface PlatformProviderModelCatalog {
  platform: true;
  /** Whether the provider is assigned to the active project (its models are callable here only then). */
  assigned: boolean;
  models: Array<{
    key: string;
    name: string;
    category: ModelCategory;
    description?: string;
    unavailable: boolean;
    /** Whether the model is already added to the active project. */
    added: boolean;
    isMultimodal?: boolean;
    capabilities?: {
      contextWindow?: number;
      maxOutputTokens?: number;
      supportsToolCalls?: boolean;
      supportsReasoning?: boolean;
    };
    /** What a call costs in credits, when the record says so. */
    credits?: { perCall?: number; perMillionTokens?: number };
  }>;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The public facts of a platform model's metadata: capabilities and credits only, never any other key. */
function platformModelFacts(metadata: unknown): Pick<PlatformProviderModelCatalog['models'][number], 'capabilities' | 'credits'> {
  const meta = recordOf(metadata);
  const caps = recordOf(meta?.capabilities);
  const credits = recordOf(meta?.credits);
  const capabilities = caps
    ? {
      contextWindow: positiveNumber(caps.contextWindow),
      maxOutputTokens: positiveNumber(caps.maxOutputTokens),
      supportsToolCalls: typeof caps.supportsToolCalls === 'boolean' ? caps.supportsToolCalls : undefined,
      supportsReasoning: typeof caps.supportsReasoning === 'boolean' ? caps.supportsReasoning : undefined,
    }
    : undefined;
  const creditFacts = credits
    ? { perCall: positiveNumber(credits.perCall), perMillionTokens: positiveNumber(credits.perMillionTokens) }
    : undefined;
  return {
    capabilities: capabilities && Object.values(capabilities).some((v) => v !== undefined) ? capabilities : undefined,
    credits: creditFacts && Object.values(creditFacts).some((v) => v !== undefined) ? creditFacts : undefined,
  };
}

/** The credit price of a platform model row (from its metadata), or undefined when it has none. */
export function platformModelCredits(metadata: unknown): { perCall?: number; perMillionTokens?: number } | undefined {
  return platformModelFacts(metadata).credits;
}

/**
 * The catalog of a platform provider, looked up tenant-wide. It never opens credentials or asks the upstream: the
 * models are the platform model rows of the provider.
 */
async function getPlatformProviderCatalog(
  tenantDbName: string,
  projectId: string,
  config: { key: string; projectId?: unknown; projectIds?: unknown },
): Promise<PlatformProviderModelCatalog> {
  const rows = await listModels(tenantDbName, '', { providerKey: config.key });
  const assigned = String(config.projectId) === String(projectId)
    || (Array.isArray(config.projectIds) && config.projectIds.map(String).includes(String(projectId)));
  return {
    platform: true,
    assigned,
    models: rows
      .filter((model) => model.platform && model.providerKey === config.key)
      .map((model) => ({
        key: model.key,
        name: model.name,
        category: model.category,
        description: model.description,
        unavailable: model.metadata?.inactive === true,
        added: Array.isArray(model.projectIds) && model.projectIds.map(String).includes(String(projectId)),
        isMultimodal: typeof model.isMultimodal === 'boolean' ? model.isMultimodal : undefined,
        ...platformModelFacts(model.metadata),
      })),
  };
}

/**
 * The catalog the route answers: a platform provider is answered from its platform model rows (see
 * `PlatformProviderModelCatalog`), whether or not it is assigned to the project, with no discovery and no credentials
 * opened; any other provider through `getProviderModelCatalog`.
 */
export async function getProviderCatalog(
  params: { tenantDbName: string; tenantId: string; projectId: string; providerKey: string },
  deps?: DiscoveryDeps,
): Promise<ProviderModelCatalog | PlatformProviderModelCatalog> {
  const { tenantDbName, tenantId, projectId, providerKey } = params;
  const tenantWide = await getProviderConfigByKey(tenantDbName, tenantId, providerKey);
  if (tenantWide?.platform && tenantWide.tenantId === tenantId && MODEL_PROVIDER_TYPES.has(tenantWide.type)) {
    return getPlatformProviderCatalog(tenantDbName, projectId, tenantWide);
  }
  return getProviderModelCatalog(params, deps);
}

/**
 * The model catalog of a (non-platform) provider of the project. Throws `ProviderCatalogNotFoundError` (404) and
 * `ProviderCatalogDisabledError` (409); everything about the listing itself, including credentials that cannot be
 * opened, is answered in the catalog's `error`.
 */
export async function getProviderModelCatalog(
  params: { tenantDbName: string; tenantId: string; projectId: string; providerKey: string },
  deps?: DiscoveryDeps,
): Promise<ProviderModelCatalog> {
  const { tenantDbName, tenantId, projectId, providerKey } = params;

  const config = await getProviderConfigByKey(tenantDbName, tenantId, providerKey, projectId);
  // A platform provider never reaches discovery (it would open operator credentials): `getProviderCatalog` answers it.
  if (!config || config.platform || config.tenantId !== tenantId || !MODEL_PROVIDER_TYPES.has(config.type)) {
    throw new ProviderCatalogNotFoundError(providerKey);
  }
  if (config.status === 'disabled') throw new ProviderCatalogDisabledError(providerKey);

  const provider = { key: config.key, label: config.label, driver: config.driver, status: config.status };
  const allowedCategories = allowedCategoriesOf(config.driver);

  let result: DiscoveryResult;
  try {
    const { record, credentials } = await loadProviderRuntimeData(tenantDbName, { key: providerKey, tenantId, projectId });
    result = await discoverProviderModels(
      {
        driver: record.driver,
        type: record.type,
        credentials: credentials ?? {},
        settings: record.settings ?? {},
        tenantId,
        allowedCategories,
      },
      deps,
    );
  } catch (error) {
    if (!(error instanceof ProviderCredentialDecryptError)) throw error;
    const now = deps?.now?.() ?? new Date();
    result = {
      source: 'live',
      supported: true,
      models: [],
      fetchedAt: now.toISOString(),
      latencyMs: 0,
      error: {
        code: 'credentials_unavailable',
        message: 'The stored credentials of this provider could not be opened. Enter them again in the provider settings.',
      },
    };
  }

  const registered = await registeredKeysByModelId(tenantDbName, projectId, providerKey);
  const models = result.models.map((model) => {
    const keys = registered.get(model.id.trim());
    return keys ? { ...model, registeredModelKeys: keys } : model;
  });

  logger.info('Provider model catalog listed', {
    providerKey,
    driver: provider.driver,
    source: result.source,
    count: models.length,
    latencyMs: result.latencyMs,
    ...(result.error ? { errorCode: result.error.code, status: result.error.status } : {}),
  });

  return { provider, ...result, models };
}
