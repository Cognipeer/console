/**
 * Managed storage: the runtime of a file or vector provider that the operator serves (a platform record).
 *
 * A managed storage record holds no connection of its own. The host names one live route and hands core the
 * connection behind it (see `@/enterprise/managed-credits`). Storage is never paid with credits: what a tenant stores
 * counts against its plan storage, metered by the file and vector services.
 *
 * Tenant isolation is enforced here, by core, whatever the host returns:
 * - root-scoped drivers (`MANAGED_STORAGE_DRIVERS`, all but the name-scoped vector drivers): the runtime is rooted in a
 *   folder (or key prefix, or blob prefix) named after the tenant under the backend's root. The driver adds its own
 *   tenant and provider folders below it.
 * - the name-scoped vector drivers (one shared namespace of indexes): every index the tenant creates is named with the
 *   tenant's token, and any handle that does not name one of the tenant's indexes (in the configured bucket, for the
 *   bucket-based driver) is refused.
 * - any other driver: refused (fail closed). The server log names the driver; the tenant gets a generic message.
 * Storage uses the FIRST live route only: stored data stays on the backend it was written to (no failover).
 *
 * The connection (driver, settings, credentials) is operator-side: never logged, persisted or returned.
 */
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { hashRuntimeConfig, runtimePool } from '@/lib/core/runtimePool';
import { isManagedProviderRecord, listManagedRoutes } from '@/enterprise/managed-credits';
import type { IProviderRecord } from '@/lib/database';
import { providerRegistry } from '@/lib/providers/registry';
import { isPostgresIndexTableName } from '@/lib/providers/contracts/postgresVector.contract';
import type { CreateVectorIndexInput, VectorIndexHandle, VectorProviderRuntime } from '@/lib/providers/domains/vector';
import { loadProviderRuntimeData } from '@/lib/services/providers/providerService';
import { ManagedProviderError } from '@/lib/services/providers/managedProviderErrors';

const log = createLogger('managed-storage');

export type ManagedStorageKind = 'file' | 'vector';

/** What a tenant reads when a platform storage provider cannot serve: nothing about the backend. */
export const MANAGED_STORAGE_UNAVAILABLE = 'This provider is not available right now.';

/** The drivers whose runtime core can confine to one tenant. Any other driver on a managed route is refused. */
export const MANAGED_STORAGE_DRIVERS: Readonly<Record<ManagedStorageKind, readonly string[]>> = {
  file: ['local-filesystem', 'aws-s3-files', 's3-compatible-files', 'azure-blob-files'],
  vector: ['sqlite-vector', 'aws-s3-vectors', 'azure-ai-search', 'postgres'],
};

/** The vector drivers with one shared namespace of indexes: scoped by index name, not by a root. */
const NAME_SCOPED_VECTOR_DRIVER = 'aws-s3-vectors';
const SEARCH_VECTOR_DRIVER = 'azure-ai-search';
const POSTGRES_VECTOR_DRIVER = 'postgres';
/** The optional base of a tenant's schema on the platform database. */
const POSTGRES_SCHEMA_BASE = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * The tenant's folder (or index name prefix) on a platform storage backend: stable for the tenant, the same length for
 * every tenant, and neither its id nor its slug.
 */
export function tenantStorageToken(tenantId: string): string {
  return `t${createHash('sha256').update(String(tenantId)).digest('hex').slice(0, 16)}`;
}

function trimSlashes(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/^\/+|\/+$/g, '') : '';
}

/**
 * The settings of a root-scoped driver with the tenant's token added to its root; null for a driver that is not
 * root-scoped. Nothing else of the settings changes.
 */
