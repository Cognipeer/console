/**
 * Unit tests — the dependency-free JSON helpers behind the assertion and
 * tool-call scorers: the extended schema subset (and its loud failure on
 * keywords it cannot honour), own-property lookups and bracket string keys.
 */

import { describe, it, expect } from 'vitest';
import { deepEqual, getByPath, UnsupportedSchemaError, validateSchema } from '@/lib/services/evaluation/scorers/json';
import type { JsonSchema } from '@/lib/services/evaluation/types';

describe('validateSchema — extended subset', () => {
  it('enum and const', () => {
    expect(validateSchema('a', { enum: ['a', 'b'] })).toEqual([]);
    expect(validateSchema('c', { enum: ['a', 'b'] })).toHaveLength(1);
    expect(validateSchema({ x: 1 }, { enum: [{ x: 1 }] })).toEqual([]);
    expect(validateSchema(2, { const: 1 })).toHaveLength(1);
    expect(validateSchema(1, { const: 1 })).toEqual([]);
  });

  it('numeric bounds, inclusive and exclusive', () => {
    const schema: JsonSchema = { type: 'number', minimum: 1, maximum: 5 };
    expect(validateSchema(1, schema)).toEqual([]);
    expect(validateSchema(0, schema)).toHaveLength(1);
    expect(validateSchema(6, schema)).toHaveLength(1);
    expect(validateSchema(1, { exclusiveMinimum: 1 })).toHaveLength(1);
    expect(validateSchema(5, { exclusiveMaximum: 5 })).toHaveLength(1);
    expect(validateSchema(2, { exclusiveMinimum: 1, exclusiveMaximum: 5 })).toEqual([]);
  });

  it('string length and pattern', () => {
    expect(validateSchema('ab', { minLength: 3 })).toHaveLength(1);
    expect(validateSchema('abcd', { maxLength: 3 })).toHaveLength(1);
    expect(validateSchema('abc', { pattern: '^a.c$' })).toEqual([]);
    expect(validateSchema('abd', { pattern: '^a.c$' })).toHaveLength(1);
  });

  it('guards pattern length and input length', () => {
    expect(() => validateSchema('x', { pattern: 'a'.repeat(501) })).toThrow(UnsupportedSchemaError);
    expect(() => validateSchema('x', { pattern: '(' })).toThrow(UnsupportedSchemaError);
    const errors = validateSchema('a'.repeat(10_001), { pattern: '^a+$' });
    expect(errors[0]).toMatch(/too long/);
  });

  it('array size and items', () => {
    expect(validateSchema([1], { minItems: 2 })).toHaveLength(1);
    expect(validateSchema([1, 2, 3], { maxItems: 2 })).toHaveLength(1);
    expect(validateSchema([1, 'x'], { items: { type: 'number' } })).toHaveLength(1);
  });

  it('additionalProperties false and as a schema', () => {
    const closed: JsonSchema = { type: 'object', properties: { a: { type: 'number' } }, additionalProperties: false };
    expect(validateSchema({ a: 1 }, closed)).toEqual([]);
    expect(validateSchema({ a: 1, b: 2 }, closed)).toHaveLength(1);
    const typed: JsonSchema = { type: 'object', additionalProperties: { type: 'string' } };
    expect(validateSchema({ x: 's' }, typed)).toEqual([]);
    expect(validateSchema({ x: 1 }, typed)).toHaveLength(1);
  });

  it('anyOf, oneOf and allOf', () => {
    expect(validateSchema(1, { anyOf: [{ type: 'string' }, { type: 'number' }] })).toEqual([]);
    expect(validateSchema(true, { anyOf: [{ type: 'string' }, { type: 'number' }] })).toHaveLength(1);
    expect(validateSchema(1, { oneOf: [{ type: 'number' }, { minimum: 0 }] })).toHaveLength(1); // matches both
    expect(validateSchema('a', { oneOf: [{ type: 'number' }, { type: 'string' }] })).toEqual([]);
    expect(validateSchema(3, { allOf: [{ type: 'number' }, { minimum: 5 }] })).toHaveLength(1);
  });

  it('required and properties use own-property checks', () => {
    expect(validateSchema({}, { type: 'object', required: ['toString'] })).toHaveLength(1);
    expect(validateSchema({ a: 1 }, { type: 'object', required: ['a'] })).toEqual([]);
  });

  it('accepts annotation keywords', () => {
    expect(validateSchema(1, { type: 'number', description: 'n', title: 'N' })).toEqual([]);
  });

  it('throws for a keyword outside the subset, even in a branch the value never reaches', () => {
    expect(() => validateSchema({}, { type: 'object', patternProperties: {} } as unknown as JsonSchema)).toThrow(/patternProperties/);
    expect(() =>
      validateSchema('x', { anyOf: [{ type: 'string' }, { format: 'email' } as unknown as JsonSchema] }),
    ).toThrow(/format/);
    expect(() =>
      validateSchema({ a: 1 }, { type: 'object', properties: { b: { $ref: '#/x' } as unknown as JsonSchema } }),
    ).toThrow(/\$ref/);
  });
});

describe('getByPath / deepEqual — own properties and bracket keys', () => {
  it('does not find inherited names', () => {
    expect(getByPath({}, 'toString').exists).toBe(false);
    expect(getByPath({}, 'constructor').exists).toBe(false);
    expect(getByPath({ a: {} }, 'a.__proto__').exists).toBe(false);
  });

  it('addresses keys that contain dots with bracket strings', () => {
    const root = { 'a.b': { 'c[0]': 5 } };
    expect(getByPath(root, '["a.b"]')).toEqual({ exists: true, value: { 'c[0]': 5 } });
    expect(getByPath(root, "['a.b'][\"c[0]\"]")).toEqual({ exists: true, value: 5 });
    expect(getByPath(root, '["missing.key"]').exists).toBe(false);
  });

  it('keeps dot and index syntax working', () => {
    expect(getByPath({ data: { items: [{ name: 'x' }] } }, 'data.items[0].name').value).toBe('x');
    expect(getByPath({ a: [1] }, 'a[3]').exists).toBe(false);
  });

  it('deepEqual ignores inherited keys', () => {
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(deepEqual({ toString: 1 }, { valueOf: 1 })).toBe(false);
  });
});
