/**
 * Unit tests — `single` vs `perTurn` replay.
 *
 * The two modes measure different things. `single` sends the recorded prefix
 * and calls the model once, so every earlier assistant turn is the one
 * production actually produced — a clean regression signal that structurally
 * cannot catch drift. `perTurn` drives the conversation turn by turn and feeds
 * the model its OWN answers back, so errors compound the way they do live.
 *
 * What is pinned here: the same item still produces ONE score in both modes
 * (so runs stay comparable), only the LAST turn is graded, recorded tool
 * exchanges replay verbatim while the model's own words do not, and the cost
 * of the whole replay is reported rather than the last call's.
 */

import { describe, it, expect } from 'vitest';
import { runEvaluation, replayPerTurn } from '@/lib/services/evaluation/runner';
import type { DatasetItem, ScorerConfig, TargetInvoker } from '@/lib/services/evaluation/types';

const ASSERTION: ScorerConfig[] = [{ type: 'assertion' }];

/** Three user turns with the production answers recorded between them. */
const MULTI_TURN: DatasetItem = {
  id: 'conv-1',
  input: [
    { role: 'system', content: 'You are a billing assistant.' },
    { role: 'user', content: 'what is my balance?' },
    { role: 'assistant', content: 'Your balance is $42.' },
    { role: 'user', content: 'and last month?' },
    { role: 'assistant', content: 'Last month it was $37.' },
    { role: 'user', content: 'so what changed?' },
  ],
  expected: { mustContain: ['ok'] },
};

/** Records every call the runner makes, and answers deterministically. */
function recordingInvoker(answer: (call: number, item: DatasetItem) => string) {
  const calls: DatasetItem[] = [];
  const invoke: TargetInvoker = async (item) => {
    calls.push(item);
    return { text: answer(calls.length, item), latencyMs: 10 };
  };
  return { calls, invoke };
}

describe('single mode (default)', () => {
  it('calls the model once with the recorded prefix untouched', async () => {
    const { calls, invoke } = recordingInvoker(() => 'ok');
    await runEvaluation({ items: [MULTI_TURN], scorers: ASSERTION, invokeTarget: invoke });

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual(MULTI_TURN.input);
  });
});