export function scopeStorageSettings(
  driver: string,
  settings: Record<string, unknown>,
  token: string,
): Record<string, unknown> | null {
  switch (driver) {
    case 'local-filesystem': {
      // The subdirectory sits between the base directory and the driver's own tenant folder, whatever the base is.
      const subdirectory = trimSlashes(settings.subdirectory);
      return { ...settings, subdirectory: subdirectory ? `${subdirectory}/${token}` : token };
    }
    case 'aws-s3-files':
    case 's3-compatible-files':
    case 'azure-blob-files': {
      const prefix = trimSlashes(settings.prefix);
      return { ...settings, prefix: prefix ? `${prefix}/${token}` : token };
    }
    case 'sqlite-vector': {
      const base = typeof settings.basePath === 'string' && settings.basePath.trim() !== ''
        ? settings.basePath.trim()
        : path.join(getConfig().storage.dataDir, 'vectors');
      return { ...settings, basePath: path.join(base, token) };
    }
    case 'postgres': {
      // One schema per tenant, the table-per-index layout whatever the catalog says, and no shared table.
      const rawBase = settings.schema;
      const base = typeof rawBase === 'string' ? rawBase.trim() : '';
      if (rawBase !== undefined && rawBase !== null && (typeof rawBase !== 'string' || (base !== '' && !POSTGRES_SCHEMA_BASE.test(base)))) {
        return null;
      }
      const { tableName: _table, ...rest } = settings;
      void _table;
      return { ...rest, schema: base ? `${base}_${token}` : token, indexLayout: 'table-per-index' };
    }
    default:
      return null;
  }
}

/** Index names of the name-scoped driver: 3 to 63 lowercase letters, digits and hyphens. */
const MAX_INDEX_NAME = 63;
const INDEX_SUFFIX_BYTES = 4;

/**
 * A physical index name for the tenant: `<token>-<slug of the name>-<random>`, at most 63 characters. The random part
 * keeps two indexes with the same name apart (the driver would otherwise reuse an index that already has the name).
 */
export function managedIndexName(token: string, name: string, random = randomBytes(INDEX_SUFFIX_BYTES).toString('hex')): string {
  const room = MAX_INDEX_NAME - token.length - random.length - 2;
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, room)
    .replace(/^-+|-+$/g, '');
  return `${token}-${slug || 'index'}-${random}`;
}

const S3_VECTORS_INDEX_ARN = /^arn:aws[a-z-]*:s3vectors:[a-z0-9-]*:[0-9]*:bucket\/([a-z0-9.-]+)\/index\/([a-z0-9.-]+)$/;

/**
 * The name-scoped vector runtime: the tenant creates, lists and reaches only the indexes named with its token in the
 * configured bucket. Every handle is checked and rebuilt before the driver sees it: its index ARN must be one of the
 * tenant's, and the metadata identifiers the driver would prefer over the ARN are dropped.
 */
