import slugify from 'slugify';
import { getDatabase, IModel, IModelUsageAggregate, IModelUsageLog, ModelCategory, ModelProviderType } from '@/lib/database';
import { CreateModelInput, UpdateModelInput } from './types';
import { PROVIDER_DEFINITIONS } from './providerCatalog';

const SLUG_OPTIONS = {
  lower: true,
  strict: true,
  trim: true,
};

const MAX_KEY_ATTEMPTS = 50;

function normalizeKeyCandidate(input: string): string {
  const fallback = input?.trim().length ? input.trim() : 'model';
  return slugify(fallback, SLUG_OPTIONS);
}

function ensureCurrency(pricing: CreateModelInput['pricing']): CreateModelInput['pricing'] {
  return {
    currency: pricing.currency || 'USD',
    inputTokenPer1M: pricing.inputTokenPer1M,
    outputTokenPer1M: pricing.outputTokenPer1M,
    cachedTokenPer1M: pricing.cachedTokenPer1M ?? 0,
  };
}

function getProviderDefinition(provider: ModelProviderType) {
  const definition = PROVIDER_DEFINITIONS.find((item) => item.id === provider);
  if (!definition) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return definition;
}

export async function listModels(tenantDbName: string, filters?: { category?: ModelCategory; provider?: ModelProviderType; }): Promise<IModel[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listModels(filters);
}

async function generateUniqueKey(tenantDbName: string, desiredKey: string): Promise<string> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const base = normalizeKeyCandidate(desiredKey);
  let attempt = 0;
  let candidate = base;

  while (attempt < MAX_KEY_ATTEMPTS) {
    const existing = await db.findModelByKey(candidate);
    if (!existing) {
      return candidate;
    }
    attempt += 1;
    candidate = `${base}-${attempt + 1}`;
  }

  throw new Error('Could not generate unique model key');
}

export async function createModel(tenantDbName: string, tenantId: string, userId: string, payload: CreateModelInput): Promise<IModel> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const providerDefinition = getProviderDefinition(payload.provider);

  if (!providerDefinition.categories.includes(payload.category)) {
    throw new Error('Selected provider does not support requested category');
  }

  const keyCandidate = payload.key || payload.name;
  const key = await generateUniqueKey(tenantDbName, keyCandidate);

  const newModel: Omit<IModel, '_id' | 'createdAt' | 'updatedAt'> = {
    tenantId,
    name: payload.name,
    description: payload.description,
    key,
    provider: payload.provider,
    category: payload.category,
    modelId: payload.modelId,
    pricing: ensureCurrency(payload.pricing),
    settings: payload.settings,
    isMultimodal: payload.isMultimodal ?? false,
    supportsToolCalls: payload.supportsToolCalls ?? false,
    metadata: payload.metadata || {},
    createdBy: userId,
    updatedBy: userId,
  };

  const created = await db.createModel(newModel);
  return created;
}

export async function updateModel(tenantDbName: string, modelId: string, updates: UpdateModelInput, userId?: string): Promise<IModel | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const existing = await db.findModelById(modelId);
  if (!existing) {
    return null;
  }

  const updatePayload: UpdateModelInput & { updatedBy?: string } = { ...updates };
  if (updates.pricing) {
    updatePayload.pricing = ensureCurrency(updates.pricing);
  }

  if (updates.key && updates.key !== existing.key) {
    updatePayload.key = await generateUniqueKey(tenantDbName, updates.key);
  }

  if (userId) {
    updatePayload.updatedBy = userId;
  }

  return db.updateModel(modelId, updatePayload as any);
}

export async function deleteModel(tenantDbName: string, modelId: string): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.deleteModel(modelId);
}

export async function getModelByKey(tenantDbName: string, key: string): Promise<IModel | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findModelByKey(key);
}

export async function getModelById(tenantDbName: string, id: string): Promise<IModel | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findModelById(id);
}

export async function listUsageLogs(tenantDbName: string, modelKey: string, options?: { limit?: number; skip?: number; from?: Date; to?: Date; }): Promise<IModelUsageLog[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listModelUsageLogs(modelKey, options);
}

export async function getUsageAggregate(tenantDbName: string, modelKey: string, options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month'; }): Promise<IModelUsageAggregate> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.aggregateModelUsage(modelKey, options);
}

export function getProviderDefinitions() {
  return PROVIDER_DEFINITIONS;
}
