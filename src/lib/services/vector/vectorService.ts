import { assertServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import slugify from 'slugify';
import {
  getDatabase,
  type DatabaseProvider,
  type IProviderRecord,
  type IVectorIndexRecord,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { recordUsageEvent } from '@/lib/services/usage/usageEvents';
import { runtimePool, hashCredentials } from '@/lib/core/runtimePool';
import { withResilience } from '@/lib/core/resilience';
import { fireAndForget } from '@/lib/core/asyncTask';
import { listManagedRoutes } from '@/enterprise/managed-credits';
import { assertStorageStock, noteStoredBytes } from '@/lib/limits/storage';
import type { PlanLimitSource } from '@/lib/limits/types';
import { getManagedStorageRuntime, loadStorageProvider } from '@/lib/services/storage/managedStorage';
import {
  providerRegistry,
  assertFilterSupported,
  describeHybrid,
  parseVectorFilter,
  type VectorFilterNode,
  type VectorFilterOperator,
  type VectorProviderRuntime,
  type VectorIndexHandle,
  type VectorQueryInput,
  type VectorQueryResult,
  type VectorUpsertItem,
} from '@/lib/providers';
import {
  listProviderConfigs,
  createProviderConfig,
  getProviderConfigByKey,
  redactPlatformProvider,
  type ProviderConfigView,
  type CreateProviderConfigInput,
} from '@/lib/services/providers/providerService';
import type {
  CreateVectorIndexRequest,
  UpdateVectorIndexRequest,
  VectorProviderView,
  VectorQueryRequest,
  VectorQueryResponse,
  VectorUpsertRequest,
  VectorDeleteRequest,
  VectorIndexRecord,
  VectorIndexView,
} from './types';

const SLUG_OPTIONS = {
  lower: true,
  strict: true,
  trim: true,
};

const FALLBACK_KEY = 'vector-index';
const MAX_KEY_ATTEMPTS = 50;

function normalizeKeyCandidate(input: string | undefined): string {
  const fallback = input && input.trim().length > 0 ? input.trim() : FALLBACK_KEY;
  const slug = slugify(fallback, SLUG_OPTIONS);
  return slug.length > 0 ? slug : FALLBACK_KEY;
}

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

/**
 * The capability keys a view of a platform provider may carry: what a caller can do with the store, never what
 * serves it.
 */
const PLATFORM_CAPABILITY_KEYS = [
  'vector.filterOperators',
  'vector.filterRaw',
  'vector.supportsHybrid',
  'vector.metrics',
] as const;

function attachDriverCapabilities(provider: ProviderConfigView): VectorProviderView {
  if (provider.platform) {
    const view: VectorProviderView = { ...redactPlatformProvider(provider) };
    const driver = listManagedRoutes({ providerKey: provider.key, kind: 'vector' })[0]?.driver;
    if (!driver) return view;
    try {
      const capabilities = providerRegistry.getContract(driver).capabilities ?? {};
      const shown: Record<string, unknown> = {};
      for (const key of PLATFORM_CAPABILITY_KEYS) {
        if (capabilities[key] !== undefined) shown[key] = capabilities[key];
      }
      return { ...view, driverCapabilities: shown as VectorProviderView['driverCapabilities'] };
    } catch {
      return view;
    }
  }

  try {
    const contract = providerRegistry.getContract(provider.driver);
    return {
      ...provider,
      driverCapabilities: contract.capabilities,
    };
  } catch (error) {
    logger.warn('Vector provider contract missing for driver', {
      driver: provider.driver,
      error: error instanceof Error ? error.message : error,
    });
  }

  return { ...provider };
}

/**
 * An index as a caller sees it. On a platform provider the provider's own identifier of the index (the name-scoped
 * driver keeps an ARN there) is never returned: the key is the handle callers use.
 */
function toIndexView(index: VectorIndexRecord, platform: boolean): VectorIndexView {
  if (!platform) return index;
  const { externalId: _externalId, ...rest } = index;
  void _externalId;
  return rest;
}

function ensureVectorProvider(record: IProviderRecord): void {
  if (record.type !== 'vector') {
    throw new Error('Provider configuration is not a vector provider.');
  }

  if (record.status !== 'active') {
    throw new Error('Vector provider is not active.');
  }
}

const logger = createLogger('vector');

function createProviderLogger(providerKey: string) {
  return createLogger(`vector:${providerKey}`);
}

interface VectorRuntimeContext {
  runtime: VectorProviderRuntime;
  record: IProviderRecord;
  /** A platform provider: served by the operator's backend, metered against the plan storage. */
  platform: boolean;
  /** The driver whose capabilities apply: the route's for a platform record, the record's otherwise. */
  driver: string;
}

async function buildRuntimeContext(
  tenantDbName: string,
  tenantId: string,
  providerKey: string,
  projectId?: string,
  options: { cleanup?: boolean } = {},
): Promise<VectorRuntimeContext> {
  // Deleting stays possible while the service is off, so removing a knowledge
  // engine, a memory store or a project still cleans up its vectors.
  if (!options.cleanup) await assertServiceEnabled({ tenantDbName, tenantId }, 'vector');
  try {
    const loaded = await loadStorageProvider('vector', { tenantDbName, tenantId, providerKey, projectId });
    const { record, credentials } = loaded;

    ensureVectorProvider(record);

    if (loaded.managed) {
      const runtime = await getManagedStorageRuntime<VectorProviderRuntime>('vector', { ...loaded, managed: loaded.managed }, { tenantId, projectId });
      return { runtime, record, platform: true, driver: loaded.managed.driver };
    }

    const cacheKey = `vector:${tenantId}:${record.key}`;
    const credHash = hashCredentials(credentials);

    const runtime = await runtimePool.getOrCreate<VectorProviderRuntime>(
      cacheKey,
      credHash,
      async () => {
        const providerLog = createProviderLogger(record.key);
        return providerRegistry.createRuntime<VectorProviderRuntime>(
          record.driver,
          {
            tenantId,
            providerKey: record.key,
            credentials,
            settings: record.settings ?? {},
            metadata: record.metadata ?? {},
            logger: providerLog,
          },
        );
      },
    );

    return { runtime, record, platform: false, driver: record.driver };
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) {
      throw new Error('Vector provider configuration not found.');
    }
    throw error;
  }
}

async function generateUniqueIndexKey(
  db: DatabaseProvider,
  providerKey: string,
  projectId: string,
  desiredKey: string | undefined,
): Promise<string> {
  const base = normalizeKeyCandidate(desiredKey);
  let attempt = 0;
  let candidate = base;

  while (attempt < MAX_KEY_ATTEMPTS) {
    const existing = await db.findVectorIndexByKey(
      providerKey,
      candidate,
      projectId,
    );
    if (!existing) {
      return candidate;
    }

    attempt += 1;
    candidate = `${base}-${attempt + 1}`;
  }

  throw new Error('Could not generate unique vector index key.');
}

function toRuntimeHandle(index: VectorIndexRecord): VectorIndexHandle {
  const metadata =
    index.metadata && Object.keys(index.metadata).length > 0
      ? index.metadata
      : undefined;

  return {
    externalId: index.externalId,
    name: index.name,
    dimension: index.dimension,
    metric: index.metric,
    metadata,
  };
}

function composeMetadataForCreate(
  remote: Record<string, unknown> | undefined,
  custom: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!remote && !custom) {
    return undefined;
  }

  const merged = {
    ...(custom ?? {}),
    ...(remote ?? {}),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeMetadataForUpdate(
  existing: Record<string, unknown> | undefined,
  updates: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!updates) {
    return existing && Object.keys(existing).length > 0 ? { ...existing } : undefined;
  }

  const merged = {
    ...(existing ?? {}),
    ...updates,
  };

  // vectorCount is computed live per request. A read-modify-write client would
  // otherwise persist a stale value that then outlives the provider it came from.
  delete merged.vectorCount;

  const hasValues = Object.keys(merged).some(
    (key) => merged[key] !== undefined && merged[key] !== null,
  );

  return hasValues ? merged : undefined;
}

function getRecordId(record: IVectorIndexRecord): string {
  if (!record._id) {
    throw new Error('Vector index record missing identifier.');
  }
  return typeof record._id === 'string' ? record._id : record._id.toString();
}

function validateVectors(
  index: VectorIndexRecord,
  vectors: VectorUpsertItem[],
): void {
  const expectedDimension = index.dimension;

  for (const vector of vectors) {
    if (!Array.isArray(vector.values)) {
      throw new Error(`Vector "${vector.id}" is missing numeric values.`);
    }

    if (vector.values.length !== expectedDimension) {
      throw new Error(
        `Vector "${vector.id}" must contain exactly ${expectedDimension} values.`,
      );
    }

    if (vector.values.some((value) => typeof value !== 'number' || Number.isNaN(value))) {
      throw new Error(`Vector "${vector.id}" contains non-numeric values.`);
    }
  }
}

async function requireVectorIndexRecord(
  db: DatabaseProvider,
  providerKey: string,
  key: string,
  projectId: string,
): Promise<VectorIndexRecord> {
  const record = await db.findVectorIndexByKey(providerKey, key, projectId);
  if (!record) {
    throw new Error('Vector index record not found.');
  }
  return record;
}

async function requireVectorIndexRecordByExternalId(
  db: DatabaseProvider,
  providerKey: string,
  externalId: string,
  projectId: string,
): Promise<VectorIndexRecord> {
  const record = await db.findVectorIndexByExternalId(
    providerKey,
    externalId,
    projectId,
  );
  if (!record) {
    throw new Error('Vector index metadata not found.');
  }
  return record;
}

async function resolveVectorIndexRecord(
  db: DatabaseProvider,
  providerKey: string,
  identifiers: { indexKey?: string; indexExternalId?: string },
  projectId: string,
): Promise<VectorIndexRecord> {
  if (identifiers.indexKey) {
    return requireVectorIndexRecord(db, providerKey, identifiers.indexKey, projectId);
  }

  if (identifiers.indexExternalId) {
    return requireVectorIndexRecordByExternalId(
      db,
      providerKey,
      identifiers.indexExternalId,
      projectId,
    );
  }

  throw new Error('Vector index identifier is required.');
}

export async function listVectorDrivers() {
  return providerRegistry.listTenantDescriptors('vector');
}

type ProviderFilters = NonNullable<Parameters<typeof listProviderConfigs>[2]>;
type VectorProviderFilters = Omit<ProviderFilters, 'type'>;
type CreateVectorProviderInput = Omit<CreateProviderConfigInput, 'type'>;

export async function listVectorProviders(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  filters?: VectorProviderFilters,
): Promise<VectorProviderView[]> {
  const providers = await listProviderConfigs(tenantDbName, tenantId, {
    ...(filters ?? {}),
    type: 'vector',
    projectId,
  });
  return providers.map((provider) => attachDriverCapabilities(provider));
}

export async function createVectorProvider(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  payload: CreateVectorProviderInput,
): Promise<VectorProviderView> {
  const provider = await createProviderConfig(tenantDbName, tenantId, {
    ...payload,
    type: 'vector',
    projectId,
  });
  return attachDriverCapabilities(provider);
}

/**
 * Thrown by `attachExistingIndex` when the provider can't be listed (missing
 * permission, or the driver doesn't support discovery) and the caller didn't
 * supply enough to attach blind. The API layer maps this to a distinguishable
 * response so the UI can prompt for the missing fields instead of failing flat.
 */
export class VectorAttachRequiresDetailsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorAttachRequiresDetailsError';
  }
}