export function wrapNameScopedVectorRuntime(
  inner: VectorProviderRuntime,
  token: string,
  vectorBucketName: string,
): VectorProviderRuntime {
  const ownPrefix = `${token}-`;
  const ownArn = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const match = S3_VECTORS_INDEX_ARN.exec(value);
    return match && match[1] === vectorBucketName && match[2].startsWith(ownPrefix) ? value : null;
  };
  const refuse = (what: string): never => {
    log.warn('Managed vector call refused: the index is not the tenant\'s', { what });
    throw new ManagedProviderError('This index is not available.');
  };
  const cleanMetadata = (metadata: Record<string, unknown> | undefined): Record<string, unknown> => {
    const { indexArn: _arn, indexName: _name, ...rest } = metadata ?? {};
    void _arn;
    void _name;
    return rest;
  };
  const checked = (handle: VectorIndexHandle): VectorIndexHandle => {
    const arn = ownArn(handle?.externalId);
    if (!arn) return refuse('handle');
    return { ...handle, externalId: arn, metadata: cleanMetadata(handle.metadata) };
  };

  const runtime: VectorProviderRuntime = {
    async createIndex(input: CreateVectorIndexInput) {
      const physical = managedIndexName(token, input.name);
      const handle = await inner.createIndex({ ...input, name: physical });
      const arn = ownArn(handle?.externalId);
      if (!arn || !arn.endsWith(`/index/${physical}`)) {
        // The driver hands back the bare physical name when it could not read the index it just created. A bare name
        // is never accepted as a handle later (the driver cannot address an index by it, and a tenant could send any
        // name), so the index that now exists is removed before the call is refused: no orphan is left behind.
        if (handle?.externalId === physical) {
          try {
            await inner.deleteIndex({ externalId: physical });
          } catch (error) {
            log.error('Could not remove a created index the wrapper refused', {
              error: error instanceof Error ? error.message : error,
            });
          }
        }
        return refuse('created index');
      }
      // The tenant keeps its own name; nothing of the backend (bucket, account) is handed back but the ARN, which the
      // services keep operator-side.
      return { ...handle, externalId: arn, name: input.name, metadata: {} };
    },
    async deleteIndex({ externalId }) {
      const arn = ownArn(externalId);
      if (!arn) return refuse('delete');
      await inner.deleteIndex({ externalId: arn });
    },
    async listIndexes() {
      const all = await inner.listIndexes();
      return all
        .filter((item) => ownArn(item?.externalId) !== null)
        .map((item) => ({ ...item, metadata: {} }));
    },
    // Async, so a refusal is a rejected promise like any other failure of the call.
    upsertVectors: async (handle, items) => inner.upsertVectors(checked(handle), items),
    queryVectors: async (handle, query) => inner.queryVectors(checked(handle), query),
    deleteVectors: async (handle, ids) => inner.deleteVectors(checked(handle), ids),
    ...(inner.existingVectorIds
      ? { existingVectorIds: async (handle: VectorIndexHandle, ids: string[]) => inner.existingVectorIds!(checked(handle), ids) }
      : {}),
    ...(inner.existingVectors
      ? { existingVectors: async (handle: VectorIndexHandle, ids: string[]) => inner.existingVectors!(checked(handle), ids) }
      : {}),
    listVectors: async (handle, input) => inner.listVectors(checked(handle), input),
  };
  if (inner.close) runtime.close = () => inner.close?.();
  return runtime;
}

/**
 * The wrapper of the platform postgres vector runtime. The driver already resolves the table from the handle's
 * externalId alone; this is the second line: every handle is rebuilt without metadata (which a tenant can set) and
 * with an externalId that is a valid index table name, and nothing but the name, dimension and metric reaches createIndex.
 */
export function wrapPostgresVectorRuntime(inner: VectorProviderRuntime): VectorProviderRuntime {
  const refuse = (what: string): never => {
    log.warn('Managed vector call refused: the index is not valid', { what });
    throw new ManagedProviderError(MANAGED_STORAGE_UNAVAILABLE);
  };
  const checked = (handle: VectorIndexHandle): VectorIndexHandle => {
    if (!isPostgresIndexTableName(handle?.externalId)) return refuse('handle');
    return { externalId: handle.externalId, name: handle.name, dimension: handle.dimension, metric: handle.metric };
  };
  const stripped = (item: VectorIndexHandle): VectorIndexHandle => ({ ...item, metadata: {} });

  const runtime: VectorProviderRuntime = {
    async createIndex(input: CreateVectorIndexInput) {
      const { metadata: _metadata, ...rest } = input;
      void _metadata;
      const handle = await inner.createIndex(rest);
      if (!isPostgresIndexTableName(handle?.externalId)) return refuse('created index');
      return stripped(handle);
    },
    async deleteIndex({ externalId }) {
      if (!isPostgresIndexTableName(externalId)) return refuse('delete');
      await inner.deleteIndex({ externalId });
    },
    async listIndexes() {
      const all = await inner.listIndexes();
      return all.filter((item) => isPostgresIndexTableName(item?.externalId)).map(stripped);
    },
    upsertVectors: async (handle, items) => inner.upsertVectors(checked(handle), items),
    queryVectors: async (handle, query) => inner.queryVectors(checked(handle), query),
    deleteVectors: async (handle, ids) => inner.deleteVectors(checked(handle), ids),
    ...(inner.existingVectorIds
      ? { existingVectorIds: async (handle: VectorIndexHandle, ids: string[]) => inner.existingVectorIds!(checked(handle), ids) }
      : {}),
    ...(inner.existingVectors
      ? { existingVectors: async (handle: VectorIndexHandle, ids: string[]) => inner.existingVectors!(checked(handle), ids) }
      : {}),
    listVectors: async (handle, input) => inner.listVectors(checked(handle), input),
  };
  if (inner.close) runtime.close = () => inner.close?.();
  return runtime;
}

