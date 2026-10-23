/**
 * What a delegated child forwards to the parent's host (agent-sdk stamps it with
 * `subagentName` / `subagentId`), and the three places a turn must not take it
 * as its own: the answer text, the reasoning, the compactions.
 */

import { describe, expect, it, vi } from 'vitest';

import { __testables, extractPlaygroundSteps, type AgentToolCallEvent } from '@/lib/services/agents/agentService';
import { isSubagentEvent, resumedDelegationIds, subagentStampOf } from '@/lib/services/agents/subagentEvents';
import { TURN_FLOW_LIMITS, createTurnFlowTracker } from '@/lib/services/agents/turnFlowTracker';
import { orderTurnFlow, type AgentCompactionEvent, type AgentSubagentEvent, type AgentToolCallSubagentStamp } from '@/lib/shared/agentTurnFlow';

const child = { subagentName: 'helper', subagentId: 'sa_1' };
const { textStreamOptions, createTurnFlowSink } = __testables;

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

describe('subagentStampOf', () => {
  it('reads the name and id off a stamped event', () => {
    expect(subagentStampOf({ subagentId: 's1', subagentName: 'helper' })).toEqual({ id: 's1', name: 'helper' });
    expect(subagentStampOf({ delegatedTo: 'worker' })).toEqual({ name: 'worker' });
    expect(subagentStampOf({ subagentId: 's1' })).toEqual({ id: 's1', name: 's1' });
  });

  it('is undefined where isSubagentEvent is false', () => {
    for (const input of [{}, null, undefined, { subagentName: '' }]) {
      expect(subagentStampOf(input)).toBeUndefined();
      expect(isSubagentEvent(input)).toBe(false);
    }
  });
});