/** Thrown when the provider was listed successfully but no index with this name/externalId exists there. */
export class VectorAttachNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorAttachNotFoundError';
  }
}

/**
 * Thrown when an existing index is to be attached (or a provider's remote indexes listed) on a platform provider,
 * where the tenant only ever sees the indexes it created. HTTP 409.
 */
export class VectorAttachNotAvailableError extends Error {
  readonly status = 409;

  readonly code = 'attach_not_available';

  constructor(message = 'Attaching an existing index is not available on this provider.') {
    super(message);
    this.name = 'VectorAttachNotAvailableError';
  }
}

async function attachExistingIndex(
  runtime: VectorProviderRuntime,
  providerKey: string,
  request: CreateVectorIndexRequest,
): Promise<VectorIndexHandle> {
  const wantedExternalId = request.externalId ?? request.name;
  let remoteIndexes: VectorIndexHandle[] | null = null;

  try {
    remoteIndexes = await runtime.listIndexes();
  } catch (error) {
    logger.warn('Vector attach: listIndexes failed, falling back to manual details', {
      providerKey,
      name: request.name,
      error: error instanceof Error ? error.message : error,
    });
  }

  if (remoteIndexes) {
    const match = remoteIndexes.find(
      (item) => item.name === request.name || item.externalId === wantedExternalId,
    );

    if (!match) {
      throw new VectorAttachNotFoundError(
        `No index named "${request.name}" was found on this provider. Create it there first, or enable "Create index in provider".`,
      );
    }

    if (request.dimension !== undefined && request.dimension !== match.dimension) {
      throw new Error(
        `Attach failed: the provider reports dimension ${match.dimension}, but ${request.dimension} was supplied.`,
      );
    }
    if (request.metric !== undefined && request.metric !== match.metric) {
      throw new Error(
        `Attach failed: the provider reports metric "${match.metric}", but "${request.metric}" was supplied.`,
      );
    }

    return match;
  }

  // Couldn't list the provider at all (permission or support gap) — we cannot
  // safely guess externalId ourselves, since adapters derive it differently
  // (e.g. Postgres/Mongo compose it from provider settings, others echo the
  // name back). The caller must supply the full shape.
  if (request.dimension === undefined || !request.metric || !request.externalId) {
    throw new VectorAttachRequiresDetailsError(
      'Could not read this index from the provider (insufficient permission, or listing is unsupported). Provide the external ID, dimension and metric manually to attach it.',
    );
  }

  return {
    externalId: request.externalId,
    name: request.name,
    dimension: request.dimension,
    metric: request.metric,
    metadata: request.metadata,
  };
}