/** Azure AI Search index names: 2 to 128 lowercase letters, digits and hyphens, no hyphen at either end. */
const SEARCH_INDEX_NAME = /^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/;
/**
 * The only handle metadata the search driver reads: the filter push-down and hybrid search markers. Every index the
 * wrapper creates goes through the driver's createIndex, which always builds the filterable metadata and content
 * fields, and platform index records do not keep handle metadata, so the markers are constants of a tenant index.
 */
const SEARCH_HANDLE_MARKERS: Readonly<Record<string, string>> = { filterSchema: 'kv-v1', contentSchema: 'text-v1' };

/**
 * The name-scoped wrapper of the search vector driver (one search service, one shared namespace of indexes). An index is
 * the tenant's when its name is a valid index name that starts with the tenant's token. Handles are rebuilt before the
 * driver sees them and before the services do: the metadata is replaced by the markers the driver reads (never the
 * endpoint or the derived algorithm and profile names).
 */
export function wrapSearchVectorRuntime(inner: VectorProviderRuntime, token: string): VectorProviderRuntime {
  const ownPrefix = `${token}-`;
  const ownName = (value: unknown): string | null =>
    typeof value === 'string' && SEARCH_INDEX_NAME.test(value) && value.startsWith(ownPrefix) ? value : null;
  const refuse = (what: string): never => {
    log.warn('Managed vector call refused: the index is not the tenant\'s', { what });
    throw new ManagedProviderError('This index is not available.');
  };
  const markers = (): Record<string, unknown> => ({ ...SEARCH_HANDLE_MARKERS });
  const checked = (handle: VectorIndexHandle): VectorIndexHandle => {
    const name = ownName(handle?.externalId);
    if (!name) return refuse('handle');
    return { ...handle, externalId: name, metadata: markers() };
  };

  const runtime: VectorProviderRuntime = {
    async createIndex(input: CreateVectorIndexInput) {
      const physical = managedIndexName(token, input.name);
      const handle = await inner.createIndex({ ...input, name: physical });
      if (handle?.externalId !== physical || !ownName(physical)) {
        try {
          await inner.deleteIndex({ externalId: physical });
        } catch (error) {
          log.error('Could not remove a created index the wrapper refused', {
            error: error instanceof Error ? error.message : error,
          });
        }
        return refuse('created index');
      }
      return { ...handle, externalId: physical, name: input.name, metadata: markers() };
    },
    async deleteIndex({ externalId }) {
      const name = ownName(externalId);
      if (!name) return refuse('delete');
      await inner.deleteIndex({ externalId: name });
    },
    async listIndexes() {
      const all = await inner.listIndexes();
      return all
        .filter((item) => ownName(item?.externalId) !== null)
        .map((item) => ({ ...item, metadata: markers() }));
    },
    upsertVectors: async (handle, items) => inner.upsertVectors(checked(handle), items),
    queryVectors: async (handle, query) => inner.queryVectors(checked(handle), query),
    deleteVectors: async (handle, ids) => inner.deleteVectors(checked(handle), ids),
    ...(inner.existingVectorIds
      ? { existingVectorIds: async (handle: VectorIndexHandle, ids: string[]) => inner.existingVectorIds!(checked(handle), ids) }
      : {}),
    ...(inner.existingVectors
      ? { existingVectors: async (handle: VectorIndexHandle, ids: string[]) => inner.existingVectors!(checked(handle), ids) }
      : {}),
    listVectors: async (handle, input) => inner.listVectors(checked(handle), input),
  };
  if (inner.close) runtime.close = () => inner.close?.();
  return runtime;
}

/**
 * The driver whose contract describes a provider's capabilities: the route's driver for a platform record (the record's
 * own driver is a placeholder), the record's driver otherwise. Only the route's driver id is read, never its connection.
 */
