/**
 * Where the local disk driver keeps a provider's files: `<base>[/<subdirectory>]/<organization id>/<provider key>`.
 * The organization folder is what keeps one organization's files from another's, so a provider key (or a subdirectory)
 * that would put the root anywhere else is refused - when it is saved and when a runtime is built from a provider that
 * was saved before it was checked - and only an owner or an admin of a self-hosted deployment can name a base directory.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { LocalFileProviderContract } from '@/lib/providers/contracts/localFile.contract';
import { ProviderSettingsError } from '@/lib/providers/errors';
import type { FileProviderRuntime } from '@/lib/providers/domains/file';
import { isSafePathSegment, relativeFolderNames } from '@/lib/providers/pathSegments';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'local-root-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runtimeOf(over: { tenantId?: string; providerKey?: string; settings?: Record<string, unknown> } = {}): Promise<FileProviderRuntime> {
  return Promise.resolve(LocalFileProviderContract.createRuntime({
    tenantId: over.tenantId ?? 'tenant-1',
    providerKey: over.providerKey ?? 'disk',
    credentials: {},
    settings: { basePath: dir, ...over.settings },
  }));
}

async function failureOf(run: () => Promise<unknown>): Promise<Error & { field?: string }> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to fail');
}

/** Every file and folder below `root`, relative to it. */
function listing(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).sort();
}

