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

/**
 * The ONE sanctioned local wrapper, and why it is not a clone.
 *
 * This guard exists because three copies of the auth + tenant-bind + RBAC
 * wrapper once drifted apart and one of them stopped enforcing RBAC. It matches
 * on the NAME, which cannot tell a drifting copy from a different mechanism
 * that happens to be named the same way — so an entry here has to argue its
 * case, not just silence the test.
 *
 * `appgw-data-plane.ts` (EE overlay) does not resolve a console session or an
 * API token at all. `/api/appgw/*` is deliberately registered as a PUBLIC
 * enterprise prefix (`console-ee/overlay/src/enterprise/registry.ts:165`), and
 * `withGatewayRequestContext` binds the gateway's OWN app identity — the
 * documented INV-1 choke point in `aiAppGateway/identity.ts:4`, which is
 * fail-closed at `identity.ts:307-332`. Routing it through the console's
 * session wrapper would be the actual bug.
 *
 * Note this file exists only in the overlay, so the community suite never sees
 * it and only an overlay-applied run goes red. Keep the entry in the COMMUNITY
 * tree regardless: the test is community-owned, and an allowlist that lives in
 * a different tree from its guard is how the pair silently separates.
 */
const SANCTIONED_LOCAL_WRAPPERS = new Set(['appgw-data-plane.ts']);

  it('no plugin defines its own request-context wrapper (no clones)', () => {
    const offenders: string[] = [];
    const localWrapperDef = /(?:function|const)\s+with[A-Za-z]*(?:Client|OpenAi|Context)[A-Za-z]*\s*(?:<|=|\()/;
    for (const file of pluginFiles()) {
      if (SANCTIONED_LOCAL_WRAPPERS.has(path.basename(file))) continue;
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
