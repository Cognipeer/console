import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import slugify from 'slugify';
import type { Stats } from 'node:fs';
import type { ProviderContract } from '../types';
import type {
  FileProviderRuntime,
  FileObjectHandle,
  ListFilesOptions,
  ListFilesResult,
  UploadFileResult,
} from '../domains/file';

interface LocalFileSettings {
  basePath: string;
  subdirectory?: string;
}

interface LocalFileMetadata {
  checksum?: string;
  contentType?: string;
  custom?: Record<string, unknown>;
}

type LocalFileCredentials = Record<string, never>;

const SLUG_OPTIONS = {
  lower: true,
  strict: true,
  trim: true,
};

function ensurePathProvided(settings: LocalFileSettings): string {
  const raw = settings.basePath?.trim();
  if (!raw) {
    throw new Error('Local file provider requires a basePath setting.');
  }

  const resolved = path.resolve(raw);
  return resolved;
}

function buildTenantRoot(
  settings: LocalFileSettings,
  tenantId: string,
  providerKey: string,
): string {
  const base = ensurePathProvided(settings);
  const segments = [base];

  if (settings.subdirectory && settings.subdirectory.trim().length > 0) {
    segments.push(settings.subdirectory.trim());
  }

  segments.push(tenantId, providerKey);
  return path.join(...segments);
}

function sanitizeKey(rawKey: string): string {
  const normalized = rawKey.replace(/\\/g, '/').replace(/\.{2,}/g, '.');
  const trimmed = normalized.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed || trimmed.includes('..')) {
    throw new Error('Invalid file key provided.');
  }
  return trimmed;
}

function generateKey(fileName: string | undefined): string {
  if (!fileName) {
    return `${Date.now()}-${randomUUID()}`;
  }

  const extension = path.extname(fileName);
  const baseName = fileName.slice(0, fileName.length - extension.length);
  const slug = slugify(baseName, SLUG_OPTIONS) || 'file';
  return `${slug}-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`;
}

function ensureWithin(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative.startsWith('..') ||
    relative.includes(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Attempted to access path outside of storage root.');
  }
}

async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

function buildHandle(
  key: string,
  name: string,
  stats: Stats,
  metadata?: LocalFileMetadata,
): FileObjectHandle {
  return {
    key,
    name,
    size: stats.size,
    contentType: metadata?.contentType,
    checksum: metadata?.checksum,
    metadata: metadata?.custom,
    lastModified: stats.mtime,
  };
}

async function tryStat(filePath: string): Promise<Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return (await tryStat(filePath)) !== null;
}

interface ListWalkOptions {
  limit: number;
  cursor?: string;
}

async function listFileEntries(
  root: string,
  normalizedPrefix: string | undefined,
  options: ListWalkOptions,
): Promise<ListFilesResult> {
  const searchRoot = normalizedPrefix
    ? path.join(root, normalizedPrefix)
    : root;

  if (!(await pathExists(searchRoot))) {
    return { items: [] };
  }

  const maxResults = options.limit + 1;
  const items: FileObjectHandle[] = [];
  let lastKey: string | undefined;

  async function walk(currentDir: string, relativePrefix: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sorted) {
      const entryRelativeKey = relativePrefix
        ? `${relativePrefix}/${entry.name}`
        : entry.name;
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(entryPath, entryRelativeKey);
        if (items.length >= maxResults) {
          return;
        }
        continue;
      }

      const shouldSkipCursor =
        options.cursor && entryRelativeKey <= options.cursor;
      if (shouldSkipCursor) {
        continue;
      }

      const stats = await fs.stat(entryPath);
      items.push(buildHandle(entryRelativeKey, entry.name, stats));
      lastKey = entryRelativeKey;

      if (items.length >= maxResults) {
        return;
      }
    }
  }

  await walk(searchRoot, normalizedPrefix ?? '');

  let nextCursor: string | undefined;
  if (items.length > options.limit) {
    const overflow = items.pop();
    nextCursor = overflow?.key ?? lastKey;
  }

  return {
    items,
    nextCursor,
  };
}

export const LocalFileProviderContract: ProviderContract<
  FileProviderRuntime,
  LocalFileCredentials,
  LocalFileSettings
