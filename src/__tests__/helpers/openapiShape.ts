/**
 * A small structural check of an API answer against a schema of `openapi.yaml`.
 *
 * `npm run test:openapi` proves the document is well formed and covers the routes; it does not prove an answer
 * looks the way its schema says. A schema that omits a field the route sends (a client reading the document never
 * learns of it) or declares one the route never sends passes it. This helper compares the two directions:
 *
 *   - a value the schema does not allow (wrong type, `null` where the schema is not `nullable`, a value outside
 *     `enum`, a missing `required` key),
 *   - a key the answer carries that the schema does not declare (strict: the document is the contract).
 *
 * It reads the subset of OpenAPI 3.0 the document uses (`$ref`, `allOf`, `oneOf`/`anyOf`, `nullable`, `type`,
 * `enum`, `properties`, `required`, `additionalProperties`, `items`). Nothing else is checked (formats, lengths,
 * patterns): those are the routes' own validation. Ajv is deliberately not used; it is only a transitive dependency.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema = Record<string, any>;

let document: Schema | null = null;

function openapi(): Schema {
  if (!document) document = parse(readFileSync(path.resolve(__dirname, '../../../openapi.yaml'), 'utf8')) as Schema;
  return document;
}

/** A named schema of `components.schemas`. */
export function componentSchema(name: string): Schema {
  const schema = openapi().components?.schemas?.[name];
  if (!schema) throw new Error(`openapi.yaml has no schema ${name}`);
  return schema;
}

function resolve(schema: Schema): Schema {
  if (typeof schema.$ref !== 'string') return schema;
  const match = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref);
  if (!match) throw new Error(`Unsupported $ref ${schema.$ref}`);
  return resolve(componentSchema(match[1]));
}

const typeOf = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    default: return true;
  }
}

/** The property names an object schema declares, through `$ref` and `allOf`. */
function declaredProperties(schema: Schema): Set<string> {
  const resolved = resolve(schema);
  const names = new Set<string>(Object.keys(resolved.properties ?? {}));
  for (const part of resolved.allOf ?? []) for (const name of declaredProperties(part)) names.add(name);
  return names;
}

/** Whether any part of the schema (through `allOf`) closes the object to declared keys only, or opens it. */
function extraKeysAllowed(schema: Schema): Schema | boolean | undefined {
  const resolved = resolve(schema);
  if (resolved.additionalProperties !== undefined) return resolved.additionalProperties;
  for (const part of resolved.allOf ?? []) {
    const nested = extraKeysAllowed(part);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** `extraKeys`: whether this level may flag keys the schema does not declare (off for one part of an `allOf`). */
function check(value: unknown, input: Schema, at: string, strict: boolean, extraKeys = true): string[] {
  const schema = resolve(input);
  if (value === null) {
    return schema.nullable === true || (schema.enum && schema.enum.includes(null)) ? [] : [`${at}: null, but the schema does not allow null`];
  }
  const branches: Schema[] | undefined = schema.oneOf ?? schema.anyOf;
  if (branches) {
    const results = branches.map((branch) => check(value, branch, at, strict, extraKeys));
    return results.some((problems) => problems.length === 0) ? [] : results[0];
  }
  const problems: string[] = [];
  if (schema.type && !matchesType(value, schema.type)) {
    return [`${at}: expected ${schema.type}, got ${typeOf(value)}`];
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  for (const part of schema.allOf ?? []) {
    // A part of an allOf sees the keys of the other parts too, so the extra-key check runs once, on the union.
    problems.push(...check(value, part, at, strict, false));
  }
  if (matchesType(value, 'object') && (schema.properties || schema.allOf || schema.required)) {
    const record = value as Record<string, unknown>;
    const declared = declaredProperties(schema);
    for (const key of schema.required ?? []) if (!(key in record)) problems.push(`${at}.${key}: required, but missing`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) problems.push(...check(record[key], child as Schema, `${at}.${key}`, strict));
    }
    const extra = extraKeysAllowed(schema);
    for (const key of Object.keys(record)) {
      if (declared.has(key)) continue;
      if (extra && typeof extra === 'object') problems.push(...check(record[key], extra, `${at}.${key}`, strict));
      else if (strict && extraKeys && extra !== true && declared.size > 0) problems.push(`${at}.${key}: not declared by the schema`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => problems.push(...check(item, schema.items, `${at}[${index}]`, strict)));
  }
  return problems;
}

/**
 * What differs between an answer and a schema of `components.schemas` (an empty list when it fits). `strict`
 * (default) also flags keys the schema does not declare.
 */
export function shapeProblems(value: unknown, schemaName: string, options: { strict?: boolean } = {}): string[] {
  return check(value, componentSchema(schemaName), '$', options.strict !== false);
}
