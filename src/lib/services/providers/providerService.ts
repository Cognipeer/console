import {
  getDatabase,
  IProviderLastTest,
  IProviderRecord,
  ProviderDomain,
} from '@/lib/database';
import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import { createLogger } from '@/lib/core/logger';
import { assertProviderEndpointsAllowed } from './providerEndpointGuard';
import { settingsValidatorOf, validateProviderSettings } from './providerSettingsValidation';

const logger = createLogger('provider-service');

export type ProviderStatus = IProviderRecord['status'];

/**
 * Stored credentials could not be opened with any configured secret — almost
 * always because the row was sealed under a different `PROVIDER_ENCRYPTION_SECRET`
 * (a rotated key, or an environment pointed at another deployment's database).
 * Raw AES-GCM failures surface as "Unsupported state or unable to authenticate
 * data", which tells an operator nothing about what to do next.
 */
export class ProviderCredentialDecryptError extends Error {
  readonly providerKey: string;
  readonly driver: string;

  constructor(providerKey: string, driver: string, cause?: unknown) {
    super(
      `Stored credentials for provider "${providerKey}" (${driver}) could not be decrypted. `
      + 'They were encrypted with a different key than this environment is configured with — '
      + 'check PROVIDER_ENCRYPTION_SECRET (and JWT_SECRET, which it falls back to), '
      + 're-enter the credentials to re-seal them under the current key.',
    );
    this.name = 'ProviderCredentialDecryptError';
    this.providerKey = providerKey;
    this.driver = driver;
    this.cause = cause;
  }
}

