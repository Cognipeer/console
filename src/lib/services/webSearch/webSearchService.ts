/**
 * Web Search service — resolves a configured Web Search instance (explicit key
 * or the project's single active instance) and executes the query through the
 * driver adapter. Optionally interprets the results with the instance's
 * configured AI model (settings.aiAnswer) when the request asks for an answer.
 * When the instance enables its semantic cache (settings.cache) the query is
 * looked up in the selected vector index first and the provider is only called
 * on a miss.
 */

import { assertServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import { createLogger } from '@/lib/core/logger';
import { fireAndForget } from '@/lib/core/asyncTask';
import { enforceServiceQuota } from '@/lib/quota/serviceQuota';
import { getDatabase, type IWebSearchInstance, type IWebSearchRunLog } from '@/lib/database';
import {
  listProviderConfigs,
  loadProviderRuntimeData,
  type ProviderConfigView,
  type ProviderViewOptions,
} from '@/lib/services/providers/providerService';
import {
  getManagedCreditsHost,
  isManagedProviderRecord,
  listManagedRoutes,
  type ManagedCreditLease,
  type ManagedRoute,
} from '@/enterprise/managed-credits';
import { shouldTryNextReplica } from '@/lib/services/models/replicaPool';
import { recordUsageEvent } from '@/lib/services/usage/usageEvents';
import { splitWebSearchSettings } from '@/lib/providers/contracts/webSearchContracts';
import { callWebSearchProvider } from './webSearchAdapter';
import { getWebSearchInstance, listWebSearchInstances } from './webSearchInstanceService';
import { asSafeSearch, asString } from './searchOptions';
import { resolveWebSearchCacheSettings } from './cacheSettings';
import type {
  WebSearchAiAnswerSettings,
  WebSearchCacheInfo,
  WebSearchInput,
  WebSearchResult,
  WebSearchResultItem,
} from './types';

const logger = createLogger('websearch-service');

/** Results inlined into a run log (snippets truncated to keep records small). */
const LOGGED_RESULTS_LIMIT = 20;
const LOGGED_SNIPPET_MAX = 300;
/** Results handed to the AI model for interpretation. */
const AI_ANSWER_RESULTS_LIMIT = 10;

export interface RunWebSearchOptions extends WebSearchInput {
  /** Instance key, or a legacy websearch provider key. Omit to use the project's single active instance. */
  providerKey?: string;
  /** Attribution only (dashboard test vs API). */
  source?: 'dashboard' | 'api';
  /** Depth of one search; a managed provider takes it from here only (advanced = 2 credit units). */
  searchDepth?: string;
}

const MANAGED_UNAVAILABLE = 'This provider is not available right now.';

export async function listWebSearchProviders(
  tenantDbName: string,
  tenantId: string,
  projectId?: string,
  options?: ProviderViewOptions,
): Promise<ProviderConfigView[]> {
  return listProviderConfigs(tenantDbName, tenantId, {
    type: 'websearch',
    projectId,
  }, options);
}

/**
 * True when a search can run in the project without naming a key: an active instance is visible (platform ones
 * included), or an active provider is (the legacy path, which managed providers still use).
 */
export async function hasActiveWebSearch(
  tenantDbName: string,
  tenantId: string,
  projectId?: string,
): Promise<boolean> {
  const instances = await listWebSearchInstances(tenantDbName, tenantId, projectId);
  if (instances.some((i) => i.status === 'active')) return true;
  const providers = await listWebSearchProviders(tenantDbName, tenantId, projectId);
  return providers.some((p) => p.status === 'active');
}

async function withTenantDb(tenantDbName: string) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

export async function listWebSearchRunLogs(
  tenantDbName: string,
  searchKey: string,
  options?: { limit?: number; skip?: number; from?: Date; to?: Date },
): Promise<IWebSearchRunLog[]> {
  const db = await withTenantDb(tenantDbName);
  return db.listWebSearchRunLogs(searchKey, options);
}

function logRun(
  tenantDbName: string,
  entry: Omit<IWebSearchRunLog, '_id' | 'createdAt'>,
): void {
  // Resolve attribution + rollup synchronously so the request ALS is in scope.
  const attribution = recordUsageEvent({
    tenantDbName,
    tenantId: entry.tenantId,
    projectId: entry.projectId,
    service: 'websearch',
    refKey: entry.searchKey,
    status: entry.status,
    latencyMs: entry.latencyMs,
    units: { results: entry.resultCount },
  });
  fireAndForget('log-websearch-run', async () => {
    const db = await withTenantDb(tenantDbName);
    await db.createWebSearchRunLog({
      ...entry,
      userId: attribution.userId,
      apiTokenId: attribution.apiTokenId,
      actorType: attribution.actorType,
    });
  });
}

function loggableResults(results: WebSearchResultItem[]): IWebSearchRunLog['results'] {
  return results.slice(0, LOGGED_RESULTS_LIMIT).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet.length > LOGGED_SNIPPET_MAX
      ? `${r.snippet.slice(0, LOGGED_SNIPPET_MAX)}…`
      : r.snippet,
    position: r.position,
  }));
}

