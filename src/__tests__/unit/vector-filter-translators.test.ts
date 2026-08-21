/**
 * Unit tests — canonical filter → native store syntax.
 *
 * Each translator is checked against the shape its store actually parses, and
 * against the operators it cannot express (which must throw rather than be
 * silently dropped).
 */

import { describe, it, expect } from 'vitest';
import {
  VectorFilterError,
  parseVectorFilter,
  type VectorFilterNode,
} from '@/lib/providers/domains/vectorFilter';
import {
  toAwsVectorFilter,
  toAzureMetadataKeyValues,
  toAzureODataFilter,
  toChromaWhere,
  toElasticsearchFilter,
  toMilvusExpression,
  toMongoQueryFilter,
  toPostgresCondition,
} from '@/lib/providers/contracts/vectorFilterTranslators';

function parse(filter: unknown): VectorFilterNode {
  const node = parseVectorFilter(filter);
  if (!node) throw new Error('expected a parsed filter');
  return node;
}

describe('toMongoQueryFilter', () => {
  it('prefixes fields with the metadata path', () => {
    expect(toMongoQueryFilter(parse({ source: 'crawler' }))).toEqual({
      'metadata.source': { $eq: 'crawler' },
    });
  });

  it('maps membership and ranges', () => {
    expect(toMongoQueryFilter(parse({ lang: { $in: ['tr'] }, depth: { $lte: 2 } }))).toEqual({
      $and: [
        { 'metadata.lang': { $in: ['tr'] } },
        { 'metadata.depth': { $lte: 2 } },
      ],
    });
  });

  it('expresses $not as $nor, since Mongo $not only negates one field operator', () => {
    expect(toMongoQueryFilter(parse({ $not: { source: 'crawler' } }))).toEqual({
      $nor: [{ 'metadata.source': { $eq: 'crawler' } }],
    });
  });

  it('passes $raw through untouched', () => {
    expect(toMongoQueryFilter(parse({ $raw: { 'meta.x': 1 } }))).toEqual({ 'meta.x': 1 });
  });
});

describe('toChromaWhere', () => {
  it('emits Chroma where clauses without a metadata prefix', () => {
    expect(toChromaWhere(parse({ source: 'crawler' }))).toEqual({ source: { $eq: 'crawler' } });
    expect(toChromaWhere(parse({ $or: [{ a: 1 }, { b: { $in: [2] } }] }))).toEqual({
      $or: [{ a: { $eq: 1 } }, { b: { $in: [2] } }],
    });
  });

  it('rejects the operators Chroma has no equivalent for', () => {
    expect(() => toChromaWhere(parse({ $not: { a: 1 } }))).toThrow(VectorFilterError);
    expect(() => toChromaWhere(parse({ a: { $exists: true } }))).toThrow(VectorFilterError);
  });
});

describe('toElasticsearchFilter', () => {
  it('targets the .keyword sub-field for string equality', () => {
    expect(toElasticsearchFilter(parse({ source: 'crawler' }))).toEqual({
      term: { 'metadata.source.keyword': 'crawler' },
    });
    expect(toElasticsearchFilter(parse({ lang: { $in: ['tr', 'en'] } }))).toEqual({
      terms: { 'metadata.lang.keyword': ['tr', 'en'] },
    });
  });

  it('uses the plain field for numbers and booleans', () => {
    expect(toElasticsearchFilter(parse({ depth: 2 }))).toEqual({
      term: { 'metadata.depth': 2 },
    });
    expect(toElasticsearchFilter(parse({ depth: { $lte: 3 } }))).toEqual({
      range: { 'metadata.depth': { lte: 3 } },
    });
  });

  it('maps composition to bool clauses', () => {
    expect(toElasticsearchFilter(parse({ $or: [{ depth: 1 }, { depth: 2 }] }))).toEqual({
      bool: {
        should: [{ term: { 'metadata.depth': 1 } }, { term: { 'metadata.depth': 2 } }],
        minimum_should_match: 1,
      },
    });
    expect(toElasticsearchFilter(parse({ draft: { $exists: false } }))).toEqual({
      bool: { must_not: [{ exists: { field: 'metadata.draft' } }] },
    });
  });
});

