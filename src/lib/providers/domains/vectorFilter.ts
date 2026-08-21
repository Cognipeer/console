/**
 * Canonical vector metadata filter DSL.
 *
 * Every vector provider used to receive `query.filter` verbatim, so the same
 * payload meant different things per driver (Chroma `where`, Elasticsearch
 * DSL, Atlas `$vectorSearch.filter`) and most drivers ignored it outright.
 * This module defines one provider-neutral filter language, parsed and
 * validated once in the service layer, then translated by each contract into
 * its native syntax.
 *
 * Shape (MongoDB-flavoured, the de-facto standard across vector stores):
 *
 *   { source: 'crawler' }                        // implicit $eq
 *   { depth: { $lte: 2 }, lang: { $in: ['tr'] } } // operators, ANDed
 *   { $or: [{ a: 1 }, { b: { $exists: false } }] }
 *   { $raw: { ...provider native... } }           // escape hatch
 *
 * Filters are never applied in memory by the service layer: a provider either
 * pushes the filter down to the store or rejects it, so `topK` always means
 * "topK matching documents" instead of "topK candidates, some of which match".
 */

/** Leaf values accepted by comparison operators. */
export type VectorFilterValue = string | number | boolean | null;

export type VectorFilterOperator =
  | '$eq'
  | '$ne'
  | '$gt'
  | '$gte'
  | '$lt'
  | '$lte'
  | '$in'
  | '$nin'
  | '$exists'
  | '$and'
  | '$or'
  | '$not'
  | '$raw';

/** User-supplied filter document, before parsing. */
export type VectorFilter = Record<string, unknown>;

export type VectorFilterComparison =
  | { op: '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte'; field: string; value: VectorFilterValue }
  | { op: '$in' | '$nin'; field: string; values: VectorFilterValue[] }
  | { op: '$exists'; field: string; value: boolean };

/** Parsed, validated filter tree handed to provider translators. */
export type VectorFilterNode =
  | { kind: 'and'; nodes: VectorFilterNode[] }
  | { kind: 'or'; nodes: VectorFilterNode[] }
  | { kind: 'not'; node: VectorFilterNode }
  | { kind: 'comparison'; comparison: VectorFilterComparison }
  | { kind: 'raw'; value: unknown };

/** Raised for malformed filters and for operators a provider cannot honour. */
export class VectorFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorFilterError';
  }
}

const COMPARISON_OPERATORS = new Set([
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$exists',
]);

const ORDERING_OPERATORS = new Set(['$gt', '$gte', '$lt', '$lte']);

/** Operators every provider that supports filtering at all must handle. */
export const BASE_FILTER_OPERATORS: VectorFilterOperator[] = [
  '$eq',
  '$ne',
  '$in',
  '$nin',
  '$and',
  '$or',
  '$not',
];

/** Base set plus range comparisons — for stores with typed metadata queries. */
export const FULL_FILTER_OPERATORS: VectorFilterOperator[] = [
  ...BASE_FILTER_OPERATORS,
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$exists',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilterValue(value: unknown): value is VectorFilterValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'object' && value !== null) return Array.isArray(value) ? 'array' : 'object';
  return typeof value;
}

function parseFieldValue(field: string, value: unknown): VectorFilterNode {
  // Bare value → equality.
  if (!isPlainObject(value)) {
    if (Array.isArray(value)) {
      throw new VectorFilterError(
        `Filter field "${field}" cannot be an array. Use { "${field}": { "$in": [...] } }.`,
      );
    }
    if (!isFilterValue(value)) {
      throw new VectorFilterError(
        `Filter field "${field}" has unsupported value type "${describeValue(value)}".`,
      );
    }
    return { kind: 'comparison', comparison: { op: '$eq', field, value } };
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new VectorFilterError(`Filter field "${field}" must declare at least one operator.`);
  }

  const nodes: VectorFilterNode[] = entries.map(([op, operand]) => {
    if (!COMPARISON_OPERATORS.has(op)) {
      throw new VectorFilterError(
        `Unsupported operator "${op}" on filter field "${field}". Supported: ${[...COMPARISON_OPERATORS].join(', ')}.`,
      );
    }

    if (op === '$in' || op === '$nin') {
      if (!Array.isArray(operand) || operand.length === 0) {
        throw new VectorFilterError(`Operator "${op}" on "${field}" requires a non-empty array.`);
      }
      const values = operand.map((item) => {
        if (!isFilterValue(item)) {
          throw new VectorFilterError(
            `Operator "${op}" on "${field}" accepts only primitive values, got "${describeValue(item)}".`,
          );
        }
        return item;
      });
      return { kind: 'comparison', comparison: { op, field, values } };
    }

    if (op === '$exists') {
      if (typeof operand !== 'boolean') {
        throw new VectorFilterError(`Operator "$exists" on "${field}" requires a boolean.`);
      }
      return { kind: 'comparison', comparison: { op, field, value: operand } };
    }

    if (!isFilterValue(operand)) {
      throw new VectorFilterError(
        `Operator "${op}" on "${field}" accepts only primitive values, got "${describeValue(operand)}".`,
      );
    }

    if (ORDERING_OPERATORS.has(op) && typeof operand !== 'number') {
      throw new VectorFilterError(`Operator "${op}" on "${field}" requires a number.`);
    }

    return {
      kind: 'comparison',
      comparison: { op: op as '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte', field, value: operand },
    };
  });

  return nodes.length === 1 ? nodes[0] : { kind: 'and', nodes };
}