export function storageCapabilityDriverOf(
  kind: ManagedStorageKind,
  record: { key: string; driver: string; platform?: boolean },
): string {
  if (!record.platform) return record.driver;
  return listManagedRoutes({ providerKey: record.key, kind })[0]?.driver ?? record.driver;
}

export interface StorageProviderContext {
  tenantDbName: string;
  tenantId: string;
  providerKey: string;
  projectId?: string;
}

export interface ManagedStorageConnection {
  /** The route's connection id (operator-side). */
  connectionId: string;
  /** The driver that serves the route. */
  driver: string;
  /** The route's settings with the tenant's isolation applied. */
  settings: Record<string, unknown>;
  /** The tenant's token on the backend. */
  token: string;
  /**
   * Reads and deletes only: the catalog no longer offers the storage (the route says `settings.cleanupOnly`) or the
   * record is switched off. The tenant can still get at and remove what it stored; a write is refused.
   */
  cleanupOnly?: boolean;
}

export interface LoadedStorageProvider {
  record: IProviderRecord;
  /** Holds secrets: never log, persist or return it. */
  credentials: Record<string, unknown>;
  /** Set for a platform record: the connection of the one route that serves it. */
  managed?: ManagedStorageConnection;
}

/**
 * Loads a file or vector provider for a runtime: the tenant's own record as before, or a platform record served by the
 * one live route the host names, with the tenant's isolation applied. A platform record's stored credentials are
 * never opened. Refuses (ManagedProviderError, generic message) a platform record with no live route, a route whose
 * driver core cannot confine to one tenant, or a route without the settings that confinement needs.
 */
export async function loadStorageProvider(
  kind: ManagedStorageKind,
  context: StorageProviderContext,
): Promise<LoadedStorageProvider> {
  // The host knows routes for its platform keys only; a tenant's own provider has none.
  const route = listManagedRoutes({ providerKey: context.providerKey, kind })[0];
  const loaded = await loadProviderRuntimeData(
    context.tenantDbName,
    { tenantId: context.tenantId, key: context.providerKey, projectId: context.projectId },
    { allowManaged: true, ...(route ? { managedConnectionId: route.connectionId } : {}) },
  );
  if (!isManagedProviderRecord(loaded.record)) {
    return { record: loaded.record, credentials: loaded.credentials };
  }
  const connection = loaded.managedConnection;
  if (!route || !connection) throw new ManagedProviderError(MANAGED_STORAGE_UNAVAILABLE);

  const driver = connection.driver;
  if (!MANAGED_STORAGE_DRIVERS[kind].includes(driver)) {
    log.error('Managed storage route refused: core cannot confine its driver to one tenant', {
      kind,
      driver,
      providerKey: loaded.record.key,
    });
    throw new ManagedProviderError(MANAGED_STORAGE_UNAVAILABLE);
  }
  const token = tenantStorageToken(context.tenantId);
  let settings: Record<string, unknown> | null;
  if (driver === NAME_SCOPED_VECTOR_DRIVER) {
    const bucket = connection.settings.vectorBucketName;
    const arn = connection.settings.vectorBucketArn;
    // The ownership check compares the bucket by name, but the driver prefers the ARN when both are set: a route that
    // carries an ARN could point the driver at another bucket than the one checked.
    const hasArn = typeof arn === 'string' ? arn.trim() !== '' : arn !== undefined && arn !== null;
    settings = typeof bucket === 'string' && bucket.trim() !== '' && !hasArn ? { ...connection.settings } : null;
  } else if (driver === SEARCH_VECTOR_DRIVER) {
    // The service is located by this endpoint alone: without it the driver has nothing to confine.
    const endpoint = connection.settings.foundryProjectEndpoint;
    settings = typeof endpoint === 'string' && endpoint.trim() !== '' ? { ...connection.settings } : null;
  } else {
    settings = scopeStorageSettings(driver, connection.settings, token);
  }
  if (!settings) {
    log.error('Managed storage route refused: its settings cannot be confined to one tenant', {
      kind,
      driver,
      providerKey: loaded.record.key,
    });
    throw new ManagedProviderError(MANAGED_STORAGE_UNAVAILABLE);
  }
  const cleanupOnly = route.settings?.cleanupOnly === true || loaded.record.status !== 'active';
  return {
    record: loaded.record,
    credentials: loaded.credentials,
    managed: { connectionId: route.connectionId, driver, settings, token, ...(cleanupOnly ? { cleanupOnly } : {}) },
  };
}

