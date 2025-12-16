import {
  getDatabase,
  IProviderRecord,
  ProviderDomain,
} from '@/lib/database';
import { decryptObject, encryptObject } from '@/lib/utils/crypto';

export type ProviderStatus = IProviderRecord['status'];

export interface CreateProviderConfigInput {
  projectId?: string;
  key: string;
  type: ProviderDomain;
  driver: string;
  label: string;
  description?: string;
  status?: ProviderStatus;
  credentials: Record<string, unknown>;
  settings?: Record<string, unknown>;
  capabilitiesOverride?: string[];
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface UpdateProviderConfigInput {
  projectIds?: string[];
  label?: string;
  description?: string;
  status?: ProviderStatus;
  credentials?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  capabilitiesOverride?: string[];
  metadata?: Record<string, unknown>;
  updatedBy?: string;
}

export interface ProviderConfigView
  extends Omit<IProviderRecord, 'credentialsEnc'> {
  hasCredentials: boolean;
}

function sanitize(record: IProviderRecord): ProviderConfigView {
  const { credentialsEnc, ...rest } = record;
  return {
    ...rest,
    hasCredentials: Boolean(credentialsEnc),
  };
}

async function withTenantDb(tenantDbName: string) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

export async function createProviderConfig(
  tenantDbName: string,
  tenantId: string,
  payload: CreateProviderConfigInput,
): Promise<ProviderConfigView> {
  const db = await withTenantDb(tenantDbName);

  // Provider keys are tenant-level; project assignment is handled via projectIds.
  const existing = await db.findProviderByKey(tenantId, payload.key);
  if (existing) {
    throw new Error(`Provider with key "${payload.key}" already exists.`);
  }

  const record = await db.createProvider({
    tenantId,
    projectIds: payload.projectId ? [payload.projectId] : undefined,
    key: payload.key,
    type: payload.type,
    driver: payload.driver,
    label: payload.label,
    description: payload.description,
    status: payload.status ?? 'active',
    credentialsEnc: encryptObject(payload.credentials),
    settings: payload.settings ?? {},
    capabilitiesOverride: payload.capabilitiesOverride ?? undefined,
    metadata: payload.metadata ?? undefined,
    createdBy: payload.createdBy,
    updatedBy: payload.createdBy,
  });

  return sanitize(record);
}

export async function updateProviderConfig(
  tenantDbName: string,
  providerId: string,
  payload: UpdateProviderConfigInput,
): Promise<ProviderConfigView | null> {
  const db = await withTenantDb(tenantDbName);
  const updates: Partial<IProviderRecord> = {};

  if (payload.projectIds !== undefined) {
    updates.projectIds = payload.projectIds;
  }

  if (payload.label !== undefined) {
    updates.label = payload.label;
  }

  if (payload.description !== undefined) {
    updates.description = payload.description;
  }

  if (payload.status !== undefined) {
    updates.status = payload.status;
  }

  if (payload.settings !== undefined) {
    updates.settings = payload.settings;
  }

  if (payload.capabilitiesOverride !== undefined) {
    updates.capabilitiesOverride = payload.capabilitiesOverride;
  }

  if (payload.metadata !== undefined) {
    updates.metadata = payload.metadata;
  }

  if (payload.credentials !== undefined) {
    updates.credentialsEnc = encryptObject(payload.credentials);
  }

  if (payload.updatedBy) {
    updates.updatedBy = payload.updatedBy;
  }

  const updated = await db.updateProvider(providerId, updates);
  return updated ? sanitize(updated) : null;
}

export async function listProviderConfigs(
  tenantDbName: string,
  tenantId: string,
  filters?: {
    type?: ProviderDomain;
    driver?: string;
    status?: ProviderStatus;
    projectId?: string;
  },
): Promise<ProviderConfigView[]> {
  const db = await withTenantDb(tenantDbName);
  const records = await db.listProviders(tenantId, filters);
  return records.map(sanitize);
}

export async function getProviderConfigById(
  tenantDbName: string,
  providerId: string,
): Promise<ProviderConfigView | null> {
  const db = await withTenantDb(tenantDbName);
  const record = await db.findProviderById(providerId);
  return record ? sanitize(record) : null;
}

export async function getProviderConfigByKey(
  tenantDbName: string,
  tenantId: string,
  key: string,
  projectId?: string,
): Promise<ProviderConfigView | null> {
  const db = await withTenantDb(tenantDbName);
  const record = await db.findProviderByKey(tenantId, key, projectId);
  return record ? sanitize(record) : null;
}

export async function deleteProviderConfig(
  tenantDbName: string,
  providerId: string,
): Promise<boolean> {
  const db = await withTenantDb(tenantDbName);
  return db.deleteProvider(providerId);
}

export interface ProviderRuntimeData<TCredentials = Record<string, unknown>> {
  record: IProviderRecord;
  credentials: TCredentials;
}

export async function loadProviderRuntimeData<TCredentials = Record<string, unknown>>(
  tenantDbName: string,
  providerIdOrKey: {
    id?: string;
    key?: string;
    tenantId: string;
    projectId?: string;
  },
): Promise<ProviderRuntimeData<TCredentials>> {
  const db = await withTenantDb(tenantDbName);
  let record: IProviderRecord | null = null;

  if (providerIdOrKey.id) {
    record = await db.findProviderById(providerIdOrKey.id);
  } else if (providerIdOrKey.key) {
    record = await db.findProviderByKey(
      providerIdOrKey.tenantId,
      providerIdOrKey.key,
      providerIdOrKey.projectId,
    );
  }

  if (!record) {
    throw new Error('Provider configuration not found.');
  }

  const credentials = decryptObject<TCredentials>(record.credentialsEnc);

  return {
    record,
    credentials,
  };
}
