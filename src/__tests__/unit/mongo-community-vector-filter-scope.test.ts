/**
 * Unit tests — index scoping of filters for the MongoDB community vector store.
 */

import { describe, it, expect } from 'vitest';
import { buildScopedEntriesFilter } from '@/lib/providers/contracts/mongoCommunityVector.contract';

describe('buildScopedEntriesFilter', () => {
  it('returns only the index scope without a filter', () => {
    expect(buildScopedEntriesFilter('idx')).toEqual({ indexId: 'idx' });
  });

  it('keeps the index scope when the filter names indexId', () => {
    const out = buildScopedEntriesFilter('idx', { indexId: { $ne: 'idx' } });
    expect(out).toEqual({ $and: [{ indexId: 'idx' }, { indexId: { $ne: 'idx' } }] });
  });

  it('rejects server-side evaluation operators, including nested ones', () => {
    expect(() => buildScopedEntriesFilter('idx', { $where: 'true' })).toThrow(/not supported/);
    expect(() => buildScopedEntriesFilter('idx', { $or: [{ a: 1 }, { $expr: {} }] })).toThrow(/not supported/);
  });

  it('accepts ordinary metadata filters', () => {
    expect(() => buildScopedEntriesFilter('idx', { 'metadata.k': { $in: ['a'] } })).not.toThrow();
  });
});
