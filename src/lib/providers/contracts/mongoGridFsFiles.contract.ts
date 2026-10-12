import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { GridFSBucket, MongoClient, type GridFSFile } from 'mongodb';
import { getConfig } from '@/lib/core/config';
import type { ProviderContract } from '../types';
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

// One MongoClient per URI for the process: createRuntime runs per request, and
// an unclosed client per call would leak connections.
const clients = new Map<string, Promise<MongoClient>>();

function getClient(uri: string): Promise<MongoClient> {
  let pending = clients.get(uri);
  if (!pending) {
    pending = new MongoClient(uri).connect().catch((error) => {
      clients.delete(uri);
      throw error;
    });
    clients.set(uri, pending);
  }
  return pending;
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

  async createRuntime({ tenantId, providerKey, credentials, settings, logger }) {
    const uri = resolveUri(credentials);
    const usingAppConnection = !credentials?.uri?.trim();
    const cfg = getConfig();
    const defaultDbName =
      usingAppConnection && cfg.database.provider === 'mongodb' && cfg.database.singleDatabase
        ? cfg.database.mainDbName
        : DEFAULT_DB;

    const dbName = settings.database?.trim() || defaultDbName;
    const bucketName = (settings.bucketName?.trim() || DEFAULT_BUCKET).replace(/[^a-zA-Z0-9_-]/g, '_');
    const chunk = Number(settings.chunkSizeBytes);
    const chunkSizeBytes = Number.isFinite(chunk) && chunk > 0 ? Math.floor(chunk) : undefined;

    const client = await getClient(uri);
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
          throw new Error(`File not found: ${relativeKey}`);
        }
        const chunks: Buffer[] = [];
        for await (const part of bucket.openDownloadStream(file._id)) {
          chunks.push(Buffer.from(part as Uint8Array));
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
