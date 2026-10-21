/**
 * What MCP and OpenAPI tools declare beyond the structured-output subset:
 * local `$ref`s, `allOf`, `const`, literal enums, bounds and patterns. Each
 * used to fall to `any` (or vanish), so the model saw no contract and the
 * upstream got arguments it rejected.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { jsonSchemaToZod, toolInputSchemaToZod } from '@/lib/services/agents/agentRuntimeConfig';

function shapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  return (schema as z.ZodObject<z.ZodRawShape>).shape;
}

describe('tool input schemas', () => {
  it('follows local $refs into $defs and definitions', () => {
    const schema = toolInputSchemaToZod({
      type: 'object',
      properties: { pet: { $ref: '#/$defs/Pet', description: 'The pet to add' }, owner: { $ref: '#/definitions/Owner' } },
      required: ['pet'],
      $defs: { Pet: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
      definitions: { Owner: { type: 'string', minLength: 2 } },
    });
    expect(schema.safeParse({ pet: { name: 'Rex' }, owner: 'Al' }).success).toBe(true);
    expect(schema.safeParse({ pet: {} }).success).toBe(false);
    expect(schema.safeParse({ pet: { name: 'Rex' }, owner: 'A' }).success).toBe(false);
    expect(shapeOf(schema).pet!.description).toBe('The pet to add');
  });

  it('stops at a $ref that points back at itself instead of looping', () => {
    const schema = toolInputSchemaToZod({
      type: 'object',
      properties: { node: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
    });
    expect(schema.safeParse({ node: { child: { child: { anything: true } } } }).success).toBe(true);
  });

  it('merges allOf members into one object', () => {
    const schema = toolInputSchemaToZod({
      allOf: [
        { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        { properties: { note: { type: 'string' } } },
      ],
    });
    expect(Object.keys(shapeOf(schema))).toEqual(['id', 'note']);
    expect(schema.safeParse({ id: 3, note: 'x' }).success).toBe(true);
    expect(schema.safeParse({ note: 'x' }).success).toBe(false);
  });

  it('reads const, number and boolean enums, and nullable', () => {
    const schema = toolInputSchemaToZod({
      type: 'object',
      properties: {
        kind: { const: 'order' },
        level: { enum: [1, 2, 3] },
        flag: { enum: [true] },
        note: { type: 'string', nullable: true },
      },
      required: ['kind', 'level'],
    });
    expect(schema.safeParse({ kind: 'order', level: 2, flag: true, note: null }).success).toBe(true);
    expect(schema.safeParse({ kind: 'invoice', level: 2 }).success).toBe(false);
    expect(schema.safeParse({ kind: 'order', level: 4 }).success).toBe(false);
  });

  it('keeps patterns, exclusive bounds, multiples and array lengths', () => {
    const schema = toolInputSchemaToZod({
      type: 'object',
      properties: {
        code: { type: 'string', pattern: '^[A-Z]{3}$' },
        ratio: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
        step: { type: 'integer', multipleOf: 5 },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
        broken: { type: 'string', pattern: '(' },
      },
    });
    expect(schema.safeParse({ code: 'ABC', ratio: 0.5, step: 10, tags: ['a'], broken: 'x' }).success).toBe(true);
    expect(schema.safeParse({ code: 'abc' }).success).toBe(false);
    expect(schema.safeParse({ ratio: 1 }).success).toBe(false);
    expect(schema.safeParse({ step: 7 }).success).toBe(false);
    expect(schema.safeParse({ tags: [] }).success).toBe(false);
    expect(schema.safeParse({ tags: ['a', 'b', 'c'] }).success).toBe(false);
  });

  it('reads a node without `type` from its properties or items', () => {
    const schema = toolInputSchemaToZod({
      type: 'object',
      properties: { filter: { properties: { q: { type: 'string' } }, required: ['q'] }, ids: { items: { type: 'integer' } } },
    });
    expect(schema.safeParse({ filter: { q: 'x' }, ids: [1] }).success).toBe(true);
    expect(schema.safeParse({ filter: {} }).success).toBe(false);
    expect(schema.safeParse({ ids: ['a'] }).success).toBe(false);
  });

  it('checks undeclared keys against an additionalProperties schema', () => {
    const schema = toolInputSchemaToZod({
      type: 'object',
      properties: { id: { type: 'string' } },
      additionalProperties: { type: 'number' },
    });
    expect(schema.safeParse({ id: 'a', count: 2 }).success).toBe(true);
    expect(schema.safeParse({ id: 'a', count: 'two' }).success).toBe(false);
  });

  it('says a default in the description and leaves applying it to the upstream', () => {
    const schema = toolInputSchemaToZod({
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Page size.', default: 20 } },
    });
    expect(shapeOf(schema).limit!.description).toBe('Page size. Default: 20.');
    expect(schema.parse({})).toEqual({});
  });

  it('leaves the structured-output conversion as it was for its own subset', () => {
    const strict = jsonSchemaToZod({ type: 'object', properties: { a: { type: 'string' } } }, true);
    expect(strict.safeParse({ a: 'x', b: 1 }).success).toBe(false);
    expect(strict.safeParse({}).success).toBe(false);
  });
});