> = {
  id: 'local-filesystem',
  version: '1.0.0',
  domains: ['file'],
  display: {
    label: 'Local filesystem',
    description: 'Store files on the local server filesystem.',
    icon: 'tabler:device-harddrive',
  },
  capabilities: {
    supportsMarkdownConversion: true,
  },
  form: {
    sections: [
      {
        title: 'Storage configuration',
        fields: [
          {
            name: 'basePath',
            label: 'Base directory',
            type: 'text',
            required: true,
            placeholder: '/var/lib/cgate/files',
            description:
              'Absolute directory path used to store files for this provider.',
            scope: 'settings',
          },
          {
            name: 'subdirectory',
            label: 'Subdirectory (optional)',
            type: 'text',
            placeholder: 'files',
            description:
              'Optional subdirectory created inside the base directory before tenant isolation.',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  async createRuntime({ tenantId, providerKey, settings, logger }) {
    const tenantRoot = buildTenantRoot(settings, tenantId, providerKey);
    await ensureDirectory(tenantRoot);

    async function resolvePath(keyInput?: string) {
      const rawKey = keyInput ?? generateKey(undefined);
      const sanitizedKey = sanitizeKey(rawKey);
      const destination = path.join(tenantRoot, sanitizedKey);
      ensureWithin(tenantRoot, destination);
      await ensureDirectory(path.dirname(destination));
      return { destination, key: sanitizedKey };
    }

    async function getMetadataPath(destination: string): Promise<string> {
      return `${destination}.meta.json`;
    }

    async function writeMetadata(
      destination: string,
      metadata: LocalFileMetadata,
    ) {
      const metaPath = await getMetadataPath(destination);
      await fs.writeFile(metaPath, JSON.stringify(metadata), 'utf8');
    }

    async function readMetadata(
      destination: string,
    ): Promise<LocalFileMetadata | undefined> {
      try {
        const metaPath = await getMetadataPath(destination);
        const payload = await fs.readFile(metaPath, 'utf8');
        const parsed = JSON.parse(payload) as LocalFileMetadata;
        return parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
    }

    const runtime: FileProviderRuntime = {
      async uploadFile(input) {
        const { destination, key } = await resolvePath(input.key);
        const data = Buffer.isBuffer(input.data)
          ? input.data
          : Buffer.from(input.data);
        await fs.writeFile(destination, data);
        const stats = await fs.stat(destination);
        const checksum = createHash('sha256').update(data).digest('hex');

        const metadata: LocalFileMetadata = {
          checksum,
          contentType: input.contentType,
          custom: input.metadata,
        };

        await writeMetadata(destination, metadata);

        logger?.info?.('Stored local file', { key, size: stats.size });

        return {
          handle: buildHandle(key, input.name ?? path.basename(key), stats, metadata),
        } satisfies UploadFileResult;
      },

      async downloadFile(key) {
        const sanitizedKey = sanitizeKey(key);
        const filePath = path.join(tenantRoot, sanitizedKey);
        ensureWithin(tenantRoot, filePath);
        const data = await fs.readFile(filePath);
        const stats = await fs.stat(filePath);
        const metadata = await readMetadata(filePath);

        return {
          data,
          size: stats.size,
          contentType: metadata?.contentType,
          metadata: metadata?.custom,
          etag: metadata?.checksum,
        };
      },

      async deleteFile(key) {
        const sanitizedKey = sanitizeKey(key);
        const filePath = path.join(tenantRoot, sanitizedKey);
        ensureWithin(tenantRoot, filePath);
        await fs.rm(filePath, { force: true });
        const metaPath = `${filePath}.meta.json`;
        await fs.rm(metaPath, { force: true });
        logger?.info?.('Deleted local file', { key: sanitizedKey });
      },

      async listFiles(options?: ListFilesOptions) {
        const normalizedOptions: Required<ListFilesOptions> = {
          prefix: options?.prefix,
          cursor: options?.cursor,
          limit: options?.limit ?? 50,
        } as Required<ListFilesOptions>;

        const normalizedPrefix = normalizedOptions.prefix
          ? sanitizeKey(normalizedOptions.prefix)
          : undefined;

        return listFileEntries(tenantRoot, normalizedPrefix, normalizedOptions);
      },

      async getFileMetadata(key) {
        const sanitizedKey = sanitizeKey(key);
        const filePath = path.join(tenantRoot, sanitizedKey);
        ensureWithin(tenantRoot, filePath);
        const stats = await tryStat(filePath);
        if (!stats) {
          return null;
        }
        const metadata = await readMetadata(filePath);
        return buildHandle(
          sanitizedKey,
          path.basename(sanitizedKey),
          stats,
          metadata,
        );
      },
    } satisfies FileProviderRuntime;

    return runtime;
  },
};
