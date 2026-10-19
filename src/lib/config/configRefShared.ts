/**
 * Config references, the parts both the browser and the server need: how a config item key becomes an
 * environment variable name, and what a write may send for a reference. No server imports here.
 *
 * Stored shapes: `IConfigValueRef` / `IConfigGroupRef` (`@/lib/database/provider/types.extended`).
 * Server side (validation, resolution): `@/lib/services/config/configRefs`.
 */

export type { IConfigGroupRef, IConfigValueRef } from '@/lib/database/provider/types.extended';

/** What the sandbox and agent env accept as a variable name. */
export const CONFIG_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Most groups one agent, template or sandbox can bind. */
export const MAX_CONFIG_GROUP_REFS = 20;

/** Most single-item references in one map (the sandbox env takes at most 100 variables in all). */
export const MAX_CONFIG_VALUE_REFS = 100;

/**
 * The variable name a config item gets when its whole group is bound, and the name the pickers suggest:
 * the generated `cfg-` prefix is dropped, anything that is not a letter or digit becomes `_`, upper case.
 * `cfg-openai-api-key` -> `OPENAI_API_KEY`, `db.password` -> `DB_PASSWORD`, `2fa-seed` -> `_2FA_SEED`.
 * Null when nothing usable is left.
 */
export function envNameFromConfigKey(key: string): string | null {
  const base = key.trim().replace(/^cfg-/i, '');
  let name = base.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  if (!name) return null;
  if (/^[0-9]/.test(name)) name = `_${name}`;
  name = name.slice(0, 128);
  return CONFIG_ENV_NAME_RE.test(name) ? name : null;
}

/**
 * One reference as a write may send it: the stored shape (`configId`, `key`), or only a key to look up in
 * the project (`configKey`, or `key` alone, the form an exported agent carries).
 */
export interface ConfigValueRefInput {
  configId?: string;
  configKey?: string;
  key?: string;
}

/** One group reference as a write may send it: by id, or by key (`groupKey`, or `key` alone). */
export interface ConfigGroupRefInput {
  groupId?: string;
  groupKey?: string;
  key?: string;
}