export async function createVectorIndex(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  request: CreateVectorIndexRequest,
): Promise<VectorIndexView> {
  const { runtime, platform } = await buildRuntimeContext(
    tenantDbName,
    tenantId,
    request.providerKey,
    projectId,
  );

  const createInProvider = request.createInProvider !== false;
  // On a platform provider the tenant only has the indexes it created: nothing existing is listed or attached.
  if (platform && !createInProvider) throw new VectorAttachNotAvailableError();

  const db = await withTenantDb(tenantDbName);
  const key = await generateUniqueIndexKey(
    db,
    request.providerKey,
    projectId,
    request.key ?? request.name,
  );

  let handle: VectorIndexHandle;
  if (createInProvider) {
    if (request.dimension === undefined) {
      throw new Error('dimension is required to create a new index in the provider.');
    }
    handle = await withResilience(
      () => runtime.createIndex({
        name: request.name,
        dimension: request.dimension as number,
        metric: request.metric,
        metadata: request.metadata,
      }),
      { key: `vector-create:${request.providerKey}` },
    );
  } else {
    handle = await attachExistingIndex(runtime, request.providerKey, request);
  }

  // Nothing the backend reports about the index is kept on a platform provider: only what the tenant supplied.
  const metadata = composeMetadataForCreate(platform ? undefined : handle.metadata, request.metadata);

  const created = await db.createVectorIndex({
    tenantId,
    projectId,
    providerKey: request.providerKey,
    key,
    name: handle.name,
    externalId: handle.externalId,
    dimension: handle.dimension,
    metric: handle.metric,
    metadata,
    createdBy: request.createdBy,
    updatedBy: request.createdBy,
  });

  return toIndexView(created, platform);
}

