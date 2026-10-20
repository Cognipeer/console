import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';
import { GridFSBucket, MongoClient, type GridFSFile } from 'mongodb';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import {
  createGuardedLookup,
  guardRefusesAddress,
  privateNetworkBlockApplies,
  type OutboundGuardOptions,
} from '@/lib/security/outboundFetch';
import {
  assertProviderUrlAllowed,
  assertSrvTargetsAllowed,
  endpointGuardOptions,
  ProviderEndpointError,
  refusesUnvettableEndpoints,
  type ProviderEndpointScope,
} from '@/lib/services/providers/providerEndpointGuard';
import { ProviderSettingsError } from '../errors';
import type { ProviderContract } from '../types';
import { maxStorageDownloadBytes, StorageObjectTooLargeError } from './storageLimits';
import type {
  FileObjectHandle,
  FileProviderRuntime,
  ListFilesOptions,
} from '../domains/file';

/**
 * MongoDB GridFS file store — object storage for deployments without S3.
 *
 * Works against any MongoDB (self-hosted Community included) using the
 * driver's built-in GridFS, so no extra service, PVC or bucket is needed.
 * Leaving the connection URI empty reuses the app's own MongoDB connection.
 */

interface GridFsCredentials {
  uri?: string;
}

interface GridFsSettings {
  database?: string;
  bucketName?: string;
  chunkSizeBytes?: number | string;
}

const DEFAULT_BUCKET = 'files';
const DEFAULT_DB = 'cognipeer_files';

/** The GridFS bucket a provider writes to: its setting, cleaned the way the runtime uses it. */
function gridFsBucketName(settings: GridFsSettings | undefined): string {
  return (settings?.bucketName?.trim() || DEFAULT_BUCKET).replace(/[^a-zA-Z0-9_-]/g, '_');
}

const logger = createLogger('mongodb-gridfs-files');

// One MongoClient per URI for the process: createRuntime runs per request, and
// an unclosed client per call would leak connections. A guarded client is also per organization: its lookup carries
// the private networks opened for that organization, so two organizations never share one.
const clients = new Map<string, Promise<MongoClient>>();

/** True for a literal address the policy refuses to dial; a name is left to the guarded lookup. `address` is `host:port` or `[v6]:port`. */
function refusesLiteralMember(address: string, guard: OutboundGuardOptions | undefined): boolean {
  const host = address.startsWith('[') ? address.slice(1, address.indexOf(']')) : address.replace(/:\d+$/, '');
  return isIP(host) !== 0 && privateNetworkBlockApplies(host, guard) && guardRefusesAddress(host, guard);
}

/**
 * `guarded`: the URI was typed into the provider form, so the client's connections follow the deployment's
 * network policy (see `assertUriAllowed`), with the private networks opened for `tenantId`. The app's own
 * connection is not subject to it.
 */
function getClient(uri: string, tenantId: string | undefined, guarded: boolean): Promise<MongoClient> {
  const key = guarded ? `guarded:${JSON.stringify([tenantId ?? null, uri])}` : `app:${uri}`;
  let pending = clients.get(key);
  if (!pending) {
    const guard = endpointGuardOptions(tenantId);
    // A guarded lookup refuses a name that answers with a private address when the socket connects (a seed host, a
    // member the servers announce, an SRV target), which a check made when the URI was saved cannot see.
    const client = new MongoClient(uri, guarded ? { lookup: createGuardedLookup(guard) } : undefined);
    let refused: string | undefined;
    // only this client's own entry: a newer one for the same URI may have taken its place
    const forget = () => {
      if (clients.get(key) === pending) clients.delete(key);
    };
    if (guarded) {
      // A literal address skips that lookup, and the servers announce members the URI never named. The event comes
      // before the driver starts connecting to the member; closing the client cancels that connection before the
      // handshake is sent, and a client that cannot be trusted is not kept.
      client.on('serverOpening', ({ address }) => {
        if (refused || !refusesLiteralMember(address, guard)) return;
        refused = address;
        forget();
        logger.warn('MongoDB server announced a host this deployment does not allow; connection closed', { address });
        process.nextTick(() => { client.close().catch(() => undefined); });
      });
    }
    const notAllowed = () => new ProviderEndpointError('uri', 'the database announced a host that is not allowed on this deployment');
    pending = client.connect()
      .then((connected) => {
        if (refused) throw notAllowed();
        return connected;
      })
      .catch((error) => {
        forget();
        throw refused ? notAllowed() : error;
      });
    clients.set(key, pending);
  }
  return pending;
}

