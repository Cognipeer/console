/**
 * Persist-time validation for Web Search instance settings.
 *
 * Shape checks are pure (`cacheSettings.ts`); this adds the reference checks
 * that need the tenant database, scoped to the project the settings are saved
 * from, so an instance can never point its cache at another project's index or
 * model.
 */

import { providerRegistry } from '@/lib/providers';
import { getModelByKey } from '@/lib/services/models/modelService';
import { getVectorIndex } from '@/lib/services/vector/vectorService';
import {
  WebSearchCacheConfigError,
  normalizeWebSearchProviderSettings,
} from './cacheSettings';

/** The cache filters on a metadata field, so the driver must push down `$eq`. */
function assertDriverCanFilter(driver: string): void {
  let operators: unknown;
  try {
    operators = providerRegistry.getContract(driver).capabilities?.['vector.filterOperators'];
  } catch {
    operators = undefined;
  }
  if (!Array.isArray(operators) || !operators.includes('$eq')) {
    throw new WebSearchCacheConfigError(
      'The selected vector provider cannot filter by metadata, which the cache needs to keep entries '
      + 'isolated per tenant, project and instance. Choose a provider with metadata filter support.',
    );
  }
}

/**
 * Validate `settings.cache` and return the settings to persist (defaults
 * filled in). References are verified only when `projectId` is known — a
 * tenant-scoped instance has no single project to resolve them in; they are
 * checked against the calling project at search time instead.
 */
export async function validateWebSearchProviderSettings(params: {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  settings: Record<string, unknown> | undefined;
}): Promise<Record<string, unknown> | undefined> {
  const normalized = normalizeWebSearchProviderSettings(params.settings);
  const cache = normalized?.cache as
    | { enabled: boolean; vectorProviderKey?: string; vectorIndexKey?: string; embeddingModelKey?: string }
    | undefined;

  if (!cache?.enabled || !params.projectId) return normalized;

  const { tenantDbName, tenantId, projectId } = params;

  let provider;
  try {
    ({ provider } = await getVectorIndex(
      tenantDbName,
      tenantId,
      projectId,
      cache.vectorProviderKey as string,
      cache.vectorIndexKey as string,
    ));
  } catch {
    throw new WebSearchCacheConfigError(
      'The selected vector provider or index was not found in this project.',
    );
  }
  if (provider.type !== 'vector' || provider.status !== 'active') {
    throw new WebSearchCacheConfigError('The selected vector provider is not an active vector provider.');
  }
  assertDriverCanFilter(provider.driver);

  const model = await getModelByKey(tenantDbName, cache.embeddingModelKey as string, projectId);
  if (!model) {
    throw new WebSearchCacheConfigError('The selected embedding model was not found in this project.');
  }
  if (model.category !== 'embedding') {
    throw new WebSearchCacheConfigError('The selected model is not an embedding model.');
  }

  return normalized;
}