export async function listVectorIndexes(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  providerKey: string,
): Promise<VectorIndexView[]> {
  const provider = await getProviderConfigByKey(
    tenantDbName,
    tenantId,
    providerKey,
    projectId,
  );

  if (!provider) {
    throw new Error('Vector provider configuration not found.');
  }

  const db = await withTenantDb(tenantDbName);
  const indexes = await db.listVectorIndexes({ providerKey, projectId });
  return indexes.map((index) => toIndexView(index, Boolean(provider.platform)));
}

export async function listProjectVectorIndexes(
  tenantDbName: string,
  projectId: string,
): Promise<VectorIndexView[]> {
  const db = await withTenantDb(tenantDbName);
  const indexes = await db.listVectorIndexes({ projectId });
  const isPlatform = new Map<string, boolean>();
  for (const index of indexes) {
    if (isPlatform.has(index.providerKey)) continue;
    const provider = await db.findProviderByKey(index.tenantId, index.providerKey);
    isPlatform.set(index.providerKey, Boolean(provider?.platform));
  }
  return indexes.map((index) => toIndexView(index, isPlatform.get(index.providerKey) === true));
}

export async function getVectorIndex(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  providerKey: string,
  key: string,
): Promise<{ index: VectorIndexView; provider: VectorProviderView }> {
  const provider = await getProviderConfigByKey(
    tenantDbName,
    tenantId,
    providerKey,
    projectId,
  );

  if (!provider) {
    throw new Error('Vector provider configuration not found.');
  }

  const db = await withTenantDb(tenantDbName);
  const index = await requireVectorIndexRecord(db, providerKey, key, projectId);

  return {
    index: toIndexView(index, Boolean(provider.platform)),
    provider: attachDriverCapabilities(provider),
  };
}

/**
 * Live vector count for an index, straight from the provider.
 *
 * Deliberately NOT part of `getVectorIndex`: that runs on the client API too,
 * and counting is expensive and side-effecting on several providers (Milvus
 * loads the collection into RAM, Postgres does a full COUNT(*), Mongo opens a
 * fresh connection). Keep it on the session-authenticated dashboard stats path
 * only. Returns undefined when the provider cannot cheaply report a total.
 */
export async function getVectorIndexCount(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  providerKey: string,
  key: string,
): Promise<number | undefined> {
  try {
    const db = await withTenantDb(tenantDbName);
    const index = await requireVectorIndexRecord(db, providerKey, key, projectId);
    const { runtime, platform } = await buildRuntimeContext(tenantDbName, tenantId, providerKey, projectId);

    const result = await withResilience(
      () => runtime.listVectors(toRuntimeHandle(index), { limit: 1 }),
      { key: `vector-count:${providerKey}` },
    );
    if (platform && typeof result.total === 'number') {
      await reconcileStoredSize(db, tenantId, index, result.total);
    }
    return result.total;
  } catch (error) {
    logger.warn('Failed to fetch live vector count for index', {
      providerKey,
      indexKey: key,
      error: error instanceof Error ? error.message : error,
    });
    return undefined;
  }
}

export async function updateVectorIndex(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  providerKey: string,
  key: string,
  updates: UpdateVectorIndexRequest,
): Promise<VectorIndexView> {
  const provider = await getProviderConfigByKey(
    tenantDbName,
    tenantId,
    providerKey,
    projectId,
  );

  if (!provider) {
    throw new Error('Vector provider configuration not found.');
  }

  const db = await withTenantDb(tenantDbName);
  const existing = await requireVectorIndexRecord(db, providerKey, key, projectId);

  // Only these fields are ever written: the provider's identifier of the index (`externalId`) and the metered size
  // are never taken from a request.
  const payload: Partial<IVectorIndexRecord> = {
    updatedBy: updates.updatedBy,
  };

  if (updates.name !== undefined) {
    payload.name = updates.name;
  }

  if (updates.metadata !== undefined) {
    payload.metadata = mergeMetadataForUpdate(existing.metadata, updates.metadata);
  }

  const updated = await db.updateVectorIndex(
    getRecordId(existing),
    payload,
  );

  if (!updated) {
    throw new Error('Failed to update vector index.');
  }

  return toIndexView(updated, Boolean(provider.platform));
}

