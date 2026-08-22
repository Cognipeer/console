/**
 * Unit tests — list pagination helpers
 *
 * The point of these is that an absent `limit` yields a bounded page rather
 * than the whole collection, which is the behaviour the endpoints used to have.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  overfetchLimit,
  paginationMeta,
  readPagination,
  takePage,
} from '@/lib/api/pagination';

describe('readPagination', () => {
  it('bounds a request that asks for no limit', () => {
    expect(readPagination({})).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
    expect(readPagination(undefined)).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
  });

  it('honours a caller-supplied window', () => {
    expect(readPagination({ limit: '25', offset: '50' })).toEqual({ limit: 25, offset: 50 });
  });

  it('clamps above the ceiling', () => {
    expect(readPagination({ limit: '100000' }).limit).toBe(MAX_PAGE_LIMIT);
  });

  it('ignores junk rather than returning everything', () => {
    expect(readPagination({ limit: 'all' }).limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(readPagination({ limit: '-5' }).limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(readPagination({ limit: '0' }).limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(readPagination({ offset: '-5' }).offset).toBe(0);
  });

  it('accepts a per-endpoint default and ceiling', () => {
    const page = readPagination({}, { limit: 10, maxLimit: 20 });
    expect(page.limit).toBe(10);
    expect(readPagination({ limit: '999' }, { maxLimit: 20 }).limit).toBe(20);
  });

  it('never lets a default exceed the ceiling', () => {
    expect(readPagination({}, { limit: 900, maxLimit: 50 }).limit).toBe(50);
  });
});

describe('takePage', () => {
  const page = { limit: 3, offset: 0 };

  it('asks for one row past the window', () => {
    expect(overfetchLimit(page)).toBe(4);
  });

  it('reports another page and trims the extra row', () => {
    const { items, hasMore } = takePage([1, 2, 3, 4], page);
    expect(items).toEqual([1, 2, 3]);
    expect(hasMore).toBe(true);
  });

  it('reports the last page unchanged', () => {
    const { items, hasMore } = takePage([1, 2], page);
    expect(items).toEqual([1, 2]);
    expect(hasMore).toBe(false);
  });

  it('handles an exactly-full page', () => {
    const { items, hasMore } = takePage([1, 2, 3], page);
    expect(items).toEqual([1, 2, 3]);
    expect(hasMore).toBe(false);
  });
});

describe('paginationMeta', () => {
  it('derives hasMore from a known total', () => {
    expect(paginationMeta({ limit: 10, offset: 0 }, { total: 25 }))
      .toEqual({ limit: 10, offset: 0, total: 25, hasMore: true });
    expect(paginationMeta({ limit: 10, offset: 20 }, { total: 25 }).hasMore).toBe(false);
  });

  it('omits total when the caller only knows hasMore', () => {
    const meta = paginationMeta({ limit: 10, offset: 0 }, { hasMore: true });
    expect(meta.hasMore).toBe(true);
    expect(meta.total).toBeUndefined();
  });
});
