import { describe, expect, it } from 'vitest';
import { McpToolInputError } from '@/lib/services/mcp/errors';
import { fitPublicToolArguments } from '@/lib/services/mcp/publicArguments';

const schema = { type: 'object', properties: { q: { type: 'string' }, opts: { type: 'object' } } };

describe('fitPublicToolArguments', () => {
  it('keeps declared keys and drops the rest', () => {
    expect(fitPublicToolArguments(schema, { q: 'a', opts: { x: 1 }, other: 2 }, 100)).toEqual({ q: 'a', opts: { x: 1 } });
  });

  it('leaves the keys alone when the schema declares none or accepts extra ones', () => {
    expect(fitPublicToolArguments(undefined, { any: 1 }, 100)).toEqual({ any: 1 });
    expect(fitPublicToolArguments({ type: 'object' }, { any: 1 }, 100)).toEqual({ any: 1 });
    expect(fitPublicToolArguments({ ...schema, additionalProperties: { type: 'string' } }, { any: 'v' }, 100)).toEqual({ any: 'v' });
  });

  it('refuses a long string inside a declared argument and nesting past the limit', () => {
    expect(() => fitPublicToolArguments(schema, { opts: { list: ['z'.repeat(101)] } }, 100)).toThrow(McpToolInputError);
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i += 1) deep = [deep];
    expect(() => fitPublicToolArguments(schema, { opts: { deep } }, 100)).toThrow(/nested deeper than 32 levels/);
  });

  it('does not count a dropped argument against the limits', () => {
    expect(fitPublicToolArguments(schema, { q: 'ok', other: 'z'.repeat(1000) }, 100)).toEqual({ q: 'ok' });
  });
});