function parseNode(input: unknown, path: string): VectorFilterNode | null {
  if (!isPlainObject(input)) {
    throw new VectorFilterError(`Filter ${path} must be an object, got "${describeValue(input)}".`);
  }

  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return null;

  if (entries.some(([key]) => key === '$raw')) {
    if (entries.length > 1) {
      throw new VectorFilterError(
        '"$raw" cannot be combined with other filter keys — it replaces the whole filter.',
      );
    }
    if (path !== 'filter') {
      throw new VectorFilterError('"$raw" is only allowed at the top level of a filter.');
    }
    const [, raw] = entries[0];
    if (raw === null || raw === undefined) {
      throw new VectorFilterError('"$raw" requires a provider-native filter value.');
    }
    return { kind: 'raw', value: raw };
  }

  const nodes: VectorFilterNode[] = [];

  for (const [key, value] of entries) {
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(value) || value.length === 0) {
        throw new VectorFilterError(`Operator "${key}" requires a non-empty array of filters.`);
      }
      const children = value
        .map((child, index) => parseNode(child, `${path}.${key}[${index}]`))
        .filter((child): child is VectorFilterNode => child !== null);
      if (children.length === 0) {
        throw new VectorFilterError(`Operator "${key}" requires at least one non-empty filter.`);
      }
      nodes.push(children.length === 1 ? children[0] : { kind: key === '$and' ? 'and' : 'or', nodes: children });
      continue;
    }

    if (key === '$not') {
      const child = parseNode(value, `${path}.$not`);
      if (!child) {
        throw new VectorFilterError('Operator "$not" requires a non-empty filter.');
      }
      nodes.push({ kind: 'not', node: child });
      continue;
    }

    if (key.startsWith('$')) {
      throw new VectorFilterError(
        `Unknown top-level operator "${key}". Supported: $and, $or, $not, $raw.`,
      );
    }

    nodes.push(parseFieldValue(key, value));
  }

  if (nodes.length === 0) return null;
  return nodes.length === 1 ? nodes[0] : { kind: 'and', nodes };
}

/**
 * Validate and normalize a user-supplied filter document.
 * Returns null when the filter is absent or empty (no filtering requested).
 */
export function parseVectorFilter(input: unknown): VectorFilterNode | null {
  if (input === undefined || input === null) return null;
  return parseNode(input, 'filter');
}

/** Every operator used by a parsed filter, for capability checks and logging. */
export function collectFilterOperators(node: VectorFilterNode): Set<VectorFilterOperator> {
  const found = new Set<VectorFilterOperator>();

  const walk = (current: VectorFilterNode): void => {
    switch (current.kind) {
      case 'and':
        found.add('$and');
        current.nodes.forEach(walk);
        break;
      case 'or':
        found.add('$or');
        current.nodes.forEach(walk);
        break;
      case 'not':
        found.add('$not');
        walk(current.node);
        break;
      case 'raw':
        found.add('$raw');
        break;
      case 'comparison':
        found.add(current.comparison.op);
        break;
    }
  };

  walk(node);
  return found;
}

