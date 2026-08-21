/**
 * Translators from the canonical vector filter DSL to each store's native
 * filter syntax.
 *
 * Kept in one module so the mapping for every driver is reviewable side by
 * side and unit-testable without a live store. Each translator accepts a
 * parsed `VectorFilterNode` and either returns the native filter or throws a
 * `VectorFilterError` when the store cannot express it — filters are never
 * downgraded or dropped silently.
 */

import type { DocumentType } from '@smithy/types';
import {
  VectorFilterError,
  type VectorFilterComparison,
  type VectorFilterNode,
  type VectorFilterValue,
} from '../domains/vectorFilter';

/* ── MongoDB-style (Atlas $vectorSearch, MongoDB Community) ─────────────── */

function mongoComparison(comparison: VectorFilterComparison, prefix: string): Record<string, unknown> {
  const path = `${prefix}${comparison.field}`;

  switch (comparison.op) {
    case '$in':
    case '$nin':
      return { [path]: { [comparison.op]: comparison.values } };
    case '$exists':
      return { [path]: { $exists: comparison.value } };
    default:
      return { [path]: { [comparison.op]: comparison.value } };
  }
}

/**
 * MongoDB query document. `$not` becomes `$nor` because the DSL negates a
 * whole sub-filter, while Mongo's `$not` only negates a single field operator.
 */
export function toMongoQueryFilter(
  node: VectorFilterNode,
  prefix = 'metadata.',
): Record<string, unknown> {
  switch (node.kind) {
    case 'raw':
      return node.value as Record<string, unknown>;
    case 'and':
      return { $and: node.nodes.map((child) => toMongoQueryFilter(child, prefix)) };
    case 'or':
      return { $or: node.nodes.map((child) => toMongoQueryFilter(child, prefix)) };
    case 'not':
      return { $nor: [toMongoQueryFilter(node.node, prefix)] };
    case 'comparison':
      return mongoComparison(node.comparison, prefix);
  }
}

/* ── Chroma `where` ─────────────────────────────────────────────────────── */

/**
 * Chroma metadata filters. Chroma has no negation of a compound clause and no
 * existence check, so those operators are excluded from its declared
 * capabilities and rejected before translation.
 */
export function toChromaWhere(node: VectorFilterNode): Record<string, unknown> {
  switch (node.kind) {
    case 'raw':
      return node.value as Record<string, unknown>;
    case 'and':
      return { $and: node.nodes.map(toChromaWhere) };
    case 'or':
      return { $or: node.nodes.map(toChromaWhere) };
    case 'not':
      throw new VectorFilterError('Chroma does not support "$not" filters.');
    case 'comparison': {
      const { comparison } = node;
      switch (comparison.op) {
        case '$exists':
          throw new VectorFilterError('Chroma does not support "$exists" filters.');
        case '$in':
        case '$nin':
          return { [comparison.field]: { [comparison.op]: comparison.values } };
        default:
          return { [comparison.field]: { [comparison.op]: comparison.value } };
      }
    }
  }
}

/* ── Elasticsearch bool query ───────────────────────────────────────────── */

/**
 * Elasticsearch indexes map `metadata` as a dynamic object, so string values
 * land as `text` with a `.keyword` sub-field. Exact-match clauses must target
 * that sub-field; numbers and booleans are matched on the field itself.
 */
function esTermField(prefix: string, field: string, values: VectorFilterValue[]): string {
  const path = `${prefix}${field}`;
  const allStrings = values.length > 0 && values.every((value) => typeof value === 'string');
  return allStrings ? `${path}.keyword` : path;
}

export function toElasticsearchFilter(
  node: VectorFilterNode,
  prefix = 'metadata.',
): Record<string, unknown> {
  switch (node.kind) {
    case 'raw':
      return node.value as Record<string, unknown>;
    case 'and':
      return { bool: { filter: node.nodes.map((child) => toElasticsearchFilter(child, prefix)) } };
    case 'or':
      return {
        bool: {
          should: node.nodes.map((child) => toElasticsearchFilter(child, prefix)),
          minimum_should_match: 1,
        },
      };
    case 'not':
      return { bool: { must_not: [toElasticsearchFilter(node.node, prefix)] } };
    case 'comparison': {
      const { comparison } = node;
      const path = `${prefix}${comparison.field}`;

      switch (comparison.op) {
        case '$eq':
          return { term: { [esTermField(prefix, comparison.field, [comparison.value])]: comparison.value } };
        case '$ne':
          return {
            bool: {
              must_not: [
                { term: { [esTermField(prefix, comparison.field, [comparison.value])]: comparison.value } },
              ],
            },
          };
        case '$in':
          return { terms: { [esTermField(prefix, comparison.field, comparison.values)]: comparison.values } };
        case '$nin':
          return {
            bool: {
              must_not: [
                { terms: { [esTermField(prefix, comparison.field, comparison.values)]: comparison.values } },
              ],
            },
          };
        case '$exists':
          return comparison.value
            ? { exists: { field: path } }
            : { bool: { must_not: [{ exists: { field: path } }] } };
        default:
          return { range: { [path]: { [comparison.op.slice(1)]: comparison.value } } };
      }
    }
  }
}