export async function deleteVectorIndex(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  providerKey: string,
  key: string,
  _options?: { updatedBy?: string },
): Promise<void> {
  void _options;
  const { runtime, platform } = await buildRuntimeContext(
    tenantDbName,
    tenantId,
    providerKey,
    projectId,
    { cleanup: true },
  );

  const db = await withTenantDb(tenantDbName);
  const index = await requireVectorIndexRecord(db, providerKey, key, projectId);

  try {
    await withResilience(
      () => runtime.deleteIndex({ externalId: index.externalId }),
      { key: `vector-delete:${providerKey}` },
    );
  } catch (error) {
    logger.warn('Failed to delete remote vector index. Continuing with local cleanup.', { error });
  }

  await db.deleteVectorIndex(getRecordId(index));
  if (platform && index.storedBytes) noteStoredBytes(tenantId, -index.storedBytes);
}

export async function upsertVectors(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  request: VectorUpsertRequest,
): Promise<void> {
  const { runtime, platform } = await buildRuntimeContext(
    tenantDbName,
    tenantId,
    request.providerKey,
    projectId,
  );

  const db = await withTenantDb(tenantDbName);
  const index = await resolveVectorIndexRecord(
    db,
    request.providerKey,
    request,
    projectId,
  );

  // One request names an id once: the last item for it wins.
  const items = platform ? dedupeUpsertItems(request.vectors) : request.vectors;
  validateVectors(index, items);

  // What a platform provider stores counts against the plan storage: checked before the write, counted after it.
  // The check uses the full estimate (a replaced id is counted as new there: erring high is fine).
  const estimate = platform ? estimateUpsertBytes(index.dimension, items) : 0;
  let replaced = new Set<string>();
  if (platform) {
    const source: PlanLimitSource = request.updatedBy ? { type: 'user', id: request.updatedBy } : { type: 'system' };
    await assertStorageStock({ tenantId, incomingBytes: estimate, source });
    // Which ids the write replaces is asked before it. Unknown: every id counts as new (the high side).
    replaced = new Set(await findExistingIds(runtime, index, items.map((item) => String(item.id))) ?? []);
  }

  await withResilience(
    () => runtime.upsertVectors(toRuntimeHandle(index), items),
    { key: `vector-upsert:${request.providerKey}` },
  );

  if (platform) {
    // A new id adds its estimate and one vector. A replaced id changes the size by the difference to the average
    // (it may shrink the index) and adds no vector.
    const average = index.storedVectors ? (index.storedBytes ?? 0) / index.storedVectors : 0;
    let bytes = 0;
    let vectors = 0;
    for (const item of items) {
      const itemBytes = estimateUpsertBytes(index.dimension, [item]);
      if (replaced.has(String(item.id))) {
        bytes += itemBytes - Math.round(average);
      } else {
        bytes += itemBytes;
        vectors += 1;
      }
    }
    await adjustStoredSize(db, tenantId, index, bytes, vectors);
  }
}

export async function deleteVectors(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  request: VectorDeleteRequest,
): Promise<void> {
  if (!Array.isArray(request.ids) || request.ids.length === 0) {
    throw new Error('ids array is required to delete vectors.');
  }

  const { runtime, platform } = await buildRuntimeContext(
    tenantDbName,
    tenantId,
    request.providerKey,
    projectId,
    { cleanup: true },
  );

  const db = await withTenantDb(tenantDbName);
  const index = await resolveVectorIndexRecord(
    db,
    request.providerKey,
    request,
    projectId,
  );

  const ids = platform ? [...new Set(request.ids.map(String))] : request.ids;
  // Only vectors that exist are metered out: made-up or repeated ids must not shrink the meter. Asked before the delete.
  const existing = platform ? await findExistingIds(runtime, index, ids) : null;

  await withResilience(
    () => runtime.deleteVectors(toRuntimeHandle(index), ids),
    { key: `vector-delete-vectors:${request.providerKey}` },
  );

  if (platform) {
    if (!existing) {
      logger.debug('Vector delete not metered: the provider cannot confirm which ids exist', { indexKey: index.key });
      return;
    }
    // The size of a deleted vector is not known: the index's average stands in for it.
    const vectors = Math.min(existing.length, index.storedVectors ?? 0);
    const average = index.storedVectors ? (index.storedBytes ?? 0) / index.storedVectors : 0;
    await adjustStoredSize(db, tenantId, index, -Math.round(average * vectors), -vectors);
  }
}

