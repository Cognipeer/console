/**
 * Process-wide schema state: the generated schema for the CURRENT set of
 * resource types, preparsed once for request validation and rebuilt (and
 * re-preparsed under the same name) when the registry gains types — e.g. when
 * the enterprise overlay contributes its resource types after boot.
 */

import { createHash } from 'node:crypto';
import { preparseSchema, validatePolicies, type CedarValidation } from './cedar';
import { listIamResourceTypes } from './resourceTypes';
import { buildSchema, type BuiltSchema } from './schema';

export const PREPARSED_SCHEMA_NAME = 'iam:schema';

let current: (BuiltSchema & { hash: string }) | null = null;
let currentTypesKey = '';
let checkedAt = 0;
let preparsedHash: string | null = null;

/** The registry is re-read at most this often on the hot path. */
const REGISTRY_RECHECK_MS = 1_000;

/**
 * The schema for the registry as it is now. Rebuilt only when the SET of
 * resource types changed (e.g. the enterprise overlay registered its types
 * after boot); a cheap signature of the type list decides, and even that is
 * re-read at most once a second so the decision path stays allocation-light.
 */
export function getIamSchema(): BuiltSchema & { hash: string } {
  const now = Date.now();
  if (current && now - checkedAt < REGISTRY_RECHECK_MS) return current;
  checkedAt = now;
  const types = listIamResourceTypes();
  const typesKey = types.map((t) => `${t.type}:${t.service}`).sort().join(',');
  if (current && typesKey === currentTypesKey) return current;
  const built = buildSchema(types);
  const hash = createHash('sha1').update(built.signature).digest('hex').slice(0, 12);
  current = { ...built, hash };
  currentTypesKey = typesKey;
  return current;
}

/** Ensure the preparsed copy (used by `validateRequest`) matches the current schema. */
export function ensureSchemaPreparsed(): { ok: true } | { ok: false; errors: string[] } {
  const schema = getIamSchema();
  if (preparsedHash === schema.hash) return { ok: true };
  const result = preparseSchema(PREPARSED_SCHEMA_NAME, schema.schema);
  if (!result.ok) return { ok: false, errors: result.errors.map((e) => e.message) };
  preparsedHash = schema.hash;
  return { ok: true };
}

export function validateAgainstSchema(policies: Record<string, string>): CedarValidation {
  return validatePolicies(getIamSchema().schema, policies);
}

export function resetSchemaStateForTests(): void {
  current = null;
  currentTypesKey = '';
  checkedAt = 0;
  preparsedHash = null;
}
