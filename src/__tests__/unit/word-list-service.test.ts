/**
 * Unit tests — Word List Service
 * CSV/text parsing, word normalization, and the cached evaluation-time resolver.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import {
  parseWordListContent,
  normalizeWordArray,
  resolveCustomWordLists,
  invalidateWordListCache,
  WordListValidationError,
  WORD_LIST_LIMITS,
} from '@/lib/services/guardrail/wordListService';

describe('parseWordListContent', () => {
  it('parses newline-separated entries', () => {
    expect(parseWordListContent('alpha\nbeta\ngamma')).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('parses comma/semicolon/tab separated entries', () => {
    expect(parseWordListContent('a,b;c\td')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('strips quotes from CSV cells', () => {
    expect(parseWordListContent('"quoted word",\'single\'')).toEqual(['quoted word', 'single']);
  });

  it('skips blank lines and # comments', () => {
    expect(parseWordListContent('# header\n\nword\n  \n# another')).toEqual(['word']);
  });

  it('deduplicates case-insensitively, keeping the first form', () => {
    expect(parseWordListContent('Yasak\nyasak\nYASAK\nother')).toEqual(['Yasak', 'other']);
  });

  it('keeps multi-word phrases', () => {
    expect(parseWordListContent('rakip marka\nikinci ifade')).toEqual(['rakip marka', 'ikinci ifade']);
  });

  it('rejects entries that are too long', () => {
    const long = 'x'.repeat(WORD_LIST_LIMITS.maxWordLength + 1);
    expect(() => parseWordListContent(long)).toThrow(WordListValidationError);
  });

  it('rejects lists with too many entries', () => {
    const content = Array.from({ length: WORD_LIST_LIMITS.maxWords + 1 }, (_, i) => `w${i}`).join('\n');
    expect(() => parseWordListContent(content)).toThrow(WordListValidationError);
  });
});

describe('normalizeWordArray', () => {
  it('trims, drops empties, dedupes', () => {
    expect(normalizeWordArray([' a ', '', 'A', 'b'])).toEqual(['a', 'b']);
  });

  it('rejects non-arrays and non-strings', () => {
    expect(() => normalizeWordArray('nope')).toThrow(WordListValidationError);
    expect(() => normalizeWordArray([1, 2])).toThrow(WordListValidationError);
  });
});

describe('resolveCustomWordLists', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('resolves lists by key and caches subsequent lookups', async () => {
    const key = `list-${Date.now()}-a`;
    db.findGuardrailWordListByKey.mockResolvedValue({ key, words: ['foo', 'bar'], tenantId: 't', name: 'L', createdBy: 'u' });

    const first = await resolveCustomWordLists('tenant_x', 'proj-1', [key]);
    expect(first).toEqual([{ key, words: ['foo', 'bar'] }]);

    await resolveCustomWordLists('tenant_x', 'proj-1', [key]);
    // Second call served from cache — DB hit only once
    expect(db.findGuardrailWordListByKey).toHaveBeenCalledTimes(1);

    invalidateWordListCache('tenant_x', key);
    await resolveCustomWordLists('tenant_x', 'proj-1', [key]);
    expect(db.findGuardrailWordListByKey).toHaveBeenCalledTimes(2);
  });

  it('resolves unknown keys to empty lists without throwing', async () => {
    const key = `list-${Date.now()}-missing`;
    db.findGuardrailWordListByKey.mockResolvedValue(null);
    const resolved = await resolveCustomWordLists('tenant_x', undefined, [key]);
    expect(resolved).toEqual([{ key, words: [] }]);
  });

  it('falls back to tenant-wide lookup when project-scoped lookup misses', async () => {
    const key = `list-${Date.now()}-fallback`;
    db.findGuardrailWordListByKey
      .mockResolvedValueOnce(null) // project-scoped miss
      .mockResolvedValueOnce({ key, words: ['tenantwide'], tenantId: 't', name: 'L', createdBy: 'u' });

    const resolved = await resolveCustomWordLists('tenant_x', 'proj-1', [key]);
    expect(resolved).toEqual([{ key, words: ['tenantwide'] }]);
  });
});
