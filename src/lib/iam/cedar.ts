/**
 * Cedar (WASM) loader and typed wrappers.
 *
 * SERVER ONLY. The module is loaded lazily, on first use, through the CommonJS
 * entry `@cedar-policy/cedar-wasm/nodejs` (the ESM entry needs top-level wasm
 * instantiation that Node's loader does not give us under tsx/vitest). Nothing
 * here may be imported from a client component.
 *
 * Why the stateful API: parsing policies per call costs ~4 ms (text) to
 * ~19 ms (JSON records); a preparsed policy set + preparsed schema is looked
 * up by id and a decision costs ~0.1-0.4 ms (see docs of the spike benchmark).
 * The preparse caches live in the WASM instance, i.e. PER PROCESS, so set ids
 * must be stable and are simply overwritten when the content changes.
 *
 * Every wrapper returns plain data and never throws on a Cedar-level failure;
 * only a missing/unloadable WASM binary throws (from `getCedar`).
 */

import type * as CedarTypes from '@cedar-policy/cedar-wasm/nodejs';

export type Cedar = typeof CedarTypes;

export type CedarEntityUid = { type: string; id: string };
export type CedarEntity = CedarTypes.EntityJson;
export type CedarSchemaJson = CedarTypes.SchemaJson<string>;
export type CedarPolicyJson = CedarTypes.PolicyJson;

let cedar: Cedar | null = null;

/** Lazy singleton. Throws only if the WASM package cannot be loaded. */
export function getCedar(): Cedar {
  if (!cedar) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cedar = require('@cedar-policy/cedar-wasm/nodejs') as Cedar;
  }
  return cedar;
}

/** Can the WASM module be loaded here at all (loads it on first use)? */
export function cedarAvailable(): boolean {
  try {
    getCedar();
    return true;
  } catch {
    return false;
  }
}

/** True once the WASM module has been loaded in this process. */
export function isCedarLoaded(): boolean {
  return cedar !== null;
}

export function getCedarVersion(): { sdk: string; language: string } {
  const c = getCedar();
  return { sdk: c.getCedarSDKVersion(), language: c.getCedarLangVersion() };
}

export interface CedarMessage {
  message: string;
  help?: string | null;
  code?: string | null;
  policyId?: string;
  /** Character offsets of the first source location, relative to the text the error is about (a statement for validation errors). */
  start?: number;
  end?: number;
}

function firstLocation(entry: CedarTypes.DetailedError): { start?: number; end?: number } {
  const loc = entry.sourceLocations?.[0];
  return loc && typeof loc.start === 'number' ? { start: loc.start, end: loc.end } : {};
}

function messages(errors: Array<CedarTypes.DetailedError | CedarTypes.ValidationError> | undefined): CedarMessage[] {
  return (errors ?? []).map((entry) => {
    if ('policyId' in entry && 'error' in entry) {
      return {
        policyId: entry.policyId,
        message: entry.error.message,
        help: entry.error.help,
        code: entry.error.code,
        ...firstLocation(entry.error),
      };
    }
    const detailed = entry as CedarTypes.DetailedError;
    return { message: detailed.message, help: detailed.help, code: detailed.code, ...firstLocation(detailed) };
  });
}

// ── preparsed policy sets ────────────────────────────────────────────────

/**
 * Parse a record-form policy set (`{ [policyId]: policyText }`) and cache it
 * in the WASM instance under `setId`. Re-using an id overwrites the old set.
 */
