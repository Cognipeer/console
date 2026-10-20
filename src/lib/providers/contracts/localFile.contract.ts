import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import slugify from 'slugify';
import { getConfig } from '@/lib/core/config';
import type { Stats } from 'node:fs';
import { ProviderSettingsError } from '../errors';
import { isSafePathSegment, relativeFolderNames } from '../pathSegments';
import type { ProviderContract } from '../types';
import { resolveDownloadCeiling } from './downloadCeiling';
import { hasLoneSurrogate, StorageInvalidKeyError, StorageObjectTooLargeError } from './storageLimits';
import type {
  FileProviderRuntime,
  FileObjectHandle,
  ListFilesOptions,
  ListFilesResult,
  UploadFileResult,
} from '../domains/file';

interface LocalFileSettings {
  basePath?: string;
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

function resolveBasePath(settings: LocalFileSettings): string {
  const raw = settings.basePath?.trim()
    || path.join(getConfig().storage.dataDir, 'files');
  return path.resolve(raw);
}

/**
 * The folders of a subdirectory setting, inside the base directory. Blank is none. Anything that could leave the base
 * directory (an absolute path, a drive, a `..`) is refused, whether it is being saved or comes from a provider that was
 * saved before it was checked.
 */
function subdirectoryFolders(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'string') throw new ProviderSettingsError('subdirectory', 'The subdirectory must be text.');
  const text = raw.trim();
  if (text === '') return [];
  const names = relativeFolderNames(text);
  if (!names) {
    throw new ProviderSettingsError(
      'subdirectory',
      'The subdirectory must be a folder inside the base directory: a relative path with no "..", no leading "/" and no drive letter.',
    );
  }
  return names;
}

/** Whether `relative` (a path from a folder to something) leaves that folder. */
function leavesFolder(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * `<base>[/<subdirectory>]/<organization id>/<provider key>`: the one folder this provider's files live in. It is always
 * below `<base>[/<subdirectory>]/<organization id>`, which is what keeps one organization's files from another's: a
 * provider key that points anywhere else (`..`, `../<another id>/<key>`, `.`) is refused, even for a provider that was
 * saved before keys were checked. The organization id is one name of the path by construction.
 */
function buildTenantRoot(
  settings: LocalFileSettings,
  tenantId: string,
  providerKey: string,
): string {
  if (!isSafePathSegment(tenantId)) {
    throw new Error('The organization id cannot be used as a folder name.');
  }
  const parent = path.join(resolveBasePath(settings), ...subdirectoryFolders(settings.subdirectory), tenantId);
  const root = path.join(parent, providerKey);
  const relative = path.relative(parent, root);
  if (relative === '' || leavesFolder(relative)) {
    throw new ProviderSettingsError('key', 'The provider key cannot be used as a folder name: it must name a folder inside the organization folder (not empty, ".", or a path that goes up with "..").');
  }
  return root;
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

/** The file system refuses a name (a part of the path) that is longer than it takes: 255 bytes on the usual ones. */
function isNameTooLong(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENAMETOOLONG';
}

/** A key whose name the file system cannot hold is a key to change, like any other the store refuses. */
function refuseLongName(error: unknown): never {
  if (isNameTooLong(error)) {
    throw new StorageInvalidKeyError('a part of the name is longer than the file system allows (usually 255 bytes in UTF-8).');
  }
  throw error;
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

  async function walk(currentDir: string, relativePrefix: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    // In the order of the keys themselves (a folder's keys all start with "<name>/"): the cursor below is compared
    // with the keys as text, so the walk has to visit them in that same order.
    const walkKey = (entry: (typeof entries)[number]) => (entry.isDirectory() ? `${entry.name}/` : entry.name);
    const sorted = entries.sort((a, b) => {
      const left = walkKey(a);
      const right = walkKey(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });

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

      if (items.length >= maxResults) {
        return;
      }
    }
  }

  await walk(searchRoot, normalizedPrefix ?? '');

  let nextCursor: string | undefined;
  if (items.length > options.limit) {
    // The extra item only proves there is more. The next page continues AFTER the last one returned, so it starts with it.
    items.pop();
    nextCursor = items[items.length - 1]?.key;
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
    description:
      'Built-in local file storage on the server filesystem. Persistent and zero-configuration.',
    icon: 'tabler:device-harddrive',
  },
  capabilities: {
    supportsMarkdownConversion: true,
    local: true,
    builtin: true,
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
            required: false,
            placeholder: 'Defaults to DATA_DIR/files',
            description:
              'Optional directory path used to store files for this provider. Leave empty to use the built-in data directory (DATA_DIR/files). Only an owner or an admin of a self-hosted deployment can choose one.',
            scope: 'settings',
          },
          {
            name: 'subdirectory',
            label: 'Subdirectory (optional)',
            type: 'text',
            placeholder: 'files',
            description:
              'Optional relative folder (no "..") created inside the base directory before tenant isolation.',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  validateSettings({ settings, isOnPrem, allowHostPaths }) {
    const { basePath, subdirectory } = (settings ?? {}) as Record<string, unknown>;
    if (basePath !== undefined && basePath !== null && typeof basePath !== 'string') {
      throw new ProviderSettingsError('basePath', 'The base directory must be text.');
    }
    // A directory of this server is named by whoever runs the server: never on a shared deployment, and on a
    // self-hosted one only by the people who administer providers.
    if (typeof basePath === 'string' && basePath.trim() !== '') {
      if (!isOnPrem) {
        throw new ProviderSettingsError('basePath', 'A base directory can only be chosen on a self-hosted deployment. Leave it empty to use the built-in data directory.');
      }
      if (allowHostPaths !== true) {
        throw new ProviderSettingsError('basePath', 'Only an owner or an admin can choose the base directory. Leave it empty to use the built-in data directory.');
      }
    }
    subdirectoryFolders(subdirectory);
  },
  // The files sit in a directory of this server: its path is not something to show.
  describeStorageLocation: () => null,
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
        const { destination, key } = await resolvePath(input.key).catch(refuseLongName);
        const data = Buffer.isBuffer(input.data)
          ? input.data
          : Buffer.from(input.data);
        let stats: Awaited<ReturnType<typeof fs.stat>>;
        const metadata: LocalFileMetadata = {
          checksum: createHash('sha256').update(data).digest('hex'),
          contentType: input.contentType,
          custom: input.metadata,
        };
        try {
          await fs.writeFile(destination, data);
          stats = await fs.stat(destination);
          await writeMetadata(destination, metadata);
        } catch (error) {
          // The name fits the file but not its sidecar: nothing of this upload stays.
          if (isNameTooLong(error)) await fs.rm(destination, { force: true }).catch(() => undefined);
          return refuseLongName(error);
        }

        logger?.info?.('Stored local file', { key, size: stats.size });

        return {
          handle: buildHandle(key, input.name ?? path.basename(key), stats, metadata),
        } satisfies UploadFileResult;
      },

      async downloadFile(key, options) {
        const sanitizedKey = sanitizeKey(key);
        const filePath = path.join(tenantRoot, sanitizedKey);
        ensureWithin(tenantRoot, filePath);
        // The size first: an object put here by another tool is not read whole when it is larger than the caller holds.
        const stats = await fs.stat(filePath);
        const ceiling = resolveDownloadCeiling(options);
        if (stats.size > ceiling) throw new StorageObjectTooLargeError(ceiling);
        const data = await fs.readFile(filePath);
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
