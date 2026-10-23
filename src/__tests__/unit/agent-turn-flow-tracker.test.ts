/**
 * The turn flow tracker: from the SDK's events, in arrival order, to the plan
 * versions, the sub-agent runs and the positioned summarization passes a turn
 * records, and to the frames it forwards live.
 *
 * Pure: the tracker takes plain event objects, so the tests feed it the shapes the
 * SDK emits (agent-sdk 0.18/0.19, and 0.20's additions) without any agent.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  TURN_FLOW_LIMITS,
  createTurnFlowTracker,
  planStepsOf,
  subagentTargets,
} from '@/lib/services/agents/turnFlowTracker';
import { sessionPlanOf, mayHavePlan, readSessionPlan, sessionPlanFromMessages } from '@/lib/services/agents/sessionPlan';

const AT = new Date('2026-10-23T10:00:00.000Z');
const tracker = (options: Parameters<typeof createTurnFlowTracker>[0] = {}) => createTurnFlowTracker({ now: () => AT, ...options });

const tool = (phase: 'start' | 'success' | 'error', name: string, id: string, extra: Record<string, unknown> = {}) => ({
  type: 'tool_call', phase, name, id, ...extra,
});
const child = (id = 'sa_1', name = 'helper') => ({ subagentId: id, subagentName: name });
const step = (id: number, status = 'not-started', extra: Record<string, unknown> = {}) => ({
  id, step: `Step ${id}`, owner: 'agent', exitCriteria: `Done ${id}`, status, ...extra,
});
const plan = (version: number, todoList: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'plan', source: 'manage_plan', operation: 'write', version, todoList, adherenceScore: 0, ...extra,
});
const subagent = (phase: string, extra: Record<string, unknown> = {}) => ({
  type: 'subagent', phase, id: 'sa_1', name: 'helper', mode: 'registry', ...extra,
});
const summary = (extra: Record<string, unknown> = {}) => ({
  type: 'summarization', summary: 'S', messagesCompressed: 6, tokenCountBefore: 8000, tokenCountAfter: 1500, ...extra,
});

describe('plan versions', () => {
  it('anchors a version on the call id the event carries (agent-sdk >= 0.20)', () => {
    const t = tracker();
    t.noteToolCall(tool('start', 'manage_plan', 'p1'));
    const written = t.notePlan(plan(1, [step(1)], { toolCallId: 'p1' }));
    expect(written).toMatchObject({ toolCallId: 'p1', version: 1, operation: 'write', at: AT.toISOString() });
    expect(written?.steps).toEqual([{ id: 1, title: 'Step 1', status: 'not-started', owner: 'agent', exitCriteria: 'Done 1' }]);
    expect(t.snapshot().plans).toHaveLength(1);
  });

  it('without a call id, anchors on the newest plan call still open', () => {
    const t = tracker();
    t.noteToolCall(tool('start', 'manage_plan', 'p1'));
    t.noteToolCall(tool('start', 'web_search', 's1'));
    t.noteToolCall(tool('start', 'manage_todo_list', 'p2'));
    expect(t.notePlan(plan(1, [step(1)]))?.toolCallId).toBe('p2');
    // p2 finishes; p1 is the only plan call left open.
    t.noteToolCall(tool('success', 'manage_todo_list', 'p2'));
    expect(t.notePlan(plan(2, [step(1, 'completed')], { operation: 'update' }))?.toolCallId).toBe('p1');
  });

  it('has no anchor when no plan call is open, and a stamped child call never anchors the parent\'s plan', () => {
    const t = tracker();
    t.noteToolCall(tool('start', 'manage_plan', 'cp1', child()));
    expect(t.notePlan(plan(1, [step(1)]))).not.toHaveProperty('toolCallId');
  });

  it('keeps a plan write or update, and skips a read and a child\'s plan', () => {
    const t = tracker();
    expect(t.notePlan(plan(1, [step(1)], { operation: 'read' }))).toBeUndefined();
    expect(t.notePlan(plan(1, [step(1)], child()))).toBeUndefined();
    expect(t.notePlan({ type: 'plan', todoList: [step(1)], version: 1 })).toBeUndefined();
    expect(t.notePlan(plan(1, [step(1)], { operation: 'update' }))).toMatchObject({ operation: 'update' });
    expect(t.snapshot().plans).toHaveLength(1);
  });

  it('skips a version already recorded in the leg, and counts on when the event carries none', () => {
    const t = tracker();
    expect(t.notePlan(plan(3, [step(1)]))).toBeDefined();
    expect(t.notePlan(plan(3, [step(1, 'completed')]))).toBeUndefined();
    expect(t.notePlan({ type: 'plan', operation: 'update', todoList: [step(1)] })).toMatchObject({ version: 4 });
    expect(t.snapshot().plans.map((p) => p.version)).toEqual([3, 4]);
  });

  it('reads the steps: title falls back to the step text, text is clipped, an unknown status is not started', () => {
    const long = 'x'.repeat(900);
    const written = tracker().notePlan(plan(1, [
      { id: 7, step: 'Old text', title: 'New title', status: 'in-progress', owner: long, evidence: 'saw it' },
      { id: 'b', step: long, status: 'weird' },
      { step: 'No id' },
    ]));
    expect(written?.steps[0]).toMatchObject({ id: 7, title: 'New title', status: 'in-progress', evidence: 'saw it' });
    expect(written?.steps[0].owner).toHaveLength(TURN_FLOW_LIMITS.planText);
    expect(written?.steps[1]).toMatchObject({ id: 'b', status: 'not-started' });
    expect(written?.steps[1].title).toHaveLength(TURN_FLOW_LIMITS.planText);
    expect(written?.steps[2]).toMatchObject({ id: 3, title: 'No id' });
  });

  it('keeps at most 100 steps and takes the completion from the adherence score', () => {
    const written = tracker().notePlan(plan(1, Array.from({ length: 150 }, (_, i) => step(i + 1)), { adherenceScore: 0.4 }));
    expect(written?.steps).toHaveLength(100);
    expect(written?.completion).toBe(0.4);
    expect(planStepsOf('nope')).toEqual([]);
  });

  it('keeps the first version and the latest 29 past the cap', () => {
    const t = tracker();
    for (let v = 1; v <= 35; v += 1) t.notePlan(plan(v, [step(1)]));
    const versions = t.snapshot().plans.map((p) => p.version);
    expect(versions).toHaveLength(TURN_FLOW_LIMITS.plans);
    expect(versions[0]).toBe(1);
    expect(versions.slice(1)).toEqual(Array.from({ length: 29 }, (_, i) => 7 + i));
  });

  it('counts the agent\'s successful plan calls, whatever they wrote, so a read can be told from no plan call at all', () => {
    const t = tracker();
    expect(t.snapshot().planCalls).toBe(0);
    t.noteToolCall(tool('start', 'manage_plan', 'p1'));
    expect(t.snapshot().planCalls).toBe(0);
    t.noteToolCall(tool('success', 'manage_plan', 'p1'));
    t.noteToolCall(tool('start', 'manage_todo_list', 'p2'));
    t.noteToolCall(tool('success', 'manage_todo_list', 'p2'));
    expect(t.snapshot().planCalls).toBe(2);
    // A failed call, any other tool and a sub-agent's own plan call are not the agent's plan being read.
    t.noteToolCall(tool('start', 'manage_plan', 'p3'));
    t.noteToolCall(tool('error', 'manage_plan', 'p3'));
    t.noteToolCall(tool('success', 'web_search', 'w1'));
    t.noteToolCall(tool('success', 'manage_plan', 'c1', child()));
    expect(t.snapshot().planCalls).toBe(2);
    // The read itself writes no version.
    expect(t.notePlan(plan(1, [step(1)], { operation: 'read' }))).toBeUndefined();
    expect(t.snapshot().plans).toEqual([]);
  });
});

describe('sub-agent runs', () => {
  it('records a run from its start to its result, and returns the lifecycle frames', () => {
    const t = tracker();
    const started = t.noteSubagent(subagent('start', { parentToolCallId: 'd1', input: 'Find the report' }));
    expect(started).toEqual({
      phase: 'start', id: 'sa_1', name: 'helper', mode: 'registry', parentToolCallId: 'd1', input: 'Find the report', at: AT.toISOString(),
    });
    const done = t.noteSubagent(subagent('result', {
      parentToolCallId: 'd1',
      content: 'Found it',
      status: 'ok',
      durationMs: 1200,
      usage: { perRequest: [], totals: { 'gpt-x': { input: 100, output: 40, total: 140, cachedInput: 0 } } },
    }));
    expect(done).toMatchObject({ phase: 'result', content: 'Found it', status: 'ok', durationMs: 1200, usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } });
    expect(done).not.toHaveProperty('input');
    expect(t.snapshot().subagentRuns).toEqual([{
      id: 'sa_1',
      name: 'helper',
      mode: 'registry',
      parentToolCallId: 'd1',
      phase: 'result',
      status: 'ok',
      input: 'Find the report',
      result: 'Found it',
      durationMs: 1200,
      usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
      startedAt: AT.toISOString(),
      endedAt: AT.toISOString(),
      steps: [],
    }]);
  });

  it('sums the usage over models, however its keys are cased', () => {
    const t = tracker();
    t.noteSubagent(subagent('start'));
    const done = t.noteSubagent(subagent('result', { usage: { totals: { a: { input: 10, output: 5, total: 15 }, b: { input: 1, output: 1, total: 2 } } } }));
    expect(done?.usage).toEqual({ inputTokens: 11, outputTokens: 6, totalTokens: 17 });
    const camel = tracker();
    camel.noteSubagent(subagent('start'));
    expect(camel.noteSubagent(subagent('result', { usage: { inputTokens: 3, outputTokens: 4 } }))?.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  });

  it('clips the task and the answer to 2 KB, and reports an error and a pause', () => {
    const t = tracker();
    const started = t.noteSubagent(subagent('start', { input: 'i'.repeat(5000) }));
    expect(started?.input).toHaveLength(TURN_FLOW_LIMITS.runText);
    const failed = t.noteSubagent(subagent('error', { content: 'c'.repeat(5000), error: { message: 'boom' }, status: 'error' }));
    expect(failed?.content).toHaveLength(TURN_FLOW_LIMITS.runText);
    expect(failed).toMatchObject({ phase: 'error', error: 'boom', status: 'error' });

    const p = tracker();
    p.noteSubagent(subagent('start'));
    const paused = p.noteSubagent(subagent('paused', { status: 'needs_input', note: 'waiting for approval' }));
    expect(paused).toMatchObject({ phase: 'paused', status: 'needs_input', note: 'waiting for approval' });
    expect(p.snapshot().subagentRuns[0]).not.toHaveProperty('endedAt');
  });

  it('ignores a stamped (nested) subagent event, an unknown phase and one without an id', () => {
    const t = tracker();
    expect(t.noteSubagent(subagent('start', child('sa_9', 'inner')))).toBeUndefined();
    expect(t.noteSubagent(subagent('weird'))).toBeUndefined();
    expect(t.noteSubagent({ type: 'subagent', phase: 'start', name: 'x' })).toBeUndefined();
    expect(t.snapshot().subagentRuns).toEqual([]);
  });

  it('collects a child\'s tool calls as steps of its run, and stamps them with the delegation', () => {
    const t = tracker();
    t.noteToolCall(tool('start', 'spawn_subagents_parallel', 'd1'));
    t.noteSubagent(subagent('start', { parentToolCallId: 'd1', parallel: true }));

    const started = t.noteToolCall(tool('start', 'web_search', 'c1', { ...child(), args: { q: 'cognipeer' } }));
    expect(started.stamp).toEqual({ id: 'sa_1', name: 'helper', parentToolCallId: 'd1', parallel: true });
    t.noteToolCall(tool('success', 'web_search', 'c1', { ...child(), result: { hits: 3 }, durationMs: 40 }));
    t.noteToolCall(tool('start', 'read_url', 'c2', child()));
    t.noteToolCall(tool('error', 'read_url', 'c2', { ...child(), error: { message: '404' }, durationMs: 5 }));

    expect(t.snapshot().subagentRuns[0].steps).toEqual([
      { id: 'c1', name: 'web_search', status: 'success', args: { q: 'cognipeer' }, output: { hits: 3 }, durationMs: 40, timestamp: AT.toISOString() },
      { id: 'c2', name: 'read_url', status: 'error', error: '404', durationMs: 5, timestamp: AT.toISOString() },
    ]);
  });

  it('leaves the parent\'s own calls unstamped and out of the run', () => {
    const t = tracker();
    t.noteSubagent(subagent('start'));
    expect(t.noteToolCall(tool('start', 'web_search', 'p1'))).toEqual({});
    expect(t.snapshot().subagentRuns[0].steps).toEqual([]);
  });

  it('a child\'s event for a run it has not seen creates a resumed run from the stamp', () => {
    const t = tracker();
    t.noteToolCall(tool('start', 'delegate_to', 'd1', { }));
    const { stamp } = t.noteToolCall(tool('start', 'lookup', 'c1', child('sa_7', 'researcher')));
    const [run] = t.snapshot().subagentRuns;
    expect(run).toMatchObject({ id: 'sa_7', name: 'researcher', resumed: true, phase: 'start', parentToolCallId: 'd1' });
    expect(run.steps).toHaveLength(1);
    expect(stamp).toMatchObject({ id: 'sa_7', parentToolCallId: 'd1' });
  });

  it('does not guess the delegation of a run when several are open', () => {
    const t = tracker();
    t.noteToolCall(tool('start', 'delegate_to', 'd1'));
    t.noteToolCall(tool('start', 'delegate_to', 'd2'));
    t.noteToolCall(tool('start', 'lookup', 'c1', child()));
    expect(t.snapshot().subagentRuns[0]).not.toHaveProperty('parentToolCallId');
  });

  it('a start that arrives after the child\'s first call settles the run, and marks a re-entered delegation as resumed', () => {
    const t = tracker();
    t.noteToolCall(tool('start', 'lookup', 'c1', child()));
    expect(t.snapshot().subagentRuns[0].resumed).toBe(true);
    t.noteSubagent(subagent('start', { parentToolCallId: 'd1', input: 'task' }));
    expect(t.snapshot().subagentRuns[0]).not.toHaveProperty('resumed');

    const resumed = tracker({ resumedDelegationIds: new Set(['d9']) });
    const frame = resumed.noteSubagent(subagent('start', { id: 'sa_2', parentToolCallId: 'd9' }));
    expect(frame).toMatchObject({ resumed: true });
    expect(resumed.snapshot().subagentRuns[0].resumed).toBe(true);
  });

  it('a run whose first event is its answer was started by an earlier leg: it is a resumed run', () => {
    const t = tracker();
    const frame = t.noteSubagent(subagent('result', { parentToolCallId: 'd1', content: 'done', status: 'ok' }));
    expect(frame).toMatchObject({ phase: 'result', resumed: true, parentToolCallId: 'd1' });
    expect(t.snapshot().subagentRuns[0]).toMatchObject({ id: 'sa_1', resumed: true, result: 'done' });
  });

  it('finds a child without an id by its name', () => {
    const t = tracker();
    t.noteSubagent(subagent('start'));
    t.noteToolCall(tool('start', 'lookup', 'c1', { subagentName: 'helper' }));
    expect(t.snapshot().subagentRuns).toHaveLength(1);
    expect(t.snapshot().subagentRuns[0].steps).toHaveLength(1);
  });

  it('fills the target from the roster', () => {
    const targets = subagentTargets([
      { kind: 'ref', name: 'helper', agentKey: 'researcher-agent', agentVersion: 3 },
      { kind: 'inline', name: 'writer' },
    ]);
    const t = tracker({ targets });
    t.noteSubagent(subagent('start'));
    t.noteSubagent(subagent('start', { id: 'sa_2', name: 'writer' }));
    t.noteSubagent(subagent('start', { id: 'sa_3', name: 'adhoc role' }));
    const runs = t.snapshot().subagentRuns;
    expect(runs[0].target).toEqual({ kind: 'ref', agentName: 'researcher-agent', version: 3 });
    expect(runs[1].target).toEqual({ kind: 'inline' });
    expect(runs[2]).not.toHaveProperty('target');
  });
});

describe('sub-agent caps', () => {
  it('keeps at most 50 steps of a run and counts the rest', () => {
    const t = tracker();
    t.noteSubagent(subagent('start'));
    for (let i = 0; i < 55; i += 1) t.noteToolCall(tool('start', 'lookup', `c${i}`, child()));
    // A dropped call's result is not mistaken for a new step.
    t.noteToolCall(tool('success', 'lookup', 'c54', { ...child(), result: 'late' }));
    const [run] = t.snapshot().subagentRuns;
    expect(run.steps).toHaveLength(TURN_FLOW_LIMITS.stepsPerRun);
    expect(run.stepsDropped).toBe(5);
  });

  it('keeps a small value whole and cuts a large one to a 1 KB preview of its JSON', () => {
    const t = tracker();
    t.noteSubagent(subagent('start'));
    const big = { text: 'y'.repeat(3000) };
    t.noteToolCall(tool('start', 'small', 'a', { ...child(), args: { q: 'hi' } }));
    t.noteToolCall(tool('success', 'small', 'a', { ...child(), result: 'ok' }));
    t.noteToolCall(tool('start', 'large', 'b', { ...child(), args: big }));
    t.noteToolCall(tool('success', 'large', 'b', { ...child(), result: big }));
    const [small, large] = t.snapshot().subagentRuns[0].steps;
    expect(small).toMatchObject({ args: { q: 'hi' }, output: 'ok' });
    expect(small).not.toHaveProperty('_truncated');
    expect(typeof large.args).toBe('string');
    expect((large.args as string).length).toBe(TURN_FLOW_LIMITS.stepValue);
    expect(large.output).toBe(JSON.stringify(big).slice(0, TURN_FLOW_LIMITS.stepValue));
    expect(large._truncated).toBe(true);
  });

  it('keeps neither args nor output once the leg\'s 64 KB budget is spent', () => {
    const t = tracker();
    const value = 'z'.repeat(1000);
    let withoutValues = 0;
    for (let run = 0; run < 4; run += 1) {
      const stamp = child(`sa_${run}`, `helper${run}`);
      t.noteSubagent(subagent('start', { id: `sa_${run}`, name: `helper${run}` }));
      for (let i = 0; i < 50; i += 1) {
        t.noteToolCall(tool('start', 'lookup', `c${run}-${i}`, { ...stamp, args: value }));
        t.noteToolCall(tool('success', 'lookup', `c${run}-${i}`, { ...stamp, result: value }));
      }
    }
    const steps = t.snapshot().subagentRuns.flatMap((run) => run.steps);
    let stored = 0;
    for (const s of steps) {
      if (s.args !== undefined) stored += JSON.stringify(s.args).length;
      if (s.output !== undefined) stored += JSON.stringify(s.output).length;
      if (s.args === undefined && s.output === undefined) {
        withoutValues += 1;
        expect(s._truncated).toBe(true);
      }
    }
    expect(stored).toBeLessThanOrEqual(TURN_FLOW_LIMITS.stepBudget);
    expect(withoutValues).toBeGreaterThan(0);
    // Every step is still there: the budget costs detail, not rows.
    expect(steps).toHaveLength(200);
  });

  it('keeps at most 64 runs, counts the rest and ignores a dropped run\'s later events', () => {
    const t = tracker();
    for (let i = 0; i < 66; i += 1) t.noteSubagent(subagent('start', { id: `sa_${i}`, name: `w${i}` }));
    expect(t.snapshot().subagentRuns).toHaveLength(TURN_FLOW_LIMITS.runs);
    expect(t.snapshot().subagentRunsDropped).toBe(2);
    expect(t.noteSubagent(subagent('result', { id: 'sa_65', name: 'w65' }))).toBeUndefined();
    // Its children's calls are neither stamped nor kept: no group shows them, so live would show a run that never ends.
    expect(t.noteToolCall(tool('start', 'lookup', 'c1', child('sa_65', 'w65')))).toEqual({ dropped: true });
    expect(t.snapshot().subagentRunsDropped).toBe(2);
    // A run already kept still updates, and so do its children's calls.
    expect(t.noteSubagent(subagent('result', { id: 'sa_0', name: 'w0' }))).toMatchObject({ phase: 'result' });
    expect(t.noteToolCall(tool('start', 'lookup', 'c2', child('sa_0', 'w0'))).stamp).toEqual({ id: 'sa_0', name: 'w0' });
  });

  it('marks every call of a dropped run\'s child as dropped, and leaves the agent\'s own calls and passes alone', () => {
    const t = tracker();
    for (let i = 0; i <= TURN_FLOW_LIMITS.runs; i += 1) t.noteSubagent(subagent('start', { id: `sa_${i}`, name: `w${i}` }));
    const dropped = child(`sa_${TURN_FLOW_LIMITS.runs}`, `w${TURN_FLOW_LIMITS.runs}`);
    for (const phase of ['start', 'success', 'error'] as const) {
      expect(t.noteToolCall(tool(phase, 'lookup', 'c1', dropped))).toEqual({ dropped: true });
    }
    // An unknown phase of the same child is dropped too, and the agent's own calls are untouched.
    expect(t.noteToolCall(tool('progress' as never, 'lookup', 'c1', dropped))).toEqual({ dropped: true });
    expect(t.noteToolCall(tool('start', 'lookup', 'own'))).toEqual({});
    t.noteToolCall(tool('success', 'lookup', 'own'));
    expect(t.noteCompaction(summary())?.event).toMatchObject({ afterToolCallId: 'own' });
    expect(t.snapshot().subagentRuns).toHaveLength(TURN_FLOW_LIMITS.runs);
  });

  it('drops the calls of a run first seen through them once the cap is reached, and counts that run once', () => {
    const t = tracker();
    for (let i = 0; i < TURN_FLOW_LIMITS.runs; i += 1) t.noteSubagent(subagent('start', { id: `sa_${i}`, name: `w${i}` }));
    // A leg that continues a run an earlier leg started sees the child's calls before any lifecycle event of the run.
    const late = child('sa_late', 'late-worker');
    expect(t.noteToolCall(tool('start', 'lookup', 'c1', late))).toEqual({ dropped: true });
    expect(t.noteToolCall(tool('success', 'lookup', 'c1', late))).toEqual({ dropped: true });
    expect(t.noteCompaction(summary({ id: 'p1', ...late }))).toBeUndefined();
    expect(t.snapshot().subagentRunsDropped).toBe(1);
    expect(t.snapshot().subagentRuns).toHaveLength(TURN_FLOW_LIMITS.runs);
  });

  it('tells nothing of a dropped run\'s summarization passes, live or finished, and still keeps a kept run\'s', () => {
    const t = tracker();
    for (let i = 0; i <= TURN_FLOW_LIMITS.runs; i += 1) t.noteSubagent(subagent('start', { id: `sa_${i}`, name: `w${i}` }));
    const dropped = child(`sa_${TURN_FLOW_LIMITS.runs}`, `w${TURN_FLOW_LIMITS.runs}`);
    expect(t.noteCompaction(summary({ phase: 'start', id: 'p1', ...dropped }))).toBeUndefined();
    expect(t.noteCompaction(summary({ phase: 'skipped', id: 'p1', ...dropped }))).toBeUndefined();
    expect(t.noteCompaction(summary({ id: 'p1', ...dropped }))).toBeUndefined();
    expect(t.snapshot().subagentRunsDropped).toBe(1);
    expect(t.noteCompaction(summary({ id: 'p2', ...child('sa_0', 'w0') }))).toMatchObject({ persist: true, event: { id: 'p2', subagent: { id: 'sa_0', name: 'w0' } } });
    expect(t.snapshot().subagentRuns[0].compactions).toHaveLength(1);
  });

  it('bounds what a run keeps of its passes: every text to 2 KB, every list to ten entries, ids and counts untouched', () => {
    const t = tracker();
    t.noteSubagent(subagent('start'));
    const long = 'w'.repeat(5000);
    const many = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));
    const note = t.noteCompaction(summary({
      ...child(),
      id: 'p1',
      trigger: 'mid_leg',
      messagesCompressed: 9,
      structuredSummary: {
        user_directives: many(30, (i) => `directive ${i}`),
        user_directive_sources: Object.fromEntries(many(30, (i) => [`directive ${i}`, long]) as Array<[string, string]>),
        stable_facts: many(30, (i) => ({ key: `fact ${i}`, value: long })),
        active_goals: [long, 'second'],
        open_questions: many(12, (i) => `question ${i}`),
        discarded_obsolete: ['old'],
      },
      droppedDirectives: many(12, () => ({ directive: long, reason: 'no user message says so', sourceQuote: long })),
      integrity: { notes: many(15, (i) => `note ${i}`) },
      compactedTools: many(80, (i) => ({ toolName: 'lookup', toolCallId: `c${i}` })),
    }));
    const limit = TURN_FLOW_LIMITS.runText;
    const items = TURN_FLOW_LIMITS.compactionItems;
    const [kept] = t.snapshot().subagentRuns[0].compactions!;
    for (const pass of [kept, note!.event]) {
      expect(pass).toMatchObject({ id: 'p1', index: 1, trigger: 'mid_leg', messagesCompressed: 9 });
      expect(pass.summary!.userDirectives).toEqual(many(items, (i) => `directive ${i}`));
      const sources = Object.entries(pass.summary!.directiveSources!);
      expect(sources).toHaveLength(items);
      expect(sources.every(([directive, quote]) => directive.startsWith('directive ') && quote.length === limit && quote.endsWith('…'))).toBe(true);
      expect(pass.summary!.facts).toHaveLength(items);
      expect(pass.summary!.facts!.every((fact) => fact.key.startsWith('fact ') && fact.value.length === limit)).toBe(true);
      expect(pass.summary!.goals!.map((goal) => goal.length)).toEqual([limit, 'second'.length]);
      expect(pass.summary!.openQuestions).toHaveLength(items);
      expect(pass.summary!.discarded).toEqual(['old']);
      expect(pass.droppedDirectives).toHaveLength(items);
      expect(pass.droppedDirectives![0]).toEqual({ directive: `${'w'.repeat(limit - 1)}…`, reason: 'no user message says so', sourceQuote: `${'w'.repeat(limit - 1)}…` });
      expect(pass.integrityNotes).toHaveLength(items);
      expect(pass.compactedTools).toHaveLength(TURN_FLOW_LIMITS.stepsPerRun);
    }
    // The agent's own passes are not cut: they are the transcript's compactions.
    t.noteCompaction(summary({ structuredSummary: { user_directives: many(30, (i) => `directive ${i}`) } }));
    expect(t.snapshot().compactions[0].summary!.userDirectives).toHaveLength(30);
  });
});

describe('summarization passes of the agent', () => {
  it('positions a pass after the last tool call of its own that finished, or null before any', () => {
    const t = tracker();
    const first = t.noteCompaction(summary());
    expect(first?.persist).toBe(true);
    expect(first?.event).toMatchObject({ id: 'pass-1', index: 1, afterToolCallId: null });

    t.noteToolCall(tool('start', 'web_search', 'a'));
    // Started, not finished: the pass still follows nothing... of the finished calls.
    expect(t.noteCompaction(summary())?.event).toMatchObject({ index: 2, afterToolCallId: null });
    t.noteToolCall(tool('success', 'web_search', 'a'));
    t.noteToolCall(tool('start', 'manage_plan', 'p'));
    t.noteToolCall(tool('error', 'manage_plan', 'p'));
    expect(t.noteCompaction(summary())?.event).toMatchObject({ index: 3, afterToolCallId: 'p' });
    // A child's finished call is not the agent's.
    t.noteToolCall(tool('success', 'lookup', 'c1', child()));
    expect(t.noteCompaction(summary())?.event).toMatchObject({ index: 4, afterToolCallId: 'p' });
    expect(t.snapshot().compactions.map((c) => c.index)).toEqual([1, 2, 3, 4]);
  });

  it('keeps several passes after the same call in order', () => {
    const t = tracker();
    t.noteToolCall(tool('start', 'delegate_to', 'd1'));
    t.noteToolCall(tool('success', 'delegate_to', 'd1'));
    t.noteCompaction(summary({ id: 'call_summary_1' }));
    t.noteCompaction(summary({ id: 'call_summary_2' }));
    expect(t.snapshot().compactions.map((c) => [c.id, c.afterToolCallId])).toEqual([['call_summary_1', 'd1'], ['call_summary_2', 'd1']]);
  });

  it('reads what agent-sdk 0.20 reports: id, trigger and the tool results this pass replaced', () => {
    const t = tracker();
    const note = t.noteCompaction(summary({
      id: 'call_summary_9',
      trigger: 'mid_leg',
      compactedTools: [{ toolCallId: 'a', toolName: 'web_search' }, { toolCallId: 'b', toolName: 'read_url' }, { nope: true }],
    }));
    expect(note?.event).toMatchObject({
      id: 'call_summary_9',
      trigger: 'mid_leg',
      compactedTools: [{ toolName: 'web_search', toolCallId: 'a' }, { toolName: 'read_url', toolCallId: 'b' }],
    });
    expect(t.noteCompaction(summary({ trigger: 'somewhere' }))?.event).not.toHaveProperty('trigger');
  });

  it('marks a pass whose summarizer failed', () => {
    expect(tracker().noteCompaction(summary({ status: 'fallback', error: 'timeout' }))?.event.failed).toBe(true);
  });

  it('tells a pass that started or was skipped live only, never keeping or logging it', () => {
    const t = tracker();
    const start = t.noteCompaction({ type: 'summarization', phase: 'start', id: 'call_summary_1', pass: 1, trigger: 'pre_leg', summary: '' });
    expect(start).toEqual({ event: { at: AT.toISOString(), phase: 'start', id: 'call_summary_1', trigger: 'pre_leg' }, persist: false });
    const skipped = t.noteCompaction({ type: 'summarization', phase: 'skipped', id: 'call_summary_1', summary: '', status: 'fallback' });
    expect(skipped).toEqual({ event: { at: AT.toISOString(), phase: 'skipped', id: 'call_summary_1', failed: true }, persist: false });
    const thrown = t.noteCompaction({ type: 'summarization', phase: 'skipped', id: 'call_summary_2', summary: '', status: 'error' });
    expect(thrown?.event.failed).toBe(true);
    expect(t.snapshot().compactions).toEqual([]);
    // None moved the numbering.
    expect(t.noteCompaction(summary({ id: 'call_summary_1' }))?.event).toMatchObject({ index: 1 });
  });

  it('a sub-agent\'s live frames carry its name', () => {
    const frame = tracker().noteCompaction({ type: 'summarization', phase: 'start', id: 'x', summary: '', ...child() });
    expect(frame?.event).toMatchObject({ phase: 'start', subagent: { id: 'sa_1', name: 'helper' } });
    expect(frame?.persist).toBe(false);
  });

  it('merges the double report of a failed summarizer (agent-sdk < 0.20) into one pass', () => {
    const t = tracker();
    const failure = summary({ summary: 'fallback text', integrity: { notes: ['Used fallback summary'] } });
    const first = t.noteCompaction(failure);
    expect(first?.event.failed).toBe(true);
    const second = t.noteCompaction({ ...failure, tokenCountAfter: 1400 });
    expect(second?.persist).toBe(false);
    expect(second?.event).toMatchObject({ id: 'pass-1', index: 1, failed: true, tokensAfter: 1400 });
    const kept = t.snapshot().compactions;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: 'pass-1', index: 1, afterToolCallId: null, failed: true, tokensAfter: 1400 });
  });

  it('does not merge when a tool event came between, the summary differs or the SDK says the pass is its own', () => {
    const failure = summary({ summary: 'fallback text', integrity: { notes: ['fallback'] } });

    const between = tracker();
    between.noteCompaction(failure);
    between.noteToolCall(tool('start', 'web_search', 'a'));
    between.noteCompaction(failure);
    expect(between.snapshot().compactions).toHaveLength(2);

    const different = tracker();
    different.noteCompaction(failure);
    different.noteCompaction({ ...failure, summary: 'another' });
    expect(different.snapshot().compactions).toHaveLength(2);

    const modern = tracker();
    modern.noteCompaction({ ...failure, status: 'fallback' });
    modern.noteCompaction({ ...failure, status: 'fallback' });
    expect(modern.snapshot().compactions).toHaveLength(2);

    const healthy = tracker();
    healthy.noteCompaction(summary({ summary: 'same' }));
    healthy.noteCompaction(summary({ summary: 'same' }));
    expect(healthy.snapshot().compactions).toHaveLength(2);
  });

  describe('which pass replaced a tool result (agent-sdk < 0.20)', () => {
    const lookup = (id: string) => ({ toolName: 'lookup_note', toolCallId: id });
    const run = (t: ReturnType<typeof tracker>, ...ids: string[]) => {
      for (const id of ids) t.noteToolCall(tool('start', 'lookup_note', id));
      for (const id of ids.reverse()) t.noteToolCall(tool('success', 'lookup_note', id));
    };

    it('gives each result to the first pass that came after a later round of calls: a pass leaves the newest call alone', () => {
      // The shape the E2E saw: lookup 1, lookup 2, pass 1, lookup 3, pass 2. Pass 1 could not replace lookup 2, the
      // newest call when it ran; the old rule (first pass after the call finished) gave it both lookups and pass 2 none.
      const t = tracker();
      run(t, 'lookup1');
      run(t, 'lookup2');
      t.noteCompaction(summary({ summary: 'one' }));
      run(t, 'lookup3');
      t.noteCompaction(summary({ summary: 'two' }));
      const passes = t.finalizeCompactedTools([
        lookup('lookup1'),
        lookup('lookup2'),
        { toolName: 'old_tool', toolCallId: 'earlier-turn' },
      ]);
      expect(passes[0].compactedTools).toEqual([lookup('lookup1'), { toolName: 'old_tool', toolCallId: 'earlier-turn' }]);
      expect(passes[1].compactedTools).toEqual([lookup('lookup2')]);
    });

    it('reads calls that were in flight together as one round', () => {
      const t = tracker();
      // One model reply asked for two calls at once; they finish in either order.
      run(t, 'a', 'b');
      t.noteCompaction(summary({ summary: 'one' }));
      run(t, 'c');
      t.noteCompaction(summary({ summary: 'two' }));
      const passes = t.finalizeCompactedTools([lookup('a'), lookup('b')]);
      // The first pass ran right after their round, so neither was replaceable yet.
      expect(passes[0]).not.toHaveProperty('compactedTools');
      expect(passes[1].compactedTools).toEqual([lookup('a'), lookup('b')]);
    });

    it('falls back to the first pass after the call finished when no pass followed a later round', () => {
      const t = tracker();
      run(t, 'a');
      t.noteCompaction(summary({ summary: 'one' }));
      run(t, 'b');
      t.noteCompaction(summary({ summary: 'two' }));
      // `b` was replaced although it was the newest call: an SDK that does not hold it back. The pass after it is the best guess.
      const passes = t.finalizeCompactedTools([lookup('b')]);
      expect(passes[0]).not.toHaveProperty('compactedTools');
      expect(passes[1].compactedTools).toEqual([lookup('b')]);
    });

    it('gives a result whose call is not in this leg\'s order (an earlier turn\'s) to the first pass', () => {
      const t = tracker();
      run(t, 'a');
      t.noteCompaction(summary({ summary: 'one' }));
      run(t, 'b');
      t.noteCompaction(summary({ summary: 'two' }));
      const passes = t.finalizeCompactedTools([{ toolName: 'old_tool', toolCallId: 'earlier-turn' }]);
      expect(passes[0].compactedTools).toEqual([{ toolName: 'old_tool', toolCallId: 'earlier-turn' }]);
      expect(passes[1]).not.toHaveProperty('compactedTools');
    });
  });

  it('leaves a pass that reports its own replaced results as it is', () => {
    const t = tracker();
    t.noteCompaction(summary({ compactedTools: [{ toolCallId: 'a', toolName: 'web_search' }] }));
    t.noteCompaction(summary({ summary: 'two', compactedTools: [] }));
    const passes = t.finalizeCompactedTools([{ toolName: 'web_search', toolCallId: 'a' }, { toolName: 'read_url', toolCallId: 'b' }]);
    expect(passes[0].compactedTools).toEqual([{ toolName: 'web_search', toolCallId: 'a' }]);
    expect(passes[1]).not.toHaveProperty('compactedTools');
  });

  it('has nothing to attribute without a pass', () => {
    expect(tracker().finalizeCompactedTools([{ toolName: 'x', toolCallId: 'a' }])).toEqual([]);
  });
});

describe('summarization passes of a sub-agent', () => {
  it('goes to the run, numbered per run, and never into the agent\'s list', () => {
    const t = tracker();
    t.noteSubagent(subagent('start'));
    const one = t.noteCompaction(summary({ ...child() }));
    const two = t.noteCompaction(summary({ id: 'call_summary_7', ...child() }));
    expect(one?.persist).toBe(true);
    expect(one?.event).toMatchObject({ id: 'pass-sa_1-1', index: 1, subagent: { id: 'sa_1', name: 'helper' } });
    expect(two?.event).toMatchObject({ id: 'call_summary_7', index: 2 });
    expect(t.snapshot().compactions).toEqual([]);
    const [run] = t.snapshot().subagentRuns;
    expect(run.compactions?.map((c) => c.id)).toEqual(['pass-sa_1-1', 'call_summary_7']);
    // The stored copy does not repeat whose it is.
    expect(run.compactions?.[0]).not.toHaveProperty('subagent');
    expect(run.compactions?.[0]).not.toHaveProperty('afterToolCallId');
  });

  it('creates the run when its first sign is a pass', () => {
    const t = tracker();
    t.noteCompaction(summary({ ...child('sa_4', 'late') }));
    expect(t.snapshot().subagentRuns[0]).toMatchObject({ id: 'sa_4', resumed: true });
  });

  it('does not number the agent\'s own passes with a child\'s', () => {
    const t = tracker();
    t.noteSubagent(subagent('start'));
    t.noteCompaction(summary({ ...child() }));
    expect(t.noteCompaction(summary())?.event).toMatchObject({ index: 1 });
  });
});

describe('a leg end to end', () => {
  it('records the plan, the sub-agent and the pass in the order they happened', () => {
    const t = tracker();
    t.noteToolCall(tool('start', 'manage_plan', 'p1'));
    t.notePlan(plan(1, [step(1), step(2)], { toolCallId: 'p1' }));
    t.noteToolCall(tool('success', 'manage_plan', 'p1'));
    t.noteToolCall(tool('start', 'delegate_to', 'd1'));
    t.noteSubagent(subagent('start', { parentToolCallId: 'd1', input: 'go' }));
    t.noteToolCall(tool('start', 'lookup', 'c1', child()));
    t.noteToolCall(tool('success', 'lookup', 'c1', { ...child(), result: 1 }));
    t.noteSubagent(subagent('result', { parentToolCallId: 'd1', content: 'done', status: 'ok' }));
    t.noteToolCall(tool('success', 'delegate_to', 'd1'));
    t.noteCompaction(summary());
    t.noteToolCall(tool('start', 'manage_plan', 'p2'));
    t.notePlan(plan(2, [step(1, 'completed'), step(2, 'in-progress')], { operation: 'update' }));
    t.noteToolCall(tool('success', 'manage_plan', 'p2'));

    const snapshot = t.snapshot();
    expect(snapshot.plans.map((p) => [p.version, p.toolCallId])).toEqual([[1, 'p1'], [2, 'p2']]);
    expect(snapshot.subagentRuns).toHaveLength(1);
    expect(snapshot.subagentRuns[0]).toMatchObject({ parentToolCallId: 'd1', phase: 'result', steps: [{ id: 'c1', status: 'success' }] });
    expect(snapshot.compactions[0]).toMatchObject({ afterToolCallId: 'd1' });
    expect(snapshot.subagentRunsDropped).toBe(0);
  });
});

describe('the session\'s current plan', () => {
  it('normalizes the plan the carried state holds', () => {
    expect(sessionPlanOf({
      version: 4,
      steps: [step(1, 'completed'), step(2, 'in-progress')],
      adherenceScore: 0.5,
      lastUpdated: '2026-10-23T09:00:00.000Z',
    })).toMatchObject({ version: 4, completion: 0.5, at: '2026-10-23T09:00:00.000Z', steps: [{ id: 1, status: 'completed' }, { id: 2, status: 'in-progress' }] });
  });

  it('is null for none, and for a plan without steps', () => {
    expect(sessionPlanOf(undefined)).toBeNull();
    expect(sessionPlanOf(null)).toBeNull();
    expect(sessionPlanOf({ version: 1, steps: [] })).toBeNull();
  });

  it('is worth reading when the agent plans or a turn already did', () => {
    expect(mayHavePlan(undefined, [])).toBe(false);
    expect(mayHavePlan({ runtime: { planning: { mode: 'off' } } }, [{}])).toBe(false);
    expect(mayHavePlan({ runtime: { planning: { mode: 'todo' } } }, [])).toBe(true);
    expect(mayHavePlan({}, [{}, { plans: [{}] }])).toBe(true);
    expect(mayHavePlan({}, [{ plans: [] }])).toBe(false);
  });

  const written = (version: number, steps: unknown[], extra: Record<string, unknown> = {}) => ({
    version, operation: version === 1 ? 'write' : 'update', steps, at: `2026-10-23T09:0${version}:00.000Z`, ...extra,
  });
  const gather = { id: 1, title: 'Gather', status: 'in-progress' };
  const write = { id: 2, title: 'Write', status: 'not-started' };

  it('is the last version of the newest turn that wrote one: a version holds every step, a read leaves none', () => {
    const messages = [
      { role: 'user' },
      { role: 'assistant', plans: [written(1, [gather, write]), written(2, [{ ...gather, status: 'completed' }, { ...write, status: 'in-progress' }], { completion: 0.5 })] },
      { role: 'user' },
      // A later turn that only read the plan says nothing new.
      { role: 'assistant', plans: [] },
      { role: 'assistant' },
    ] as never;
    expect(sessionPlanFromMessages(messages)).toEqual({
      version: 2,
      completion: 0.5,
      at: '2026-10-23T09:02:00.000Z',
      steps: [{ id: 1, title: 'Gather', status: 'completed' }, { id: 2, title: 'Write', status: 'in-progress' }],
    });
    // An older turn's plan is the answer only while no later turn wrote one.
    const later = [...(messages as unknown[]), { role: 'assistant', plans: [written(3, [write])] }] as never;
    expect(sessionPlanFromMessages(later)).toMatchObject({ version: 3, steps: [{ id: 2, title: 'Write' }] });
  });

  it('is null when no turn recorded a plan with steps', () => {
    expect(sessionPlanFromMessages(undefined)).toBeNull();
    expect(sessionPlanFromMessages([])).toBeNull();
    expect(sessionPlanFromMessages([{}, { plans: [] }] as never)).toBeNull();
    expect(sessionPlanFromMessages([{ plans: [written(1, [])] }] as never)).toBeNull();
  });

  describe('readSessionPlan', () => {
    const carried = { version: 3, steps: [step(1, 'completed'), step(2, 'in-progress')], adherenceScore: 0.5, lastUpdated: '2026-10-23T09:00:00.000Z' };
    const stateStore = (messageCount: number) => vi.fn(async () => ({ messageCount, snapshot: JSON.stringify({ messages: [], plan: carried, planVersion: 3 }) }));
    const dbOf = (find: ReturnType<typeof stateStore>) => ({ findAgentConversationState: find }) as never;
    const planning = { runtime: { planning: { mode: 'todo' } } };

    it('reads the plan off the stored turns and never decompresses the carried state', async () => {
      const find = stateStore(2);
      const messages = [{ role: 'user' }, { role: 'assistant', plans: [written(1, [gather, write])] }];
      const read = await readSessionPlan(dbOf(find), { _id: 'c1', messages } as never, planning);
      expect(read).toMatchObject({ version: 1, steps: [{ title: 'Gather' }, { title: 'Write' }] });
      expect(find).not.toHaveBeenCalled();
    });

    it('falls back to the carried state for turns stored before versions were recorded', async () => {
      const find = stateStore(2);
      const messages = [{ role: 'user' }, { role: 'assistant' }];
      expect(await readSessionPlan(dbOf(find), { _id: 'c1', messages } as never, planning)).toMatchObject({
        version: 3, completion: 0.5, at: '2026-10-23T09:00:00.000Z', steps: [{ id: 1, status: 'completed' }, { id: 2, status: 'in-progress' }],
      });
      expect(find).toHaveBeenCalledTimes(1);
    });

    it('falls back to it too when the newest recorded version has no steps to show', async () => {
      const find = stateStore(1);
      const messages = [{ role: 'assistant', plans: [written(5, [])] }];
      expect(await readSessionPlan(dbOf(find), { _id: 'c1', messages } as never, undefined)).toMatchObject({ version: 3 });
      expect(find).toHaveBeenCalledTimes(1);
    });

    it('is null, without reading anything, for an agent that does not plan and no turn that did; and for a state behind the transcript', async () => {
      const find = stateStore(2);
      expect(await readSessionPlan(dbOf(find), { _id: 'c1', messages: [{ role: 'assistant', plans: [] }] } as never, undefined)).toBeNull();
      expect(find).not.toHaveBeenCalled();
      // The state holds two messages, the transcript three: the plan it carries is not known to be current.
      expect(await readSessionPlan(dbOf(find), { _id: 'c1', messages: [{}, {}, {}] } as never, planning)).toBeNull();
    });
  });
});
