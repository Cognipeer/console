/**
 * Dependency-free JSON helpers shared by the assertion and LLM-judge scorers:
 * lenient extraction (handles ```json fences / surrounding prose), dot/bracket
 * path resolution, deep equality, and a minimal JSON-schema subset validator.
 */

import { stripInlineReasoning } from '@/lib/shared/inlineReasoning';
import { balancedJsonBlocks } from '@/lib/shared/jsonExtraction';
import type { JsonSchema } from '../types';

export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * Parse JSON from arbitrary model output. Tries a direct parse first, then
 * falls back to the first balanced `{...}` / `[...]` block found in the text
 * (covering fenced code blocks and chatty preambles).
 */
export function extractJson(text: string): ParseResult {
  // Upstreams that leak `<reasoning>…</reasoning>` into `content` would
  // otherwise defeat the direct parse and let the fallback pick a JSON-looking
  // fragment out of the chain-of-thought.
  const trimmed = stripInlineReasoning(text ?? '').trim();
  if (!trimmed) return { ok: false, error: 'empty output' };

  const direct = tryParse(trimmed);
  if (direct.ok) return direct;

  for (const block of balancedJsonBlocks(trimmed)) {
    const parsed = tryParse(block);
    if (parsed.ok) return parsed;
  }
  return { ok: false, error: 'no valid JSON found in output' };
}

function tryParse(s: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}


export interface PathLookup {
  exists: boolean;
  value: unknown;
}

/** Own-property test: `in` also finds inherited names (`toString`, `constructor`, `__proto__`). */
export function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Resolve a dot / bracket path against a value: `data.items[0].name`, and
 * `["a.b"]` / `['a.b']` for keys that contain dots or brackets.
 */
export function getByPath(root: unknown, path: string): PathLookup {
  const tokens = tokenizePath(path);
  let current: unknown = root;
  for (const token of tokens) {
    if (current === null || current === undefined) return { exists: false, value: undefined };
    if (typeof token === 'number') {
      if (!Array.isArray(current) || token < 0 || token >= current.length) {
        return { exists: false, value: undefined };
      }
      current = current[token];
    } else {
      if (typeof current !== 'object' || Array.isArray(current)) {
        return { exists: false, value: undefined };
      }
      const obj = current as Record<string, unknown>;
      if (!hasOwn(obj, token)) return { exists: false, value: undefined };
      current = obj[token];
    }
  }
  return { exists: true, value: current };
}

function tokenizePath(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  let i = 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      const quote = path[i + 1];
      if (quote === '"' || quote === "'") {
        // Quoted key: read to the matching unescaped quote, then expect `]`.
        let key = '';
        let j = i + 2;
        let closed = false;
        while (j < path.length) {
          const c = path[j];
          if (c === '\\' && j + 1 < path.length) {
            key += path[j + 1];
            j += 2;
            continue;
          }
          if (c === quote) {
            closed = true;
            break;
          }
          key += c;
          j += 1;
        }
        if (closed && path[j + 1] === ']') {
          tokens.push(key);
          i = j + 2;
          continue;
        }
        // Malformed: treat the rest literally rather than throwing.
        tokens.push(path.slice(i));
        return tokens;
      }
      const end = path.indexOf(']', i);
      if (end === -1) {
        tokens.push(path.slice(i));
        return tokens;
      }
      const inner = path.slice(i + 1, end);
      tokens.push(/^\d+$/.test(inner) ? Number(inner) : inner);
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j += 1;
    tokens.push(path.slice(i, j));
    i = j;
  }
  return tokens;
}

/** Structural deep-equality good enough for JSON values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}

// ── JSON-schema subset ────────────────────────────────────────────────

/**
 * Thrown when a schema uses a keyword this validator does not implement (or an
 * unusable pattern). It is a problem with the SCHEMA, not with the output being
 * checked, so scorers turn it into a scorer error instead of a failed check.
 */
export class UnsupportedSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSchemaError';
  }
}

const SCHEMA_KEYWORDS = new Set([
  'type', 'required', 'properties', 'items', 'enum', 'const',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems',
  'additionalProperties', 'anyOf', 'oneOf', 'allOf',
  // Annotations: carry no validation semantics.
  'description', 'title', '$schema', '$id', '$comment', 'default', 'examples',
]);

