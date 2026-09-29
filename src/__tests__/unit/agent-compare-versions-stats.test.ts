/**
 * The compare drawer's pure half — what a side's stats row says.
 *
 * The distinction pinned here is "zero" versus "not reported". A model that
 * does not report cache reads has to show "—", not "0": a zero next to the
 * other side's real count reads as "only that version uses the cache".
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESPONSE_FORMAT,
  compareTotals,
  isResponseFormat,
  readTurnUsage,
  type CompareTurn,
} from '@/components/agents/studio/compareVersionsStats';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

const user: CompareTurn = { role: 'user', content: 'hi' };

describe('readTurnUsage', () => {
  it('reads every token field the chat route returns', () => {
    expect(readTurnUsage({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 100,
      totalTokens: 150,
      costUsd: 0.002,
    })).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 100,
      totalTokens: 150,
      costUsd: 0.002,
    });
  });

  it('derives the total from input + output when the total is missing', () => {
    expect(readTurnUsage({ inputTokens: 10, outputTokens: 5 }).totalTokens).toBe(15);
  });

  it('leaves unreported or malformed fields undefined instead of zero', () => {
    const usage = readTurnUsage({ inputTokens: 'lots', outputTokens: Number.NaN, totalTokens: 42 });
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.outputTokens).toBeUndefined();
    expect(usage.cachedInputTokens).toBeUndefined();
    expect(usage.totalTokens).toBe(42);
  });

  it('tolerates a response with no usage at all', () => {
    expect(readTurnUsage(undefined)).toEqual({});
    expect(readTurnUsage(null)).toEqual({});
  });
});

describe('compareTotals', () => {
  it('sums input, output and cache separately across answers', () => {
    const totals = compareTotals([
      user,
      { role: 'assistant', content: 'a', inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, totalTokens: 120, latencyMs: 500, costUsd: 0.01 },
      user,
      { role: 'assistant', content: 'b', inputTokens: 50, outputTokens: 10, cachedInputTokens: 0, totalTokens: 60, latencyMs: 250, steps: [{ name: 'search' } as never] },
    ]);
    expect(totals).toEqual({
      latencyMs: 750,
      tokens: 180,
      inputTokens: 150,
      outputTokens: 30,
      cachedInputTokens: 80,
      cost: 0.01,
      toolCalls: 1,
    });
  });

  it('keeps a field undefined when no answer reported it, but a reported zero stays zero', () => {
    const totals = compareTotals([
      { role: 'assistant', content: 'a', inputTokens: 0, outputTokens: 4, totalTokens: 4 },
    ]);
    expect(totals.inputTokens).toBe(0);
    expect(totals.cachedInputTokens).toBeUndefined();
  });

  it('reports nothing when the answers carried no usage', () => {
    const totals = compareTotals([user, { role: 'assistant', content: 'a' }]);
    expect(totals.tokens).toBeUndefined();
    expect(totals.inputTokens).toBeUndefined();
    expect(totals.outputTokens).toBeUndefined();
    expect(totals.cachedInputTokens).toBeUndefined();
  });

  it('ignores user turns and failed turns', () => {
    const totals = compareTotals([
      user,
      { role: 'error', content: 'HTTP 500', inputTokens: 999 },
    ]);
    expect(totals.inputTokens).toBeUndefined();
    expect(totals.latencyMs).toBe(0);
  });
});

describe('response format', () => {
  it('renders Markdown by default', () => {
    expect(DEFAULT_RESPONSE_FORMAT).toBe('markdown');
  });

  it('accepts only the two known modes', () => {
    expect(isResponseFormat('markdown')).toBe(true);
    expect(isResponseFormat('plain')).toBe(true);
    expect(isResponseFormat('html')).toBe(false);
    expect(isResponseFormat(null)).toBe(false);
  });
});

describe('compare translations', () => {
  const keysOf = (value: object, prefix = ''): string[] => Object.entries(value).flatMap(([key, child]) => (
    child && typeof child === 'object' ? keysOf(child, `${prefix}${key}.`) : [`${prefix}${key}`]
  ));

  it('gives Turkish every key English has', () => {
    expect(keysOf(tr.agents.compare).sort()).toEqual(keysOf(en.agents.compare).sort());
  });

  it('labels the token breakdown', () => {
    expect(en.agents.compare.stats).toMatchObject({ input: 'Input', output: 'Output', cache: 'Cache' });
  });
});
