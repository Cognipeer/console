/**
 * Web search instances: the behavior of a search (depth, answer, locale, cache, ...) on top of a websearch
 * provider record that holds the connection.
 *
 * Visibility in a project P: the instance belongs to P or to no project, AND its provider is visible in P (the
 * provider visibility `listWebSearchProviders` uses: assigned by projectId / projectIds, platform records included).
 */

import { runWithTenantScope, type DatabaseProvider, type IProviderRecord, type IWebSearchInstance } from '@/lib/database';
import { isManagedProviderRecord } from '@/enterprise/managed-credits';
import { createLogger } from '@/lib/core/logger';
import { PROVIDER_KEY_EXISTS, ProviderKeyExistsError, ProviderSettingsError } from '@/lib/providers/errors';
import { splitWebSearchSettings } from '@/lib/providers/contracts/webSearchContracts';
import { asSafeSearch } from '@/lib/services/webSearch/searchOptions';
import {
  ManagedProviderReadOnlyError,
  PlatformRecordReadOnlyError,
  validateWebSearchSettings,
} from '@/lib/services/providers/providerService';

const logger = createLogger('websearch-instances');

export class WebSearchInstanceKeyExistsError extends Error {
  readonly code = PROVIDER_KEY_EXISTS;
  readonly retryable = false;

  constructor(key: string) {
    super(`Web search instance with key "${key}" already exists.`);
    this.name = 'WebSearchInstanceKeyExistsError';
  }
}

export class WebSearchInstanceNotFoundError extends Error {
  readonly status = 404;

  constructor(key: string) {
    super(`Web search instance "${key}" not found.`);
    this.name = 'WebSearchInstanceNotFoundError';
  }
}

export interface CreateWebSearchInstanceInput {
  key: string;
  name: string;
  description?: string;
  providerKey: string;
  /** Owning project. Left out = tenant-wide (visible wherever its provider is). */
  projectId?: string | null;
  status?: IWebSearchInstance['status'];
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface UpdateWebSearchInstanceInput {
  name?: string;
  description?: string;
  providerKey?: string;
  status?: IWebSearchInstance['status'];
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  updatedBy?: string;
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === 11000) return true;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /unique constraint/i.test(message);
}

function assertNotPlatform(instance: Pick<IWebSearchInstance, 'platform'>): void {
  if (instance.platform) throw new PlatformRecordReadOnlyError();
}

function assignedTo(provider: Pick<IProviderRecord, 'projectId' | 'projectIds'>, projectId: string): boolean {
  return provider.projectId === projectId || (provider.projectIds ?? []).map(String).includes(projectId);
}

/** Keys of the websearch providers visible in a project (every one when no project is given). */
async function visibleProviderKeys(db: DatabaseProvider, tenantId: string, projectId?: string): Promise<Set<string>> {
  const providers = await db.listProviders(tenantId, { type: 'websearch', ...(projectId ? { projectId } : {}) });
  return new Set(providers.map((p) => p.key));
}

function isInProject(instance: Pick<IWebSearchInstance, 'projectId'>, projectId?: string): boolean {
  return !instance.projectId || !projectId || instance.projectId === projectId;
}

/**
 * The provider an instance points at has to exist, be a websearch provider and be visible in the instance's
 * project (for a tenant-wide instance: visible somewhere is enough).
 */
async function assertProviderUsable(
  db: DatabaseProvider,
  tenantId: string,
  providerKey: string,
  projectId?: string | null,
): Promise<IProviderRecord> {
  const provider = await db.findProviderByKey(tenantId, providerKey);
  if (!provider) {
    throw new ProviderSettingsError('providerKey', `Provider "${providerKey}" was not found.`);
  }
  if (provider.type !== 'websearch') {
    throw new ProviderSettingsError('providerKey', `Provider "${providerKey}" is not a web search provider.`);
  }
  if (projectId && !assignedTo(provider, projectId)) {
    throw new ProviderSettingsError(
      'providerKey',
      `Provider "${providerKey}" is not assigned to project ${projectId}. Assign it from the provider's Projects tab.`,
    );
  }
  return provider;
}

/** Connection fields (endpoint, base URL) belong to the provider: an instance only carries behavior. */
async function validateBehavior(
  tenantDbName: string,
  tenantId: string,
  provider: IProviderRecord,
  projectId: string | null | undefined,
  settings: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const given = settings ?? {};
  assertSearchOptions(given);
  const { connection } = splitWebSearchSettings(provider.driver, given);
  const misplaced = Object.keys(connection);
  if (misplaced.length > 0) {
    throw new ProviderSettingsError(
      misplaced[0],
      `"${misplaced.join('", "')}" belongs to the provider connection, not to an instance.`,
    );
  }
  return (await validateWebSearchSettings(tenantDbName, tenantId, projectId ?? undefined, given)) ?? {};
}

/** The search options a search reads from the instance, when given, have to be ones it understands. */
function assertSearchOptions(settings: Record<string, unknown>): void {
  if (settings.safeSearch !== undefined && !asSafeSearch(settings.safeSearch)) {
    throw new ProviderSettingsError('safeSearch', 'Safe search must be "off", "moderate" or "strict".');
  }
  if (settings.searchDepth !== undefined && settings.searchDepth !== 'basic' && settings.searchDepth !== 'advanced') {
    throw new ProviderSettingsError('searchDepth', 'Search depth must be "basic" or "advanced".');
  }
  const count = settings.count;
  // Exactly the values `clampCount` would silently replace with the default.
  if (count !== undefined && (typeof count !== 'number' || !Number.isFinite(count) || count <= 0)) {
    throw new ProviderSettingsError('count', 'The result count must be a positive number.');
  }
}

