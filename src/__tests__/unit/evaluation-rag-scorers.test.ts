/**
 * Unit tests — the three retrieval scorers (context-recall, context-precision,
 * groundedness) and the rag target's contribution to them.
 *
 * The point of these scorers is that they judge MEANING: the stub embedder
 * below maps a handful of phrasings onto shared vectors, so a paraphrase and
 * its reference embed close together while an unrelated passage does not.
 * A string-overlap scorer would fail every "paraphrase scores high" case here.
 */

import { describe, it, expect, vi } from 'vitest';
import { scoreContextRecall } from '@/lib/services/evaluation/scorers/contextRecallScorer';
import { scoreContextPrecision, RELEVANCE_SIMILARITY } from '@/lib/services/evaluation/scorers/contextPrecisionScorer';
import { scoreGroundedness } from '@/lib/services/evaluation/scorers/groundednessScorer';
import { EMBED_BATCH_SIZE, splitClaims } from '@/lib/services/evaluation/scorers/retrievalSimilarity';
import { runScorers } from '@/lib/services/evaluation/scorers';
import type {
  DatasetItem,
  EmbedInvoker,
  RetrievedChunk,
  TargetOutput,
} from '@/lib/services/evaluation/types';

/**
 * Concept vectors: texts sharing a concept token embed onto the SAME axis, so
 * differently-worded text about one concept is similar and text about another
 * is orthogonal. `refund` and `refund-paraphrase` deliberately share an axis —
 * that is the paraphrase case the whole feature exists for.
 */
function conceptVector(text: string): number[] {
  const lower = text.toLowerCase();
  if (lower.includes('money back') || lower.includes('refund')) return [1, 0, 0];
  if (lower.includes('delivery') || lower.includes('shipping')) return [0, 1, 0];
  return [0, 0, 1];
}

const stubEmbed: EmbedInvoker = vi.fn(async (texts: string[]) => texts.map(conceptVector));

function chunk(content: string, rank: number, extra: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return { id: `c${rank}`, score: 1 - rank / 100, content, rank, ...extra };
}

const item = (reference?: string): DatasetItem => ({
  id: 'q1',
  input: [{ role: 'user', content: 'How do I get my money back?' }],
  expected: reference ? { reference } : undefined,
});

function output(text: string, retrieved?: RetrievedChunk[]): TargetOutput {
  return { text, ...(retrieved ? { retrieved } : {}) };
}

const REFERENCE = 'Request a refund within thirty days of purchase.';
/** Same meaning, no shared wording beyond the concept — the case that matters. */
const PARAPHRASE = chunk('You can ask for your money back up to a month after buying.', 1);
const UNRELATED = chunk('Shipping is handled by our delivery partner.', 1);

describe('splitClaims', () => {
  it('splits on sentence boundaries and falls back to the whole text', () => {
    expect(splitClaims('Refunds take five days. Shipping is separate.')).toEqual([
      'Refunds take five days.',
      'Shipping is separate.',
    ]);
    expect(splitClaims('short')).toEqual(['short']);
    expect(splitClaims('   ')).toEqual([]);
  });
});