describe('resumedDelegationIds', () => {
  it('is the delegation calls the state still holds a pending child for', () => {
    expect(resumedDelegationIds({ ctx: { __subagentPending: { d1: {}, d2: {} } } })).toEqual(new Set(['d1', 'd2']));
  });

  it('is empty without any', () => {
    expect(resumedDelegationIds(undefined).size).toBe(0);
    expect(resumedDelegationIds({}).size).toBe(0);
    expect(resumedDelegationIds({ ctx: {} }).size).toBe(0);
    expect(resumedDelegationIds({ ctx: { __subagentPending: 'x' } }).size).toBe(0);
  });

  it('names a parallel call\'s child by its call: the SDK keys it `<call>#<index>`', () => {
    expect(resumedDelegationIds({ ctx: { __subagentPending: { 'd1#0': {}, 'd1#1': {}, d2: {} } } })).toEqual(new Set(['d1', 'd2']));
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

describe('createTurnFlowSink: summarization', () => {
  const event = (extra: Record<string, unknown> = {}) => ({
    type: 'summarization', messagesCompressed: 6, tokenCountBefore: 8000, tokenCountAfter: 1500, ...extra,
  }) as never;

  function turn(withCallback = true) {
    const logged: AgentCompactionEvent[] = [];
    const handed: AgentCompactionEvent[] = [];
    const flow = createTurnFlowTracker();
    const sink = createTurnFlowSink({
      tracker: flow,
      turnEvents: { onSdkEvent: () => undefined, onCompaction: (c) => logged.push(c), onPlan: () => undefined, onSubagent: () => undefined },
      agentKey: 'a1',
      ...(withCallback ? { onCompaction: (c: AgentCompactionEvent) => handed.push(c) } : {}),
    });
    return { flow, sink, logged, handed };
  }

  it('records the turn\'s own compaction: on the record, on the session log and to the caller', () => {
    const t = turn();
    t.sink(event());
    const { compactions } = t.flow.snapshot();
    expect(compactions).toHaveLength(1);
    expect(compactions[0]).toMatchObject({ messagesCompressed: 6, tokensBefore: 8000, tokensAfter: 1500, index: 1, afterToolCallId: null });
    expect(t.logged).toEqual(compactions);
    expect(t.handed).toEqual(compactions);
  });

  it('a sub-agent\'s compaction of its own context is not the turn\'s: it goes to its run, to the log and to the caller with its name', () => {
    const t = turn();
    t.sink(event(child));
    expect(t.flow.snapshot().compactions).toEqual([]);
    expect(t.flow.snapshot().subagentRuns[0].compactions).toHaveLength(1);
    expect(t.logged).toHaveLength(1);
    expect(t.handed).toEqual(t.logged);
    expect(t.handed[0]).toMatchObject({ subagent: { id: 'sa_1', name: 'helper' } });
  });

  it('a live-only start / skipped frame reaches the caller, never the log or the record', () => {
    const t = turn();
    t.sink(event({ phase: 'start', id: 'call_summary_1', summary: '' }));
    t.sink(event({ phase: 'skipped', id: 'call_summary_1', summary: '' }));
    expect(t.handed.map((c) => c.phase)).toEqual(['start', 'skipped']);
    expect(t.logged).toEqual([]);
    expect(t.flow.snapshot().compactions).toEqual([]);
  });

  it('a caller callback that throws never breaks the run, and a turn without a log or a callback still records', () => {
    const boom = vi.fn(() => { throw new Error('boom'); });
    const flow = createTurnFlowTracker();
    const sink = createTurnFlowSink({ tracker: flow, turnEvents: undefined, onCompaction: boom, agentKey: 'a1' });
    expect(() => sink(event())).not.toThrow();
    expect(boom).toHaveBeenCalledTimes(1);
    const quiet = createTurnFlowSink({ tracker: flow, turnEvents: undefined, agentKey: 'a1' });
    quiet(event());
    expect(flow.snapshot().compactions).toHaveLength(2);
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

describe('delegatedSubagentName on a start event', () => {
  it('labels spawn_subagent with the role it spawns, and names a delegate_to target', async () => {
    const { delegatedSubagentName } = await import('@/lib/services/agents/subagentEvents');
    expect(delegatedSubagentName('spawn_subagent', { role: 'researcher', task: 'x' }, undefined)).toBe('researcher');
    expect(delegatedSubagentName('delegate_to', { subagent: 'writer' }, undefined)).toBe('writer');
    expect(delegatedSubagentName('delegate_to', { role: 'ignored' }, undefined)).toBeUndefined();
    expect(delegatedSubagentName('web_search', { role: 'x' }, undefined)).toBeUndefined();
  });
});

describe('the step ids of a stored turn', () => {
  const entry = (executionId: string, toolName: string, callId: string | undefined, extra: Record<string, unknown> = {}) => ({
    executionId, toolName, args: {}, output: 'ok', status: 'success', ...(callId !== undefined ? { tool_call_id: callId } : {}), ...extra,
  });
  const stepsOf = (history: unknown[], prior?: ReadonlySet<string>) =>
    extractPlaygroundSteps({ state: { toolHistory: history, messages: [] } } as never, prior);

  it('names a step by the call the model made, not by the SDK\'s execution id', () => {
    expect(stepsOf([entry('ex_a', 'lookup', 'call_1'), entry('ex_b', 'lookup', 'call_2')]).map((s) => s.id)).toEqual(['call_1', 'call_2']);
  });

  it('falls back to the execution id for a call recorded without one', () => {
    const steps = stepsOf([entry('ex_a', 'lookup', undefined), entry('ex_b', 'lookup', ''), entry('ex_c', 'lookup', undefined, { tool_call_id: 7 })]);
    expect(steps.map((s) => s.id)).toEqual(['ex_a', 'ex_b', 'ex_c']);
  });

  it('still leaves out the calls of earlier turns, by their execution id', () => {
    const steps = stepsOf([entry('ex_old', 'lookup', 'call_0'), entry('ex_new', 'lookup', 'call_1')], new Set(['ex_old']));
    expect(steps.map((s) => s.id)).toEqual(['call_1']);
  });

  it('lets the plan, the sub-agent group and the pass of the turn find the step they follow', () => {
    // What a turn records anchors on the call ids the live events carry; the execution ids are other strings.
    const steps = stepsOf([
      entry('ex_1', 'manage_plan', 'call_1'),
      entry('ex_2', 'delegate_to', 'call_2', { args: { subagent: 'helper' }, output: { name: 'helper', status: 'ok', content: 'legwork' } }),
      entry('ex_3', 'lookup', 'call_3'),
    ]);
    const blocks = orderTurnFlow({
      steps,
      plans: [{ toolCallId: 'call_1', version: 1, operation: 'write', steps: [{ id: 1, title: 'Look it up', status: 'in-progress' }], at: '2026-10-23T10:00:00.000Z' }],
      subagentRuns: [{ id: 'sa_1', name: 'helper', parentToolCallId: 'call_2', phase: 'result', steps: [] }],
      compactions: [{ at: '2026-10-23T10:00:05.000Z', id: 'pass-1', index: 1, afterToolCallId: 'call_2' }],
    });
    // The plan stands in for its manage_plan step, the run sits on its delegation call (not a second group for an
    // orphan), and the pass follows the call it came after.
    expect(blocks.map((b) => b.kind)).toEqual(['plan', 'subagents', 'compaction', 'steps']);
    expect(blocks[1]).toMatchObject({ parentToolCallId: 'call_2', step: { id: 'call_2', name: 'delegate_to' }, runs: [{ id: 'sa_1' }] });
    expect(blocks[3]).toMatchObject({ steps: [{ id: 'call_3', name: 'lookup' }] });
  });
});

describe('createTurnFlowSink: the children of a parallel call', () => {
  const sub = (phase: string, id: string, parent: string, extra: Record<string, unknown> = {}) => ({
    type: 'subagent', phase, id, name: `worker ${id}`, mode: 'adhoc', parentToolCallId: parent, parallel: true, ...extra,
  }) as never;

  /** The SDK keys each child of `spawn_subagents_parallel` `<call>#<index>`; the call itself is `call_9`. */
  function parallelTurn() {
    const told: AgentSubagentEvent[] = [];
    const logged: AgentSubagentEvent[] = [];
    const stamps: Array<AgentToolCallSubagentStamp | undefined> = [];
    const flow = createTurnFlowTracker();
    const sink = createTurnFlowSink({
      tracker: flow,
      turnEvents: { onSdkEvent: (_event, stamp) => stamps.push(stamp), onCompaction: () => undefined, onPlan: () => undefined, onSubagent: (e) => logged.push(e) },
      agentKey: 'a1',
      onSubagent: (e) => told.push(e),
    });
    sink({ type: 'tool_call', phase: 'start', name: 'spawn_subagents_parallel', id: 'call_9' } as never);
    sink(sub('start', 'sa_1', 'call_9#0'));
    sink(sub('start', 'sa_2', 'call_9#1'));
    sink({ type: 'tool_call', phase: 'start', name: 'lookup', id: 'c1', subagentId: 'sa_2', subagentName: 'worker sa_2' } as never);
    sink(sub('result', 'sa_1', 'call_9#0', { content: 'one', status: 'ok' }));
    sink(sub('result', 'sa_2', 'call_9#1', { content: 'two', status: 'ok' }));
    sink({ type: 'tool_call', phase: 'success', name: 'spawn_subagents_parallel', id: 'call_9' } as never);
    return { flow, told, logged, stamps };
  }

  it('names the call itself on every frame, log row, record and child call stamp, and keeps them parallel', () => {
    const t = parallelTurn();
    for (const seen of [t.told, t.logged]) {
      expect(seen.map((e) => [e.phase, e.id, e.parentToolCallId, e.parallel])).toEqual([
        ['start', 'sa_1', 'call_9', true], ['start', 'sa_2', 'call_9', true], ['result', 'sa_1', 'call_9', true], ['result', 'sa_2', 'call_9', true],
      ]);
    }
    expect(t.flow.snapshot().subagentRuns.map((r) => [r.id, r.parentToolCallId, r.parallel])).toEqual([['sa_1', 'call_9', true], ['sa_2', 'call_9', true]]);
    expect(t.stamps.find((stamp) => stamp?.id === 'sa_2')).toEqual({ id: 'sa_2', name: 'worker sa_2', parentToolCallId: 'call_9', parallel: true });
  });

  it('puts the children of one call in one group, anchored to the call', () => {
    const blocks = orderTurnFlow({
      steps: [{ id: 'call_9', name: 'spawn_subagents_parallel', status: 'success' }],
      subagentRuns: parallelTurn().flow.snapshot().subagentRuns,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'subagents', parentToolCallId: 'call_9', parallel: true, runs: [{ id: 'sa_1' }, { id: 'sa_2' }] });
  });

  it('groups runs stored under the SDK\'s own keys by their call as well', () => {
    const run = (id: string, parent: string) => ({ id, name: id, parentToolCallId: parent, parallel: true, phase: 'result' as const, steps: [] });
    const blocks = orderTurnFlow({
      steps: [{ id: 'call_9', name: 'spawn_subagents_parallel', status: 'success' }],
      subagentRuns: [run('sa_1', 'call_9#0'), run('sa_2', 'call_9#1')],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'subagents', parentToolCallId: 'call_9', runs: [{ id: 'sa_1' }, { id: 'sa_2' }] });
  });
});

describe('createTurnFlowSink: a sub-agent run past the cap', () => {
  it('neither tells nor logs what the child of a dropped run does, and still does for a kept one', () => {
    const told: AgentToolCallEvent[] = [];
    const logged: Array<string | undefined> = [];
    const passes: AgentCompactionEvent[] = [];
    const loggedPasses: AgentCompactionEvent[] = [];
    const flow = createTurnFlowTracker();
    const sink = createTurnFlowSink({
      tracker: flow,
      turnEvents: {
        onSdkEvent: (event) => logged.push((event as { id?: string }).id),
        onCompaction: (c) => loggedPasses.push(c),
        onPlan: () => undefined,
        onSubagent: () => undefined,
      },
      agentKey: 'a1',
      onToolEvent: (e) => told.push(e),
      onCompaction: (c) => passes.push(c),
    });
    for (let i = 0; i <= TURN_FLOW_LIMITS.runs; i += 1) sink({ type: 'subagent', phase: 'start', id: `sa_${i}`, name: `w${i}` } as never);
    const kept = { subagentId: 'sa_0', subagentName: 'w0' };
    const dropped = { subagentId: `sa_${TURN_FLOW_LIMITS.runs}`, subagentName: `w${TURN_FLOW_LIMITS.runs}` };
    const call = (phase: string, id: string, who: object) => sink({ type: 'tool_call', phase, name: 'lookup', id, ...who } as never);

    call('start', 'k1', kept);
    call('start', 'x1', dropped);
    call('success', 'x1', dropped);
    call('success', 'k1', kept);
    sink({ type: 'summarization', phase: 'start', id: 's1', summary: '', ...dropped } as never);
    sink({ type: 'summarization', summary: 'S', messagesCompressed: 2, ...dropped } as never);
    sink({ type: 'summarization', summary: 'S', messagesCompressed: 2, ...kept } as never);
    call('start', 'own', {});

    expect(told.map((e) => e.id)).toEqual(['k1', 'k1', 'own']);
    expect(logged).toEqual(['k1', 'k1', 'own']);
    expect(told[0].subagent).toEqual({ id: 'sa_0', name: 'w0' });
    expect(told[2].subagent).toBeUndefined();
    expect(passes.map((p) => p.subagent?.id)).toEqual(['sa_0']);
    expect(loggedPasses.map((p) => p.subagent?.id)).toEqual(['sa_0']);
    expect(flow.snapshot().subagentRunsDropped).toBe(1);
  });
});

describe('turnFlowRecord: plan versions', () => {
  const { turnFlowRecord } = __testables;
  const call = (phase: string, name: string, id: string, extra: Record<string, unknown> = {}) => ({ type: 'tool_call', phase, name, id, ...extra }) as never;
  const plan = (operation: string, version = 1) => ({
    type: 'plan', source: 'manage_plan', operation, version, todoList: [{ id: 1, step: 'Look', status: 'in-progress' }], adherenceScore: 0,
  }) as never;
  const recordOf = (events: unknown[]) => {
    const flow = createTurnFlowTracker();
    const sink = createTurnFlowSink({ tracker: flow, turnEvents: undefined, agentKey: 'a1' });
    for (const event of events) sink(event as never);
    return turnFlowRecord(flow, () => []);
  };

  it('keeps an empty list for a turn that only read its plan: a reader leaves that call out, as the live view does', () => {
    expect(recordOf([call('start', 'manage_plan', 'p1'), plan('read'), call('success', 'manage_plan', 'p1')]).plans).toEqual([]);
    expect(recordOf([call('start', 'manage_todo_list', 'p1'), call('success', 'manage_todo_list', 'p1')]).plans).toEqual([]);
  });

  it('keeps the versions of a turn that wrote one', () => {
    const { plans } = recordOf([call('start', 'manage_plan', 'p1'), plan('write'), call('success', 'manage_plan', 'p1'), call('start', 'manage_plan', 'p2'), plan('read'), call('success', 'manage_plan', 'p2')]);
    expect(plans).toHaveLength(1);
    expect(plans![0]).toMatchObject({ version: 1, toolCallId: 'p1' });
  });

  it('leaves the field off a turn with no plan call, a failed one, or only a sub-agent\'s', () => {
    for (const events of [
      [call('start', 'lookup', 'x'), call('success', 'lookup', 'x')],
      [call('start', 'manage_plan', 'p1'), call('error', 'manage_plan', 'p1')],
      [call('start', 'manage_plan', 'c1', child), call('success', 'manage_plan', 'c1', child)],
      [],
    ]) {
      expect(recordOf(events)).not.toHaveProperty('plans');
    }
  });
});
