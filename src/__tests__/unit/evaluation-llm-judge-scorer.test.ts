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
    // Unparseable verdicts are retried: 1 call + 2 retries.
    expect(garbage).toHaveBeenCalledTimes(3);
    expect(r2.error).toMatch(/3 attempts/);
  });

  it('does not retry a transport error (the invoker owns those retries)', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('503'));
    await scoreLlmJudge(ITEM, OUTPUT, CONFIG, boom);
    expect(boom).toHaveBeenCalledOnce();
  });

  it('retries after an unparseable verdict and reports the attempts', async () => {
    const invokeJudge = vi.fn()
      .mockResolvedValueOnce('hmm')
      .mockResolvedValueOnce('{"score":0.8,"reasoning":"ok"}');
    const r = await scoreLlmJudge(ITEM, OUTPUT, CONFIG, invokeJudge);
    expect(r.score).toBeCloseTo(0.8, 5);
    expect(r.detail?.attempts).toBe(2);
    expect(r.error).toBeUndefined();
  });

  it('lets the threshold decide; the judge’s own passed flag is only kept as detail', async () => {
    const invokeJudge = vi.fn().mockResolvedValue('{"score":0.2,"passed":true}');
    const r = await scoreLlmJudge(ITEM, OUTPUT, CONFIG, invokeJudge);
    expect(r.passed).toBe(false);
    expect(r.detail?.judgePassed).toBe(true);
    expect(r.detail?.threshold).toBe(0.5);
  });

  it('treats a score outside 0..1 as a parse error (no /10 rescaling)', async () => {
    const invokeJudge = vi.fn().mockResolvedValue('{"score":8}');
    const r = await scoreLlmJudge(ITEM, OUTPUT, CONFIG, invokeJudge);
    expect(r.error).toMatch(/outside the allowed range/);
    expect(r.passed).toBe(false);
  });

  it('sums usage over attempts when the invoker returns completions', async () => {
    const invokeJudge = vi.fn()
      .mockResolvedValueOnce({ text: 'nope', usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.001 } })
      .mockResolvedValueOnce({ text: '{"score":1}', usage: { inputTokens: 10, outputTokens: 3, costUsd: 0.002 } });
    const r = await scoreLlmJudge(ITEM, OUTPUT, CONFIG, invokeJudge);
    expect(r.usage).toMatchObject({ inputTokens: 20, outputTokens: 5 });
    expect(r.usage?.costUsd).toBeCloseTo(0.003, 6);
  });
});

describe('parseJudgeResponse — last object wins, strict range', () => {
  it('takes the LAST JSON object that has a numeric score', () => {
    const raw = 'Example: {"score": 1, "reasoning": "example"}\nMy verdict: {"score": 0.25, "reasoning": "weak"}';
    expect(parseJudgeResponse(raw).score).toBe(0.25);
  });

  it('ignores later objects without a numeric score', () => {
    expect(parseJudgeResponse('{"score":0.6} {"note":"done"}').score).toBe(0.6);
  });

  it('finds the verdict after a long chain of thought full of JSON-looking text', () => {
    const echoed = Array.from({ length: 40 }, (_, i) => `search({"q":"term ${i}","filters":{"page":${i}}})`).join('\n');
    const raw = `Checking the calls:\n${echoed}\nVerdict: {"score": 0.9, "reasoning": "calls match {as expected}"}`;
    const verdict = parseJudgeResponse(raw);
    expect(verdict.score).toBe(0.9);
    expect(verdict.reasoning).toBe('calls match {as expected}');
  });

  it('rejects out-of-range and non-numeric scores', () => {
    expect(() => parseJudgeResponse('{"score":1.5}')).toThrow(/range/);
    expect(() => parseJudgeResponse('{"score":-0.1}')).toThrow(/range/);
    expect(() => parseJudgeResponse('{"score":"0.9"}')).toThrow();
  });
});

describe('buildJudgePrompt — delimiting and tool calls', () => {
  it('wraps untrusted sections in nonce tags and says they are data', () => {
    const [system, user] = buildJudgePrompt(ITEM, OUTPUT, CONFIG, 'abc123');
    expect(system.content).toMatch(/untrusted data/);
    expect(system.content).toMatch(/tool calls and no text is not a failure/);
    expect(user.content).toContain('<assistant_output_abc123>\nThe answer is 4.\n</assistant_output_abc123>');
    expect(user.content).toContain('<user_input_abc123>');
    expect(user.content).toContain('<reference_answer_abc123>');
    // The rubric is the author's own text and stays untagged.
    expect(user.content).toContain('# Rubric\nCorrect and concise.');
  });

  it('uses a fresh random nonce per call', () => {
    const a = buildJudgePrompt(ITEM, OUTPUT, CONFIG)[1].content;
    const b = buildJudgePrompt(ITEM, OUTPUT, CONFIG)[1].content;
    expect(a.match(/assistant_output_([0-9a-f]+)>/)?.[1]).not.toBe(b.match(/assistant_output_([0-9a-f]+)>/)?.[1]);
  });

  it('shows the judge the tool calls, a no-text placeholder, and the expected calls', () => {
    const item: DatasetItem = {
      ...ITEM,
      expected: { toolCalls: [{ name: 'search', args: { q: 'x' }, argsMatch: 'exact' }] },
    };
    const output: TargetOutput = { text: '', toolCalls: [{ name: 'search', args: { q: ' x ', limit: 3 } }] };
    const body = buildJudgePrompt(item, output, CONFIG, 'n1')[1].content;
    expect(body).toContain('(no text — the assistant answered with tool calls only)');
    expect(body).toContain('<assistant_tool_calls_n1>\nsearch({"limit":3,"q":"x"})\n</assistant_tool_calls_n1>');
    expect(body).toContain('<expected_tool_calls_n1>\nsearch({"q":"x"})');
  });
});
