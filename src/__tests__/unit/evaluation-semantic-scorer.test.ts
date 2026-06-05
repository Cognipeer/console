/**
 * Unit tests — semantic (vector) scorer.
 * Covers cosine math, the expected.reference requirement, threshold pass/fail,
 * and graceful handling of embedding-provider errors.
 */

import { describe, it, expect, vi } from 'vitest';
import { cosineSimilarity, scoreSemantic } from '@/lib/services/evaluation/scorers/semanticScorer';
import type { DatasetItem, EmbedInvoker, SemanticScorerConfig, TargetOutput } from '@/lib/services/evaluation/types';

const CONFIG: SemanticScorerConfig = { type: 'semantic' };
const item = (reference?: string): DatasetItem => ({
  id: 'q1',
  input: [{ role: 'user', content: 'q' }],
  expected: reference ? { reference } : undefined,
});
const output = (text: string): TargetOutput => ({ text });

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('returns 0 for empty or mismatched-length vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
  });
});

describe('scoreSemantic', () => {
  it('errors (does not throw) when the item has no expected.reference', async () => {
    const invokeEmbed: EmbedInvoker = vi.fn();
    const result = await scoreSemantic(item(undefined), output('four'), CONFIG, invokeEmbed);
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/expected\.reference/);
    expect(invokeEmbed).not.toHaveBeenCalled();
  });

  it('passes when similarity meets the threshold', async () => {
    const invokeEmbed: EmbedInvoker = vi.fn(async () => [[1, 0, 0], [1, 0, 0]]);
    const result = await scoreSemantic(item('4'), output('four'), CONFIG, invokeEmbed);
    expect(result.score).toBeCloseTo(1, 6);
    expect(result.passed).toBe(true);
    expect(invokeEmbed).toHaveBeenCalledWith(['four', '4']);
  });

  it('fails when similarity is below the threshold', async () => {
    const invokeEmbed: EmbedInvoker = vi.fn(async () => [[1, 0], [0, 1]]);
    const result = await scoreSemantic(item('4'), output('nope'), { type: 'semantic', threshold: 0.5 }, invokeEmbed);
    expect(result.score).toBeCloseTo(0, 6);
    expect(result.passed).toBe(false);
  });

  it('records an error result when the embedding provider throws', async () => {
    const invokeEmbed: EmbedInvoker = vi.fn(async () => { throw new Error('embeddings down'); });
    const result = await scoreSemantic(item('4'), output('four'), CONFIG, invokeEmbed);
    expect(result.passed).toBe(false);
    expect(result.error).toBe('embeddings down');
  });
});