describe('scoreContextRecall', () => {
  it('scores a paraphrase of the gold answer high', async () => {
    const result = await scoreContextRecall(
      item(REFERENCE),
      output('ctx', [PARAPHRASE]),
      { type: 'context-recall' },
      stubEmbed,
    );
    expect(result.score).toBeCloseTo(1, 6);
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('scores an unrelated retrieved set low', async () => {
    const result = await scoreContextRecall(
      item(REFERENCE),
      output('ctx', [UNRELATED]),
      { type: 'context-recall' },
      stubEmbed,
    );
    expect(result.score).toBeCloseTo(0, 6);
    expect(result.passed).toBe(false);
  });

  it('scores 0 without throwing when nothing was retrieved', async () => {
    const result = await scoreContextRecall(item(REFERENCE), output('', []), { type: 'context-recall' }, stubEmbed);
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    // Retrieving nothing is a real result, not a broken suite.
    expect(result.error).toBeUndefined();
    expect(result.detail).toMatchObject({ scoredChunks: 0 });
  });

  it('errors (does not throw) when the target does not retrieve at all', async () => {
    const result = await scoreContextRecall(item(REFERENCE), output('an answer'), { type: 'context-recall' }, stubEmbed);
    expect(result.error).toMatch(/retrieved context/);
    expect(result.score).toBe(0);
  });

  it('errors when the item carries no gold answer', async () => {
    const invokeEmbed: EmbedInvoker = vi.fn();
    const result = await scoreContextRecall(item(), output('ctx', [PARAPHRASE]), { type: 'context-recall' }, invokeEmbed);
    expect(result.error).toMatch(/expected\.reference/);
    expect(invokeEmbed).not.toHaveBeenCalled();
  });

  it('skips empty chunks instead of embedding them', async () => {
    const embedded: string[] = [];
    const invokeEmbed: EmbedInvoker = async (texts: string[]) => {
      embedded.push(...texts);
      return texts.map(conceptVector);
    };
    const result = await scoreContextRecall(
      item(REFERENCE),
      output('ctx', [chunk('   ', 1), { ...PARAPHRASE, rank: 2, id: 'c2' }]),
      { type: 'context-recall' },
      invokeEmbed,
    );
    // A zero vector scores 0 against everything, so embedding '' would have
    // halved a perfect recall.
    expect(result.score).toBeCloseTo(1, 6);
    expect(result.detail).toMatchObject({ skippedEmpty: 1, scoredChunks: 1 });
    expect(embedded).not.toContain('   ');
  });

  it('averages coverage across the reference claims', async () => {
    // Two claims, one covered by the retrieved passage and one not.
    const reference = 'You can ask for a refund. Delivery partners handle returns.';
    const result = await scoreContextRecall(
      item(reference),
      output('ctx', [PARAPHRASE]),
      { type: 'context-recall' },
      stubEmbed,
    );
    expect(result.score).toBeCloseTo(0.5, 6);
    expect(result.detail).toMatchObject({ claims: 2 });
  });

  it('records an error result when the embedding provider throws', async () => {
    const invokeEmbed: EmbedInvoker = vi.fn(async () => { throw new Error('embeddings down'); });
    const result = await scoreContextRecall(item(REFERENCE), output('ctx', [PARAPHRASE]), { type: 'context-recall' }, invokeEmbed);
    expect(result.passed).toBe(false);
    expect(result.error).toBe('embeddings down');
  });

  it('embeds in bounded batches so a large topK cannot exceed a provider input cap', async () => {
    const sizes: number[] = [];
    const invokeEmbed: EmbedInvoker = vi.fn(async (texts: string[]) => {
      sizes.push(texts.length);
      return texts.map(conceptVector);
    });
    const many = Array.from({ length: 70 }, (_, i) => chunk(PARAPHRASE.content, i + 1, { id: `c${i}` }));
    const result = await scoreContextRecall(item(REFERENCE), output('ctx', many), { type: 'context-recall' }, invokeEmbed);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(EMBED_BATCH_SIZE);
    expect(result.score).toBeCloseTo(1, 6);
  });
});

describe('scoreContextPrecision', () => {
  it('is 1 when every retrieved passage is relevant', async () => {
    const chunks = [PARAPHRASE, chunk('Refund requests are processed weekly.', 2, { id: 'c2' })];
    const result = await scoreContextPrecision(item(REFERENCE), output('ctx', chunks), { type: 'context-precision' }, stubEmbed);
    expect(result.score).toBeCloseTo(1, 6);
    expect(result.detail).toMatchObject({ relevantChunks: 2, relevanceSimilarity: RELEVANCE_SIMILARITY });
  });

  it('is 0 when nothing retrieved is relevant', async () => {
    const result = await scoreContextPrecision(item(REFERENCE), output('ctx', [UNRELATED]), { type: 'context-precision' }, stubEmbed);
    expect(result.score).toBeCloseTo(0, 6);
    expect(result.passed).toBe(false);
  });

  it('rewards a relevant passage at rank 1 over the same passage at the tail', async () => {
    const relevant = PARAPHRASE.content;
    const noise = UNRELATED.content;
    const front = [chunk(relevant, 1), chunk(noise, 2, { id: 'c2' }), chunk(noise, 3, { id: 'c3' })];
    const back = [chunk(noise, 1), chunk(noise, 2, { id: 'c2' }), chunk(relevant, 3, { id: 'c3' })];
    const scoreFront = await scoreContextPrecision(item(REFERENCE), output('ctx', front), { type: 'context-precision' }, stubEmbed);
    const scoreBack = await scoreContextPrecision(item(REFERENCE), output('ctx', back), { type: 'context-precision' }, stubEmbed);
    expect(scoreFront.score).toBeGreaterThan(scoreBack.score);
  });

  it('scores 0 without throwing on an empty retrieved set', async () => {
    const result = await scoreContextPrecision(item(REFERENCE), output('', []), { type: 'context-precision' }, stubEmbed);
    expect(result.score).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('keeps chunk ids and scores on the detail, never chunk content', async () => {
    const result = await scoreContextPrecision(item(REFERENCE), output('ctx', [PARAPHRASE]), { type: 'context-precision' }, stubEmbed);
    const chunks = (result.detail as { chunks: Array<Record<string, unknown>> }).chunks;
    expect(chunks[0]).toMatchObject({ id: 'c1', rank: 1 });
    expect(JSON.stringify(chunks)).not.toContain('money back');
  });
});

describe('scoreGroundedness', () => {
  it('scores an answer that restates the retrieved passage high', async () => {
    const result = await scoreGroundedness(
      item(REFERENCE),
      output('Refunds are available for thirty days.', [PARAPHRASE]),
      { type: 'groundedness' },
      stubEmbed,
    );
    expect(result.score).toBeCloseTo(1, 6);
    expect(result.passed).toBe(true);
  });

  it('scores an answer invented next to the context low', async () => {
    const result = await scoreGroundedness(
      item(REFERENCE),
      output('Our delivery partner ships on Tuesdays.', [PARAPHRASE]),
      { type: 'groundedness' },
      stubEmbed,
    );
    expect(result.score).toBeCloseTo(0, 6);
    expect(result.passed).toBe(false);
  });

  it('reports the least-supported sentence of a half-invented answer', async () => {
    const result = await scoreGroundedness(
      item(REFERENCE),
      output('You can request a refund. Delivery takes three weeks.', [PARAPHRASE]),
      { type: 'groundedness' },
      stubEmbed,
    );
    expect(result.score).toBeCloseTo(0.5, 6);
    expect(result.detail).toMatchObject({ weakestClaim: { text: 'Delivery takes three weeks.', support: 0 } });
  });

  it('scores 0 without throwing when nothing was retrieved', async () => {
    const result = await scoreGroundedness(item(REFERENCE), output('anything', []), { type: 'groundedness' }, stubEmbed);
    expect(result.score).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('errors when the target does not retrieve at all', async () => {
    const result = await scoreGroundedness(item(REFERENCE), output('anything'), { type: 'groundedness' }, stubEmbed);
    expect(result.error).toMatch(/retrieved context/);
  });
});

describe('runScorers dispatch', () => {
  it('reports a missing embed invoker as an error rather than a silent zero', async () => {
    const results = await runScorers(
      item(REFERENCE),
      output('ctx', [PARAPHRASE]),
      [{ type: 'context-recall' }, { type: 'context-precision' }, { type: 'groundedness' }],
      {},
    );
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.score).toBe(0);
      expect(result.error).toBe('no embed invoker configured');
    }
  });

  it('runs all three when an embed invoker is supplied', async () => {
    const results = await runScorers(
      item(REFERENCE),
      output('Refunds are available for thirty days.', [PARAPHRASE]),
      [{ type: 'context-recall' }, { type: 'context-precision' }, { type: 'groundedness' }],
      { invokeEmbed: stubEmbed },
    );
    expect(results.map((r) => r.scorerType)).toEqual(['context-recall', 'context-precision', 'groundedness']);
    for (const result of results) {
      expect(result.error).toBeUndefined();
      expect(result.passed).toBe(true);
    }
  });
});
