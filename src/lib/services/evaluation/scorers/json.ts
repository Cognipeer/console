/**
 * Dependency-free JSON helpers shared by the assertion and LLM-judge scorers:
 * lenient extraction (handles ```json fences / surrounding prose), dot/bracket
 * path resolution, deep equality, and a minimal JSON-schema subset validator.
 */

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
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ok: false, error: 'empty output' };

  const direct = tryParse(trimmed);
  if (direct.ok) return direct;

  const block = findFirstBalancedBlock(trimmed);
  if (block) {
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

/** Find the first balanced object or array literal, respecting strings. */
function findFirstBalancedBlock(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface PathLookup {
  exists: boolean;
  value: unknown;
}

/** Resolve a dot / bracket path (e.g. `data.items[0].name`) against a value. */
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
      if (!(token in obj)) return { exists: false, value: undefined };
      current = obj[token];
    }
  }
  return { exists: true, value: current };
}

function tokenizePath(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  // Split on dots that are not inside brackets, then expand [n] indices.
  const segments = path.split('.').filter((s) => s.length > 0);
  for (const segment of segments) {
    const bracketMatch = segment.match(/^([^[]*)((\[\d+\])*)$/);
    if (!bracketMatch) {
      tokens.push(segment);
      continue;
    }
    const [, name, indices] = bracketMatch;
    if (name) tokens.push(name);
    for (const idx of indices.match(/\[(\d+)\]/g) ?? []) {
      tokens.push(Number(idx.slice(1, -1)));
    }
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
    return ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
  }
  return false;
}

/** Validate a value against the minimal JSON-schema subset; returns errors. */
export function validateSchema(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = [];
  if (schema.type) {
    if (!matchesType(value, schema.type)) {
      errors.push(`${path}: expected ${schema.type}, got ${describeType(value)}`);
      return errors; // type mismatch — deeper checks are meaningless
    }
  }
  if (schema.type === 'object' || (schema.properties && isPlainObject(value))) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required`);
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj) errors.push(...validateSchema(obj[key], sub, `${path}.${key}`));
      }
    }
  }
  if (schema.type === 'array' && schema.items && Array.isArray(value)) {
    value.forEach((item, i) => errors.push(...validateSchema(item, schema.items as JsonSchema, `${path}[${i}]`)));
  }
  return errors;
}

function matchesType(value: unknown, type: NonNullable<JsonSchema['type']>): boolean {
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