describe('perTurn mode', () => {
  it('calls the model once per user turn', async () => {
    const { calls, invoke } = recordingInvoker((n) => `answer ${n} ok`);
    await runEvaluation({
      items: [MULTI_TURN],
      scorers: ASSERTION,
      invokeTarget: invoke,
      config: { turnMode: 'perTurn' },
    });

    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.input[c.input.length - 1].content)).toEqual([
      'what is my balance?',
      'and last month?',
      'so what changed?',
    ]);
  });

  it("feeds the model its OWN previous answers, not the recorded ones", async () => {
    // This is the whole point of the mode: under `single` the model would see
    // the production answers and never notice it had drifted.
    const { calls, invoke } = recordingInvoker((n) => `answer ${n} ok`);
    await replayPerTurn(MULTI_TURN, invoke);

    const secondCall = calls[1].input.map((m) => m.content);
    expect(secondCall).toContain('answer 1 ok');
    expect(secondCall).not.toContain('Your balance is $42.');

    const thirdCall = calls[2].input.map((m) => m.content);
    expect(thirdCall).toContain('answer 1 ok');
    expect(thirdCall).toContain('answer 2 ok');
    expect(thirdCall).not.toContain('Last month it was $37.');
  });

  it('keeps the system turn at the head of every call', async () => {
    const { calls, invoke } = recordingInvoker(() => 'ok');
    await replayPerTurn(MULTI_TURN, invoke);
    for (const call of calls) {
      expect(call.input[0]).toEqual({ role: 'system', content: 'You are a billing assistant.' });
    }
  });

  it('scores only the LAST turn — the one `expected` describes', async () => {
    // Every earlier turn answers a DIFFERENT question; grading one of them
    // against the item's reference would compare answer 1 with answer 3.
    const { invoke } = recordingInvoker((n) => (n === 3 ? 'ok' : 'wrong'));
    const result = await runEvaluation({
      items: [MULTI_TURN],
      scorers: ASSERTION,
      invokeTarget: invoke,
      config: { turnMode: 'perTurn' },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].passed).toBe(true);
    expect(result.items[0].output?.text).toBe('ok');
  });

  it('keeps every turn as evidence, so a failure is explainable', async () => {
    const { invoke } = recordingInvoker((n) => `answer ${n} ok`);
    const output = await replayPerTurn(MULTI_TURN, invoke);

    expect(output.turns?.map((t) => t.index)).toEqual([1, 2, 3]);
    expect(output.turns?.map((t) => t.question)).toEqual([
      'what is my balance?',
      'and last month?',
      'so what changed?',
    ]);
    expect(output.turns?.map((t) => t.text)).toEqual(['answer 1 ok', 'answer 2 ok', 'answer 3 ok']);
  });

  it('reports the whole replay’s latency and spend, not the last call’s', async () => {
    // A per-turn run costs several calls per item; reporting only the final
    // one would make it look as cheap as a single-shot run.
    const invoke: TargetInvoker = async () => ({
      text: 'ok',
      latencyMs: 10,
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.5 },
    });
    const output = await replayPerTurn(MULTI_TURN, invoke);

    expect(output.latencyMs).toBe(30);
    expect(output.usage).toEqual({ inputTokens: 300, outputTokens: 60, costUsd: 1.5 });
  });

  it('leaves usage absent when the provider reported none', async () => {
    // Absent, never zero — a zero would report "free" where the truth is
    // "the provider told us nothing".
    const invoke: TargetInvoker = async () => ({ text: 'ok' });
    const output = await replayPerTurn(MULTI_TURN, invoke);
    expect(output.usage).toBeUndefined();
    expect(output.latencyMs).toBeUndefined();
  });

  it('replays recorded tool exchanges verbatim', async () => {
    // A tool result is a fact about the environment the test cannot reproduce
    // (nothing is executed here), so it must survive the replay untouched.
    const withTools: DatasetItem = {
      id: 'conv-tools',
      input: [
        { role: 'user', content: 'what is the weather?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_weather', args: { city: 'Rome' } }] },
        { role: 'tool', content: '{"tempC":21}', toolCallId: 'c1', name: 'get_weather' },
        { role: 'assistant', content: "It's 21°C in Rome." },
        { role: 'user', content: 'should I take a jacket?' },
      ],
    };
    const { calls, invoke } = recordingInvoker((n) => `answer ${n}`);
    await replayPerTurn(withTools, invoke);

    const lastCall = calls[calls.length - 1].input;
    expect(lastCall.find((m) => m.role === 'tool')?.content).toBe('{"tempC":21}');
    expect(lastCall.find((m) => m.toolCalls?.length)?.toolCalls?.[0].name).toBe('get_weather');
    // The model's own answer replaced the recorded prose turn.
    expect(lastCall.map((m) => m.content)).toContain('answer 1');
    expect(lastCall.map((m) => m.content)).not.toContain("It's 21°C in Rome.");
  });

  it('carries the model’s emitted tool calls into the next turn’s history', async () => {
    // A turn that decides to call a tool is part of the conversation the next
    // turn sees; dropping it would hide the decision from the rest of the run.
    const calls: DatasetItem[] = [];
    const invoke: TargetInvoker = async (item) => {
      calls.push(item);
      return { text: '', toolCalls: [{ name: 'lookup', args: { turn: calls.length } }] };
    };
    await replayPerTurn(MULTI_TURN, invoke);

    expect(calls[1].input.some((m) => m.toolCalls?.some((c) => c.name === 'lookup'))).toBe(true);
    expect(calls[2].input.filter((m) => m.toolCalls?.length)).toHaveLength(2);
  });

  it('behaves identically to single mode on a single-turn item', async () => {
    // The two modes have to agree where there is nothing to drive, or a
    // single-turn dataset would score differently for no reason.
    const item: DatasetItem = {
      id: 'one',
      input: [{ role: 'user', content: 'hi' }],
      expected: { mustContain: ['ok'] },
    };
    const single = recordingInvoker(() => 'ok');
    const perTurn = recordingInvoker(() => 'ok');

    const a = await runEvaluation({ items: [item], scorers: ASSERTION, invokeTarget: single.invoke });
    const b = await runEvaluation({
      items: [item], scorers: ASSERTION, invokeTarget: perTurn.invoke, config: { turnMode: 'perTurn' },
    });

    expect(single.calls).toHaveLength(1);
    expect(perTurn.calls).toHaveLength(1);
    expect(a.items[0].passed).toBe(b.items[0].passed);
    expect(a.items[0].output?.text).toBe(b.items[0].output?.text);
  });

  it('falls back to a single call when the item has no user turn at all', async () => {
    const item: DatasetItem = { id: 'sys-only', input: [{ role: 'system', content: 'be brief' }] };
    const { calls, invoke } = recordingInvoker(() => 'ok');
    const output = await replayPerTurn(item, invoke);

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual(item.input);
    expect(output.turns).toBeUndefined();
  });

  it('propagates a mid-replay failure as the item’s error', async () => {
    const invoke: TargetInvoker = async (item) => {
      if (item.id.endsWith('#turn-2')) throw new Error('rate limited');
      return { text: 'ok' };
    };
    const result = await runEvaluation({
      items: [MULTI_TURN],
      scorers: ASSERTION,
      invokeTarget: invoke,
      config: { turnMode: 'perTurn' },
    });

    expect(result.items[0].error).toMatch(/rate limited/);
    expect(result.aggregate.failed).toBe(1);
  });
});