/** A host the driver dials is a plain name or address: nothing a URL parser would read differently. */
const PLAIN_HOST = /^[a-z0-9._:-]+$/i;

async function assertHostAllowed(host: string, scope: ProviderEndpointScope): Promise<void> {
  if (!PLAIN_HOST.test(host)) {
    throw new ProviderEndpointError('uri', 'a host in the connection URI is not a plain host name or address');
  }
  await assertProviderUrlAllowed('uri', `https://${host.includes(':') ? `[${host}]` : host}`, scope);
}

/**
 * A connection URI someone typed in is held to the same network policy as a storage endpoint: every host the
 * driver would dial (the seed list, a proxy) is vetted, and a form the policy cannot check - a local socket - is
 * refused while private targets are blocked. A `mongodb+srv` URI is vetted through its SRV record: the record the
 * driver will resolve (its parsed host and service name) is resolved here and every host in it is vetted. The
 * driver's own parser reads the URI, so the hosts vetted are the hosts dialled; creating a client connects to
 * nothing. A private host passes only inside a network opened for `tenantId`.
 *
 * Certificate files named in the URI are read from the server's disk, which only a self-hosted install offers.
 * An error from the driver's parser is not passed on: it can quote part of the URI, and the URI holds a password.
 */
async function assertUriAllowed(uri: string, isOnPrem: boolean, tenantId: string | undefined): Promise<void> {
  let options: MongoClient['options'];
  try {
    options = new MongoClient(uri).options;
  } catch {
    throw new ProviderSettingsError('uri', 'Connection URI is not a valid MongoDB connection string.');
  }

  if (!isOnPrem && (options.tlsCAFile || options.tlsCertificateKeyFile)) {
    throw new ProviderSettingsError('uri', 'Certificate files in the connection URI are only available on self-hosted deployments.');
  }
  const scope = { tenantId };
  const refuseUnvettable = refusesUnvettableEndpoints(scope);
  if (options.srvHost) await assertSrvTargetsAllowed('uri', options.srvHost, scope, options.srvServiceName);
  for (const address of options.hosts) {
    if (address.socketPath) {
      if (refuseUnvettable) throw new ProviderEndpointError('uri', 'a local socket is not available on this deployment');
      continue;
    }
    await assertHostAllowed(address.host ?? '', scope);
  }
  if (options.proxyHost) await assertHostAllowed(options.proxyHost, scope);
}

function resolveUri(credentials: GridFsCredentials): string {
  const explicit = credentials?.uri?.trim();
  if (explicit) return explicit;

  const cfg = getConfig();
  if (cfg.database.provider === 'mongodb' && cfg.database.uri) {
    return cfg.database.uri;
  }

  throw new Error(
    'MongoDB GridFS requires a connection URI. Set DB_PROVIDER=mongodb (so the app\'s own MongoDB connection can be reused), or provide a "uri" credential explicitly.',
  );
}

function sanitizeKey(rawKey: string): string {
  const normalized = rawKey.replace(/\\/g, '/').replace(/\.{2,}/g, '.');
  const trimmed = normalized.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed || trimmed.includes('..')) {
    throw new Error('Invalid file key provided.');
  }
  return trimmed;
}