/** Pattern and input guards: a user-supplied regex runs on model output, so bound both. */
const MAX_PATTERN_CHARS = 500;
const MAX_PATTERN_INPUT_CHARS = 10_000;

/** Walk the whole schema once and reject anything that would otherwise be silently ignored. */
function assertSupportedSchema(schema: unknown, path: string): void {
  if (typeof schema === 'boolean') return;
  if (!isPlainObject(schema)) {
    throw new UnsupportedSchemaError(`${path}: schema must be an object`);
  }
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) {
      throw new UnsupportedSchemaError(`${path}: unsupported schema keyword "${key}"`);
    }
  }
  if (typeof schema.pattern === 'string') {
    if (schema.pattern.length > MAX_PATTERN_CHARS) {
      throw new UnsupportedSchemaError(`${path}: pattern longer than ${MAX_PATTERN_CHARS} characters`);
    }
    try {
      new RegExp(schema.pattern);
    } catch (err) {
      throw new UnsupportedSchemaError(`${path}: invalid pattern (${(err as Error).message})`);
    }
  }
  if (Array.isArray(schema.items)) {
    throw new UnsupportedSchemaError(`${path}: unsupported schema keyword "items" (tuple form)`);
  }
  if (schema.items !== undefined) assertSupportedSchema(schema.items, `${path}.items`);
  if (isPlainObject(schema.properties)) {
    for (const [key, sub] of Object.entries(schema.properties)) assertSupportedSchema(sub, `${path}.${key}`);
  }
  if (isPlainObject(schema.additionalProperties)) {
    assertSupportedSchema(schema.additionalProperties, `${path}.additionalProperties`);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = schema[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new UnsupportedSchemaError(`${path}: "${key}" must be an array`);
    list.forEach((sub, i) => assertSupportedSchema(sub, `${path}.${key}[${i}]`));
  }
}

/**
 * Validate a value against the supported JSON-schema subset; returns errors.
 * Throws `UnsupportedSchemaError` when the schema uses a keyword outside the
 * subset (checked over the whole schema, including branches the value never reaches).
 */
export function validateSchema(value: unknown, schema: JsonSchema, path = '$'): string[] {
  assertSupportedSchema(schema, path);
  return validateNode(value, schema, path);
}

function validateNode(value: unknown, schema: JsonSchema | boolean, path: string): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: no value is allowed here`];
  const errors: string[] = [];

  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join(' | ')}, got ${describeType(value)}`);
      return errors; // type mismatch — deeper checks are meaningless
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    errors.push(`${path}: not one of the allowed values`);
  }
  if (hasOwn(schema, 'const') && !deepEqual(schema.const, value)) {
    errors.push(`${path}: does not equal the required constant`);
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: ${value} is above the maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) errors.push(`${path}: ${value} must be greater than ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) errors.push(`${path}: ${value} must be less than ${schema.exclusiveMaximum}`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength} characters`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string') {
      if (value.length > MAX_PATTERN_INPUT_CHARS) {
        errors.push(`${path}: too long (${value.length} characters) to check against a pattern`);
      } else if (!new RegExp(schema.pattern).test(value)) {
        errors.push(`${path}: does not match the pattern`);
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validateNode(item, schema.items as JsonSchema, `${path}[${i}]`)));
    }
  }

  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    }
    const properties = schema.properties ?? {};
    for (const [key, sub] of Object.entries(properties)) {
      if (hasOwn(value, key)) errors.push(...validateNode(value[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      for (const key of Object.keys(value)) {
        if (hasOwn(properties, key)) continue;
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional property not allowed`);
        else errors.push(...validateNode(value[key], schema.additionalProperties, `${path}.${key}`));
      }
    }
  }

  if (schema.allOf) {
    for (const sub of schema.allOf) errors.push(...validateNode(value, sub, path));
  }
  if (schema.anyOf && !schema.anyOf.some((sub) => validateNode(value, sub, path).length === 0)) {
    errors.push(`${path}: does not match any of the allowed schemas`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((sub) => validateNode(value, sub, path).length === 0).length;
    if (matches !== 1) errors.push(`${path}: matches ${matches} of the oneOf schemas, expected exactly 1`);
  }
  return errors;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