describe('the folder of a provider', () => {
  it('is <base>/<organization id>/<provider key>', async () => {
    const runtime = await runtimeOf();
    await runtime.uploadFile({ key: 'docs/a.txt', name: 'a.txt', data: Buffer.from('alpha') });

    expect(readFileSync(path.join(dir, 'tenant-1', 'disk', 'docs', 'a.txt'), 'utf8')).toBe('alpha');
  });

  it('is <base>/<subdirectory>/<organization id>/<provider key> with a subdirectory, however it is spelled', async () => {
    for (const subdirectory of ['archive/2026', ' archive/2026 ', './archive//2026/', 'archive\\2026']) {
      const runtime = await runtimeOf({ providerKey: 'sub', settings: { subdirectory } });
      await runtime.uploadFile({ key: 'a.txt', name: 'a.txt', data: Buffer.from(subdirectory) });
      expect(readFileSync(path.join(dir, 'archive', '2026', 'tenant-1', 'sub', 'a.txt'), 'utf8'), subdirectory).toBe(subdirectory);
    }
  });

  it('is DATA_DIR/files/<organization id>/<provider key> when no base directory is given', async () => {
    const original = getConfigSource();
    setConfigSource({ get: (key: string) => (key === 'DATA_DIR' ? dir : process.env[key]) } as ConfigSource);
    try {
      for (const basePath of [undefined, '', '   ']) {
        const runtime = await LocalFileProviderContract.createRuntime({ tenantId: 'tenant-1', providerKey: 'disk', credentials: {}, settings: { basePath } });
        await runtime.uploadFile({ key: 'a.txt', name: 'a.txt', data: Buffer.from('builtin') });
        expect(readFileSync(path.join(dir, 'files', 'tenant-1', 'disk', 'a.txt'), 'utf8')).toBe('builtin');
      }
    } finally {
      setConfigSource(original);
    }
  });

  it.each([
    ['one level up', '..'],
    ['up and into another organization', '../tenant-2/disk'],
    ['up, down and up again', 'a/../..'],
    ['a path that goes up through its own name', '../tenant-1/../../elsewhere'],
    ['the organization folder itself', '.'],
    ['a folder that cancels itself out', 'a/..'],
    ['nothing', ''],
  ])('refuses a provider key that names %s: it would leave the organization folder', async (_label, providerKey) => {
    mkdirSync(path.join(dir, 'tenant-2', 'disk'), { recursive: true });
    writeFileSync(path.join(dir, 'tenant-2', 'disk', 'theirs.txt'), 'another organization');
    writeFileSync(path.join(dir, 'outside.txt'), 'outside');
    const before = listing(dir);

    const error = await failureOf(() => runtimeOf({ providerKey }));

    expect(error).toBeInstanceOf(ProviderSettingsError);
    expect(error).toMatchObject({ field: 'key', retryable: false });
    expect(error.message).not.toContain(dir);
    // nothing was created, read or touched
    expect(listing(dir)).toEqual(before);
    expect(readFileSync(path.join(dir, 'outside.txt'), 'utf8')).toBe('outside');
  });

  it('keeps a key that goes down into the organization folder working (it was accepted before keys were checked)', async () => {
    const runtime = await runtimeOf({ providerKey: 'team/a' });
    await runtime.uploadFile({ key: 'f.txt', name: 'f.txt', data: Buffer.from('nested') });

    expect(readFileSync(path.join(dir, 'tenant-1', 'team', 'a', 'f.txt'), 'utf8')).toBe('nested');
  });

  it('reads and deletes only inside its own folder, whatever the provider key was once', async () => {
    mkdirSync(path.join(dir, 'tenant-2', 'disk'), { recursive: true });
    writeFileSync(path.join(dir, 'tenant-2', 'disk', 'theirs.txt'), 'another organization');
    writeFileSync(path.join(dir, 'outside.txt'), 'outside');

    // The probe: a key of ".." made the root the base directory itself, and "../tenant-2/disk" another organization's.
    for (const providerKey of ['..', '../tenant-2/disk']) {
      await expect(runtimeOf({ providerKey })).rejects.toBeInstanceOf(ProviderSettingsError);
    }
    const own = await runtimeOf();
    await expect(own.downloadFile('../outside.txt')).rejects.toThrow();
    await expect(own.downloadFile('../../tenant-2/disk/theirs.txt')).rejects.toThrow();
    // a key is read as a name inside the folder (a ".." in it is not a way up), so this deletes nothing of the outside
    await own.deleteFile('../outside.txt');
    await own.deleteFile('../../tenant-2/disk/theirs.txt');

    expect(readFileSync(path.join(dir, 'outside.txt'), 'utf8')).toBe('outside');
    expect(readFileSync(path.join(dir, 'tenant-2', 'disk', 'theirs.txt'), 'utf8')).toBe('another organization');
  });

  it.each([
    '../elsewhere',
    'a/../../elsewhere',
    '../../../../../../../../tmp',
    '/etc',
    '\\windows',
    'C:\\data',
    'c:data',
    '..',
  ])('refuses the subdirectory %j: it would leave the base directory', async (subdirectory) => {
    const before = listing(dir);

    const error = await failureOf(() => runtimeOf({ settings: { subdirectory } }));

    expect(error).toBeInstanceOf(ProviderSettingsError);
    expect(error).toMatchObject({ field: 'subdirectory' });
    expect(listing(dir)).toEqual(before);
  });

  it('refuses a subdirectory that is not text, and an organization id that is not one name', async () => {
    await expect(runtimeOf({ settings: { subdirectory: 5 as never } })).rejects.toMatchObject({ field: 'subdirectory' });
    for (const tenantId of ['..', '../tenant-2', 'a/b', '']) {
      await expect(runtimeOf({ tenantId }), tenantId).rejects.toThrow('The organization id cannot be used as a folder name.');
    }
  });
});