function generateKey(fileName?: string): string {
  if (!fileName) return `${Date.now()}-${randomUUID()}`;
  const extension = path.extname(fileName);
  const baseName = fileName.slice(0, fileName.length - extension.length);
  const slug = (baseName || 'file').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
  return `${slug}-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toHandle(relativeKey: string, file: GridFSFile): FileObjectHandle {
  const meta = (file.metadata ?? {}) as {
    contentType?: string;
    checksum?: string;
    originalName?: string;
    custom?: Record<string, unknown>;
  };
  return {
    key: relativeKey,
    name: meta.originalName ?? relativeKey.split('/').pop() ?? relativeKey,
    size: file.length,
    contentType: meta.contentType,
    checksum: meta.checksum,
    etag: meta.checksum,
    metadata: meta.custom,
    lastModified: file.uploadDate,
  };
}

export const MongoGridFsFileProviderContract: ProviderContract<
  FileProviderRuntime,
  GridFsCredentials,
  GridFsSettings
> = {
  id: 'mongodb-gridfs-files',
  version: '1.0.0',
  domains: ['file'],
  display: {
    label: 'MongoDB GridFS',
    description:
      'Store files in MongoDB GridFS. Works with any MongoDB (self-hosted Community included) and needs no S3 or shared volume.',
    icon: 'tabler:database',
  },
  capabilities: {
    supportsMarkdownConversion: true,
    supportsBulkListing: true,
    local: false,
    shared: true,
  },
  form: {
    sections: [
      {
        title: 'Connection',
        description: 'Leave empty to reuse the app\'s own MongoDB connection (when DB_PROVIDER=mongodb).',
        fields: [
          {
            name: 'uri',
            label: 'Connection URI',
            type: 'password',
            required: false,
            placeholder: 'mongodb://user:pass@host:27017',
            description: 'Optional. Defaults to the app\'s MONGODB_URI when left empty. Required when the app runs on SQLite.',
            scope: 'credentials',
          },
        ],
      },
      {
        title: 'Storage',
        fields: [
          {
            name: 'database',
            label: 'Database',
            type: 'text',
            required: false,
            placeholder: DEFAULT_DB,
            description:
              'Optional. Defaults to a dedicated "cognipeer_files" database, or the app\'s main database when MONGODB_SINGLE_DATABASE is on.',
            scope: 'settings',
          },
          {
            name: 'bucketName',
            label: 'GridFS bucket name',
            type: 'text',
            required: false,
            placeholder: DEFAULT_BUCKET,
            description: 'Collections <name>.files and <name>.chunks are created on first write.',
            scope: 'settings',
          },
          {
            name: 'chunkSizeBytes',
            label: 'Chunk size (bytes)',
            type: 'number',
            required: false,
            placeholder: '261120',
            description: 'Optional. Defaults to 255 KiB.',
            scope: 'settings',
          },
        ],
      },
    ],
  },

  async validateSettings({ credentials, isOnPrem, tenantId }) {
    const raw: unknown = credentials?.uri;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      throw new ProviderSettingsError('uri', 'Connection URI must be text.');
    }
    if (raw?.trim()) await assertUriAllowed(raw.trim(), isOnPrem, tenantId);
  },

  describeStorageLocation({ settings, tenantId, providerKey }) {
    // The filename prefix the runtime puts in front of every key (`<tenant>/<provider>/`); the database and the
    // connection stay out of it.
    return `MongoDB GridFS \u00b7 ${gridFsBucketName(settings)}/${tenantId}/${providerKey}/`;
  },

  async createRuntime({ tenantId, providerKey, credentials, settings, logger }) {
    const uri = resolveUri(credentials);
    const usingAppConnection = !credentials?.uri?.trim();
    // Rows saved before the URI was checked, and a name that now answers differently, are not covered by the save-time check
    if (!usingAppConnection) await assertUriAllowed(uri, getConfig().deployment.isOnPrem, tenantId);
    const cfg = getConfig();
    const defaultDbName =
      usingAppConnection && cfg.database.provider === 'mongodb' && cfg.database.singleDatabase
        ? cfg.database.mainDbName
        : DEFAULT_DB;

    const dbName = settings.database?.trim() || defaultDbName;
    const bucketName = gridFsBucketName(settings);
    const chunk = Number(settings.chunkSizeBytes);
    const chunkSizeBytes = Number.isFinite(chunk) && chunk > 0 ? Math.floor(chunk) : undefined;

    const client = await getClient(uri, tenantId, !usingAppConnection && refusesUnvettableEndpoints({ tenantId }));
    const db = client.db(dbName);
    const bucket = new GridFSBucket(db, {
      bucketName,
      ...(chunkSizeBytes ? { chunkSizeBytes } : {}),
    });
    const filesCollection = db.collection<GridFSFile>(`${bucketName}.files`);

    // Tenant + provider isolation lives in the filename, like the S3/local
    // contracts do with their prefix/directory.
    const basePrefix = `${tenantId}/${providerKey}/`;

    function toStorage(rawKey: string) {
      const relativeKey = sanitizeKey(rawKey);
      return { relativeKey, filename: `${basePrefix}${relativeKey}` };
    }

    async function findLatest(filename: string): Promise<GridFSFile | null> {
      return filesCollection.findOne({ filename }, { sort: { uploadDate: -1 } });
    }

    const runtime: FileProviderRuntime = {
      async uploadFile(input) {
        const { relativeKey, filename } = toStorage(input.key ?? generateKey(input.name));
        const body = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
        const checksum = createHash('sha256').update(body).digest('hex');

        const stream = bucket.openUploadStream(filename, {
          metadata: {
            contentType: input.contentType,
            checksum,
            originalName: input.name,
            custom: input.metadata,
          },
        });
        await new Promise<void>((resolve, reject) => {
          stream.once('error', reject);
          stream.once('finish', () => resolve());
          stream.end(body);
        });

        // GridFS keeps every upload as a revision; overwriting a key must
        // replace it, so drop the older revisions once the new one is durable.
        const stale = await filesCollection
          .find({ filename, _id: { $ne: stream.id } })
          .project({ _id: 1 })
          .toArray();
        await Promise.all(stale.map((doc) => bucket.delete(doc._id).catch(() => undefined)));

        logger?.info?.('Uploaded GridFS file', { key: filename, size: body.length });

        return {
          handle: {
            key: relativeKey,
            name: input.name ?? relativeKey.split('/').pop() ?? relativeKey,
            size: body.length,
            contentType: input.contentType,
            checksum,
            etag: checksum,
            metadata: input.metadata,
            lastModified: new Date(),
          },
        };
      },

      async downloadFile(key) {
        const { relativeKey, filename } = toStorage(key);
        const file = await findLatest(filename);
        if (!file) {
          // a missing key is the caller's to hear about, not a storage failure (the file circuit breaker reads the status)
          throw Object.assign(new Error(`File not found: ${relativeKey}`), { statusCode: 404 });
        }
        const ceiling = maxStorageDownloadBytes();
        if (file.length > ceiling) throw new StorageObjectTooLargeError(ceiling);
        const chunks: Buffer[] = [];
        let received = 0;
        for await (const part of bucket.openDownloadStream(file._id)) {
          const chunk = Buffer.from(part as Uint8Array);
          received += chunk.length;
          // The file document is the writer's claim; the chunks are what is really held.
          if (received > ceiling) throw new StorageObjectTooLargeError(ceiling);
          chunks.push(chunk);
        }
        const handle = toHandle(relativeKey, file);
        return {
          data: Buffer.concat(chunks),
          size: file.length,
          contentType: handle.contentType,
          metadata: handle.metadata,
          etag: handle.etag,
        };
      },

      async deleteFile(key) {
        const { filename } = toStorage(key);
        const docs = await filesCollection.find({ filename }).project({ _id: 1 }).toArray();
        await Promise.all(docs.map((doc) => bucket.delete(doc._id).catch(() => undefined)));
        logger?.info?.('Deleted GridFS file', { key: filename });
      },

      async listFiles(options?: ListFilesOptions) {
        const limit = options?.limit ?? 50;
        const prefix = options?.prefix?.trim() ? sanitizeKey(options.prefix) : '';
        const filter: Record<string, unknown> = {
          filename: { $regex: `^${escapeRegex(basePrefix + prefix)}` },
        };
        if (options?.cursor) {
          filter.$and = [{ filename: { $gt: `${basePrefix}${options.cursor}` } }];
        }

        const docs = await filesCollection
          .find(filter)
          .sort({ filename: 1 })
          .limit(limit + 1)
          .toArray();

        const page = docs.slice(0, limit);
        const items = page.map((doc) => toHandle(doc.filename.slice(basePrefix.length), doc));
        return {
          items,
          nextCursor: docs.length > limit ? items[items.length - 1]?.key : undefined,
        };
      },

      async getFileMetadata(key) {
        const { relativeKey, filename } = toStorage(key);
        const file = await findLatest(filename);
        return file ? toHandle(relativeKey, file) : null;
      },
    } satisfies FileProviderRuntime;

    return runtime;
  },
};
