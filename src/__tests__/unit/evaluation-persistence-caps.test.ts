/**
 * Persistence caps (spec F): what `toRunItem` / `fitRunItems` keep when a run is
 * written to its one document. The in-memory result is never touched.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

import { capScoreDetail, capToolCalls, fitRunItems, toRunItem } from '@/lib/services/evaluation/service';
import type { RunItemResult } from '@/lib/services/evaluation/types';
import type { IEvaluationRunItem } from '@/lib/database';

const baseItem = (over: Partial<RunItemResult> = {}): RunItemResult =>
  ({
    itemId: 'i1',
    scores: [],
    score: 1,
    passed: true,
    ...over,
  }) as RunItemResult;

describe('toRunItem caps', () => {
  it('caps output text at 20000 chars and retrieval text at 8000', () => {
    const long = 'x'.repeat(30000);
    expect(toRunItem(baseItem({ output: { text: long } })).output?.text).toHaveLength(20000);
    expect(
      toRunItem(
        baseItem({ output: { text: long, retrieved: [{ id: 'c' }] } as unknown as RunItemResult['output'] }),
      ).output?.text,
    ).toHaveLength(8000);
  });

  it('caps error and score error at 2000 chars', () => {
    const item = toRunItem(
      baseItem({
        error: 'e'.repeat(5000),
        scores: [{ scorerType: 'assertion', score: 0, passed: false, weight: 1, error: 'f'.repeat(5000) }],
      }),
    );
    expect(item.error).toHaveLength(2000);
    expect(item.scores[0].error).toHaveLength(2000);
  });

  it('keeps skipped, usage, scoringUsage, truncated and turn usage', () => {
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
    const item = toRunItem(
      baseItem({
        skipped: true,
        scoringUsage: usage,
        output: {
          text: 'hi',
          truncated: true,
          turns: [{ index: 0, question: 'q', text: 'a', usage }],
        } as unknown as RunItemResult['output'],
        scores: [{ scorerType: 'llm-judge', score: 0, passed: false, weight: 1, skipped: true, usage }],
      }),
    );
    expect(item.skipped).toBe(true);
    expect(item.scoringUsage).toEqual(usage);
    expect(item.output?.truncated).toBe(true);
    expect(item.output?.turns?.[0].usage).toEqual(usage);
    expect(item.scores[0].skipped).toBe(true);
    expect(item.scores[0].usage).toEqual(usage);
  });

  it('omits absent optional keys instead of writing undefined', () => {
    const item = toRunItem(baseItem({ output: { text: 'hi' } }));
    expect(Object.keys(item)).not.toContain('error');
    expect(Object.keys(item)).not.toContain('skipped');
    expect(Object.keys(item.output ?? {})).not.toContain('truncated');
  });
});

describe('capToolCalls', () => {
  it('keeps at most 32 calls and replaces oversized args with a preview marker', () => {
    const calls = Array.from({ length: 40 }, (_, i) => ({ name: `t${i}`, args: { n: i } }));
    expect(capToolCalls(calls)).toHaveLength(32);

    const big = capToolCalls([{ name: 'big', args: { blob: 'z'.repeat(10000) } }]);
    expect(big[0].args).toMatchObject({ __truncated: true });
    expect(String((big[0].args as { preview: string }).preview).length).toBe(500);
  });

  it('treats missing args as an empty object', () => {
    expect(capToolCalls([{ name: 'a' }])[0].args).toEqual({});
  });
});

describe('capScoreDetail', () => {
  it('leaves a small detail untouched', () => {
    const detail = { reasoning: 'ok', threshold: 0.5 };
    expect(capScoreDetail(detail)).toBe(detail);
  });

  it('shrinks a large detail to its whitelisted core and marks it truncated', () => {
    const out = capScoreDetail({
      reasoning: 'r'.repeat(5000),
      threshold: 0.7,
      judgePassed: true,
      expectedCount: 2,
      actualCount: 3,
      reason: 'because',
      chunks: Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, text: 'y'.repeat(50) })),
    });
    expect(out?.truncated).toBe(true);
    expect((out?.reasoning as string).length).toBe(2000);
    expect(out).toMatchObject({ threshold: 0.7, judgePassed: true, expectedCount: 2, actualCount: 3, reason: 'because' });
    expect(out).not.toHaveProperty('chunks');
  });
});

describe('fitRunItems', () => {
  const item = (textLen: number, detailLen: number, idLen = 1): IEvaluationRunItem => ({
    itemId: 'i'.repeat(idLen),
    output: { text: 'o'.repeat(textLen), turns: [{ index: 0, question: 'q', text: 't'.repeat(100) }] },
    scores: [
      { scorerType: 'assertion', score: 1, passed: true, weight: 1, detail: { reasoning: 'r', blob: 'b'.repeat(detailLen) } },
    ],
    score: 1,
    passed: true,
  });

  it('returns small runs untouched', () => {
    const items = [item(10, 10)];
    expect(fitRunItems(items)).toEqual({ items, degraded: false });
  });

  it('drops score details first', () => {
    const fitted = fitRunItems(Array.from({ length: 9 }, () => item(10, 1_000_000)));
    expect(fitted.degraded).toBe(true);
    expect(fitted.items).toHaveLength(9);
    expect(fitted.items[0].scores[0].detail).not.toHaveProperty('blob');
    expect(fitted.items[0].scores[0].detail).toMatchObject({ reasoning: 'r', truncated: true });
  });

  it('then trims output text and drops turns', () => {
    const fitted = fitRunItems(Array.from({ length: 500 }, () => item(30000, 1)));
    expect(fitted.degraded).toBe(true);
    expect(fitted.items).toHaveLength(500);
    expect(fitted.items[0].output?.text).toHaveLength(1000);
    expect(fitted.items[0].output?.turns).toBeUndefined();
  });

  it('finally gives up on items', () => {
    // Even the minimal form is over the cap: nothing but the ids alone are 10 MB.
    const fitted = fitRunItems(Array.from({ length: 10 }, () => item(1, 1, 1_000_000)));
    expect(fitted).toEqual({ items: [], degraded: true });
  });
});