describe('validateSettings', () => {
  const check = (settings: Record<string, unknown>, options: { isOnPrem: boolean; allowHostPaths?: boolean }) =>
    Promise.resolve(LocalFileProviderContract.validateSettings?.({ credentials: {}, settings, ...options }));

  it('asks for no base directory on a shared deployment, even from an administrator', async () => {
    for (const allowHostPaths of [undefined, false, true]) {
      const error = await failureOf(() => check({ basePath: '/var/data' }, { isOnPrem: false, allowHostPaths }));
      expect(error).toBeInstanceOf(ProviderSettingsError);
      expect(error).toMatchObject({ field: 'basePath', message: 'A base directory can only be chosen on a self-hosted deployment. Leave it empty to use the built-in data directory.' });
    }
  });

  it('lets only an owner or an admin name a base directory on a self-hosted deployment', async () => {
    for (const allowHostPaths of [undefined, false]) {
      const error = await failureOf(() => check({ basePath: '/var/data' }, { isOnPrem: true, allowHostPaths }));
      expect(error).toBeInstanceOf(ProviderSettingsError);
      expect(error).toMatchObject({ field: 'basePath', message: 'Only an owner or an admin can choose the base directory. Leave it empty to use the built-in data directory.' });
    }
    await expect(check({ basePath: '/var/data' }, { isOnPrem: true, allowHostPaths: true })).resolves.toBeUndefined();
  });

  it('takes no base directory as the built-in data directory, from everyone, anywhere', async () => {
    for (const settings of [{}, { basePath: '' }, { basePath: '   ' }, { basePath: undefined }, { basePath: null }]) {
      for (const isOnPrem of [false, true]) {
        await expect(check(settings as never, { isOnPrem }), JSON.stringify(settings)).resolves.toBeUndefined();
      }
    }
  });

  it('checks a base directory that is not text', async () => {
    for (const basePath of [5, true, {}, ['/var/data']]) {
      const error = await failureOf(() => check({ basePath }, { isOnPrem: true, allowHostPaths: true }));
      expect(error).toMatchObject({ field: 'basePath', message: 'The base directory must be text.' });
    }
  });

  it('takes a relative subdirectory from anyone, and refuses one that leaves the base directory', async () => {
    for (const subdirectory of [undefined, null, '', '  ', 'files', 'archive/2026', './files', 'a b/c.d']) {
      await expect(check({ subdirectory } as never, { isOnPrem: false }), String(subdirectory)).resolves.toBeUndefined();
    }
    for (const subdirectory of ['..', '../x', 'a/../../x', '/etc', '\\x', 'C:\\x', 'a/\u0000/b', 5]) {
      const error = await failureOf(() => check({ subdirectory } as never, { isOnPrem: true, allowHostPaths: true }));
      expect(error, String(subdirectory)).toBeInstanceOf(ProviderSettingsError);
      expect(error).toMatchObject({ field: 'subdirectory' });
    }
  });
});

describe('path names', () => {
  it('takes any text as a name that is not empty, "." or "..", and holds no separator or control character', () => {
    for (const name of ['disk', 'My Provider', 'a.b', '..hidden', '...', 'ünï', 'k:1', 'a-b_c', ' padded ']) {
      expect(isSafePathSegment(name), name).toBe(true);
    }
  });

  it.each([['empty', ''], ['a dot', '.'], ['two dots', '..'], ['a slash', 'a/b'], ['a backslash', 'a\\b'], ['a NUL', 'a\u0000b'], ['a newline', 'a\nb'], ['a DEL', 'a\u007fb']])('refuses a name that is %s', (_label, name) => {
    expect(isSafePathSegment(name)).toBe(false);
  });

  it('refuses a value that is not text', () => {
    for (const value of [undefined, null, 5, {}, ['a']]) expect(isSafePathSegment(value)).toBe(false);
  });

  it('splits a relative folder into names, and gives up on one that is not inside its folder', () => {
    expect(relativeFolderNames('')).toEqual([]);
    expect(relativeFolderNames('a/b')).toEqual(['a', 'b']);
    expect(relativeFolderNames('./a//b/')).toEqual(['a', 'b']);
    expect(relativeFolderNames('a\\b')).toEqual(['a', 'b']);
    for (const path of ['..', 'a/..', '/a', '\\a', 'C:\\a', 'a/\u0000']) expect(relativeFolderNames(path), path).toBeUndefined();
  });
});
