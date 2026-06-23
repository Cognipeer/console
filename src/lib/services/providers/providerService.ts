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

/**
 * True when a DB write failed because a unique constraint was violated —
 * MongoDB duplicate-key (E11000) or SQLite `UNIQUE constraint failed`. Used to
 * turn a concurrent-create race (two requests passing the pre-check, both
 * inserting) into a clean 409 instead of a 500.
 */
function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === 11000) return true; // MongoDB
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /unique constraint/i.test(message);
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

  let record: IProviderRecord;
  try {
    record = await db.createProvider({
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
  } catch (error) {
    // Lost the create race: another request inserted the same key between the
    // findProviderByKey check above and this insert. Surface it as a conflict.
    if (isDuplicateKeyError(error)) {
      throw new Error(`Provider with key "${payload.key}" already exists.`);
    }
    throw error;
  }

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
    // Merge incoming credentials over the existing decrypted set instead of
    // replacing wholesale. A blank/undefined value means "leave this field
    // unchanged" — the edit UI re-initialises secret fields (e.g. apiKey) to
    // '' because the backend never returns the secret, so a wholesale replace
    // would silently wipe the API key whenever an unrelated field (baseUrl,
    // region, …) is edited.
    const existing = await db.findProviderById(providerId);
    const current = existing?.credentialsEnc
      ? (decryptObject(existing.credentialsEnc) as Record<string, unknown>)
      : {};
    const merged: Record<string, unknown> = { ...current };
    for (const [field, value] of Object.entries(payload.credentials)) {
      if (value === '' || value === undefined || value === null) {
        continue;
      }
      merged[field] = value;
    }
    updates.credentialsEnc = encryptObject(merged);
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

  let credentials: TCredentials;
  try {
    credentials = decryptObject<TCredentials>(record.credentialsEnc);
  } catch (error) {
    // Legacy auto-heal: an earlier version of the GPU-fleet auto-register
    // path persisted credentialsEnc as PLAINTEXT JSON instead of running it
    // through encryptObject. Those rows fail decrypt with the Node AES-GCM
    // "Unsupported state or unable to authenticate data" error. When the
    // field happens to parse as JSON with usable credentials, recover it
    // and re-encrypt in place so subsequent loads use the proper format.
    const recovered = tryRecoverLegacyPlaintextCredentials<TCredentials>(record.credentialsEnc);
    if (!recovered) throw error;
    await db
      .updateProvider(String(record._id), {
        credentialsEnc: encryptObject(recovered),
      })
      .catch(() => undefined);
    credentials = recovered;
  }

  return {
    record,
    credentials,
  };
}

function tryRecoverLegacyPlaintextCredentials<T>(value: string): T | null {
  const trimmed = value.trim();
  // Real ciphertext is base64 of (iv | tag | data) — it never starts with `{`.
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as T;
  } catch {
    return null;
  }
}