/* ── Milvus boolean expression ──────────────────────────────────────────── */

function milvusLiteral(value: VectorFilterValue): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Milvus filter expression over a JSON column, e.g. `metadata_json["depth"] <= 2`.
 * The previous implementation sent `JSON.stringify(filter)`, which Milvus
 * rejects — this produces the expression language it actually parses.
 */
export function toMilvusExpression(node: VectorFilterNode, jsonField = 'metadata_json'): string {
  switch (node.kind) {
    case 'raw':
      if (typeof node.value !== 'string') {
        throw new VectorFilterError('Milvus "$raw" filters must be an expression string.');
      }
      return node.value;
    case 'and':
      return node.nodes.map((child) => `(${toMilvusExpression(child, jsonField)})`).join(' and ');
    case 'or':
      return node.nodes.map((child) => `(${toMilvusExpression(child, jsonField)})`).join(' or ');
    case 'not':
      return `not (${toMilvusExpression(node.node, jsonField)})`;
    case 'comparison': {
      const { comparison } = node;
      const path = `${jsonField}[${JSON.stringify(comparison.field)}]`;

      switch (comparison.op) {
        case '$eq':
          return `${path} == ${milvusLiteral(comparison.value)}`;
        case '$ne':
          return `${path} != ${milvusLiteral(comparison.value)}`;
        case '$in':
          return `${path} in [${comparison.values.map(milvusLiteral).join(', ')}]`;
        case '$nin':
          return `${path} not in [${comparison.values.map(milvusLiteral).join(', ')}]`;
        case '$exists':
          return comparison.value ? `exists ${path}` : `not (exists ${path})`;
        case '$gt':
          return `${path} > ${milvusLiteral(comparison.value)}`;
        case '$gte':
          return `${path} >= ${milvusLiteral(comparison.value)}`;
        case '$lt':
          return `${path} < ${milvusLiteral(comparison.value)}`;
        default:
          return `${path} <= ${milvusLiteral(comparison.value)}`;
      }
    }
  }
}

/* ── PostgreSQL jsonb ───────────────────────────────────────────────────── */

export interface PostgresFilterFragment {
  sql: string;
  params: unknown[];
}

/**
 * Build a parameterised `WHERE` fragment against a jsonb metadata column.
 * Field names and values are always bound as parameters, never interpolated.
 *
 * @param startIndex 1-based index of the first placeholder this fragment may use.
 */
export function toPostgresCondition(
  node: VectorFilterNode,
  column = 'metadata',
  startIndex = 1,
): PostgresFilterFragment {
  const params: unknown[] = [];
  const nextParam = (value: unknown): string => {
    params.push(value);
    return `$${startIndex + params.length - 1}`;
  };

  const build = (current: VectorFilterNode): string => {
    switch (current.kind) {
      case 'raw':
        throw new VectorFilterError('PostgreSQL vector indexes do not accept "$raw" filters.');
      case 'and':
        return `(${current.nodes.map(build).join(' AND ')})`;
      case 'or':
        return `(${current.nodes.map(build).join(' OR ')})`;
      case 'not':
        return `(NOT ${build(current.node)})`;
      case 'comparison': {
        const { comparison } = current;
        const key = nextParam(comparison.field);
        // Parenthesised so the extraction binds tighter than the comparison.
        const textValue = `(${column} ->> ${key})`;

        switch (comparison.op) {
          case '$exists':
            return comparison.value
              ? `(${column} ? ${key})`
              : `(NOT (${column} ? ${key}))`;
          case '$eq':
            return comparison.value === null
              ? `(${textValue} IS NULL)`
              : `(${textValue} = ${nextParam(String(comparison.value))})`;
          case '$ne':
            return comparison.value === null
              ? `(${textValue} IS NOT NULL)`
              : `(${textValue} IS DISTINCT FROM ${nextParam(String(comparison.value))})`;
          case '$in':
            return `(${textValue} = ANY(${nextParam(comparison.values.map(String))}))`;
          case '$nin':
            return `(${textValue} IS NULL OR NOT (${textValue} = ANY(${nextParam(comparison.values.map(String))})))`;
          default: {
            const operator = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[comparison.op];
            return `((${textValue})::numeric ${operator} ${nextParam(comparison.value)}::numeric)`;
          }
        }
      }
    }
  };

  return { sql: build(node), params };
}

/* ── Azure AI Search OData ──────────────────────────────────────────────── */