export interface CreateProviderConfigInput {
  projectId?: string;
  /** Projects the provider is assigned to on creation (deduped; `projectId` is added when given). */
  projectIds?: string[];
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

/**
 * Websearch instances carry a semantic-cache config in `settings.cache`.
 * Loaded lazily: it reaches the vector and model services, which themselves
 * depend on this module.
 */
async function validateWebSearchSettings(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  settings: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (!settings || settings.cache === undefined) return settings;
  const { validateWebSearchProviderSettings } = await import('@/lib/services/webSearch/cacheValidation');
  return validateWebSearchProviderSettings({ tenantDbName, tenantId, projectId, settings });
}

export interface ProviderConfigView
  extends Omit<IProviderRecord, 'credentialsEnc'> {
  hasCredentials: boolean;
  /**
   * The names - never the values - of the credential fields the record stores a value for. Only the dashboard reads
   * that open an edit form ask for it (`ProviderViewOptions.credentialFields`); every other reply leaves it out.
   */
  credentialFields?: string[];
}

/** What a read of a provider adds to the plain view. */
export interface ProviderViewOptions {
  /**
   * Add `credentialFields`. It needs the stored credentials opened, so it is asked for where it is used: an edit form
   * must tell a secret it may leave blank (one that is stored) from one it has to fill in.
   */
  credentialFields?: boolean;
}

function sanitize(record: IProviderRecord, options?: ProviderViewOptions): ProviderConfigView {
  const { credentialsEnc, ...rest } = record;
  return {
    ...rest,
    hasCredentials: Boolean(credentialsEnc),
    ...(options?.credentialFields ? { credentialFields: storedCredentialNames(record) } : {}),
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

function initialProjectIds(payload: CreateProviderConfigInput): string[] | undefined {
  const ids = [...(payload.projectId ? [payload.projectId] : []), ...(payload.projectIds ?? [])]
    .map(String);
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

/**
 * Checks a list of project ids from a request body against the caller's tenant:
 * the ids are deduped and each must be a project of the tenant. `unknown` lists the ones that are not.
 */
export async function resolveTenantProjectIds(
  tenantDbName: string,
  tenantId: string,
  projectIds: readonly string[],
): Promise<{ projectIds: string[]; unknown: string[] }> {
  const wanted = [...new Set(projectIds.map(String))];
  if (wanted.length === 0) return { projectIds: [], unknown: [] };
  const db = await withTenantDb(tenantDbName);
  // A tenant has fewer than a hundred projects: one list read beats a lookup per id.
  const known = new Set((await db.listProjects(tenantId)).map((project) => String(project._id)));
  return {
    projectIds: wanted.filter((id) => known.has(id)),
    unknown: wanted.filter((id) => !known.has(id)),
  };
}

export async function createProviderConfig(
  tenantDbName: string,
  tenantId: string,
  payload: CreateProviderConfigInput,
): Promise<ProviderConfigView> {
  // The driver's own checks first: a setting it cannot work with is a better answer than what the endpoint guard
  // would say about the same value.
  await validateProviderSettings(payload.driver, payload.credentials, payload.settings);
  await assertProviderEndpointsAllowed(payload.type, payload.credentials, payload.settings);
  const settings = payload.type === 'websearch'
    ? await validateWebSearchSettings(tenantDbName, tenantId, payload.projectId, payload.settings)
    : payload.settings;

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
      projectIds: initialProjectIds(payload),
      key: payload.key,
      type: payload.type,
      driver: payload.driver,
      label: payload.label,
      description: payload.description,
      status: payload.status ?? 'active',
      credentialsEnc: encryptObject(payload.credentials),
      settings: settings ?? {},
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

/** Order-insensitive deep equality for JSON-shaped values (settings, credentials). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) => sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * The credentials a record holds, decrypted; `{}` when it has none and `undefined` when none of the configured
 * secrets opens them (see `ProviderCredentialDecryptError`).
 */
function readStoredCredentials(
  record: IProviderRecord | null,
  replacing: boolean,
): Record<string, unknown> | undefined {
  if (!record?.credentialsEnc) return {};
  try {
    return decryptObject(record.credentialsEnc) as Record<string, unknown>;
  } catch (error) {
    // Undecryptable existing credentials must not block the save — that made
    // the one action that repairs the record (re-entering the key) the one
    // action guaranteed to fail. Whatever the operator supplies now is
    // re-sealed under the current key.
    logger.warn(
      replacing
        ? 'Existing provider credentials could not be decrypted; replacing them'
        : 'Existing provider credentials could not be decrypted; their settings are saved without the driver check',
      {
        driver: record.driver,
        providerKey: record.key,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return undefined;
  }
}

/** An incoming credential value that says "leave this field as stored". */
function isBlankCredentialValue(value: unknown): boolean {
  return value === '' || value === undefined || value === null;
}

/**
 * The names of the credential fields a record stores a value for: what an update that leaves a field blank keeps. The
 * values are opened here and go no further. Credentials that cannot be opened store nothing an update would keep (it
 * treats them as empty), so the list is empty and the form asks for the secrets again.
 */
function storedCredentialNames(record: IProviderRecord): string[] {
  if (!record.credentialsEnc) return [];
  let stored: unknown;
  try {
    stored = decryptObject(record.credentialsEnc);
  } catch (error) {
    logger.warn('Stored provider credentials could not be decrypted; none are reported as stored', {
      driver: record.driver,
      providerKey: record.key,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return [];
  return Object.entries(stored as Record<string, unknown>)
    .filter(([, value]) => !isBlankCredentialValue(value))
    .map(([name]) => name)
    .sort();
}

/** An update of a record's credentials: the stored set with the incoming values laid over it. */
interface CredentialMerge {
  /** The stored set (empty when there is none, or when it cannot be opened). */
  current: Record<string, unknown>;
  merged: Record<string, unknown>;
  /** A record that had no credentials gets them from this update, which is a change of its connection. */
  hadStored: boolean;
}

/**
 * Merge incoming credentials over the existing decrypted set instead of
 * replacing wholesale. A blank/undefined value means "leave this field
 * unchanged" — the edit UI re-initialises secret fields (e.g. apiKey) to
 * '' because the backend never returns the secret, so a wholesale replace
 * would silently wipe the API key whenever an unrelated field (baseUrl,
 * region, …) is edited.
 */
function mergeCredentials(
  existing: IProviderRecord | null,
  incoming: Record<string, unknown>,
): CredentialMerge {
  // Undecryptable existing credentials are treated as empty.
  const current = readStoredCredentials(existing, true) ?? {};
  const merged: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(incoming)) {
    if (isBlankCredentialValue(value)) {
      continue;
    }
    merged[field] = value;
  }
  return { current, merged, hadStored: Boolean(existing?.credentialsEnc) };
}

/**
 * The driver's own check of an update, on what the update will store rather than on the patch: the settings replace
 * the stored ones wholesale, the credentials are the merged set (or the stored one when the update leaves them alone).
 */
async function validateUpdatedProvider(
  target: IProviderRecord | null,
  payload: UpdateProviderConfigInput,
  mergedCredentials: Record<string, unknown> | undefined,
): Promise<void> {
  const validate = settingsValidatorOf(target?.driver);
  if (!target || !validate) return;
  const credentials = mergedCredentials ?? readStoredCredentials(target, false);
  // Credentials that cannot be opened say nothing about the settings: such a record still saves a settings-only edit,
  // and the credentials are repaired by entering them again.
  if (!credentials) return;
  await validate(credentials, payload.settings ?? target.settings);
}

export async function updateProviderConfig(
  tenantDbName: string,
  providerId: string,
  payload: UpdateProviderConfigInput,
  options?: { projectId?: string },
): Promise<ProviderConfigView | null> {
  const db = await withTenantDb(tenantDbName);
  const updates: Partial<IProviderRecord> = {};

  // The stored "last test" describes the connection as it was tested: once the connection settings or
  // the credentials actually change it no longer says anything, so it is dropped (a re-test writes a new one).
  let connectionChanged = false;
  let hadLastTest = false;
  // Set when the update changes the credentials.
  let credentialMerge: CredentialMerge | undefined;

  if (payload.settings !== undefined || payload.credentials !== undefined) {
    const target = await db.findProviderById(providerId);
    hadLastTest = Boolean(target?.lastTest);
    if (payload.credentials !== undefined) {
      credentialMerge = mergeCredentials(target, payload.credentials);
    }
    await validateUpdatedProvider(target, payload, credentialMerge?.merged);
    await assertProviderEndpointsAllowed(target?.type, payload.credentials, payload.settings);
    if (payload.settings !== undefined && !sameJson(payload.settings, target?.settings ?? {})) {
      connectionChanged = true;
    }
  }

  if (payload.projectIds !== undefined) {
    updates.projectIds = payload.projectIds;
    // `projectIds` is the whole assignment: a legacy single `projectId` is folded into it (callers send the
    // effective set), otherwise a project dropped from the list would stay assigned through the old field.
    const target = await db.findProviderById(providerId);
    if (target?.projectId) {
      updates.projectId = null as unknown as undefined;
    }
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
    if (payload.settings.cache !== undefined) {
      const target = await db.findProviderById(providerId);
      if (target?.type === 'websearch') {
        updates.settings = await validateWebSearchSettings(
          tenantDbName,
          target.tenantId,
          options?.projectId,
          payload.settings,
        );
      }
    }
  }

  if (payload.capabilitiesOverride !== undefined) {
    updates.capabilitiesOverride = payload.capabilitiesOverride;
  }

  if (payload.metadata !== undefined) {
    updates.metadata = payload.metadata;
  }

  if (credentialMerge) {
    if (!credentialMerge.hadStored || !sameJson(credentialMerge.merged, credentialMerge.current)) {
      connectionChanged = true;
    }
    updates.credentialsEnc = encryptObject(credentialMerge.merged);
  }

  if (connectionChanged && hadLastTest) {
    updates.lastTest = null;
  }

  if (payload.updatedBy) {
    updates.updatedBy = payload.updatedBy;
  }

  const updated = await db.updateProvider(providerId, updates);
  return updated ? sanitize(updated) : null;
}

/** Values a "Test connection" of a saved provider may carry instead of what is stored (the edit form's unsaved edits). */
export interface ProviderTestOverrides {
  /** Credential values; a blank one keeps the stored value, as in an update. */
  credentials?: Record<string, unknown>;
  /** The settings the form would save; they replace the stored ones wholesale, as in an update. */
  settings?: Record<string, unknown>;
}

/** What a "Test connection" of a saved provider runs against. */
export interface ProviderTestTarget {
  record: IProviderRecord;
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
}

/**
 * Whether a test carries values that change what is tested. Then the outcome describes a connection that is not
 * stored, and must not be kept on the record as its "last test".
 */
export function hasProviderTestOverrides(overrides: ProviderTestOverrides): boolean {
  return (
    overrides.settings !== undefined
    || Object.values(overrides.credentials ?? {}).some((value) => !isBlankCredentialValue(value))
  );
}

/**
 * The credentials and settings a "Test connection" of a saved provider runs against when it carries overrides: what an
 * update with the same values would store. Credentials are the stored set with the non-blank incoming values laid over
 * it (a stored set that cannot be decrypted counts as empty, so re-entered credentials can still be tried); settings are
 * the incoming ones when given, otherwise the stored ones. Without credential overrides the stored credentials are used,
 * and ones that cannot be opened are a `ProviderCredentialDecryptError`. The driver's `validateSettings` runs afterwards,
 * inside the test.
 */
export async function resolveProviderTestTarget(
  tenantDbName: string,
  provider: { id: string; tenantId: string },
  overrides: ProviderTestOverrides,
): Promise<ProviderTestTarget> {
  const hasCredentialOverride = Object.values(overrides.credentials ?? {}).some(
    (value) => !isBlankCredentialValue(value),
  );

  if (!hasCredentialOverride) {
    const { record, credentials } = await loadProviderRuntimeData(tenantDbName, provider);
    if (record.tenantId !== provider.tenantId) {
      throw new Error(`Provider configuration "${provider.id}" not found.`);
    }
    return { record, credentials, settings: overrides.settings ?? record.settings ?? {} };
  }

  const db = await withTenantDb(tenantDbName);
  const record = await db.findProviderById(provider.id);
  if (!record || record.tenantId !== provider.tenantId) {
    throw new Error(`Provider configuration "${provider.id}" not found.`);
  }
  const { merged } = mergeCredentials(record, overrides.credentials ?? {});
  return { record, credentials: merged, settings: overrides.settings ?? record.settings ?? {} };
}

/** Stores the outcome of a "Test connection" on the provider record. */
export async function recordProviderTest(
  tenantDbName: string,
  providerId: string,
  lastTest: IProviderLastTest,
): Promise<void> {
  const db = await withTenantDb(tenantDbName);
  await db.updateProvider(providerId, { lastTest });
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
  options?: ProviderViewOptions,
): Promise<ProviderConfigView[]> {
  const db = await withTenantDb(tenantDbName);
  const records = await db.listProviders(tenantId, filters);
  return records.map((record) => sanitize(record, options));
}

export async function getProviderConfigById(
  tenantDbName: string,
  providerId: string,
  options?: ProviderViewOptions,
): Promise<ProviderConfigView | null> {
  const db = await withTenantDb(tenantDbName);
  const record = await db.findProviderById(providerId);
  return record ? sanitize(record, options) : null;
}

export async function getProviderConfigByKey(
  tenantDbName: string,
  tenantId: string,
  key: string,
  projectId?: string,
  options?: ProviderViewOptions,
): Promise<ProviderConfigView | null> {
  const db = await withTenantDb(tenantDbName);
  const record = await db.findProviderByKey(tenantId, key, projectId);
  return record ? sanitize(record, options) : null;
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
    // Providers are strictly project-scoped, so the common cause of this miss is
    // a provider that exists but was never assigned to the active project. Saying
    // "not found" sent operators looking for a deleted record instead.
    if (providerIdOrKey.key && providerIdOrKey.projectId) {
      const unscoped = await db.findProviderByKey(
        providerIdOrKey.tenantId,
        providerIdOrKey.key,
      );
      if (unscoped) {
        throw new Error(
          `Provider "${providerIdOrKey.key}" exists but is not assigned to project `
          + `${providerIdOrKey.projectId}. Assign it from the provider's Projects tab.`,
        );
      }
    }

    throw new Error(
      `Provider configuration "${providerIdOrKey.key ?? providerIdOrKey.id}" not found.`,
    );
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
    if (!recovered) {
      throw new ProviderCredentialDecryptError(record.key, record.driver, error);
    }
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