/** The runtime methods that store something new; refused on a cleanup-only route. */
const STORAGE_WRITE_METHODS: Readonly<Record<ManagedStorageKind, readonly string[]>> = {
  file: ['uploadFile'],
  vector: ['createIndex', 'upsertVectors'],
};

function withoutWrites<T extends object>(runtime: T, kind: ManagedStorageKind): T {
  return new Proxy(runtime, {
    get(target, prop) {
      if (typeof prop === 'string' && STORAGE_WRITE_METHODS[kind].includes(prop)) {
        return async () => { throw new ManagedProviderError(MANAGED_STORAGE_UNAVAILABLE); };
      }
      return Reflect.get(target, prop, target);
    },
  });
}

/**
 * The pooled runtime of a platform storage provider, built from the route's connection with the tenant's isolation
 * (and, for the name-scoped driver, wrapped). The runtime gets the real tenant id and the platform record's key, so the
 * driver's own tenant and provider folders apply below the tenant's root.
 */
export async function getManagedStorageRuntime<TRuntime>(
  kind: ManagedStorageKind,
  loaded: LoadedStorageProvider & { managed: ManagedStorageConnection },
  context: { tenantId: string; projectId?: string },
): Promise<TRuntime> {
  const { record, credentials, managed } = loaded;
  const poolKey = `managed-storage:${kind}:${context.tenantId}:${record.key}:${managed.connectionId}`;
  const configHash = hashRuntimeConfig({ driver: managed.driver, settings: managed.settings, credentials });
  const runtime = await runtimePool.getOrCreate<TRuntime>(poolKey, configHash, async () => {
    const runtime = await providerRegistry.createRuntime<TRuntime>(managed.driver, {
      tenantId: context.tenantId,
      ...(context.projectId ? { projectId: context.projectId } : {}),
      providerKey: record.key,
      credentials,
      settings: managed.settings,
      metadata: {},
      logger: createLogger(`${kind}:${record.key}`),
    });
    let confined: TRuntime = runtime;
    if (kind === 'vector' && managed.driver === NAME_SCOPED_VECTOR_DRIVER) {
      confined = wrapNameScopedVectorRuntime(
        runtime as unknown as VectorProviderRuntime,
        managed.token,
        String(managed.settings.vectorBucketName),
      ) as unknown as TRuntime;
    } else if (kind === 'vector' && managed.driver === SEARCH_VECTOR_DRIVER) {
      confined = wrapSearchVectorRuntime(runtime as unknown as VectorProviderRuntime, managed.token) as unknown as TRuntime;
    } else if (kind === 'vector' && managed.driver === POSTGRES_VECTOR_DRIVER) {
      confined = wrapPostgresVectorRuntime(runtime as unknown as VectorProviderRuntime) as unknown as TRuntime;
    }
    return withoutBackendIdentifiers(
      confined as unknown as object,
      backendIdentifiers(managed, credentials),
      kind,
    ) as TRuntime;
  });
  return managed.cleanupOnly ? withoutWrites(runtime as unknown as object, kind) as TRuntime : runtime;
}

/** Values shorter than this are not matched: they would turn almost every message into the generic one. */
const MIN_IDENTIFIER_LENGTH = 3;

/**
 * What in an error message would name the operator's backend: the settings that locate it (bucket, endpoint host,
 * folders, prefix), the tenant's token and any ARN. Settings that core scoped to the tenant are listed with and
 * without the token, so the backend's own root is covered too.
 */
