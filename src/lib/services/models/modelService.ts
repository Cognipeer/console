import slugify from 'slugify';
import { createLogger } from '@/lib/core/logger';
import { getCache } from '@/lib/core/cache';
import {
  getDatabase,
  IModel,
  IModelUsageAggregate,
  IModelUsageLog,
  ModelCategory,
} from '@/lib/database';
import { providerRegistry } from '@/lib/providers';
import {
  createProviderConfig,
  getProviderConfigByKey,
  listProviderConfigs,
  type ProviderConfigView,
  type ProviderStatus,
} from '@/lib/services/providers/providerService';
import type {
  CreateModelInput,
  UpdateModelInput,
  ModelProviderView,
  CreateModelProviderInput,
} from './types';

const logger = createLogger('model-service');

const SLUG_OPTIONS = {
  lower: true,
  strict: true,
  trim: true,
};

const MAX_KEY_ATTEMPTS = 50;
const MODEL_CATEGORY_CAPABILITY_KEY = 'model.categories';

function attachDriverCapabilities(provider: ProviderConfigView): ModelProviderView {
  try {
    const contract = providerRegistry.getContract(provider.driver);
    return {
      ...provider,
      driverCapabilities: contract.capabilities,
    };
  } catch (error) {
    logger.warn('Model provider contract missing for driver', {
      driver: provider.driver,
      error: error instanceof Error ? error.message : error,
    });
  }

  return { ...provider };
}

async function requireModelProvider(
  tenantDbName: string,
  tenantId: string,
  providerKey: string,
  projectId?: string,
): Promise<ModelProviderView> {
  const provider = await getProviderConfigByKey(
    tenantDbName,
    tenantId,
    providerKey,
    projectId,
  );

  if (!provider) {
    throw new Error('Model provider configuration not found.');
  }

  if (provider.type !== 'model') {
    throw new Error('Provider is not configured for model operations.');
  }

  return attachDriverCapabilities(provider);
}

function ensureProviderSupportsCategory(
  provider: ModelProviderView,
  category: ModelCategory,
) {
  const rawCategories = provider.driverCapabilities?.[MODEL_CATEGORY_CAPABILITY_KEY];
  if (!Array.isArray(rawCategories)) {
    return;
  }

  const categories = rawCategories.filter((value): value is ModelCategory =>
    value === 'llm' || value === 'embedding',
  );

  if (categories.length === 0) {
    return;
  }

  if (!categories.includes(category)) {
    throw new Error('Selected provider does not support requested category');
  }
}

function normalizeKeyCandidate(input: string): string {
  const fallback = input?.trim().length ? input.trim() : 'model';
  return slugify(fallback, SLUG_OPTIONS);
}

function ensureCurrency(
  pricing: CreateModelInput['pricing'],
): CreateModelInput['pricing'] {
  return {
    currency: pricing.currency || 'USD',
    inputTokenPer1M: pricing.inputTokenPer1M,
    outputTokenPer1M: pricing.outputTokenPer1M,
    cachedTokenPer1M: pricing.cachedTokenPer1M ?? 0,
  };
}

export async function listModels(
  tenantDbName: string,
  projectId: string,
  filters?: { category?: ModelCategory; providerKey?: string; providerDriver?: string },
): Promise<IModel[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listModels({ ...filters, projectId });
}

async function generateUniqueKey(
  tenantDbName: string,
  projectId: string,
  desiredKey: string,
): Promise<string> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const base = normalizeKeyCandidate(desiredKey);
  let attempt = 0;
  let candidate = base;

  while (attempt < MAX_KEY_ATTEMPTS) {
    const existing = await db.findModelByKey(candidate, projectId);
    if (!existing) {
      return candidate;
    }
    attempt += 1;
    candidate = `${base}-${attempt + 1}`;
  }

  throw new Error('Could not generate unique model key');
}