/** The items of one upsert with one entry per id (the last one wins), in order of first appearance. */
function dedupeUpsertItems(items: VectorUpsertItem[]): VectorUpsertItem[] {
  const byId = new Map<string, VectorUpsertItem>();
  for (const item of items) byId.set(String(item.id), item);
  return [...byId.values()];
}

/**
 * The ids (of `ids`) the provider holds right now, or null when it cannot say (no such runtime method, or the lookup
 * failed): the caller then stays on the safe side of its metering.
 */
async function findExistingIds(
  runtime: VectorProviderRuntime,
  index: VectorIndexRecord,
  ids: string[],
): Promise<string[] | null> {
  if (!runtime.existingVectorIds) return null;
  try {
    return await runtime.existingVectorIds(toRuntimeHandle(index), ids);
  } catch (error) {
    logger.warn('Could not look up which vector ids exist', {
      indexKey: index.key,
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
}

/** Per-query notes of a platform provider a caller may see: nothing that names the backend. */
const PLATFORM_QUERY_USAGE_KEYS = ['hybrid', 'hybridMode', 'hybridUnavailable', 'resultCount'] as const;

function publicQueryUsage(usage: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!usage) return usage;
  const kept: Record<string, unknown> = {};
  for (const key of PLATFORM_QUERY_USAGE_KEYS) {
    if (key in usage) kept[key] = usage[key];
  }
  return kept;
}

/**
 * The bytes an upsert is expected to add on a platform provider: per vector its values (4 bytes each), its id and
 * its metadata as JSON. An estimate.
 */
export function estimateUpsertBytes(dimension: number, items: VectorUpsertItem[]): number {
  let total = 0;
  for (const item of items) {
    total += dimension * 4
      + Buffer.byteLength(String(item.id), 'utf8')
      + Buffer.byteLength(JSON.stringify(item.metadata ?? {}), 'utf8');
  }
  return total;
}

/**
 * Adds to the metered size of a platform index and to the tenant's cached storage count. The provider call it follows
 * has succeeded, so a bookkeeping failure is logged and never fails the request.
 */
async function adjustStoredSize(
  db: DatabaseProvider,
  tenantId: string,
  index: VectorIndexRecord,
  bytesDelta: number,
  vectorsDelta: number,
): Promise<void> {
  if (bytesDelta === 0 && vectorsDelta === 0) return;
  try {
    const updated = await db.adjustVectorIndexStorage(getRecordId(index), bytesDelta, vectorsDelta);
    // The cache moves by what the record really moved (it is clamped at 0).
    const moved = updated ? (updated.storedBytes ?? 0) - (index.storedBytes ?? 0) : bytesDelta;
    noteStoredBytes(tenantId, moved);
  } catch (error) {
    logger.warn('Failed to record the stored size of a vector index', {
      indexKey: index.key,
      error: error instanceof Error ? error.message : error,
    });
  }
}

/**
 * A live count below what was metered means vectors were removed some other way: both numbers scale down to it.
 * Never scales up (an estimate that is low is not corrected from a count).
 */
async function reconcileStoredSize(
  db: DatabaseProvider,
  tenantId: string,
  index: VectorIndexRecord,
  liveCount: number,
): Promise<void> {
  const metered = index.storedVectors ?? 0;
  if (metered <= 0 || liveCount >= metered) return;
  const bytes = index.storedBytes ?? 0;
  const keptBytes = Math.round((bytes * liveCount) / metered);
  await adjustStoredSize(db, tenantId, index, keptBytes - bytes, liveCount - metered);
}

/**
 * Parse a caller-supplied filter and confirm the driver can push it down.
 *
 * Filters are never applied after the fact: a driver that cannot express an
 * operator must fail the request rather than return results that silently
 * ignore the filter, so `topK` always counts matching documents.
 */
export function resolveVectorFilter(
  driver: string,
  filter: unknown,
): VectorFilterNode | undefined {
  const parsed = parseVectorFilter(filter);
  if (!parsed) return undefined;

  let capabilities;
  try {
    capabilities = providerRegistry.getContract(driver).capabilities;
  } catch {
    capabilities = undefined;
  }

  const operators = (capabilities?.['vector.filterOperators'] as VectorFilterOperator[] | undefined) ?? [];
  const supportsRaw = capabilities?.['vector.filterRaw'] === true;

  assertFilterSupported(parsed, { driverId: driver, operators, supportsRaw });

  return parsed;
}

/** The filter operators a driver can push down (empty when it declares none or is unknown). */
export function vectorFilterOperatorsOf(driver: string): VectorFilterOperator[] {
  try {
    const operators = providerRegistry.getContract(driver).capabilities?.['vector.filterOperators'];
    return Array.isArray(operators) ? (operators as VectorFilterOperator[]) : [];
  } catch {
    return [];
  }
}

/**
 * Whether a driver can run the keyword channel of a hybrid search.
 *
 * Absent means no: every vector contract states this explicitly, so a driver
 * whose capabilities say nothing is one that was never taught to fuse, and
 * handing it `text` would get the field quietly ignored.
 */
export function supportsHybridSearch(driver: string): boolean {
  try {
    return providerRegistry.getContract(driver).capabilities?.['vector.supportsHybrid'] === true;
  } catch {
    return false;
  }
}

/**
 * Account for a query: feed the usage rollup and record the row the index
 * analytics panel aggregates.
 *
 * Best-effort — a bookkeeping failure must never fail a search that already
 * returned results.
 */
async function recordVectorQuery(
  db: DatabaseProvider,
  input: {
    tenantDbName: string;
    tenantId: string;
    projectId?: string;
    providerKey: string;
    index: VectorIndexRecord;
    topK: number;
    filterApplied: boolean;
    /** Whether the keyword channel actually ran, not merely whether it was asked for. */
    hybrid: boolean;
    matches: VectorQueryResult['matches'];
    latencyMs: number;
    status: 'success' | 'error';
  },
): Promise<void> {
  // No tokens — query embeddings are billed through the models service.
  const attribution = recordUsageEvent({
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    projectId: input.projectId,
    service: 'vector',
    refKey: input.index.key,
    status: input.status,
    latencyMs: input.latencyMs,
    // Counted only when the keyword channel really ran, so the rollup answers
    // "how much of this index's traffic is hybrid" rather than how much asked.
    units: { matches: input.matches.length, ...(input.hybrid ? { hybrid: 1 } : {}) },
  });

  if (input.status === 'error') return;

  const scores = input.matches.map((match) => match.score).filter((score) => typeof score === 'number');

  try {
    await db.createVectorQueryLog({
      tenantId: input.tenantId,
      projectId: input.projectId,
      providerKey: input.providerKey,
      indexKey: input.index.key,
      topK: input.topK,
      matchCount: input.matches.length,
      latencyMs: input.latencyMs,
      avgScore: scores.length > 0
        ? scores.reduce((sum, score) => sum + score, 0) / scores.length
        : undefined,
      filterApplied: input.filterApplied,
      hybrid: input.hybrid,
      userId: attribution.userId,
      apiTokenId: attribution.apiTokenId,
      actorType: attribution.actorType,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.warn('Failed to record vector query log', { error });
  }
}

/* ── Query analytics ─────────────────────────────────────────────────── */

export interface VectorIndexQueryStats {
  daily: Array<{
    date: string;
    queryCount: number;
    avgLatencyMs: number;
    avgScore: number;
    filterCount: number;
  }>;
  totals: {
    totalQueries: number;
    avgLatencyMs: number;
    minLatencyMs: number;
    maxLatencyMs: number;
    avgScore: number;
  };
  topKDistribution: Array<{ topK: number; count: number }>;
  days: number;
  /**
   * Live vector total straight from the provider. Only present when the caller
   * supplies providerKey + tenantId; counting is expensive on several drivers,
   * so it stays on this session-authenticated path only.
   */
  vectorCount?: number;
}

/**
 * Resolve the index key the query logs are recorded under.
 *
 * Falls back to the external id so an index whose record has gone missing
 * still renders an (empty) panel instead of erroring.
 */
async function resolveStatsIndexKey(
  db: DatabaseProvider,
  externalId: string,
  providerKey: string | undefined,
  projectId: string | undefined,
): Promise<string> {
  if (providerKey) {
    const record = await db.findVectorIndexByExternalId(providerKey, externalId, projectId);
    return record?.key ?? externalId;
  }

  const indexes = await db.listVectorIndexes({ projectId });
  return indexes.find((index) => index.externalId === externalId)?.key ?? externalId;
}

/**
 * Query analytics for one vector index, shaped for the dashboard panel:
 * every day in the window is present (zero-filled) and averages are rounded.
 */
export async function getVectorIndexQueryStats(
  tenantDbName: string,
  projectId: string | undefined,
  params: {
    externalId: string;
    providerKey?: string;
    from: Date;
    to: Date;
    days: number;
    /** Supply together with providerKey to include the live vectorCount. */
    tenantId?: string;
  },
): Promise<VectorIndexQueryStats> {
  const db = await withTenantDb(tenantDbName);
  const indexKey = await resolveStatsIndexKey(
    db,
    params.externalId,
    params.providerKey,
    projectId,
  );

  const [stats, vectorCount] = await Promise.all([
    db.aggregateVectorQueryStats({
      indexKey,
      from: params.from,
      to: params.to,
    }),
    params.providerKey && params.tenantId
      ? getVectorIndexCount(tenantDbName, params.tenantId, projectId ?? '', params.providerKey, indexKey)
      : Promise.resolve(undefined),
  ]);

  const byDate = new Map(stats.daily.map((row) => [row.date, row]));
  const daily: VectorIndexQueryStats['daily'] = [];
  const dayStart = new Date(params.from);
  dayStart.setHours(0, 0, 0, 0);

  for (let offset = 0; offset < params.days; offset += 1) {
    const day = new Date(dayStart);
    day.setDate(dayStart.getDate() + offset);
    const date = day.toISOString().substring(0, 10);
    const row = byDate.get(date);

    daily.push({
      date,
      queryCount: row?.queryCount ?? 0,
      avgLatencyMs: Math.round(row?.avgLatencyMs ?? 0),
      avgScore: parseFloat((row?.avgScore ?? 0).toFixed(4)),
      filterCount: row?.filterCount ?? 0,
    });
  }

  return {
    daily,
    totals: {
      totalQueries: stats.totals.totalQueries,
      avgLatencyMs: Math.round(stats.totals.avgLatencyMs ?? 0),
      minLatencyMs: stats.totals.minLatencyMs ?? 0,
      maxLatencyMs: stats.totals.maxLatencyMs ?? 0,
      avgScore: parseFloat((stats.totals.avgScore ?? 0).toFixed(4)),
    },
    topKDistribution: stats.topKDistribution,
    days: params.days,
    vectorCount,
  };
}

export async function queryVectorIndex(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  request: VectorQueryRequest,
  options?: { signal?: AbortSignal },
): Promise<VectorQueryResponse> {
  const { runtime, driver, platform } = await buildRuntimeContext(
    tenantDbName,
    tenantId,
    request.providerKey,
    projectId,
  );

  const db = await withTenantDb(tenantDbName);
  const index = await resolveVectorIndexRecord(
    db,
    request.providerKey,
    request,
    projectId,
  );

  // Upserts are dimension-checked but queries were not: a mismatch surfaced
  // either as an opaque provider 500 or (on in-process providers) as silently
  // meaningless scores. Fail with something the caller can act on instead.
  if (Array.isArray(request.query?.vector) && request.query.vector.length !== index.dimension) {
    throw new Error(
      `Query vector has ${request.query.vector.length} values but index "${index.name}" expects ${index.dimension}. `
      + 'The embedding model likely differs from the one the index was built with.',
    );
  }

  const filter = resolveVectorFilter(driver, request.query.filter);

  const { text, hybrid, ...rest } = request.query;
  const keywordsRequested = typeof text === 'string' && text.trim().length > 0;
  // A driver that cannot fuse never sees `text`: leaving it on the input would
  // let an adapter drop it silently, and a caller has no way to tell a fused
  // result set from a dense one by looking at it.
  const keywordsAccepted = keywordsRequested && supportsHybridSearch(driver);
  const runtimeQuery: VectorQueryInput = {
    ...rest,
    filter,
    ...(keywordsAccepted ? { text, hybrid } : {}),
  };

  const startedAt = Date.now();

  let result: VectorQueryResult;
  try {
    result = await withResilience(
      () => runtime.queryVectors(toRuntimeHandle(index), runtimeQuery),
      { key: `vector-query:${request.providerKey}`, ...(options?.signal ? { signal: options.signal } : {}) },
    );
  } catch (error) {
    // A failed search still counts against the index's usage, and the rollup
    // tracks it as an error so the failure rate stays visible. Off the critical
    // path: bookkeeping must not delay the error the caller is waiting for.
    fireAndForget('vector-query-log', () => recordVectorQuery(db, {
      tenantDbName,
      tenantId,
      projectId,
      providerKey: request.providerKey,
      index,
      topK: request.query.topK,
      filterApplied: Boolean(filter),
      hybrid: false,
      matches: [],
      latencyMs: Date.now() - startedAt,
      status: 'error',
    }));
    throw error;
  }

  // The adapter is the only party that knows whether the keyword channel really
  // ran: an index may predate the searchable text field, or the store may need
  // a full-text index nobody created. Trust its report, never the request.
  const hybridRan = result.usage?.hybrid === true;

  if (keywordsRequested && !keywordsAccepted) {
    result = {
      ...result,
      usage: {
        ...(result.usage ?? {}),
        ...describeHybrid({ ran: false, reason: 'driver' }),
      },
    };
  }

  // Telemetry must not sit on the query's critical path — awaiting it added a
  // full DB round trip (usage rollup + query log) to every search.
  fireAndForget('vector-query-log', () => recordVectorQuery(db, {
    tenantDbName,
    tenantId,
    projectId,
    providerKey: request.providerKey,
    index,
    topK: request.query.topK,
    filterApplied: Boolean(filter),
    hybrid: hybridRan,
    matches: result.matches,
    latencyMs: Date.now() - startedAt,
    status: 'success',
  }));

  // On a platform provider the driver's notes can carry the backend's identifiers (index ARN, bucket): only an
  // allowlist leaves.
  if (platform) {
    const usage = publicQueryUsage(result.usage);
    return { ...result, ...(usage ? { usage } : {}) };
  }
  return result;
}
