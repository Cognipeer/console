/**
 * Unit tests — canonical vector filter DSL.
 *
 * Covers parsing/validation, capability enforcement (a filter a driver cannot
 * push down must fail rather than be dropped), and the in-memory evaluator used
 * by the scan-based stores.
 */

import { describe, it, expect } from 'vitest';
import {
  BASE_FILTER_OPERATORS,
  FULL_FILTER_OPERATORS,
  VectorFilterError,
  andFilters,
  assertFilterSupported,
  collectFilterFields,
  collectFilterOperators,
  isSystemGuardFilter,
  matchesFilter,
  parseVectorFilter,
  type VectorFilterNode,
} from '@/lib/providers/domains/vectorFilter';

function parse(filter: unknown): VectorFilterNode {
  const node = parseVectorFilter(filter);
  if (!node) throw new Error('expected a parsed filter');
  return node;
}

describe('parseVectorFilter', () => {
  it('treats absent and empty filters as no filter', () => {
    expect(parseVectorFilter(undefined)).toBeNull();
    expect(parseVectorFilter(null)).toBeNull();
    expect(parseVectorFilter({})).toBeNull();
    expect(parseVectorFilter({ source: undefined })).toBeNull();
  });

  it('reads a bare value as equality', () => {
    expect(parse({ source: 'crawler' })).toEqual({
      kind: 'comparison',
      comparison: { op: '$eq', field: 'source', value: 'crawler' },
    });
  });

  it('ANDs multiple fields', () => {
    const node = parse({ source: 'crawler', depth: 2 });
    expect(node.kind).toBe('and');
    expect(collectFilterFields(node)).toEqual(new Set(['source', 'depth']));
  });

  it('parses comparison, membership and existence operators', () => {
    const node = parse({
      depth: { $lte: 3 },
      lang: { $in: ['tr', 'en'] },
      draft: { $exists: false },
    });
    expect(collectFilterOperators(node)).toEqual(new Set(['$and', '$lte', '$in', '$exists']));
  });

  it('parses $and / $or / $not', () => {
    const node = parse({
      $or: [{ source: 'crawler' }, { $not: { depth: { $gt: 5 } } }],
    });
    expect(collectFilterOperators(node)).toEqual(new Set(['$or', '$eq', '$not', '$gt']));
  });

  it('collapses single-element $and / $or', () => {
    expect(parse({ $and: [{ source: 'crawler' }] })).toEqual({
      kind: 'comparison',
      comparison: { op: '$eq', field: 'source', value: 'crawler' },
    });
  });

  it('accepts $raw only as the entire filter', () => {
    expect(parse({ $raw: { term: { x: 1 } } })).toEqual({
      kind: 'raw',
      value: { term: { x: 1 } },
    });
    expect(() => parseVectorFilter({ $raw: {}, source: 'x' })).toThrow(VectorFilterError);
    expect(() => parseVectorFilter({ $or: [{ $raw: {} }, { a: 1 }] })).toThrow(VectorFilterError);
  });

  it('rejects malformed filters with actionable messages', () => {
    expect(() => parseVectorFilter({ tag: ['a', 'b'] })).toThrow(/\$in/);
    expect(() => parseVectorFilter({ depth: { $gt: 'high' } })).toThrow(/requires a number/);
    expect(() => parseVectorFilter({ lang: { $in: [] } })).toThrow(/non-empty array/);
    expect(() => parseVectorFilter({ draft: { $exists: 'yes' } })).toThrow(/boolean/);
    expect(() => parseVectorFilter({ source: { $like: 'x' } })).toThrow(/Unsupported operator/);
    expect(() => parseVectorFilter({ $where: 'x' })).toThrow(/Unknown top-level operator/);
    expect(() => parseVectorFilter('source=crawler')).toThrow(/must be an object/);
    expect(() => parseVectorFilter({ meta: { nested: { a: 1 } } })).toThrow(/Unsupported operator/);
  });
});

