/**
 * Filesystem operations for the toolbox daemon. All paths are confined to the
 * sandbox root. Mirrors the toolbox contract in @cognipeer/sandbox-protocol.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveInRoot, toDisplayPath } from './paths';
import type {
  FsEntry,
  FsFindMatch,
} from '@cognipeer/sandbox-protocol';

async function toEntry(abs: string): Promise<FsEntry> {
  const stat = await fs.stat(abs);
  return {
    name: path.basename(abs),
    path: toDisplayPath(abs),
    isDir: stat.isDirectory(),
    size: stat.size,
    mode: '0' + (stat.mode & 0o777).toString(8),
    modifiedAt: stat.mtime.toISOString(),
  };
}

export async function listFiles(userPath: string): Promise<FsEntry[]> {
  const abs = resolveInRoot(userPath);
  const names = await fs.readdir(abs);
  const entries: FsEntry[] = [];
  for (const name of names) {
    try {
      entries.push(await toEntry(path.join(abs, name)));
    } catch {
      /* skip unreadable */
    }
  }
  return entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

export async function getInfo(userPath: string): Promise<FsEntry | null> {
  try {
    return await toEntry(resolveInRoot(userPath));
  } catch {
    return null;
  }
}

export async function createFolder(userPath: string, mode?: string): Promise<void> {
  const abs = resolveInRoot(userPath);
  await fs.mkdir(abs, { recursive: true, mode: mode ? parseInt(mode, 8) : 0o755 });
}

export async function deletePath(userPath: string, recursive?: boolean): Promise<void> {
  const abs = resolveInRoot(userPath);
  await fs.rm(abs, { recursive: Boolean(recursive), force: true });
}

export async function movePath(source: string, destination: string): Promise<void> {
  const from = resolveInRoot(source);
  const to = resolveInRoot(destination);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
}

export async function setPermissions(userPath: string, mode?: string): Promise<void> {
  const abs = resolveInRoot(userPath);
  if (mode) await fs.chmod(abs, parseInt(mode, 8));
}

export async function readFileBuffer(userPath: string): Promise<Buffer> {
  return fs.readFile(resolveInRoot(userPath));
}

export async function writeFileBuffer(userPath: string, data: Buffer): Promise<void> {
  const abs = resolveInRoot(userPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data);
}

/** Recursive content search (grep-like) under a directory. */
export async function findInFiles(userPath: string, pattern: string): Promise<FsFindMatch[]> {
  const root = resolveInRoot(userPath);
  const re = new RegExp(pattern);
  const matches: FsFindMatch[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(abs);
      } else if (entry.isFile()) {
        try {
          const content = await fs.readFile(abs, 'utf8');
          content.split('\n').forEach((line, idx) => {
            if (re.test(line)) {
              matches.push({ file: toDisplayPath(abs), line: idx + 1, content: line.slice(0, 500) });
            }
          });
        } catch {
          /* skip binary/unreadable */
        }
        if (matches.length > 1000) return;
      }
    }
  }

  await walk(root);
  return matches;
}

export async function replaceInFiles(
  files: string[],
  pattern: string,
  newValue: string,
): Promise<number> {
  const re = new RegExp(pattern, 'g');
  let replaced = 0;
  for (const file of files) {
    const abs = resolveInRoot(file);
    try {
      const content = await fs.readFile(abs, 'utf8');
      const next = content.replace(re, newValue);
      if (next !== content) {
        await fs.writeFile(abs, next);
        replaced += 1;
      }
    } catch {
      /* skip */
    }
  }
  return replaced;
}
