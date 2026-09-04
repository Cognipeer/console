/**
 * Minimal zod -> JSON Schema conversion for the browser tool surface.
 *
 * WHY NOT A LIBRARY: `zod-to-json-schema` is present in the tree, but only as
 * something else's transitive dependency. Importing it directly would make a
 * release depend on another package's dependency graph staying the same,
 * which is exactly the kind of breakage that only shows up in a Docker build.
 *
 * WHY NOT HAND-WRITTEN SCHEMAS: that is what the MCP plugin did before, and
 * the two lists drifted — tools existed in one surface and not the other, and
 * descriptions disagreed. One definition, converted, cannot drift.
 *
 * The browser tools are deliberately flat: an object of primitives, enums,
 * arrays and one record. This handles that shape and falls back to a
 * permissive `{}` for anything it does not recognise, which is the right
 * failure mode for a tool description — a client can still call the tool.
 */

import type { z } from 'zod';

interface JsonSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
}

/** Reach zod's internal definition without importing its private types. */
function def(schema: unknown): Record<string, unknown> {
  return ((schema as { _def?: Record<string, unknown> })?._def ?? {});
}

function typeName(schema: unknown): string {
  return String(def(schema).typeName ?? '');
}

function convert(schema: unknown): JsonSchema {
  const d = def(schema);
  const description = typeof d.description === 'string' ? d.description : undefined;
  const withDescription = (out: JsonSchema): JsonSchema =>
    description ? { ...out, description } : out;

  switch (typeName(schema)) {
    case 'ZodString':
      return withDescription({ type: 'string' });
    case 'ZodNumber':
      return withDescription({ type: 'number' });
    case 'ZodBoolean':
      return withDescription({ type: 'boolean' });
    case 'ZodLiteral':
      return withDescription({ const: d.value, type: typeof d.value });
    case 'ZodEnum':
      return withDescription({ type: 'string', enum: (d.values as unknown[]) ?? [] });
    case 'ZodArray':
      return withDescription({ type: 'array', items: convert(d.type) });
    case 'ZodRecord':
      return withDescription({ type: 'object', additionalProperties: convert(d.valueType) });
    case 'ZodUnion':
      return withDescription({ anyOf: ((d.options as unknown[]) ?? []).map(convert) });
    case 'ZodObject':
      return withDescription(convertObject(schema));
    // Wrappers: the JSON Schema equivalent of "optional" is absence from
    // `required`, which the object converter handles, so unwrap and continue.
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return { ...convert(d.innerType), ...(description ? { description } : {}) };
    case 'ZodEffects':
      return { ...convert(d.schema), ...(description ? { description } : {}) };
    default:
      return withDescription({});
  }
}

function isOptional(schema: unknown): boolean {
  const name = typeName(schema);
  if (name === 'ZodOptional' || name === 'ZodDefault') return true;
  if (name === 'ZodEffects') return isOptional(def(schema).schema);
  if (name === 'ZodNullable') return isOptional(def(schema).innerType);
  return false;
}

function convertObject(schema: unknown): JsonSchema {
  const shapeFn = def(schema).shape as (() => Record<string, unknown>) | undefined;
  const shape = typeof shapeFn === 'function' ? shapeFn() : {};
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = convert(value);
    if (!isOptional(value)) required.push(key);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Convert a tool's zod schema into the JSON Schema an MCP client expects.
 *
 * Always returns an object schema: MCP's `inputSchema` is defined as one, and
 * a tool that takes nothing is `{ type: 'object', properties: {} }`.
 */
export function toolInputJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema) return { type: 'object', properties: {} };
  const converted = convert(schema as z.ZodTypeAny);
  if (converted.type !== 'object') return { type: 'object', properties: {} };
  return converted as unknown as Record<string, unknown>;
}