describe('assertFilterSupported', () => {
  it('passes when every operator is supported', () => {
    expect(() =>
      assertFilterSupported(parse({ source: 'crawler' }), {
        driverId: 'chroma',
        operators: BASE_FILTER_OPERATORS,
      }),
    ).not.toThrow();
  });

  it('rejects a driver that cannot filter at all', () => {
    expect(() =>
      assertFilterSupported(parse({ source: 'x' }), { driverId: 'orama', operators: [] }),
    ).toThrow(/does not support metadata filters/);
  });

  it('names the operators a driver is missing', () => {
    expect(() =>
      assertFilterSupported(parse({ depth: { $gt: 1 } }), {
        driverId: 'azure-ai-search',
        operators: ['$eq', '$in', '$and'],
      }),
    ).toThrow(/\$gt/);
  });

  it('gates $raw behind its own capability', () => {
    const raw = parse({ $raw: { term: {} } });
    expect(() =>
      assertFilterSupported(raw, { driverId: 'postgres', operators: FULL_FILTER_OPERATORS }),
    ).toThrow(/\$raw/);
    expect(() =>
      assertFilterSupported(raw, { driverId: 'chroma', operators: [], supportsRaw: true }),
    ).not.toThrow();
  });
});

describe('andFilters', () => {
  it('returns the other side when one is null', () => {
    const node = parse({ a: 1 });
    expect(andFilters(null, node)).toBe(node);
    expect(andFilters(node, null)).toBe(node);
    expect(andFilters(null, null)).toBeNull();
  });

  it('combines two filters', () => {
    expect(andFilters(parse({ a: 1 }), parse({ b: 2 }))?.kind).toBe('and');
  });
});

describe('matchesFilter', () => {
  const doc = { source: 'crawler', depth: 2, title: 'Home', tags: ['tr', 'news'] };

  it('evaluates equality and inequality', () => {
    expect(matchesFilter(doc, parse({ source: 'crawler' }))).toBe(true);
    expect(matchesFilter(doc, parse({ source: 'upload' }))).toBe(false);
    expect(matchesFilter(doc, parse({ source: { $ne: 'upload' } }))).toBe(true);
  });

  it('evaluates ranges', () => {
    expect(matchesFilter(doc, parse({ depth: { $lte: 2 } }))).toBe(true);
    expect(matchesFilter(doc, parse({ depth: { $gt: 2 } }))).toBe(false);
    // A non-numeric field never satisfies a range comparison.
    expect(matchesFilter(doc, parse({ title: { $gt: 1 } }))).toBe(false);
  });

  it('evaluates membership, including scalars stored as arrays', () => {
    expect(matchesFilter(doc, parse({ source: { $in: ['crawler', 'upload'] } }))).toBe(true);
    expect(matchesFilter(doc, parse({ tags: 'news' }))).toBe(true);
    expect(matchesFilter(doc, parse({ tags: { $nin: ['sports'] } }))).toBe(true);
  });

  it('evaluates existence', () => {
    expect(matchesFilter(doc, parse({ missing: { $exists: false } }))).toBe(true);
    expect(matchesFilter(doc, parse({ title: { $exists: true } }))).toBe(true);
  });

  it('evaluates boolean composition', () => {
    expect(matchesFilter(doc, parse({ $or: [{ source: 'upload' }, { depth: 2 }] }))).toBe(true);
    expect(matchesFilter(doc, parse({ $not: { source: 'crawler' } }))).toBe(false);
    expect(matchesFilter(doc, parse({ source: 'crawler', depth: 3 }))).toBe(false);
  });

  it('treats missing metadata as an empty document', () => {
    expect(matchesFilter(undefined, parse({ source: 'crawler' }))).toBe(false);
    expect(matchesFilter(undefined, parse({ source: { $exists: false } }))).toBe(true);
  });

  it('refuses to evaluate $raw in memory', () => {
    expect(() => matchesFilter(doc, parse({ $raw: { a: 1 } }))).toThrow(VectorFilterError);
  });
});

describe('isSystemGuardFilter', () => {
  it('recognises the isolation guard the service adds by itself', () => {
    expect(isSystemGuardFilter(parse({ _ragModule: 'my-rag' }))).toBe(true);
    expect(isSystemGuardFilter(parse({ _ragModule: { $in: ['a', 'b'] } }))).toBe(true);
  });

  it('does not recognise a filter the caller asked for', () => {
    expect(isSystemGuardFilter(parse({ source: 'crawler' }))).toBe(false);
    // One caller field is enough: the whole filter has to be pushed down.
    expect(isSystemGuardFilter(parse({ $and: [{ _ragModule: 'my-rag' }, { source: 'crawler' }] })))
      .toBe(false);
    expect(isSystemGuardFilter(parse({ $or: [{ _ragModule: 'my-rag' }, { source: 'crawler' }] })))
      .toBe(false);
  });

  it('never treats an opaque $raw filter as a guard', () => {
    expect(isSystemGuardFilter(parse({ $raw: { _ragModule: 'my-rag' } }))).toBe(false);
  });
});