describe('toMilvusExpression', () => {
  it('builds a JSON-path expression instead of a JSON blob', () => {
    expect(toMilvusExpression(parse({ source: 'crawler' }))).toBe('metadata_json["source"] == "crawler"');
    expect(toMilvusExpression(parse({ depth: { $lte: 2 } }))).toBe('metadata_json["depth"] <= 2');
    expect(toMilvusExpression(parse({ lang: { $in: ['tr', 'en'] } }))).toBe(
      'metadata_json["lang"] in ["tr", "en"]',
    );
  });

  it('composes clauses', () => {
    expect(toMilvusExpression(parse({ $or: [{ a: 1 }, { b: 2 }] }))).toBe(
      '(metadata_json["a"] == 1) or (metadata_json["b"] == 2)',
    );
    expect(toMilvusExpression(parse({ $not: { a: 1 } }))).toBe('not (metadata_json["a"] == 1)');
    expect(toMilvusExpression(parse({ a: { $exists: true } }))).toBe('exists metadata_json["a"]');
  });

  it('requires $raw to be an expression string', () => {
    expect(() => toMilvusExpression(parse({ $raw: { a: 1 } }))).toThrow(VectorFilterError);
    expect(toMilvusExpression(parse({ $raw: 'id > 0' }))).toBe('id > 0');
  });
});

describe('toPostgresCondition', () => {
  it('binds both field names and values as parameters', () => {
    const { sql, params } = toPostgresCondition(parse({ source: 'crawler' }), 'metadata', 2);
    expect(sql).toBe('((metadata ->> $2) = $3)');
    expect(params).toEqual(['source', 'crawler']);
  });

  it('numbers placeholders continuously across a compound filter', () => {
    const { sql, params } = toPostgresCondition(parse({ source: 'crawler', depth: { $lte: 2 } }), 'metadata', 1);
    expect(sql).toBe('(((metadata ->> $1) = $2) AND (((metadata ->> $3))::numeric <= $4::numeric))');
    expect(params).toEqual(['source', 'crawler', 'depth', 2]);
  });

  it('maps membership and existence to jsonb operators', () => {
    expect(toPostgresCondition(parse({ lang: { $in: ['tr'] } })).sql).toBe('((metadata ->> $1) = ANY($2))');
    expect(toPostgresCondition(parse({ draft: { $exists: true } })).sql).toBe('(metadata ? $1)');
  });

  it('does not accept $raw, which would break parameter binding', () => {
    expect(() => toPostgresCondition(parse({ $raw: { a: 1 } }))).toThrow(VectorFilterError);
  });
});

describe('Azure AI Search', () => {
  it('flattens metadata into key=value pairs and a key list', () => {
    expect(toAzureMetadataKeyValues({ source: 'crawler', depth: 2, tags: ['a', 'b'], skip: null }))
      .toEqual({
        keys: ['source', 'depth', 'tags', 'skip'],
        pairs: ['source=crawler', 'depth=2', 'tags=a', 'tags=b'],
      });
  });

  it('builds OData clauses over the flattened collections', () => {
    expect(toAzureODataFilter(parse({ source: 'crawler' })))
      .toBe("metadata_kv/any(kv: kv eq 'source=crawler')");
    expect(toAzureODataFilter(parse({ lang: { $in: ['tr', 'en'] } })))
      .toBe("(metadata_kv/any(kv: kv eq 'lang=tr') or metadata_kv/any(kv: kv eq 'lang=en'))");
    expect(toAzureODataFilter(parse({ draft: { $exists: true } })))
      .toBe("metadata_keys/any(k: k eq 'draft')");
  });

  it('escapes quotes in values', () => {
    expect(toAzureODataFilter(parse({ title: "O'Brien" })))
      .toBe("metadata_kv/any(kv: kv eq 'title=O''Brien')");
  });

  it('rejects comparisons a string collection cannot express', () => {
    expect(() => toAzureODataFilter(parse({ depth: { $gt: 2 } }))).toThrow(/\$gt/);
    expect(() => toAzureODataFilter(parse({ source: null }))).toThrow(/null/);
  });
});

describe('toAwsVectorFilter', () => {
  it('emits a Mongo-flavoured document over top-level keys', () => {
    expect(toAwsVectorFilter(parse({ source: 'crawler', depth: { $lte: 2 } }))).toEqual({
      $and: [{ source: { $eq: 'crawler' } }, { depth: { $lte: 2 } }],
    });
  });

  it('rejects $not, which S3 Vectors does not support', () => {
    expect(() => toAwsVectorFilter(parse({ $not: { a: 1 } }))).toThrow(VectorFilterError);
  });
});
