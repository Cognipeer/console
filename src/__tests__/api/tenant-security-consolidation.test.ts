/**
 * Architecture guard — keeps tenant security managed from ONE place.
 *
 * Every per-request auth + tenant-binding + RBAC concern must go through the
 * canonical wrappers in `src/server/api/fastify-utils.ts`
 * (`withApiRequestContext` for session routes, `withClientApiRequestContext` /
 * `withOpenAiApiRequestContext` for token routes). Plugins must NOT hand-roll
 * their own wrappers or call the low-level token primitives directly — that is
 * exactly how clones drifted and silently dropped RBAC on chat/embeddings/
 * ocr-jobs. This test fails loudly if a new clone is introduced.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PLUGINS_DIR = path.join(process.cwd(), 'src/server/api/plugins');

function pluginFiles(): string[] {
  return readdirSync(PLUGINS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(PLUGINS_DIR, f));
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

describe('tenant-security consolidation guards', () => {
  it('no plugin calls the low-level token primitives directly (use a canonical wrapper)', () => {
    const offenders: string[] = [];
    for (const file of pluginFiles()) {
      const src = read(file);
      // Calls (not imports) of the raw token-context resolvers. The canonical
      // wrappers are the only sanctioned callers.
      if (/\brequireApiTokenContext\s*\(/.test(src) || /\brequireApiTokenFromHeader\s*\(/.test(src)) {
        offenders.push(path.basename(file));
      }
    }
    expect(offenders, `These plugins resolve the API token themselves instead of using a canonical wrapper: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no plugin defines its own request-context wrapper (no clones)', () => {
    const offenders: string[] = [];
    const localWrapperDef = /(?:function|const)\s+with[A-Za-z]*(?:Client|OpenAi|Context)[A-Za-z]*\s*(?:<|=|\()/;
    for (const file of pluginFiles()) {
      const src = read(file);
      if (localWrapperDef.test(src)) {
        offenders.push(path.basename(file));
      }
    }
    expect(offenders, `These plugins define a local context wrapper (clone). Move the logic into fastify-utils and pass options instead: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the retired clone names never reappear', () => {
    const banned = ['withOpenAiClientContext', 'withClientContext'];
    const offenders: string[] = [];
    for (const file of pluginFiles()) {
      const src = read(file);
      for (const name of banned) {
        if (src.includes(name)) offenders.push(`${path.basename(file)}:${name}`);
      }
    }
    expect(offenders, `Retired clone wrappers reintroduced: ${offenders.join(', ')}`).toEqual([]);
  });

  it('every client-* plugin authenticates via a canonical token wrapper', () => {
    const missing: string[] = [];
    for (const file of pluginFiles()) {
      const base = path.basename(file);
      if (!base.startsWith('client-')) continue;
      const src = read(file);
      const usesCanonical =
        src.includes('withClientApiRequestContext') || src.includes('withOpenAiApiRequestContext');
      if (!usesCanonical) missing.push(base);
    }
    expect(missing, `These client plugins do not use a canonical token wrapper: ${missing.join(', ')}`).toEqual([]);
  });

  it('the canonical wrappers are all exported from the single fastify-utils module', () => {
    const utils = read(path.join(process.cwd(), 'src/server/api/fastify-utils.ts'));
    expect(utils).toMatch(/export function withApiRequestContext/);
    expect(utils).toMatch(/export function withClientApiRequestContext/);
    expect(utils).toMatch(/export function withOpenAiApiRequestContext/);
  });
});