/** Flattened `key=value` entries written alongside each Azure document. */
export function toAzureMetadataKeyValues(metadata: Record<string, unknown> | undefined): {
  keys: string[];
  pairs: string[];
} {
  const keys: string[] = [];
  const pairs: string[] = [];

  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value === undefined) continue;
    keys.push(key);
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === null || typeof item === 'object') continue;
      pairs.push(`${key}=${String(item)}`);
    }
  }

  return { keys, pairs };
}

function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function azureKeyValueClause(field: string, value: VectorFilterValue, kvField: string): string {
  if (value === null) {
    throw new VectorFilterError(
      `Azure AI Search cannot filter on null values (field "${field}").`,
    );
  }
  return `${kvField}/any(kv: kv eq ${odataString(`${field}=${String(value)}`)})`;
}

/**
 * OData `$filter` over the flattened metadata collections.
 *
 * Azure stores metadata as one JSON blob, which is not filterable, so indexes
 * created with the filterable schema also carry `metadata_kv` (`key=value`
 * entries) and `metadata_keys`. That supports equality and set membership;
 * range comparisons are not expressible over a string collection and are
 * excluded from the driver's declared capabilities.
 */
export function toAzureODataFilter(
  node: VectorFilterNode,
  kvField = 'metadata_kv',
  keysField = 'metadata_keys',
): string {
  switch (node.kind) {
    case 'raw':
      if (typeof node.value !== 'string') {
        throw new VectorFilterError('Azure AI Search "$raw" filters must be an OData string.');
      }
      return node.value;
    case 'and':
      return node.nodes.map((child) => `(${toAzureODataFilter(child, kvField, keysField)})`).join(' and ');
    case 'or':
      return node.nodes.map((child) => `(${toAzureODataFilter(child, kvField, keysField)})`).join(' or ');
    case 'not':
      return `not (${toAzureODataFilter(node.node, kvField, keysField)})`;
    case 'comparison': {
      const { comparison } = node;

      switch (comparison.op) {
        case '$eq':
          return azureKeyValueClause(comparison.field, comparison.value, kvField);
        case '$ne':
          return `not (${azureKeyValueClause(comparison.field, comparison.value, kvField)})`;
        case '$in':
          return `(${comparison.values
            .map((value) => azureKeyValueClause(comparison.field, value, kvField))
            .join(' or ')})`;
        case '$nin':
          return `not (${comparison.values
            .map((value) => azureKeyValueClause(comparison.field, value, kvField))
            .join(' or ')})`;
        case '$exists': {
          const clause = `${keysField}/any(k: k eq ${odataString(comparison.field)})`;
          return comparison.value ? clause : `not (${clause})`;
        }
        default:
          throw new VectorFilterError(
            `Azure AI Search cannot push down "${comparison.op}" over metadata.`,
          );
      }
    }
  }
}

/* ── AWS S3 Vectors ─────────────────────────────────────────────────────── */

/**
 * S3 Vectors accepts a MongoDB-flavoured filter document over top-level
 * metadata keys, with no negation of compound clauses.
 */
export function toAwsVectorFilter(node: VectorFilterNode): Record<string, unknown> {
  switch (node.kind) {
    case 'raw':
      return node.value as Record<string, unknown>;
    case 'and':
      return { $and: node.nodes.map(toAwsVectorFilter) };
    case 'or':
      return { $or: node.nodes.map(toAwsVectorFilter) };
    case 'not':
      throw new VectorFilterError('AWS S3 Vectors does not support "$not" filters.');
    case 'comparison': {
      const { comparison } = node;
      switch (comparison.op) {
        case '$in':
        case '$nin':
          return { [comparison.field]: { [comparison.op]: comparison.values } };
        case '$exists':
          return { [comparison.field]: { $exists: comparison.value } };
        default:
          return { [comparison.field]: { [comparison.op]: comparison.value } };
      }
    }
  }
}

/** Recursively retype a JSON value as the AWS SDK's `DocumentType`. */
function toAwsDocument(value: unknown): DocumentType | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.map((entry) => toAwsDocument(entry) ?? null);
  }

  if (typeof value === 'object') {
    const result: Record<string, DocumentType> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const converted = toAwsDocument(entry);
      if (converted !== undefined) result[key] = converted;
    }
    return result;
  }

  return String(value);
}

/**
 * The filter document a `QueryVectorsCommand` accepts.
 *
 * The conversion has to recurse: rewriting only the top-level entries turns the
 * `$and` array of a compound filter into `{ "$and": { "$eq": [...] } }`, which
 * S3 Vectors rejects with a ValidationException.
 */
export function toAwsFilterDocument(node: VectorFilterNode): DocumentType | undefined {
  const filter = toAwsVectorFilter(node);
  if (Object.keys(filter).length === 0) return undefined;
  return toAwsDocument(filter);
}
