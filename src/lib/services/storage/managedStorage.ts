/**
 * Managed storage: the runtime of a file or vector provider that the operator serves (a platform record).
 *
 * A managed storage record holds no connection of its own. The host names one live route and hands core the
 * connection behind it (see `@/enterprise/managed-credits`). Storage is never paid with credits: what a tenant stores
 * counts against its plan storage, metered by the file and vector services.
 *
 * Tenant isolation is enforced here, by core, whatever the host returns:
 * - root-scoped drivers (`MANAGED_STORAGE_DRIVERS`, all but one): the runtime is rooted in a folder (or key prefix)
 *   named after the tenant under the backend's root. The driver adds its own tenant and provider folders below it.
 * - the name-scoped vector driver (one shared namespace of indexes): every index the tenant creates is named with the
 *   tenant's token, and any handle that does not name one of the tenant's indexes in the configured bucket is refused.
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
import type { CreateVectorIndexInput, VectorIndexHandle, VectorProviderRuntime } from '@/lib/providers/domains/vector';
import { loadProviderRuntimeData } from '@/lib/services/providers/providerService';
import { ManagedProviderError } from '@/lib/services/providers/managedProviderErrors';

const log = createLogger('managed-storage');

export type ManagedStorageKind = 'file' | 'vector';

/** What a tenant reads when a platform storage provider cannot serve: nothing about the backend. */
export const MANAGED_STORAGE_UNAVAILABLE = 'This provider is not available right now.';

/** The drivers whose runtime core can confine to one tenant. Any other driver on a managed route is refused. */
export const MANAGED_STORAGE_DRIVERS: Readonly<Record<ManagedStorageKind, readonly string[]>> = {
  file: ['local-filesystem', 'aws-s3-files', 's3-compatible-files'],
  vector: ['sqlite-vector', 'aws-s3-vectors'],
};

/** The vector driver with one shared namespace of indexes: scoped by index name, not by a root. */
const NAME_SCOPED_VECTOR_DRIVER = 'aws-s3-vectors';

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
    case 's3-compatible-files': {
      const prefix = trimSlashes(settings.prefix);
      return { ...settings, prefix: prefix ? `${prefix}/${token}` : token };
    }
    case 'sqlite-vector': {
      const base = typeof settings.basePath === 'string' && settings.basePath.trim() !== ''
        ? settings.basePath.trim()
        : path.join(getConfig().storage.dataDir, 'vectors');
      return { ...settings, basePath: path.join(base, token) };
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
      if (!arn || !arn.endsWith(`/index/${physical}`)) return refuse('created index');
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
    listVectors: async (handle, input) => inner.listVectors(checked(handle), input),
  };
  if (inner.close) runtime.close = () => inner.close?.();
  return runtime;
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
    settings = typeof bucket === 'string' && bucket.trim() !== '' ? { ...connection.settings } : null;
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
  return {
    record: loaded.record,
    credentials: loaded.credentials,
    managed: { connectionId: route.connectionId, driver, settings, token },
  };
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
  return runtimePool.getOrCreate<TRuntime>(poolKey, configHash, async () => {
    const runtime = await providerRegistry.createRuntime<TRuntime>(managed.driver, {
      tenantId: context.tenantId,
      ...(context.projectId ? { projectId: context.projectId } : {}),
      providerKey: record.key,
      credentials,
      settings: managed.settings,
      metadata: {},
      logger: createLogger(`${kind}:${record.key}`),
    });
    if (kind === 'vector' && managed.driver === NAME_SCOPED_VECTOR_DRIVER) {
      return wrapNameScopedVectorRuntime(
        runtime as unknown as VectorProviderRuntime,
        managed.token,
        String(managed.settings.vectorBucketName),
      ) as unknown as TRuntime;
    }
    return runtime;
  });
}
