/**
 * Provider model catalog: the models a configured provider can serve, listed from the provider itself.
 *
 * Shared by the server (discovery service, route) and the dashboard (the "Add model" catalog and the
 * Model ID autocomplete), so this file holds types and constants only: no server imports.
 */
import type { ModelCategory } from '@/lib/database';
import type { ModelInputModality } from '@/lib/services/models/modelCapabilities';

/**
 * Where a catalog entry came from.
 * - `live`: the provider's own "list models" API, called just now with the provider's stored credentials.
 * - `reference`: the market reference catalog (LiteLLM price feed), for drivers whose API has no list route.
 * - `static`: a short built-in list, for drivers with neither (rerank vendors, single-model decision APIs).
 */
export type CatalogSource = 'live' | 'reference' | 'static';

export interface CatalogModelPricing {
  currency: 'USD';
  inputTokenPer1M: number;
  outputTokenPer1M: number;
  cachedTokenPer1M?: number;
  cacheWriteTokenPer1M?: number;
  /** `provider`: the provider's own list carried the price; `reference`: matched in the market price catalog. */
  source: 'provider' | 'reference';
  /** Reference matches only: how the id was matched. Only `exact` and `normalized` prefill a form. */
  confidence?: 'exact' | 'normalized' | 'fuzzy';
  /** Reference matches only: the catalog key the price comes from. */
  catalogKey?: string;
}

export interface CatalogModel {
  /** The value a model record stores as `modelId` (Azure: the deployment name; Bedrock: model or inference profile id). */
  id: string;
  /** Suggested display name. */
  name: string;
  description?: string;
  /** The category the model is served under. Always one of the provider driver's `model.categories`. */
  category: ModelCategory;
  ownedBy?: string;
  /** ISO timestamp, when the provider says when the model was published. */
  createdAt?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: ModelInputModality[];
  supportsToolCalls?: boolean;
  supportsReasoning?: boolean;
  supportsStructuredOutputs?: boolean;
  /** Azure: the model a deployment serves. Bedrock inference profile: the foundation model behind it. */
  upstreamModel?: string;
  /** The provider marks the model legacy / deprecated. */
  deprecated?: boolean;
  pricing?: CatalogModelPricing;
  source: CatalogSource;
  /** Keys of the models of the active project that already serve this provider + id. */
  registeredModelKeys?: string[];
}

/** Why a listing failed. The dashboard translates the code; `message` is a scrubbed detail line. */
export type CatalogErrorCode =
  | 'auth_failed'
  | 'unreachable'
  | 'timeout'
  | 'upstream_error'
  | 'endpoint_not_allowed'
  | 'credentials_unavailable'
  | 'invalid_settings';

export interface CatalogError {
  code: CatalogErrorCode;
  /** Human-readable, scrubbed of every credential value, single line, at most 300 chars. Never an upstream body. */
  message: string;
  /** Upstream HTTP status, when there was one. */
  status?: number;
}

/** Non-fatal notes about a listing. */
export type CatalogNoticeCode =
  /** The market price catalog could not be loaded in time: no reference prices or limits. */
  | 'pricing_reference_unavailable'
  /** Azure did not list deployments (newer API versions removed the route): only the configured deployment is offered. */
  | 'azure_deployments_unlisted'
  /** `count` listed models were left out because this driver cannot serve them (realtime, video, legacy completions …). */
  | 'excluded_unsupported'
  /** More than `count` models were listed; the list was cut there. */
  | 'truncated'
  /** The driver has no list API: the entries come from the market reference catalog. */
  | 'reference_listing'
  /** The driver has no list API: the entries come from a built-in list. */
  | 'static_listing'
  /** The live listing failed and a built-in / reference list is shown instead. */
  | 'listing_fallback';

export interface CatalogNotice {
  code: CatalogNoticeCode;
  count?: number;
}

export interface ProviderModelCatalog {
  provider: { key: string; label: string; driver: string; status: string };
  /** Where `models` came from; `none` when there is nothing to list (custom entry only). */
  source: CatalogSource | 'none';
  /** False when the driver offers no way to list models: the dashboard goes straight to custom entry. */
  supported: boolean;
  models: CatalogModel[];
  /** ISO timestamp of this listing. */
  fetchedAt: string;
  latencyMs: number;
  /** Set when the listing failed. `models` may still hold a fallback list (see the `listing_fallback` notice). */
  error?: CatalogError;
  notices?: CatalogNotice[];
}

/** Upper bound of entries one listing returns (the rest are dropped with a `truncated` notice). */
export const CATALOG_MAX_MODELS = 2000;
