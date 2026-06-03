/**
 * Unit tests — evaluation LLM-judge scorer (with a mocked judge invoker).
 * Covers score normalisation, threshold/pass handling, prompt construction,
 * and graceful failure on unparseable verdicts.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  scoreLlmJudge,
  parseJudgeResponse,
  normaliseScore,
  buildJudgePrompt,
} from '@/lib/services/evaluation/scorers/llmJudgeScorer';
import type { DatasetItem, LlmJudgeScorerConfig, TargetOutput } from '@/lib/services/evaluation/types';

const ITEM: DatasetItem = {
  id: 'i1',
  input: [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: 'What is 2+2?' },
  ],
  expected: { reference: '4' },
};
const OUTPUT: TargetOutput = { text: 'The answer is 4.' };
const CONFIG: LlmJudgeScorerConfig = { type: 'llm-judge', rubric: 'Correct and concise.' };

describe('normaliseScore', () => {
  it('passes through a 0..1 score', () => {
    expect(normaliseScore(0.7)).toBeCloseTo(0.7, 5);
  });
  it('auto-detects and rescales a 0..10 score', () => {
    expect(normaliseScore(8)).toBeCloseTo(0.8, 5);
  });
  it('clamps out-of-range values', () => {
    expect(normaliseScore(-2)).toBe(0);
    expect(normaliseScore(50)).toBe(1);
  });
});

describe('parseJudgeResponse', () => {
  it('parses a plain JSON verdict', () => {
    expect(parseJudgeResponse('{"score":0.9,"passed":true,"reasoning":"good"}')).toEqual({
      score: 0.9,
      passed: true,
      reasoning: 'good',
    });
  });
  it('parses a fenced verdict', () => {
    const v = parseJudgeResponse('```json\n{"score": 1}\n```');
    expect(v.score).toBe(1);
  });
  it('throws when no numeric score is present', () => {
    expect(() => parseJudgeResponse('{"reasoning":"n/a"}')).toThrow(/score/);
    expect(() => parseJudgeResponse('totally not json')).toThrow();
  });
});

describe('buildJudgePrompt', () => {
  it('includes rubric, the last user message, the reference and the output', () => {
    const messages = buildJudgePrompt(ITEM, OUTPUT, CONFIG);
    expect(messages[0].role).toBe('system');
    const body = messages[1].content;
    expect(body).toContain('Correct and concise.');
    expect(body).toContain('What is 2+2?');
    expect(body).toContain('4');
    expect(body).toContain('The answer is 4.');
  });
});

describe('scoreLlmJudge', () => {
  it('uses the judge verdict and explicit passed flag', async () => {
    const invokeJudge = vi.fn().mockResolvedValue('{"score":0.95,"passed":true,"reasoning":"correct"}');
    const r = await scoreLlmJudge(ITEM, OUTPUT, CONFIG, invokeJudge);
    expect(invokeJudge).toHaveBeenCalledOnce();
    expect(r.score).toBeCloseTo(0.95, 5);
    expect(r.passed).toBe(true);
    expect(r.detail?.reasoning).toBe('correct');
  });

  it('derives passed from the threshold when not given', async () => {
    const invokeJudge = vi.fn().mockResolvedValue('{"score":0.4}');
    const lenient = await scoreLlmJudge(ITEM, OUTPUT, { ...CONFIG, threshold: 0.3 }, invokeJudge);
    const strict = await scoreLlmJudge(ITEM, OUTPUT, { ...CONFIG, threshold: 0.5 }, invokeJudge);
    expect(lenient.passed).toBe(true);
    expect(strict.passed).toBe(false);
  });

  it('fails gracefully when the judge errors or is unparseable', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('rate limited'));
    const r = await scoreLlmJudge(ITEM, OUTPUT, CONFIG, boom);
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.error).toMatch(/rate limited/);

    const garbage = vi.fn().mockResolvedValue('no json here');
    const r2 = await scoreLlmJudge(ITEM, OUTPUT, CONFIG, garbage);
    expect(r2.passed).toBe(false);
    expect(r2.error).toBeTruthy();
  });
});