export function backendIdentifiers(
  managed: Pick<ManagedStorageConnection, 'settings' | 'token'>,
  credentials?: Record<string, unknown>,
): string[] {
  const { settings, token } = managed;
  const found = new Set<string>([token, 'arn:aws:']);
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length >= MIN_IDENTIFIER_LENGTH) found.add(trimmed);
  };
  for (const key of ['bucket', 'vectorBucketName', 'vectorBucketArn', 'basePath', 'subdirectory', 'prefix', 'container', 'accountName'] as const) {
    const value = settings[key];
    add(value);
    if (typeof value === 'string') {
      const parent = value.trim().replace(new RegExp(`[/\\\\]?${token}$`), '');
      add(parent);
    }
  }
  const addEndpoint = (endpoint: unknown) => {
    if (typeof endpoint !== 'string' || endpoint.trim() === '') return;
    add(endpoint);
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint.trim()) ? endpoint.trim() : `https://${endpoint.trim()}`);
      add(url.host);
      add(url.hostname);
    } catch {
      // Not a URL: the raw value above stands.
    }
  };
  // Postgres: where the database is and who connects (never the password).
  for (const source of [settings, credentials ?? {}]) {
    add(source.host);
    add(source.database);
    add(source.user);
  }
  addEndpoint(settings.endpoint);
  addEndpoint(settings.foundryProjectEndpoint);
  // The Azure blob endpoint a driver derives from the account: the account can sit in the settings or, for a connection
  // string, only inside the credential. Only the account name, the blob endpoint and the host are taken from it; the
  // credential itself (keys, tokens) is never added, logged or returned.
  let suffix = 'core.windows.net';
  const accounts = new Set<string>();
  if (typeof settings.accountName === 'string') accounts.add(settings.accountName.trim());
  const connectionString = credentials?.connectionString;
  if (typeof connectionString === 'string' && /^postgres(ql)?:\/\//i.test(connectionString.trim())) {
    try {
      const url = new URL(connectionString.trim());
      add(url.host);
      add(url.hostname);
      add(url.pathname.replace(/^\/+/, ''));
      try { add(decodeURIComponent(url.username)); } catch { add(url.username); }
    } catch {
      // Not parseable: the host settings above stand.
    }
  } else if (typeof connectionString === 'string') {
    for (const part of connectionString.split(';')) {
      const at = part.indexOf('=');
      if (at < 0) continue;
      const name = part.slice(0, at).trim().toLowerCase();
      const value = part.slice(at + 1).trim();
      if (name === 'accountname') accounts.add(value);
      else if (name === 'endpointsuffix' && value) suffix = value;
      else if (name === 'blobendpoint') addEndpoint(value);
    }
  }
  for (const account of accounts) {
    if (account.length < MIN_IDENTIFIER_LENGTH) continue;
    add(account);
    add(`${account}.blob.${suffix}`);
  }
  // The built-in data directory is the root of a local driver whose settings name none.
  add(getConfig().storage.dataDir);
  return [...found];
}

/**
 * The runtime with every failure checked before the tenant can read it: an error whose message holds one of the
 * backend's identifiers is logged as it is and rethrown with the generic message. An error without one passes
 * unchanged ("file not found"). A 4xx status of the original is kept, anything else becomes the refusal's own.
 */
export function withoutBackendIdentifiers<T extends object>(runtime: T, identifiers: string[], kind: ManagedStorageKind): T {
  const clean = (error: unknown): unknown => {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    if (!message || !identifiers.some((needle) => message.includes(needle))) return error;
    log.error('Managed storage call failed with a message naming the backend', { kind, error: message });
    const refusal = new ManagedProviderError(MANAGED_STORAGE_UNAVAILABLE);
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      Object.defineProperty(refusal, 'status', { value: status });
    }
    return refusal;
  };
  return new Proxy(runtime, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop === 'symbol' || prop === 'close') return value;
      return (...args: unknown[]) => {
        try {
          const result = value.apply(target, args);
          return result && typeof result.then === 'function'
            ? result.then(undefined, (error: unknown) => { throw clean(error); })
            : result;
        } catch (error) {
          throw clean(error);
        }
      };
    },
  });
}
