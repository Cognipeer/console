import type { ModelProviderView } from '@/lib/services/models/types';
import type { ModelCategory } from '@/lib/database';

/** A platform provider of the workspace, as `GET /api/models?includePlatform=true` lists it. */
export type PlatformProviderView = ModelProviderView & {
  platform: true;
  /** Whether the provider is assigned to the active project. */
  assigned: boolean;
};

/** What `GET /api/models/providers/:key/catalog` answers for a platform provider (no discovery is run). */
export interface PlatformCatalogData {
  platform: true;
  assigned: boolean;
  models: Array<{
    key: string;
    name: string;
    category: ModelCategory;
    description?: string;
    unavailable: boolean;
  }>;
}

export function isPlatformCatalog(value: unknown): value is PlatformCatalogData {
  return Boolean(value) && typeof value === 'object' && (value as { platform?: unknown }).platform === true
    && Array.isArray((value as { models?: unknown }).models);
}

/** Providers a form may create models on: the server refuses new models on a platform provider. */
export function withoutPlatformProviders<T extends { platform?: boolean }>(providers: readonly T[]): T[] {
  return providers.filter((provider) => provider.platform !== true);
}

/**
 * The project ids to write when a provider is made available in `projectId`: what it has now (a legacy single
 * `projectId` included) plus the project, without duplicates.
 */
export function mergeProjectIds(
  current: { projectId?: unknown; projectIds?: unknown },
  projectId: string,
): string[] {
  const ids: string[] = [];
  const add = (value: unknown) => {
    const id = value === undefined || value === null ? '' : String(value);
    if (id && !ids.includes(id)) ids.push(id);
  };
  if (Array.isArray(current.projectIds)) current.projectIds.forEach(add);
  add(current.projectId);
  add(projectId);
  return ids;
}