export async function createModel(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  userId: string,
  payload: CreateModelInput,
): Promise<IModel> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const provider = await requireModelProvider(
    tenantDbName,
    tenantId,
    payload.providerKey,
    projectId,
  );

  ensureProviderSupportsCategory(provider, payload.category);

  const keyCandidate = payload.key || payload.name;
  const key = await generateUniqueKey(tenantDbName, projectId, keyCandidate);

  const newModel: Omit<IModel, '_id' | 'createdAt' | 'updatedAt'> = {
    tenantId,
    projectId,
    name: payload.name,
    description: payload.description,
    key,
    providerKey: provider.key,
    providerDriver: provider.driver,
    category: payload.category,
    modelId: payload.modelId,
    pricing: ensureCurrency(payload.pricing),
    settings: payload.settings,
    isMultimodal: payload.isMultimodal ?? false,
    supportsToolCalls:
      payload.supportsToolCalls ??
      Boolean(provider.driverCapabilities?.['model.supports.tool_calls']),
    metadata: payload.metadata || {},
    createdBy: userId,
    updatedBy: userId,
  };

  const created = await db.createModel(newModel);
  return created;
}

export async function updateModel(
  tenantDbName: string,
  projectId: string,
  modelId: string,
  updates: UpdateModelInput,
  userId?: string,
): Promise<IModel | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const existing = await db.findModelById(modelId, projectId);
  if (!existing) {
    return null;
  }

  const updatePayload: UpdateModelInput & { updatedBy?: string } = {
    ...updates,
  };
  if (updates.pricing) {
    updatePayload.pricing = ensureCurrency(updates.pricing);
  }

  if (updates.key && updates.key !== existing.key) {
    updatePayload.key = await generateUniqueKey(tenantDbName, projectId, updates.key);
  }

  if (updates.providerKey && updates.providerKey !== existing.providerKey) {
    const provider = await requireModelProvider(
      tenantDbName,
      existing.tenantId,
      updates.providerKey,
      projectId,
    );

    ensureProviderSupportsCategory(provider, updates.category ?? existing.category);

    updatePayload.providerKey = provider.key;
    updatePayload.providerDriver = provider.driver;
    updatePayload.supportsToolCalls =
      updates.supportsToolCalls ??
      Boolean(provider.driverCapabilities?.['model.supports.tool_calls']);
  }

  if (userId) {
    updatePayload.updatedBy = userId;
  }

  return db.updateModel(modelId, updatePayload as Partial<IModel>);
}

export async function deleteModel(
  tenantDbName: string,
  projectId: string,
  modelId: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const existing = await db.findModelById(modelId, projectId);
  if (!existing) {
    return false;
  }
  return db.deleteModel(modelId);
}

export async function getModelByKey(
  tenantDbName: string,
  key: string,
  projectId: string,
): Promise<IModel | null> {
  const cacheKey = `model-meta:${tenantDbName}:${projectId}:${key}`;
  try {
    const cache = await getCache();
    const cached = await cache.get<IModel>(cacheKey);
    if (cached) return cached;
  } catch { /* cache miss / unavailable — fall through to DB */ }

  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const model = await db.findModelByKey(key, projectId);
  if (model) {
    try {
      const cache = await getCache();
      await cache.set(cacheKey, model, 120);
    } catch { /* best-effort cache write */ }
  }
  return model;
}

export async function getModelById(
  tenantDbName: string,
  id: string,
  projectId: string,
): Promise<IModel | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findModelById(id, projectId);
}

export async function listUsageLogs(
  tenantDbName: string,
  modelKey: string,
  projectId: string,
  options?: { limit?: number; skip?: number; from?: Date; to?: Date },
): Promise<IModelUsageLog[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listModelUsageLogs(modelKey, options, projectId);
}

export async function getUsageAggregate(
  tenantDbName: string,
  modelKey: string,
  projectId: string,
  options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
): Promise<IModelUsageAggregate> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.aggregateModelUsage(modelKey, options, projectId);
}

export async function listModelProviders(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  filters?: {
    status?: ProviderStatus;
    driver?: string;
  },
): Promise<ModelProviderView[]> {
  const providers = await listProviderConfigs(tenantDbName, tenantId, {
    type: 'model',
    projectId,
    ...(filters ?? {}),
  });

  return providers.map((provider) => attachDriverCapabilities(provider));
}

export async function createModelProvider(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  payload: CreateModelProviderInput,
): Promise<ModelProviderView> {
  const provider = await createProviderConfig(tenantDbName, tenantId, {
    ...payload,
    type: 'model',
    projectId,
  });

  return attachDriverCapabilities(provider);
}

export function listModelDriverDescriptors() {
  return providerRegistry.listDescriptors('model');
}
