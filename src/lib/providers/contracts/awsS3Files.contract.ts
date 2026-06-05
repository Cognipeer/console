import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ProviderContract } from '../types';
import type {
  FileProviderRuntime,
  FileObjectHandle,
  ListFilesOptions,
} from '../domains/file';

interface AwsS3FileCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface AwsS3FileSettings {
  region: string;
  bucket: string;
  prefix?: string;
  usePathStyleEndpoint?: boolean;
}

function ensure(value: string | undefined, message: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(message);
  }
  return value.trim();
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
  if (!fileName) {
    return `${Date.now()}-${randomUUID()}`;
  }

  const extension = path.extname(fileName);
  const baseName = fileName.slice(0, fileName.length - extension.length);
  const slug = baseName.length > 0 ? baseName : 'file';
  const normalized = slug.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
  return `${normalized}-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`;
}

function toHandle(
  key: string,
  object: Pick<_Object, 'Key' | 'Size' | 'LastModified' | 'ETag'>,
  metadata?: Record<string, unknown>,
): FileObjectHandle {
  const name = key.split('/').pop() ?? key;
  return {
    key,
    name,
    size: object.Size ?? 0,
    etag: object.ETag ?? undefined,
    lastModified: object.LastModified ?? undefined,
    metadata,
  };
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (typeof body === 'string') {
    return Buffer.from(body);
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
    const array = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(array);
  }

  if (typeof (body as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') {
    const arrayBuffer = await (body as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  const stream = body as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const bufferChunk = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk)
        : Buffer.from(chunk as Uint8Array);
    chunks.push(bufferChunk);
  }
  return Buffer.concat(chunks);
}

function toMetadataRecord(input?: Record<string, unknown>): Record<string, string> | undefined {
  if (!input) {
    return undefined;
  }

  const entries = Object.entries(input)
    .map(([key, value]) => {
      if (value === undefined || value === null) {
        return undefined;
      }
      return [key, String(value)] as const;
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry));

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export const AwsS3FileProviderContract: ProviderContract<
  FileProviderRuntime,
  AwsS3FileCredentials,
  AwsS3FileSettings
> = {
  id: 'aws-s3-files',
  version: '1.0.0',
  domains: ['file'],
  display: {
    label: 'Amazon S3',
    description: 'Store files in an S3 bucket.',
    icon: 'tabler:brand-aws',
  },
  capabilities: {
    supportsMarkdownConversion: true,
    supportsBulkListing: true,
  },
  form: {
    sections: [
      {
        title: 'Authentication',
        fields: [
          {
            name: 'accessKeyId',
            label: 'Access key ID',
            type: 'text',
            required: true,
            scope: 'credentials',
          },
          {
            name: 'secretAccessKey',
            label: 'Secret access key',
            type: 'password',
            required: true,
            scope: 'credentials',
          },
          {
            name: 'sessionToken',
            label: 'Session token',
            type: 'password',
            description: 'Optional session token for temporary credentials.',
            scope: 'credentials',
          },
        ],
      },
      {
        title: 'Bucket configuration',
        fields: [
          {
            name: 'region',
            label: 'AWS region',
            type: 'text',
            required: true,
            placeholder: 'us-east-1',
            scope: 'settings',
          },
          {
            name: 'bucket',
            label: 'Bucket name',
            type: 'text',
            required: true,
            scope: 'settings',
          },
          {
            name: 'prefix',
            label: 'Bucket prefix',
            type: 'text',
            placeholder: 'cognipeer-console/files',
            description: 'Optional prefix prepended to all stored objects.',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  async createRuntime({ tenantId, providerKey, credentials, settings, logger }) {
    const region = ensure(settings.region, 'AWS region is required.');
    const bucket = ensure(settings.bucket, 'Bucket name is required.');

    const client = new S3Client({
      region,
      credentials: {
        accessKeyId: ensure(credentials.accessKeyId, 'Access key ID is required.'),
        secretAccessKey: ensure(credentials.secretAccessKey, 'Secret access key is required.'),
        sessionToken: credentials.sessionToken,
      },
      forcePathStyle: settings.usePathStyleEndpoint ?? false,
    });

    const basePrefixSegments = [settings.prefix, tenantId, providerKey]
      .filter((segment): segment is string => Boolean(segment && segment.trim().length > 0))
      .map((segment) => segment.replace(/^\/+|\/+$/g, ''));
    const basePrefix = basePrefixSegments.length > 0
      ? `${basePrefixSegments.join('/')}/`
      : '';

    function toStorageKey(relativeKey?: string) {
      const rawKey = relativeKey ?? generateKey();
      const sanitized = sanitizeKey(rawKey);
      return {
        relativeKey: sanitized,
        storageKey: `${basePrefix}${sanitized}`,
      };
    }

    async function headObject(storageKey: string) {
      const response = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: storageKey }),
      );

      return {
        size: Number(response.ContentLength ?? 0),
        lastModified: response.LastModified ?? undefined,
        etag: response.ETag ?? undefined,
        contentType: response.ContentType ?? undefined,
        metadata: response.Metadata ?? undefined,
      };
    }

    const runtime: FileProviderRuntime = {
      async uploadFile(input) {
        const { relativeKey, storageKey } = toStorageKey(input.key ?? generateKey(input.name));
        const body = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);

        const checksum = createHash('sha256').update(body).digest('hex');

        const response = await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: storageKey,
            Body: body,
            ContentType: input.contentType,
            Metadata: toMetadataRecord({
              checksum,
              originalName: input.name,
              ...input.metadata,
            }),
          }),
        );

        logger?.info?.('Uploaded S3 object', { key: storageKey, size: body.length });

        return {
          handle: {
            key: relativeKey,
            name: input.name ?? relativeKey.split('/').pop() ?? relativeKey,
            size: body.length,
            contentType: input.contentType,
            checksum,
            etag: response.ETag ?? undefined,
            metadata: input.metadata,
          },
        };
      },

      async downloadFile(key) {
        const { storageKey } = toStorageKey(key);
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: storageKey }),
        );

        const body = await streamToBuffer(response.Body);

        return {
          data: body,
          size: response.ContentLength ?? body.length,
          contentType: response.ContentType ?? undefined,
          metadata: response.Metadata ?? undefined,
          etag: response.ETag ?? undefined,
        };
      },

      async deleteFile(key) {
        const { storageKey } = toStorageKey(key);
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
        logger?.info?.('Deleted S3 object', { key: storageKey });
      },

      async listFiles(options?: ListFilesOptions) {
        const sanitizedPrefix =
          options?.prefix && options.prefix.trim().length > 0
            ? sanitizeKey(options.prefix)
            : undefined;
        const listPrefix = sanitizedPrefix
          ? buildStoragePrefix(basePrefix, sanitizedPrefix)
          : basePrefix;

        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: listPrefix,
            ContinuationToken: options?.cursor,
            MaxKeys: options?.limit ?? 50,
          }),
        );

        const contents: _Object[] = response.Contents ?? [];
        const items = contents.map((object) => {
          const storageKey = object.Key ?? '';
          const relative = storageKey.slice(basePrefix.length);
          return toHandle(relative, object);
        });

        return {
          items,
          nextCursor: response.NextContinuationToken ?? undefined,
        };
      },

      async getFileMetadata(key) {
        const { relativeKey, storageKey } = toStorageKey(key);
        try {
          const meta = await headObject(storageKey);
          return {
            key: relativeKey,
            name: relativeKey.split('/').pop() ?? relativeKey,
            size: meta.size,
            contentType: meta.contentType,
            etag: meta.etag,
            metadata: meta.metadata,
            lastModified: meta.lastModified,
          } satisfies FileObjectHandle;
        } catch (error) {
          if ((error as Error).name === 'NotFound' || (error as Error).name === 'NoSuchKey') {
            return null;
          }
          throw error;
        }
      },
    } satisfies FileProviderRuntime;

    return runtime;
  },
};
function buildStoragePrefix(basePrefix: string, prefix: string) {
  const cleaned = prefix.replace(/^\/+|\/+$/g, '');
  return `${basePrefix}${cleaned}`;
}