export function preparsePolicySet(
  setId: string,
  policies: Record<string, string>,
): { ok: true } | { ok: false; errors: CedarMessage[] } {
  try {
    const res = getCedar().preparsePolicySet(setId, { staticPolicies: policies });
    return res.type === 'success' ? { ok: true } : { ok: false, errors: messages(res.errors) };
  } catch (error) {
    return { ok: false, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}

export function preparseSchema(
  name: string,
  schema: CedarSchemaJson | string,
): { ok: true } | { ok: false; errors: CedarMessage[] } {
  try {
    const res = getCedar().preparseSchema(name, schema);
    return res.type === 'success' ? { ok: true } : { ok: false, errors: messages(res.errors) };
  } catch (error) {
    return { ok: false, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}

// ── authorization ────────────────────────────────────────────────────────

export interface CedarAuthorizeInput {
  principal: CedarEntityUid;
  action: CedarEntityUid;
  resource: CedarEntityUid;
  context: Record<string, CedarTypes.CedarValueJson>;
  entities: CedarEntity[];
  policySetId: string;
  /** Preparsed schema name; only used together with `validateRequest`. */
  schemaName?: string;
  validateRequest?: boolean;
}

export type CedarDecision =
  | { ok: true; allowed: boolean; reasons: string[]; errors: string[] }
  | { ok: false; errors: string[] };

export function statefulIsAuthorized(input: CedarAuthorizeInput): CedarDecision {
  try {
    const res = getCedar().statefulIsAuthorized({
      principal: input.principal,
      action: input.action,
      resource: input.resource,
      context: input.context,
      entities: input.entities,
      preparsedPolicySetId: input.policySetId,
      preparsedSchemaName: input.validateRequest ? input.schemaName : undefined,
      validateRequest: input.validateRequest ?? false,
    });
    if (res.type !== 'success') {
      return { ok: false, errors: res.errors.map((e) => e.message) };
    }
    return {
      ok: true,
      allowed: res.response.decision === 'allow',
      reasons: res.response.diagnostics.reason,
      errors: res.response.diagnostics.errors.map((e) => `${e.policyId}: ${e.error.message}`),
    };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

// ── validation ───────────────────────────────────────────────────────────

export interface CedarValidation {
  /** false = does not parse OR has validation errors against the schema. */
  valid: boolean;
  /** Parse failures and type/validation errors, both fatal. */
  errors: CedarMessage[];
  warnings: CedarMessage[];
}

/**
 * Validate record-form policies against a schema. Cedar's `validate` answers
 * `type: 'success'` even when `validationErrors` is non-empty, so success is
 * defined here as "parsed AND zero validation errors".
 */
export function validatePolicies(
  schema: CedarSchemaJson | string,
  policies: Record<string, string>,
): CedarValidation {
  try {
    const res = getCedar().validate({
      schema,
      policies: { staticPolicies: policies },
    });
    if (res.type === 'failure') {
      return { valid: false, errors: messages(res.errors), warnings: messages(res.warnings) };
    }
    const errors = messages(res.validationErrors);
    const warnings = [...messages(res.validationWarnings), ...messages(res.otherWarnings)];
    return { valid: errors.length === 0, errors, warnings };
  } catch (error) {
    return {
      valid: false,
      errors: [{ message: error instanceof Error ? error.message : String(error) }],
      warnings: [],
    };
  }
}

/** Validate that a schema itself parses (used in tests and at schema build). */
export function validateSchema(schema: CedarSchemaJson | string): { ok: true } | { ok: false; errors: CedarMessage[] } {
  try {
    const res = getCedar().checkParseSchema(schema);
    return res.type === 'success' ? { ok: true } : { ok: false, errors: messages(res.errors) };
  } catch (error) {
    return { ok: false, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}

// ── policy text helpers ──────────────────────────────────────────────────

/** Split a policy text into its individual statements (templates reported separately). */
export function splitPolicyText(
  text: string,
): { ok: true; policies: string[]; templates: string[] } | { ok: false; errors: CedarMessage[] } {
  try {
    const res = getCedar().policySetTextToParts(text);
    return res.type === 'success'
      ? { ok: true, policies: res.policies, templates: res.policy_templates }
      : { ok: false, errors: messages(res.errors) };
  } catch (error) {
    return { ok: false, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}

/** Annotations (`@key("value")`) of a single policy statement, or null when it does not parse. */
export function policyAnnotations(policyText: string): Record<string, string> | null {
  try {
    const res = getCedar().policyToJson(policyText);
    return res.type === 'success' ? { ...(res.json.annotations ?? {}) } : null;
  } catch {
    return null;
  }
}

export function policyToJson(
  policyText: string,
): { ok: true; json: CedarPolicyJson } | { ok: false; errors: CedarMessage[] } {
  try {
    const res = getCedar().policyToJson(policyText);
    return res.type === 'success' ? { ok: true, json: res.json } : { ok: false, errors: messages(res.errors) };
  } catch (error) {
    return { ok: false, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}
