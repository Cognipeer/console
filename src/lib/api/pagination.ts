/**
 * Query-string pagination for list endpoints.
 *
 * Several collections grow with usage — a Knowledge Engine module's documents,
 * a tenant's batches — and returning them whole meant one request loading an
 * entire collection into memory and onto the wire. Every list endpoint that
 * can grow reads its window through here so the parameters, the ceiling and
 * the reported shape stay identical across the API.
 */

/** Rows returned when the caller does not ask for a specific page. */
export const DEFAULT_PAGE_LIMIT = 100;

/** Hard ceiling on `limit`, whatever the caller asks for. */
export const MAX_PAGE_LIMIT = 500;

export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface PaginationMeta extends PaginationParams {
  /**
   * Total rows matching the query, ignoring the window. Present only where the
   * collection has a count that filters identically to its list — a total
   * derived from different filters is worse than no total at all.
   */
  total?: number;
  /** Whether another page follows this one. */
  hasMore: boolean;
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const floored = Math.floor(parsed);
  return floored >= 0 ? floored : undefined;
}

/**
 * Read `limit` and `offset` from a query object, clamped to sane bounds.
 *
 * An absent or unparseable `limit` yields DEFAULT_PAGE_LIMIT rather than "all
 * rows": an unbounded default is the behaviour this exists to remove.
 */
export function readPagination(
  query: unknown,
  defaults: { limit?: number; maxLimit?: number } = {},
): PaginationParams {
  const source = (query ?? {}) as Record<string, unknown>;
  const maxLimit = defaults.maxLimit ?? MAX_PAGE_LIMIT;
  const fallback = Math.min(defaults.limit ?? DEFAULT_PAGE_LIMIT, maxLimit);

  const requested = toPositiveInt(source.limit);
  const limit = requested === undefined || requested === 0
    ? fallback
    : Math.min(requested, maxLimit);

  return { limit, offset: toPositiveInt(source.offset) ?? 0 };
}

/**
 * Build the metadata block returned alongside a page of rows.
 *
 * Pass `total` when the collection has a matching count query; otherwise pass
 * `hasMore` from `takePage`, which learns it without a second query.
 */
export function paginationMeta(
  params: PaginationParams,
  source: { total: number } | { hasMore: boolean },
): PaginationMeta {
  if ('total' in source) {
    return {
      ...params,
      total: source.total,
      hasMore: params.offset + params.limit < source.total,
    };
  }
  return { ...params, hasMore: source.hasMore };
}

/**
 * Read one row past the window to learn whether another page exists.
 *
 * Cheaper than a companion `COUNT(*)`, and immune to the filters of a count
 * query drifting away from those of the list it describes.
 */
export function overfetchLimit(params: PaginationParams): number {
  return params.limit + 1;
}

/** Trim an over-fetched result set back to the page, reporting what it saw. */
export function takePage<T>(rows: T[], params: PaginationParams): {
  items: T[];
  hasMore: boolean;
} {
  const hasMore = rows.length > params.limit;
  return { items: hasMore ? rows.slice(0, params.limit) : rows, hasMore };
}
