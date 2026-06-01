/**
 * Path containment helpers. All filesystem operations are confined to the
 * sandbox root (default /workspace) to prevent traversal outside the volume.
 */

import path from 'node:path';

export const SANDBOX_ROOT = process.env.SANDBOX_ROOT || '/workspace';

/** Resolve a user-supplied path against the sandbox root, rejecting escapes. */
export function resolveInRoot(userPath: string): string {
  const normalized = path.normalize(userPath || '/');
  // Treat the input as relative to the root, whether or not it starts with '/'.
  const rel = normalized.replace(/^[/\\]+/, '');
  const abs = path.resolve(SANDBOX_ROOT, rel);
  if (abs !== SANDBOX_ROOT && !abs.startsWith(SANDBOX_ROOT + path.sep)) {
    throw new Error('path-escapes-root');
  }
  return abs;
}

/** Convert an absolute in-root path back to a root-relative display path. */
export function toDisplayPath(abs: string): string {
  const rel = path.relative(SANDBOX_ROOT, abs);
  return '/' + rel.split(path.sep).join('/');
}