/** The rule the instance form suggests keys by (`instanceKeyFromName`): lower case letters, digits and "-". */
const INSTANCE_KEY = /^[a-z0-9-]{1,64}$/;

function assertKeyFormat(key: unknown): asserts key is string {
  if (typeof key === 'string' && INSTANCE_KEY.test(key)) return;
  throw new ProviderSettingsError(
    'key',
    'The instance key can only hold lower case letters, digits and "-", at most 64 characters.',
  );
}

export async function createWebSearchInstance(
  tenantDbName: string,
  tenantId: string,
  input: CreateWebSearchInstanceInput,
): Promise<IWebSearchInstance> {
  // A key the managed host reserves cannot be taken by a tenant, exactly like a provider key.
  if (isManagedProviderRecord({ key: input.key, type: 'websearch' })) {
    throw new ManagedProviderReadOnlyError();
  }
  assertKeyFormat(input.key);
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new ProviderSettingsError('name', 'The instance name is required.');
  }
  const projectId = input.projectId || null;

  return runWithTenantScope(tenantDbName, async (db) => {
    if (await db.findWebSearchInstanceByKey(tenantId, input.key)) {
      throw new WebSearchInstanceKeyExistsError(input.key);
    }
    // A search key resolves to an instance before a provider: an instance under a provider's key would hide it.
    if ((await db.findProviderByKey(tenantId, input.key))?.type === 'websearch') {
      throw new ProviderKeyExistsError(input.key);
    }
    const provider = await assertProviderUsable(db, tenantId, input.providerKey, projectId);
    const settings = await validateBehavior(tenantDbName, tenantId, provider, projectId, input.settings);

    try {
      // `platform` is never read from the input: only the hosting layer writes it, through the database API.
      return await db.createWebSearchInstance({
        tenantId,
        projectId,
        key: input.key,
        name: input.name.trim(),
        description: input.description,
        providerKey: input.providerKey,
        status: input.status ?? 'active',
        settings,
        metadata: input.metadata,
        createdBy: input.createdBy,
        updatedBy: input.createdBy,
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new WebSearchInstanceKeyExistsError(input.key);
      throw error;
    }
  });
}

export async function updateWebSearchInstance(
  tenantDbName: string,
  tenantId: string,
  key: string,
  input: UpdateWebSearchInstanceInput,
): Promise<IWebSearchInstance> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const existing = await db.findWebSearchInstanceByKey(tenantId, key);
    if (!existing) throw new WebSearchInstanceNotFoundError(key);
    assertNotPlatform(existing);

    if (input.name !== undefined && input.name.trim() === '') {
      throw new ProviderSettingsError('name', 'The instance name is required.');
    }
    const providerKey = input.providerKey ?? existing.providerKey;
    const provider = await assertProviderUsable(db, tenantId, providerKey, existing.projectId);
    const settings = input.settings !== undefined || providerKey !== existing.providerKey
      ? await validateBehavior(tenantDbName, tenantId, provider, existing.projectId, input.settings ?? existing.settings)
      : undefined;

    const updated = await db.updateWebSearchInstance(String(existing._id), {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.providerKey !== undefined ? { providerKey } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(settings !== undefined ? { settings } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.updatedBy !== undefined ? { updatedBy: input.updatedBy } : {}),
    });
    if (!updated) throw new WebSearchInstanceNotFoundError(key);
    return updated;
  });
}

export async function deleteWebSearchInstance(
  tenantDbName: string,
  tenantId: string,
  key: string,
): Promise<boolean> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const existing = await db.findWebSearchInstanceByKey(tenantId, key);
    if (!existing) return false;
    assertNotPlatform(existing);
    return db.deleteWebSearchInstance(String(existing._id));
  });
}

/** The instance when it is visible in the project, else null. */
export async function getWebSearchInstance(
  tenantDbName: string,
  tenantId: string,
  key: string,
  projectId?: string,
): Promise<IWebSearchInstance | null> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const instance = await db.findWebSearchInstanceByKey(tenantId, key);
    if (!instance || !isInProject(instance, projectId)) return null;
    const providers = await visibleProviderKeys(db, tenantId, projectId);
    return providers.has(instance.providerKey) ? instance : null;
  });
}

/** Instances visible in the project (every tenant instance when no project is given), sorted by key. */
export async function listWebSearchInstances(
  tenantDbName: string,
  tenantId: string,
  projectId?: string,
  filters?: { providerKey?: string },
): Promise<IWebSearchInstance[]> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const [instances, providers] = await Promise.all([
      db.listWebSearchInstances(tenantId, filters),
      visibleProviderKeys(db, tenantId, projectId),
    ]);
    const visible = instances.filter((i) => isInProject(i, projectId) && providers.has(i.providerKey));
    if (visible.length < instances.length) {
      logger.debug('Web search instances hidden by project or provider visibility', {
        tenantId,
        projectId,
        hidden: instances.length - visible.length,
      });
    }
    return visible.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  });
}
