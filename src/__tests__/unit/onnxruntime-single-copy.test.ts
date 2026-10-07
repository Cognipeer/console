/**
 * One onnxruntime-node for the whole app.
 *
 * `@huggingface/transformers` pins its own onnxruntime-node (1.21) while the
 * app (guardrail, `@cognipeer/pii`, the realtime voice engine) uses the direct
 * dependency (1.30). On Linux both native libraries carry the soname
 * `libonnxruntime.so.1` with versioned symbols, so in a process that runs both
 * (PII NER next to a realtime session) whichever is dlopen'ed first wins and
 * the other fails with "version `VERS_1.xx' not found". The `overrides` entry in
 * package.json points transformers at the app's own copy; this keeps the
 * manifest and the lockfile honest about it, so a dependency bump cannot bring
 * the second copy back unnoticed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface LockfileEntry {
  version?: string;
  dependencies?: Record<string, string>;
}

const root = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  overrides?: Record<string, unknown>;
};
const lockfile = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, LockfileEntry>;
};

describe('onnxruntime-node: a single copy per install', () => {
  it('is a direct dependency and @huggingface/transformers is pointed at it', () => {
    expect(manifest.dependencies['onnxruntime-node']).toBeTruthy();
    expect(manifest.overrides?.['@huggingface/transformers']).toEqual({ 'onnxruntime-node': '$onnxruntime-node' });
  });

  it('the lockfile resolves transformers to the hoisted copy, with no nested onnxruntime of its own', () => {
    const nested = Object.keys(lockfile.packages).filter((key) => /\/node_modules\/onnxruntime-(node|common)$/.test(key)
      && key.startsWith('node_modules/@huggingface/transformers/'));
    expect(nested).toEqual([]);

    const hoisted = lockfile.packages['node_modules/onnxruntime-node'];
    expect(hoisted?.version).toBeTruthy();
    // The root entry and the hoisted package agree on the major.minor line the app is built against.
    expect(manifest.dependencies['onnxruntime-node']).toContain(String(hoisted.version).split('.').slice(0, 2).join('.'));
  });

  it('every onnxruntime-node in the lockfile is that one hoisted copy', () => {
    const copies = Object.keys(lockfile.packages).filter((key) => key === 'node_modules/onnxruntime-node'
      || key.endsWith('/node_modules/onnxruntime-node'));
    expect(copies).toEqual(['node_modules/onnxruntime-node']);
  });
});
