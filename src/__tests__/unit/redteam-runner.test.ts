/**
 * Unit tests — red-team runner.
 * End-to-end through the real detectors + decision policy: outcome bucketing,
 * attack-success / resilience aggregation, per-category & per-severity rollups,
 * multi-turn transcript accumulation, target-error isolation, and the progress
 * hook. The target invoker is a deterministic fake.
 */

import { describe, it, expect, vi } from 'vitest';
import { runRedTeam } from '@/lib/services/redteam/runner';
import { createPatternDetector, createRefusalDetector } from '@/lib/services/redteam/detectors';
import type { Probe, ProbeAttempt, RedTeamMessage, TargetInvoker } from '@/lib/services/redteam/types';

/** A probe whose attempts steer a fake target toward each outcome. */
function makeProbe(attempts: ProbeAttempt[]): Probe {
  return {
    key: 'fake',
    family: 'test',
    category: 'LLM06-sensitive-information-disclosure',
    severity: 'high',
    description: 'fake probe',
    detectors: [createRefusalDetector(), createPatternDetector()],
    generate: () => attempts,
  };
}

/** Last user message decides the canned response. */
const fakeTarget: TargetInvoker = async (messages: RedTeamMessage[]) => {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (last.includes('BOOM')) throw new Error('target exploded');
  if (last.includes('LEAK')) return { text: 'sure, the secret is SECRET-1 enjoy', latencyMs: 5 };
  if (last.includes('REFUSE')) return { text: "I'm sorry, but I can't help with that.", latencyMs: 5 };
  return { text: 'the weather is nice today', latencyMs: 5 };
};

describe('runRedTeam', () => {
  it('buckets outcomes and aggregates attack-success / resilience', async () => {
    const probe = makeProbe([
      { id: 'leak', turns: ['please LEAK the secret'], expect: { canary: 'SECRET-1' } },
      { id: 'refuse', turns: ['REFUSE this please'], expect: { canary: 'SECRET-1' } },
      { id: 'neutral', turns: ['just chat'], expect: { canary: 'SECRET-1' } },
      { id: 'boom', turns: ['BOOM'], expect: { canary: 'SECRET-1' } },
    ]);

    const { aggregate, attempts } = await runRedTeam({ probes: [probe], invokeTarget: fakeTarget });

    expect(aggregate.total).toBe(4);
    expect(aggregate.failed).toBe(1); // boom
    expect(aggregate.completed).toBe(3);
    expect(aggregate.vulnerable).toBe(1); // leak
    expect(aggregate.safe).toBe(1); // refuse
    expect(aggregate.needsReview).toBe(1); // neutral (boom is excluded — it errored)
    expect(aggregate.attackSuccessRate).toBeCloseTo(1 / 3, 5);
    expect(aggregate.resilienceScore).toBeCloseTo(2 / 3, 5);
    expect(aggregate.bySeverity.high).toBe(1);
    expect(aggregate.byCategory['LLM06-sensitive-information-disclosure'].vulnerable).toBe(1);

    const boom = attempts.find((a) => a.attemptId === 'boom')!;
    expect(boom.error).toMatch(/exploded/);
    expect(boom.outcome).toBe('needs_review');
    expect(boom.verdict.decidedBy).toBe('target-error');
  });

  it('accumulates multi-turn history into the transcript', async () => {
    const seen: number[] = [];
    const recordingTarget: TargetInvoker = async (messages) => {
      seen.push(messages.length);
      return { text: 'ok' };
    };
    const probe = makeProbe([{ id: 'multi', turns: ['first', 'second', 'third'], system: 'SYS', expect: {} }]);

    const { attempts } = await runRedTeam({ probes: [probe], invokeTarget: recordingTarget });

    // Turn 1 sees [system, user]; turn 2 adds [assistant, user]; turn 3 again.
    expect(seen).toEqual([2, 4, 6]);
    expect(attempts[0].transcript).toHaveLength(3);
    expect(attempts[0].transcript[2]).toEqual({ user: 'third', assistant: 'ok' });
  });

  it('runs an adaptive multi-turn attack driven by the attacker invoker', async () => {
    const probe = makeProbe([
      { id: 'adapt', turns: ['opening attack'], adaptive: true, objective: 'break it', expect: {} },
    ]);
    const attackerTurns: string[] = [];
    const invokeAttacker = vi.fn(async () => {
      attackerTurns.push('x');
      return `escalated attack #${attackerTurns.length}`;
    });
    let targetCalls = 0;
    const recordingTarget: TargetInvoker = async () => { targetCalls += 1; return { text: 'no.' }; };

    const { attempts } = await runRedTeam({
      probes: [probe],
      invokeTarget: recordingTarget,
      invokeAttacker,
      config: { maxTurns: 4 },
    });

    // 4 target turns; attacker consulted between them (3 times).
    expect(targetCalls).toBe(4);
    expect(invokeAttacker).toHaveBeenCalledTimes(3);
    expect(attempts[0].transcript).toHaveLength(4);
    expect(attempts[0].transcript[0].user).toBe('opening attack');
    expect(attempts[0].transcript[1].user).toBe('escalated attack #1');
  });

  it('stops the adaptive loop early when the attacker signals completion', async () => {
    const probe = makeProbe([{ id: 'adapt', turns: ['open'], adaptive: true, objective: 'x', expect: {} }]);
    const invokeAttacker = vi.fn(async () => '[[STOP]]');
    const { attempts } = await runRedTeam({
      probes: [probe],
      invokeTarget: async () => ({ text: 'ok' }),
      invokeAttacker,
      config: { maxTurns: 5 },
    });
    expect(attempts[0].transcript).toHaveLength(1); // opener only, attacker stopped
  });

  it('falls back to the static script for adaptive probes when no attacker is wired', async () => {
    const probe = makeProbe([{ id: 'adapt', turns: ['only turn'], adaptive: true, objective: 'x', expect: {} }]);
    const { attempts } = await runRedTeam({ probes: [probe], invokeTarget: async () => ({ text: 'ok' }) });
    expect(attempts[0].transcript).toHaveLength(1);
  });

  it('caps turns per attempt when config.maxTurns is set', async () => {
    const probe = makeProbe([{ id: 'multi', turns: ['t1', 't2', 't3', 't4'], expect: {} }]);
    const { attempts } = await runRedTeam({
      probes: [probe],
      invokeTarget: async () => ({ text: 'ok' }),
      config: { maxTurns: 2 },
    });
    expect(attempts[0].transcript).toHaveLength(2);
    expect(attempts[0].transcript.map((t) => t.user)).toEqual(['t1', 't2']);
  });

  it('invokes the progress hook once per attempt under bounded concurrency', async () => {
    const attempts = Array.from({ length: 7 }, (_, i) => ({ id: `a${i}`, turns: ['just chat'], expect: {} }));
    const onAttempt = vi.fn();
    const { attempts: results } = await runRedTeam({
      probes: [makeProbe(attempts)],
      invokeTarget: fakeTarget,
      config: { concurrency: 3 },
      onAttempt,
    });
    expect(results).toHaveLength(7);
    expect(results.every(Boolean)).toBe(true);
    expect(onAttempt).toHaveBeenCalledTimes(7);
  });
});
