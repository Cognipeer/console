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
import {
  providerRegistry,
  assertFilterSupported,
  parseVectorFilter,
  type VectorFilterNode,
  type VectorFilterOperator,
  type VectorProviderRuntime,
  type VectorIndexHandle,
  type VectorQueryResult,
  type VectorUpsertItem,
} from '@/lib/providers';
import {
  loadProviderRuntimeData,
  listProviderConfigs,
  createProviderConfig,
  getProviderConfigByKey,
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

function attachDriverCapabilities(provider: ProviderConfigView): VectorProviderView {
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

async function buildRuntimeContext(
  tenantDbName: string,
  tenantId: string,
  providerKey: string,
  projectId?: string,
): Promise<{ runtime: VectorProviderRuntime; record: IProviderRecord }> {
  try {
    const { record, credentials } = await loadProviderRuntimeData(
      tenantDbName,
      { tenantId, key: providerKey, projectId },
    );

    ensureVectorProvider(record);

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

    return { runtime, record };
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
  return providerRegistry.listDescriptors('vector');
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

export async function createVectorIndex(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  request: CreateVectorIndexRequest,
): Promise<VectorIndexRecord> {
  const { runtime } = await buildRuntimeContext(
    tenantDbName,
    tenantId,
    request.providerKey,
    projectId,
  );

  const db = await withTenantDb(tenantDbName);
  const key = await generateUniqueIndexKey(
    db,
    request.providerKey,
    projectId,
    request.key ?? request.name,
  );

  const handle = await withResilience(
    () => runtime.createIndex({
      name: request.name,
      dimension: request.dimension,
      metric: request.metric,
      metadata: request.metadata,
    }),
    { key: `vector-create:${request.providerKey}` },
  );

  const metadata = composeMetadataForCreate(handle.metadata, request.metadata);

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

  return created;
}

export async function listVectorIndexes(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  providerKey: string,
): Promise<VectorIndexRecord[]> {
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
  return db.listVectorIndexes({ providerKey, projectId });
}

export async function listProjectVectorIndexes(
  tenantDbName: string,
  projectId: string,
): Promise<VectorIndexRecord[]> {
  const db = await withTenantDb(tenantDbName);
  return db.listVectorIndexes({ projectId });
}

export async function getVectorIndex(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  providerKey: string,
  key: string,
): Promise<{ index: VectorIndexRecord; provider: VectorProviderView }> {
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
    index,
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
    const { runtime } = await buildRuntimeContext(tenantDbName, tenantId, providerKey, projectId);

    const result = await withResilience(
      () => runtime.listVectors(toRuntimeHandle(index), { limit: 1 }),
      { key: `vector-count:${providerKey}` },
    );
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
): Promise<VectorIndexRecord> {
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

  return updated;
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
  const { runtime } = await buildRuntimeContext(
    tenantDbName,
    tenantId,
    providerKey,
    projectId,
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
}

export async function upsertVectors(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  request: VectorUpsertRequest,
): Promise<void> {
  const { runtime } = await buildRuntimeContext(
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

  validateVectors(index, request.vectors);

  await withResilience(
    () => runtime.upsertVectors(toRuntimeHandle(index), request.vectors),
    { key: `vector-upsert:${request.providerKey}` },
  );
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

  const { runtime } = await buildRuntimeContext(
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

  await withResilience(
    () => runtime.deleteVectors(toRuntimeHandle(index), request.ids),
    { key: `vector-delete-vectors:${request.providerKey}` },
  );
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
    units: { matches: input.matches.length },
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
): Promise<VectorQueryResponse> {
  const { runtime, record } = await buildRuntimeContext(
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

  const filter = resolveVectorFilter(record.driver, request.query.filter);

  const startedAt = Date.now();

  let result: VectorQueryResult;
  try {
    result = await withResilience(
      () => runtime.queryVectors(
        toRuntimeHandle(index),
        { ...request.query, filter },
      ),
      { key: `vector-query:${request.providerKey}` },
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
      matches: [],
      latencyMs: Date.now() - startedAt,
      status: 'error',
    }));
    throw error;
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
    matches: result.matches,
    latencyMs: Date.now() - startedAt,
    status: 'success',
  }));

  return result;
}