/** Metadata field names referenced by a parsed filter. */
export function collectFilterFields(node: VectorFilterNode): Set<string> {
  const fields = new Set<string>();

  const walk = (current: VectorFilterNode): void => {
    switch (current.kind) {
      case 'and':
      case 'or':
        current.nodes.forEach(walk);
        break;
      case 'not':
        walk(current.node);
        break;
      case 'comparison':
        fields.add(current.comparison.field);
        break;
      case 'raw':
        break;
    }
  };

  walk(node);
  return fields;
}

export interface FilterSupport {
  /** Driver id, used to name the provider in error messages. */
  driverId: string;
  /** Operators the driver can push down. Empty means "no filtering at all". */
  operators: readonly VectorFilterOperator[];
  /** Whether the driver accepts a `$raw` provider-native filter. */
  supportsRaw?: boolean;
}

/**
 * Reject a filter the provider cannot push down. Filters are never silently
 * dropped or applied in memory — a caller who asks for a filter that cannot
 * run gets an error instead of results that quietly ignore it.
 */
export function assertFilterSupported(node: VectorFilterNode, support: FilterSupport): void {
  const used = collectFilterOperators(node);

  if (used.has('$raw')) {
    if (!support.supportsRaw) {
      throw new VectorFilterError(
        `The "${support.driverId}" vector provider does not accept "$raw" filters.`,
      );
    }
    return;
  }

  if (support.operators.length === 0) {
    throw new VectorFilterError(
      `The "${support.driverId}" vector provider does not support metadata filters.`,
    );
  }

  const allowed = new Set(support.operators);
  const unsupported = [...used].filter((op) => !allowed.has(op));

  if (unsupported.length > 0) {
    throw new VectorFilterError(
      `The "${support.driverId}" vector provider does not support ${unsupported.join(', ')}. `
      + `Supported operators: ${support.operators.join(', ')}.`,
    );
  }
}

/** Combine two filters with AND. Either side may be null. */
export function andFilters(
  left: VectorFilterNode | null,
  right: VectorFilterNode | null,
): VectorFilterNode | null {
  if (!left) return right;
  if (!right) return left;
  return { kind: 'and', nodes: [left, right] };
}

function compareValues(actual: unknown, expected: VectorFilterValue): number | null {
  if (typeof actual === 'number' && typeof expected === 'number') return actual - expected;
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual < expected ? -1 : actual > expected ? 1 : 0;
  }
  return null;
}

function valuesEqual(actual: unknown, expected: VectorFilterValue): boolean {
  if (actual === expected) return true;
  // Metadata round-tripped through JSON can widen a scalar into a one-item
  // array; treat membership as equality so `{ tag: 'x' }` matches `['x']`.
  if (Array.isArray(actual)) return actual.some((item) => item === expected);
  return false;
}

function evaluateComparison(
  metadata: Record<string, unknown>,
  comparison: VectorFilterComparison,
): boolean {
  const actual = metadata[comparison.field];

  switch (comparison.op) {
    case '$exists':
      return (actual !== undefined) === comparison.value;
    case '$eq':
      return valuesEqual(actual, comparison.value);
    case '$ne':
      return !valuesEqual(actual, comparison.value);
    case '$in':
      return comparison.values.some((value) => valuesEqual(actual, value));
    case '$nin':
      return !comparison.values.some((value) => valuesEqual(actual, value));
    default: {
      const diff = compareValues(actual, comparison.value);
      if (diff === null) return false;
      if (comparison.op === '$gt') return diff > 0;
      if (comparison.op === '$gte') return diff >= 0;
      if (comparison.op === '$lt') return diff < 0;
      return diff <= 0;
    }
  }
}

/**
 * Evaluate a parsed filter against a metadata document.
 *
 * This is for stores that already scan every candidate row (SQLite, MongoDB
 * Community, the in-memory dummy provider): applying the predicate during that
 * scan is a genuine push-down — it runs before top-K selection, so the caller
 * still gets `topK` matching results. It is deliberately not used as a
 * post-query fallback for stores that cannot filter natively.
 */
export function matchesFilter(
  metadata: Record<string, unknown> | undefined | null,
  node: VectorFilterNode,
): boolean {
  const doc = metadata ?? {};

  switch (node.kind) {
    case 'and':
      return node.nodes.every((child) => matchesFilter(doc, child));
    case 'or':
      return node.nodes.some((child) => matchesFilter(doc, child));
    case 'not':
      return !matchesFilter(doc, node.node);
    case 'comparison':
      return evaluateComparison(doc, node.comparison);
    case 'raw':
      throw new VectorFilterError('"$raw" filters cannot be evaluated in memory.');
  }
}
