/**
 * What a delegated child forwards to the parent's host (agent-sdk stamps it with
 * `subagentName` / `subagentId`), and the three places a turn must not take it
 * as its own: the answer text, the reasoning, the compactions.
 */

import { describe, expect, it, vi } from 'vitest';

import { __testables, extractPlaygroundSteps } from '@/lib/services/agents/agentService';
import { isSubagentEvent } from '@/lib/services/agents/subagentEvents';
import type { IAgentTurnCompaction } from '@/lib/database';

const child = { subagentName: 'helper', subagentId: 'sa_1' };
const { textStreamOptions, noteTurnCompaction } = __testables;

describe('isSubagentEvent', () => {
  it('is true for anything stamped with a child, however it is stamped', () => {
    expect(isSubagentEvent({ type: 'reasoning', ...child })).toBe(true);
    expect(isSubagentEvent({ type: 'stream', subagentName: 'helper' })).toBe(true);
    expect(isSubagentEvent({ type: 'stream', subagentId: 'sa_1' })).toBe(true);
    expect(isSubagentEvent({ type: 'reasoning', delegatedTo: 'writer' })).toBe(true);
  });

  it('is false for the turn\'s own events and for nothing at all', () => {
    expect(isSubagentEvent({ type: 'reasoning', text: 'mine' })).toBe(false);
    expect(isSubagentEvent({ type: 'tool_call', subagentName: '' })).toBe(false);
    expect(isSubagentEvent(undefined)).toBe(false);
    expect(isSubagentEvent(null)).toBe(false);
  });
});

describe('textStreamOptions', () => {
  it('forwards the answer\'s deltas but not a child\'s, nor the closing chunk', () => {
    const seen: string[] = [];
    const options = textStreamOptions((text) => seen.push(text), 'a1') as { stream: boolean; onStream: (chunk: Record<string, unknown>) => void };
    expect(options.stream).toBe(true);
    options.onStream({ text: 'Hello ' });
    options.onStream({ text: 'child words', ...child });
    options.onStream({ text: 'world' });
    options.onStream({ text: 'Hello world', isFinal: true });
    expect(seen).toEqual(['Hello ', 'world']);
  });

  it('asks for nothing without a listener', () => {
    expect(textStreamOptions(undefined, 'a1')).toEqual({});
  });
});

describe('noteTurnCompaction', () => {
  const event = (extra: Record<string, unknown> = {}) => ({
    type: 'summarization', messagesCompressed: 6, tokenCountBefore: 8000, tokenCountAfter: 1500, ...extra,
  }) as never;

  function turn() {
    const compactions: IAgentTurnCompaction[] = [];
    const logged: IAgentTurnCompaction[] = [];
    const handed: IAgentTurnCompaction[] = [];
    return {
      compactions,
      logged,
      handed,
      input: {
        compactions,
        turnEvents: { onCompaction: (c: IAgentTurnCompaction) => logged.push(c) },
        onCompaction: (c: IAgentTurnCompaction) => handed.push(c),
        agentKey: 'a1',
      },
    };
  }

  it('records the turn\'s own compaction: on the record, on the session log and to the caller', () => {
    const t = turn();
    noteTurnCompaction(event(), t.input);
    expect(t.compactions).toHaveLength(1);
    expect(t.compactions[0]).toMatchObject({ messagesCompressed: 6, tokensBefore: 8000, tokensAfter: 1500 });
    expect(t.logged).toEqual(t.compactions);
    expect(t.handed).toEqual(t.compactions);
  });

  it('leaves a sub-agent\'s compaction of its own context out of all three', () => {
    const t = turn();
    noteTurnCompaction(event(child), t.input);
    expect(t.compactions).toEqual([]);
    expect(t.logged).toEqual([]);
    expect(t.handed).toEqual([]);
  });

  it('a caller callback that throws never breaks the run, and a turn without a log or a callback still records', () => {
    const compactions: IAgentTurnCompaction[] = [];
    const boom = vi.fn(() => { throw new Error('boom'); });
    expect(() => noteTurnCompaction(event(), { compactions, turnEvents: undefined, onCompaction: boom, agentKey: 'a1' })).not.toThrow();
    expect(boom).toHaveBeenCalledTimes(1);
    noteTurnCompaction(event(), { compactions, turnEvents: undefined, agentKey: 'a1' });
    expect(compactions).toHaveLength(2);
  });
});

describe('delegation steps (CON-8)', () => {
  const step = (toolName: string, args: unknown, output: unknown, status = 'success') => extractPlaygroundSteps({
    state: { toolHistory: [{ executionId: 'e1', toolName, args, output, status, tool_call_id: 't1' }], messages: [] },
  } as never)[0];

  it('names the sub-agent a delegate_to step went to', () => {
    expect(step('delegate_to', { subagent: 'researcher' }, { name: 'researcher', status: 'ok', content: 'x' }).subagent).toBe('researcher');
  });

  it('names every sub-agent of a parallel step once', () => {
    const out = { results: [{ name: 'a', status: 'ok' }, { name: 'b', status: 'ok' }, { name: 'a', status: 'ok' }] };
    expect(step('spawn_subagents_parallel', {}, out).subagent).toBe('a, b');
  });

  it('does not label any other tool', () => {
    expect(step('search', {}, { name: 'x' }).subagent).toBeUndefined();
  });

  it('reports a failed child with its reason, and a parallel call only when every task failed', () => {
    const failed = step('delegate_to', { subagent: 'r' }, { name: 'r', status: 'error', error: 'boom' }, 'error');
    expect(failed).toMatchObject({ status: 'error', error: 'boom' });

    const all = step('spawn_subagents_parallel', {}, { results: [{ name: 'a', status: 'error', error: 'x' }, { name: 'b', status: 'cancelled' }] });
    expect(all).toMatchObject({ status: 'error', error: 'All 2 sub-agent tasks failed: x' });

    const some = step('spawn_subagents_parallel', {}, { results: [{ name: 'a', status: 'error', error: 'x' }, { name: 'b', status: 'ok' }] });
    expect(some.status).toBe('success');
    expect(some.error).toBeUndefined();
  });
});
