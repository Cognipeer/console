import slugify from 'slugify';
import {
  getDatabase,
  type DatabaseProvider,
  type IProviderRecord,
  type IVectorIndexRecord,
} from '@/lib/database';
import {
  providerRegistry,
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
    console.warn(
      'Vector provider contract missing for driver',
      provider.driver,
      error instanceof Error ? error.message : error,
    );
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

function createLogger(providerKey: string) {
  const scope = `[vector:${providerKey}]`;
  return {
    debug: (...args: unknown[]) => console.debug(scope, ...args),
    info: (...args: unknown[]) => console.info(scope, ...args),
    warn: (...args: unknown[]) => console.warn(scope, ...args),
    error: (...args: unknown[]) => console.error(scope, ...args),
  };
}

async function buildRuntimeContext(
  tenantDbName: string,
  tenantId: string,
  providerKey: string,
): Promise<{ runtime: VectorProviderRuntime; record: IProviderRecord }> {
  try {
    const { record, credentials } = await loadProviderRuntimeData(
      tenantDbName,
      { tenantId, key: providerKey },
    );

    ensureVectorProvider(record);

    const logger = createLogger(record.key);
    const runtime = await providerRegistry.createRuntime<VectorProviderRuntime>(
      record.driver,
      {
        tenantId,
        providerKey: record.key,
        credentials,
        settings: record.settings ?? {},
        metadata: record.metadata ?? {},
        logger,
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
  desiredKey: string | undefined,
): Promise<string> {
  const base = normalizeKeyCandidate(desiredKey);
  let attempt = 0;
  let candidate = base;

  while (attempt < MAX_KEY_ATTEMPTS) {
    const existing = await db.findVectorIndexByKey(providerKey, candidate);
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
): Promise<VectorIndexRecord> {
  const record = await db.findVectorIndexByKey(providerKey, key);
  if (!record) {
    throw new Error('Vector index record not found.');
  }
  return record;
}

async function requireVectorIndexRecordByExternalId(
  db: DatabaseProvider,
  providerKey: string,
  externalId: string,
): Promise<VectorIndexRecord> {
  const record = await db.findVectorIndexByExternalId(providerKey, externalId);
  if (!record) {
    throw new Error('Vector index metadata not found.');
  }
  return record;
}

async function resolveVectorIndexRecord(
  db: DatabaseProvider,
  providerKey: string,
  identifiers: { indexKey?: string; indexExternalId?: string },
): Promise<VectorIndexRecord> {
  if (identifiers.indexKey) {
    return requireVectorIndexRecord(db, providerKey, identifiers.indexKey);
  }

  if (identifiers.indexExternalId) {
    return requireVectorIndexRecordByExternalId(
      db,
      providerKey,
      identifiers.indexExternalId,
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
  filters?: VectorProviderFilters,
): Promise<VectorProviderView[]> {
  const providers = await listProviderConfigs(tenantDbName, tenantId, {
    ...(filters ?? {}),
    type: 'vector',
  });
  return providers.map((provider) => attachDriverCapabilities(provider));
}

export async function createVectorProvider(
  tenantDbName: string,
  tenantId: string,
  payload: CreateVectorProviderInput,
): Promise<VectorProviderView> {
  const provider = await createProviderConfig(tenantDbName, tenantId, {
    ...payload,
    type: 'vector',
  });
  return attachDriverCapabilities(provider);
}

export async function createVectorIndex(
  tenantDbName: string,
  tenantId: string,
  request: CreateVectorIndexRequest,
): Promise<VectorIndexRecord> {
  const { runtime } = await buildRuntimeContext(
    tenantDbName,
    tenantId,
    request.providerKey,
  );

  const db = await withTenantDb(tenantDbName);
  const key = await generateUniqueIndexKey(
    db,
    request.providerKey,
    request.key ?? request.name,
  );

  const handle = await runtime.createIndex({
    name: request.name,
    dimension: request.dimension,
    metric: request.metric,
    metadata: request.metadata,
  });

  const metadata = composeMetadataForCreate(handle.metadata, request.metadata);

  const created = await db.createVectorIndex({
    tenantId,
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
  providerKey: string,
): Promise<VectorIndexRecord[]> {
  const provider = await getProviderConfigByKey(
    tenantDbName,
    tenantId,
    providerKey,
  );

  if (!provider) {
    throw new Error('Vector provider configuration not found.');
  }

  const db = await withTenantDb(tenantDbName);
  return db.listVectorIndexes({ providerKey });
}

export async function getVectorIndex(
  tenantDbName: string,
  tenantId: string,
  providerKey: string,
  key: string,
): Promise<{ index: VectorIndexRecord; provider: VectorProviderView }> {
  const provider = await getProviderConfigByKey(
    tenantDbName,
    tenantId,
    providerKey,
  );

  if (!provider) {
    throw new Error('Vector provider configuration not found.');
  }

  const db = await withTenantDb(tenantDbName);
  const index = await requireVectorIndexRecord(db, providerKey, key);

  return {
    index,
    provider: attachDriverCapabilities(provider),
  };
}

export async function updateVectorIndex(
  tenantDbName: string,
  tenantId: string,
  providerKey: string,
  key: string,
  updates: UpdateVectorIndexRequest,
): Promise<VectorIndexRecord> {
  const provider = await getProviderConfigByKey(
    tenantDbName,
    tenantId,
    providerKey,
  );

  if (!provider) {
    throw new Error('Vector provider configuration not found.');
  }

  const db = await withTenantDb(tenantDbName);
  const existing = await requireVectorIndexRecord(db, providerKey, key);

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
  providerKey: string,
  key: string,
  _options?: { updatedBy?: string },
): Promise<void> {
  const { runtime } = await buildRuntimeContext(
    tenantDbName,
    tenantId,
    providerKey,
  );

  const db = await withTenantDb(tenantDbName);
  const index = await requireVectorIndexRecord(db, providerKey, key);

  try {
    await runtime.deleteIndex({ externalId: index.externalId });
  } catch (error) {
    console.warn(
      'Failed to delete remote vector index. Continuing with local cleanup.',
      error,
    );
  }

  await db.deleteVectorIndex(getRecordId(index));
}

export async function upsertVectors(
  tenantDbName: string,
  tenantId: string,
  request: VectorUpsertRequest,
): Promise<void> {
  const { runtime } = await buildRuntimeContext(
    tenantDbName,
    tenantId,
    request.providerKey,
  );

  const db = await withTenantDb(tenantDbName);
  const index = await resolveVectorIndexRecord(db, request.providerKey, request);

  validateVectors(index, request.vectors);

  await runtime.upsertVectors(toRuntimeHandle(index), request.vectors);
}

export async function deleteVectors(
  tenantDbName: string,
  tenantId: string,
  request: VectorDeleteRequest,
): Promise<void> {
  if (!Array.isArray(request.ids) || request.ids.length === 0) {
    throw new Error('ids array is required to delete vectors.');
  }

  const { runtime } = await buildRuntimeContext(
    tenantDbName,
    tenantId,
    request.providerKey,
  );

  const db = await withTenantDb(tenantDbName);
  const index = await resolveVectorIndexRecord(db, request.providerKey, request);

  await runtime.deleteVectors(toRuntimeHandle(index), request.ids);
}

export async function queryVectorIndex(
  tenantDbName: string,
  tenantId: string,
  request: VectorQueryRequest,
): Promise<VectorQueryResponse> {
  const { runtime } = await buildRuntimeContext(
    tenantDbName,
    tenantId,
    request.providerKey,
  );

  const db = await withTenantDb(tenantDbName);
  const index = await resolveVectorIndexRecord(db, request.providerKey, request);

  const result: VectorQueryResult = await runtime.queryVectors(
    toRuntimeHandle(index),
    request.query,
  );

  return result;
}
