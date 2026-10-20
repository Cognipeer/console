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
import { resolveDownloadCeiling } from './downloadCeiling';
import { hasLoneSurrogate, StorageInvalidKeyError, StorageObjectTooLargeError } from './storageLimits';
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

/** The fields of a server's answer to the driver's heartbeat that name the other members of its replica set. */
const ANNOUNCED_MEMBER_FIELDS = ['hosts', 'passives', 'arbiters'] as const;

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
    // A client that met a member it may not dial cannot be trusted: it is not kept, and closing it ends the attempt.
    const refuse = (address: string) => {
      if (refused) return;
      refused = address;
      forget();
      logger.warn('MongoDB server announced a host this deployment does not allow; connection closed', { address });
      process.nextTick(() => { client.close().catch(() => undefined); });
    };
    if (guarded) {
      // A literal address skips that lookup, and the servers announce members the URI never named. A member is
      // announced in a server's answer to the heartbeat, and the driver reads that answer into its list of servers
      // right after this event has been delivered: the members this deployment does not allow are taken out of the
      // answer here, in place, so the driver never opens a socket to one.
      client.on('serverHeartbeatSucceeded', ({ reply }) => {
        try {
          for (const field of ANNOUNCED_MEMBER_FIELDS) {
            const members: unknown = reply?.[field];
            if (!Array.isArray(members)) continue;
            for (let index = members.length - 1; index >= 0; index -= 1) {
              const address: unknown = members[index];
              if (typeof address !== 'string' || !refusesLiteralMember(address, guard)) continue;
              members.splice(index, 1);
              refuse(address);
            }
          }
        } catch {
          // The check above is the first line; the one below still holds if this one could not run.
          logger.warn('The members a MongoDB server announced could not be checked');
        }
      });
      // The second line, for a member that reaches the driver another way than a heartbeat answer. The event comes
      // after the driver has begun connecting to the member, so a TCP connection may be opened and dropped here, but
      // closing the client cancels the handshake: nothing is sent to the member.
      client.on('serverOpening', ({ address }) => {
        if (refusesLiteralMember(address, guard)) refuse(address);
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
 * Sign-in methods whose credentials are the ones written in the URI. Every other method makes the driver sign in as
 * the machine the console runs on (a cloud role or workload identity, a Kerberos ticket, the client certificate the
 * server holds): an identity of the deployment, not of whoever typed the URI.
 */
const URI_CREDENTIAL_MECHANISMS: ReadonlySet<string> = new Set(['DEFAULT', 'SCRAM-SHA-1', 'SCRAM-SHA-256', 'PLAIN']);

/** What a person is told when a sign-in method is refused: the method (a fixed name of the driver, never part of the URI) and what to use instead. */
const SERVER_IDENTITY_REASON = 'uses the server\'s own identity and is available on self-hosted deployments only. Use a user name and password in the connection URI.';

/** The user name and password the URI itself holds, split the way the driver's connection string parser splits them. */
const URI_USERINFO = /^[^/]+:\/\/(?:([^:@]*)(?::([^@]*))?@)?/;

/**
 * The sign-in method of a URI must take its credentials from the URI: DEFAULT, SCRAM-SHA-1, SCRAM-SHA-256 and PLAIN
 * do, and MONGODB-AWS does when the URI holds both the access key and the secret. MONGODB-OIDC, GSSAPI, MONGODB-X509,
 * and the `ENVIRONMENT` and `TOKEN_RESOURCE` properties make the driver use the identity of the server instead.
 *
 * MONGODB-AWS is judged on the text of the URI, not on the credentials the driver built from it: the driver fills a
 * missing access key or secret in from the AWS variables of its own process.
 */
function assertCredentialsFromUri(uri: string, options: MongoClient['options']): void {
  const credentials = options.credentials;
  if (!credentials) return;
  const refuse = (subject: string) => new ProviderSettingsError('uri', `${subject} ${SERVER_IDENTITY_REASON}`);

  const mechanism: string = credentials.mechanism;
  if (mechanism === 'MONGODB-AWS') {
    const [, accessKey, secret] = URI_USERINFO.exec(uri) ?? [];
    if (!accessKey || !secret) {
      throw new ProviderSettingsError(
        'uri',
        'Authentication method MONGODB-AWS needs the access key and the secret in the connection URI: without them it uses the server\'s own identity, which is available on self-hosted deployments only.',
      );
    }
  } else if (!URI_CREDENTIAL_MECHANISMS.has(mechanism)) {
    throw refuse(`Authentication method ${mechanism}`);
  }

  // These name where the server's own identity is read from, whatever the method
  const { ENVIRONMENT, TOKEN_RESOURCE } = credentials.mechanismProperties;
  if (ENVIRONMENT !== undefined) throw refuse('The authentication property ENVIRONMENT');
  if (TOKEN_RESOURCE !== undefined) throw refuse('The authentication property TOKEN_RESOURCE');
}

/**
 * A connection URI someone typed in is held to the same network policy as a storage endpoint: every host the
 * driver would dial (the seed list, a proxy) is vetted, and a form the policy cannot check - a local socket - is
 * refused while private targets are blocked. A `mongodb+srv` URI is vetted through its SRV record: the record the
 * driver will resolve (its parsed host and service name) is resolved here and every host in it is vetted. The
 * driver's own parser reads the URI, so the hosts vetted are the hosts dialled; creating a client connects to
 * nothing. A private host passes only inside a network opened for `tenantId`.
 *
 * Certificate files named in the URI (the CA bundle, the client certificate and key, the revocation list) are read from
 * the server's disk, which only a self-hosted install offers. Where the deployment blocks private targets (SaaS, or a
 * self-hosted install that turns the block on) the sign-in method must take its credentials from the URI (see
 * `assertCredentialsFromUri`). Turning certificate verification off with the URI options (`tlsInsecure`,
 * `tlsAllowInvalidCertificates`, `tlsAllowInvalidHostnames`) is the provider's own choice on every deployment, as it is
 * for the storage endpoints; the hosts it dials are held to the network policy either way.
 * An error from the driver's parser is not passed on: it can quote part of the URI, and the URI holds a password.
 */
async function assertUriAllowed(uri: string, isOnPrem: boolean, tenantId: string | undefined): Promise<void> {
  let options: MongoClient['options'];
  try {
    options = new MongoClient(uri).options;
  } catch {
    throw new ProviderSettingsError('uri', 'Connection URI is not a valid MongoDB connection string.');
  }

  if (!isOnPrem && (options.tlsCAFile || options.tlsCertificateKeyFile || options.tlsCRLFile)) {
    throw new ProviderSettingsError('uri', 'Certificate files (tlsCAFile, tlsCertificateKeyFile, tlsCRLFile) in the connection URI are only available on self-hosted deployments.');
  }
  const scope = { tenantId };
  const refuseUnvettable = refusesUnvettableEndpoints(scope);
  if (!isOnPrem || refuseUnvettable) assertCredentialsFromUri(uri, options);
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
    throw new StorageInvalidKeyError();
  }
  // Written to a path (or a file name), a lone surrogate turns into U+FFFD: two different keys would be one file.
  if (hasLoneSurrogate(trimmed)) {
    throw new StorageInvalidKeyError('it holds a character that has no UTF-8 form (a lone surrogate).');
  }
  return trimmed;
}

function generateKey(fileName?: string): string {
  if (!fileName) return `${Date.now()}-${randomUUID()}`;
  const extension = path.extname(fileName);
  const baseName = fileName.slice(0, fileName.length - extension.length);
  // A dash left at either end of the stem is dropped, as the other drivers do.
  const slug = (baseName || 'file').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'file';
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

      async downloadFile(key, options) {
        const { relativeKey, filename } = toStorage(key);
        const file = await findLatest(filename);
        if (!file) {
          // a missing key is the caller's to hear about, not a storage failure (the file circuit breaker reads the status)
          throw Object.assign(new Error(`File not found: ${relativeKey}`), { statusCode: 404 });
        }
        const ceiling = resolveDownloadCeiling(options);
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