/** Credit units of one search: an advanced (deep) search costs 2, a basic one 1. */
function searchUnitsOf(settings: Record<string, unknown> | undefined): number {
  const depth = typeof settings?.searchDepth === 'string' ? settings.searchDepth.toLowerCase() : 'basic';
  return depth === 'advanced' || depth === 'deep' ? 2 : 1;
}

/** Units of a managed search: from the request only, never from route or connection settings. */
function requestedSearchUnits(depth: string | undefined): number {
  return searchUnitsOf({ searchDepth: depth });
}

type ProviderRuntime = Awaited<ReturnType<typeof loadProviderRuntimeData>>;

/**
 * Calls a managed search through its routes in order: the first live route, then the next one only when the failure
 * is a capacity or availability fault. The adapter sees a synthetic record built from the route's connection; the
 * public record stays the one logged, cached and returned.
 */
async function callManagedRoutes(params: {
  routes: ManagedRoute[];
  first: ProviderRuntime;
  load: (connectionId: string) => Promise<ProviderRuntime>;
  options: WebSearchInput;
  depth: string;
  tenantId: string;
  projectId?: string;
  providerKey: string;
}): Promise<Awaited<ReturnType<typeof callWebSearchProvider>>> {
  const { routes } = params;
  let lastError: unknown;
  for (let i = 0; i < routes.length; i += 1) {
    const route = routes[i];
    try {
      const runtime = i === 0 ? params.first : await params.load(route.connectionId);
      const connection = runtime.managedConnection;
      if (!connection) throw new Error(MANAGED_UNAVAILABLE);
      const synthetic = {
        ...runtime.record,
        driver: connection.driver,
        settings: { ...connection.settings, ...(route.settings ?? {}), searchDepth: params.depth },
      };
      const result = await callWebSearchProvider(
        synthetic,
        runtime.credentials as Record<string, unknown>,
        params.options,
        { breakerScope: route.id },
      );
      // One shape whichever route served: fields only some upstreams return (a native score, a metasearch engine
      // name) would tell the routes apart.
      return {
        ...result,
        results: result.results.map(({ title, url, snippet, position, publishedAt }) => ({
          title, url, snippet, position, ...(publishedAt ? { publishedAt } : {}),
        })),
      };
    } catch (error) {
      lastError = error;
      if (i === routes.length - 1 || !shouldTryNextReplica(error)) throw error;
      // Server log only: the route id and the upstream error text never reach the tenant.
      logger.warn('Managed search route failed, trying the next one', {
        tenantId: params.tenantId,
        projectId: params.projectId,
        providerKey: params.providerKey,
        routeId: route.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw lastError;
}

export interface ResolvedWebSearchTarget {
  /** The instance whose behavior applies; null on the legacy path (a provider key used directly). */
  instance: IWebSearchInstance | null;
  /** The provider record key: connection, credentials, managed routes and credits. */
  providerKey: string;
}

function multipleError(keys: string[]): Error {
  return new Error(
    `Multiple web search instances are configured (${keys.join(', ')}). Specify one with the \`provider\` field or the /websearch/:key/search endpoint.`,
  );
}

/**
 * Explicit key: an instance with that key visible in the project, else a websearch provider with that key (legacy:
 * the provider row's own settings act as the behavior). No key, in this order: the tenant's own active instances
 * (the project's single one, else the single visible one; several is an error), the single active own provider
 * (legacy), the first active platform instance by key, the first managed provider by key. The tenant's own always
 * win over what the host provides.
 */
export async function resolveWebSearchTarget(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  explicitKey: string | undefined,
): Promise<ResolvedWebSearchTarget> {
  if (explicitKey) {
    const instance = await getWebSearchInstance(tenantDbName, tenantId, explicitKey, projectId);
    if (instance) return { instance, providerKey: instance.providerKey };
    logger.debug('Web search key resolved as a provider (no visible instance with that key)', {
      tenantId,
      projectId,
      key: explicitKey,
    });
    return { instance: null, providerKey: explicitKey };
  }

  const active = (await listWebSearchInstances(tenantDbName, tenantId, projectId))
    .filter((i) => i.status === 'active');
  // The tenant's own instances come first; a platform instance is only the default when nothing of the tenant's own
  // can answer (the same rule the provider branch below applies to managed providers).
  const instances = active.filter((i) => i.platform !== true);
  for (const group of [instances.filter((i) => projectId && i.projectId === projectId), instances]) {
    if (group.length > 1) throw multipleError(group.map((i) => i.key));
    if (group.length === 1) return { instance: group[0], providerKey: group[0].providerKey };
  }

  const providers = await listWebSearchProviders(tenantDbName, tenantId, projectId);
  const allActive = providers.filter((p) => p.status === 'active');
  // A platform provider is the host's, like a managed one: it must not make the tenant's own provider ambiguous.
  const hostProvided = (p: { platform?: boolean } & Parameters<typeof isManagedProviderRecord>[0]) =>
    p.platform === true || isManagedProviderRecord(p);
  const own = allActive.filter((p) => !hostProvided(p));
  if (own.length > 1) throw multipleError(own.map((p) => p.key));
  if (own.length === 1) return { instance: null, providerKey: own[0].key };

  const byKey = <T extends { key: string }>(a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const platform = active.filter((i) => i.platform === true).sort(byKey);
  if (platform.length > 0) return { instance: platform[0], providerKey: platform[0].providerKey };

  const managed = allActive.filter((p) => hostProvided(p)).sort(byKey);
  if (managed.length > 0) return { instance: null, providerKey: managed[0].key };
  throw new Error(
    'No active web search instance is configured. Create one under Data → Web Search.',
  );
}

function aiAnswerSettingsOf(settings: Record<string, unknown> | undefined): WebSearchAiAnswerSettings {
  const raw = settings?.aiAnswer;
  return raw && typeof raw === 'object' ? (raw as WebSearchAiAnswerSettings) : {};
}

async function interpretResults(params: {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  modelKey: string;
  instructions?: string;
  query: string;
  results: WebSearchResultItem[];
}): Promise<string> {
  // Lazy import keeps the search path free of the inference module unless an
  // AI answer is actually requested.
  const { handleChatCompletion } = await import('@/lib/services/models/inferenceService');

  const sources = params.results
    .slice(0, AI_ANSWER_RESULTS_LIMIT)
    .map((r) => `[${r.position}] ${r.title}\nURL: ${r.url}\n${r.snippet}`)
    .join('\n\n');

  const prompt = [
    params.instructions?.trim(),
    'You are given web search results. Using ONLY these results, answer the query concisely.',
    'Cite the result numbers you used like [1], [2]. If the results do not answer the query, say so.',
    '',
    `Query: ${params.query}`,
    '',
    'Results:',
    sources,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');

  const { response } = await handleChatCompletion({
    tenantDbName: params.tenantDbName,
    tenantId: params.tenantId,
    modelKey: params.modelKey,
    projectId: params.projectId ?? '',
    body: {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    },
  });

  const text = (response as { choices?: Array<{ message?: { content?: string } }> })
    ?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('AI answer model returned an empty response.');
  }
  return text.trim();
}

interface CacheSession {
  info: WebSearchCacheInfo;
  /** Cached result set when the query was served from the cache. */
  hit?: { results: WebSearchResultItem[]; answer?: string };
  /** Non-fatal notes raised while consulting the cache. */
  warnings: string[];
  /** Write a provider result set back after a miss; resolves to a warning on failure. */
  store(results: WebSearchResultItem[], answer?: string): Promise<string | undefined>;
}

/**
 * Consult the instance's semantic cache. Returns undefined when caching is off
 * (the search is then exactly the uncached flow). A cache that cannot be
 * consulted never fails the search: it is reported as `error` with a warning.
 */
async function openCacheSession(params: {
  tenantDbName: string;
  tenantId: string;
  projectId: string | undefined;
  searchKey: string;
  driver: string;
  instanceSettings: Record<string, unknown>;
  query: string;
  input: WebSearchInput;
}): Promise<CacheSession | undefined> {
  const noStore = async () => undefined;

  let settings: ReturnType<typeof resolveWebSearchCacheSettings>;
  try {
    settings = resolveWebSearchCacheSettings(params.instanceSettings);
  } catch {
    // Enabled-looking but malformed (e.g. edited outside the API).
    const { describeCacheFailure } = await import('./webSearchCache');
    return { info: { status: 'error' }, warnings: [describeCacheFailure('config')], store: noStore };
  }
  if (!settings) return undefined;

  // Lazy: the cache pulls in the embedding and vector services, which the
  // uncached path must not load.
  const cache = await import('./webSearchCache');
  if (!params.projectId) {
    return { info: { status: 'error' }, warnings: [cache.describeCacheFailure('config')], store: noStore };
  }

  const target = {
    tenantDbName: params.tenantDbName,
    settings,
    scope: {
      tenantId: params.tenantId,
      projectId: params.projectId,
      searchKey: params.searchKey,
      driver: params.driver,
      instanceSettings: params.instanceSettings,
      input: params.input,
    },
  };

  const lookup = await cache.lookupWebSearchCache({ ...target, query: params.query });
  if (lookup.status === 'hit') {
    return {
      info: { status: 'hit', similarity: lookup.similarity },
      hit: { results: lookup.results, answer: lookup.answer },
      warnings: [],
      store: noStore,
    };
  }
  if (lookup.status === 'error') {
    return { info: { status: 'error' }, warnings: [cache.describeCacheFailure(lookup.stage)], store: noStore };
  }

  const info: WebSearchCacheInfo = { status: 'miss', stored: false };
  return {
    info,
    warnings: [],
    async store(results, answer) {
      info.stored = await cache.storeWebSearchCache({
        ...target,
        query: params.query,
        embedding: lookup.embedding,
        results,
        answer,
      });
      return info.stored ? undefined : cache.describeCacheFailure('store');
    },
  };
}

export async function runWebSearch(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  options: RunWebSearchOptions,
): Promise<WebSearchResult> {
  await assertServiceEnabled({ tenantDbName, tenantId }, 'websearch');
  const query = options.query?.trim();
  if (!query) throw new Error('`query` is required.');

  const { instance, providerKey } = await resolveWebSearchTarget(
    tenantDbName,
    tenantId,
    projectId,
    options.providerKey,
  );
  // Quota, run logs, usage and the cache are keyed by the instance when there is one (the provider key otherwise).
  const searchKey = instance?.key ?? providerKey;

  // A managed provider is served by the operator's live routes; the host knows none for a tenant's own instance.
  const routes = listManagedRoutes({ providerKey, kind: 'search' });
  const loadRuntime = (managedConnectionId?: string) => loadProviderRuntimeData(tenantDbName, {
    tenantId,
    key: providerKey,
    projectId,
  }, { allowManaged: true, ...(managedConnectionId ? { managedConnectionId } : {}) });
  const loaded = await loadRuntime(routes[0]?.connectionId);
  const { record, credentials } = loaded;
  const managed = isManagedProviderRecord(record);
  // No live route: refused before anything is reserved or dialled.
  if (managed && (routes.length === 0 || !loaded.managedConnection)) {
    throw new Error(MANAGED_UNAVAILABLE);
  }

  if (record.type !== 'websearch') {
    throw new Error(`Provider "${providerKey}" is not a web search provider.`);
  }
  if (instance && instance.status !== 'active') {
    throw new Error(`Instance "${instance.key}" is not active.`);
  }
  if (record.status !== 'active') {
    throw new Error(`Provider "${providerKey}" is not active.`);
  }
  // The behavior comes from the instance; on the legacy path the provider row's own settings act as the behavior.
  const behavior = (instance?.settings ?? record.settings ?? {}) as Record<string, unknown>;
  const runRecord = instance
    ? {
      ...record,
      settings: { ...splitWebSearchSettings(record.driver, record.settings).connection, ...behavior },
    }
    : record;

  await enforceServiceQuota(
    { tenantDbName, tenantId, projectId },
    { domain: 'websearch', resourceKey: searchKey, cost: { requests: 1 } },
  );

  // An answer is a best-effort extra on top of the search, never a reason to
  // fail it: agents set `includeAnswer` on their own and API callers cannot see
  // the instance settings. When AI answers are off (or have no model) the
  // search still runs and the response says why there is no AI answer.
  const aiSettings = aiAnswerSettingsOf(behavior);
  const warnings: string[] = [];
  let answerModelKey: string | undefined;
  if (options.includeAnswer) {
    if (aiSettings.enabled !== true) {
      warnings.push(
        `AI answers are not enabled on instance "${searchKey}"; returning search results only. Enable them under Configuration → AI Answer.`,
      );
    } else if (!aiSettings.modelKey) {
      warnings.push(
        `Instance "${searchKey}" has AI answers enabled but no model selected; returning search results only. Pick a model under Configuration → AI Answer.`,
      );
    } else {
      answerModelKey = aiSettings.modelKey;
    }
  }

  const startedAt = Date.now();
  const logEntry: Pick<IWebSearchRunLog, 'tenantId' | 'projectId' | 'searchKey' | 'driver' | 'query' | 'source'> = {
    tenantId,
    projectId,
    searchKey,
    driver: record.driver,
    query,
    source: options.source ?? 'api',
  };
  try {
    const cacheSession = await openCacheSession({
      tenantDbName,
      tenantId,
      projectId,
      searchKey,
      driver: record.driver,
      instanceSettings: behavior,
      query,
      input: options,
    });
    warnings.push(...(cacheSession?.warnings ?? []));

    let lease: ManagedCreditLease | undefined;
    let providerResult: Awaited<ReturnType<typeof callWebSearchProvider>>;
    if (cacheSession?.hit) {
      // A cache hit is free: nothing is reserved.
      providerResult = cacheSession.hit;
    } else {
      const host = managed ? getManagedCreditsHost() : null;
      const units = managed
        ? requestedSearchUnits(options.searchDepth ?? (instance ? asString(behavior.searchDepth) : undefined))
        : searchUnitsOf(behavior);
      if (host) {
        lease = await host.reserve({
          tenantId,
          tenantDbName,
          projectId,
          providerKey,
          driver: record.driver,
          kind: 'search',
          requestId: crypto.randomUUID(),
          estimate: { units },
          attribution: { source: options.source ?? 'api' },
          // Operator-side attribution only: the first route attempted.
          ...(routes[0] ? { routeId: routes[0].id } : {}),
        });
      }
      try {
        providerResult = managed
          ? await callManagedRoutes({
            routes,
            first: loaded,
            load: (connectionId) => loadRuntime(connectionId),
            // A managed connection carries no tenant behavior: the instance's locale defaults ride on the request.
            options: instance
              ? {
                ...options,
                query,
                language: options.language ?? asString(behavior.language),
                country: options.country ?? asString(behavior.country),
                safeSearch: options.safeSearch ?? asSafeSearch(behavior.safeSearch),
              }
              : { ...options, query },
            depth: units > 1 ? 'advanced' : 'basic',
            tenantId,
            projectId,
            providerKey,
          })
          : await callWebSearchProvider(
            runRecord,
            credentials as Record<string, unknown>,
            { ...options, query },
          );
      } catch (error) {
        void lease?.release('error').catch(() => undefined);
        if (host) {
          // The upstream account is the operator's: its error text stays in the server log, the tenant gets a generic one.
          logger.warn('Managed web search request failed', { tenantId, projectId, providerKey, driver: record.driver, error });
          throw new Error('Managed web search request failed.');
        }
        throw error;
      }
      void lease?.settle({ units }).catch(() => undefined);
    }
    const { results, answer: providerAnswer } = providerResult;

    const storeWarning = await cacheSession?.store(results, providerAnswer);
    if (storeWarning) warnings.push(storeWarning);
    const cache = cacheSession?.info;

    let answer = providerAnswer;
    let answerModel: string | undefined;
    if (answerModelKey) {
      try {
        answer = await interpretResults({
          tenantDbName,
          tenantId,
          projectId,
          modelKey: answerModelKey,
          instructions: aiSettings.instructions,
          query,
          results,
        });
        answerModel = answerModelKey;
      } catch (error) {
        // The provider call already succeeded (and was billed) — keep its
        // results rather than throwing them away over the answer.
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`AI answer failed: ${message}`);
        logger.warn('Web search AI answer failed', { tenantId, projectId, providerKey, error: message });
      }
    }

    const latencyMs = Date.now() - startedAt;

    logRun(tenantDbName, {
      ...logEntry,
      resultCount: results.length,
      latencyMs,
      status: 'success',
      results: loggableResults(results),
      answer,
      metadata: answerModel || warnings.length > 0 || cache || instance
        ? {
          ...(instance ? { providerKey } : {}),
          ...(answerModel ? { answerModel } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(cache ? { cache } : {}),
        }
        : undefined,
    });

    return {
      providerKey: searchKey,
      driver: record.driver,
      query,
      results,
      answer,
      answerModel,
      cached: cache?.status === 'hit',
      ...(cache ? { cache } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      latencyMs,
    };
  } catch (error) {
    logRun(tenantDbName, {
      ...logEntry,
      resultCount: 0,
      latencyMs: Date.now() - startedAt,
      status: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    logger.warn('Web search failed', {
      tenantId,
      projectId,
      providerKey,
      driver: record.driver,
      error,
    });
    throw error;
  }
}
