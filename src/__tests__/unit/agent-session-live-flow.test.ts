/**
 * The live turn as data (components/agents/session/liveFlow.ts): the reducers
 * that turn the SSE frames of a running turn (or the session log, when
 * following one) into the ordered segments the playground draws - text, tool
 * calls, plan versions, sub-agent groups and summarization passes.
 */
import { describe, expect, it } from 'vitest';
import {
    appendLiveText,
    applyLiveCompaction,
    applyLivePlan,
    applyLiveSubagent,
    applyLiveToolEvent,
    isGenerating,
    latestLivePlan,
    type LiveSegment,
    type LiveToolEvent,
} from '@/components/agents/session/liveFlow';
import * as viaLiveToolCalls from '@/components/agents/session/LiveToolCalls';
import type { IAgentTurnPlanSnapshot } from '@/lib/database/provider/types.domain';
import type { AgentCompactionEvent, AgentSubagentEvent, AgentToolCallSubagentStamp } from '@/lib/shared/agentTurnFlow';

const AT = '2026-10-23T10:00:00.000Z';

function plan(version: number, extra: Partial<IAgentTurnPlanSnapshot> = {}): IAgentTurnPlanSnapshot {
    return {
        version,
        operation: version === 1 ? 'write' : 'update',
        steps: [{ id: 1, title: 'Research', status: 'in-progress' }, { id: 2, title: 'Write', status: 'not-started' }],
        at: `2026-10-23T10:00:0${version}.000Z`,
        ...extra,
    };
}

function sub(phase: AgentSubagentEvent['phase'], extra: Partial<AgentSubagentEvent> = {}): AgentSubagentEvent {
    return { phase, id: 'sa_1', name: 'researcher', at: AT, ...extra };
}

function pass(extra: Partial<AgentCompactionEvent> = {}): AgentCompactionEvent {
    return { at: AT, id: 'p1', tokensBefore: 1000, tokensAfter: 200, ...extra };
}

function tool(segments: LiveSegment[], phase: string, name: string, id?: string, extra: Partial<LiveToolEvent> = {}): LiveSegment[] {
    return applyLiveToolEvent(segments, { phase, name, ...(id ? { id } : {}), ...extra });
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    }
    return value;
}

const kinds = (segments: LiveSegment[]) => segments.map((segment) => segment.kind);
const groupOf = (segments: LiveSegment[], index = 0) => {
    const segment = segments[index];
    if (segment?.kind !== 'subagents') throw new Error(`segment ${index} is ${segment?.kind}, not subagents`);
    return segment;
};

describe('LiveToolCalls keeps exporting the model', () => {
    it('re-exports the reducers from liveFlow', () => {
        for (const name of ['appendLiveText', 'appendLiveReasoning', 'applyLiveToolEvent', 'applyLivePlan', 'applyLiveSubagent', 'applyLiveCompaction', 'isGenerating', 'latestLivePlan', 'summariseArgs'] as const) {
            expect(typeof viaLiveToolCalls[name], name).toBe('function');
        }
    });
});

describe('plan segments', () => {
    it('adds no row for the plan call itself, on start or success, whichever alias it uses', () => {
        for (const name of ['manage_plan', 'manage_todo_list']) {
            let segments: LiveSegment[] = [];
            segments = tool(segments, 'start', name, 'c1', { args: { operation: 'write' } });
            expect(segments).toEqual([]);
            segments = applyLivePlan(segments, plan(1));
            segments = tool(segments, 'success', name, 'c1', { durationMs: 3 });
            expect(kinds(segments)).toEqual(['plan']);
        }
    });

    it('shows a plan call that failed, with its error, so the failure is not hidden', () => {
        let segments: LiveSegment[] = [];
        segments = tool(segments, 'start', 'manage_plan', 'c9');
        segments = tool(segments, 'error', 'manage_plan', 'c9', { error: 'bad plan' });
        expect(segments).toEqual([{ kind: 'tools', calls: [{ key: 'c9', name: 'manage_plan', running: false, error: 'bad plan' }] }]);
    });

    it('takes the session plan as the first version\'s previous, then its own earlier version', () => {
        const base = plan(1);
        let segments = applyLivePlan([], plan(2), base);
        expect(segments[0]).toMatchObject({ kind: 'plan', previous: { version: 1 } });
        segments = applyLivePlan(segments, plan(3), base);
        expect(segments[1]).toMatchObject({ kind: 'plan', plan: { version: 3 }, previous: { version: 2 } });
    });

    it('has no previous when the session had no plan', () => {
        const segments = applyLivePlan([], plan(1), null);
        expect('previous' in segments[0]).toBe(false);
        expect(latestLivePlan(segments)?.version).toBe(1);
        expect(latestLivePlan([{ kind: 'text', text: 'x' }])).toBeUndefined();
    });

    it('does not show a frame twice when a followed session replays it', () => {
        const once = applyLivePlan([], plan(1));
        expect(applyLivePlan(once, plan(1))).toBe(once);
        // Same version at another time is a new write.
        expect(applyLivePlan(once, plan(1, { at: '2026-10-23T11:00:00.000Z' }))).toHaveLength(2);
    });

    it('starts a new tools run after a plan, keeping the order of the turn', () => {
        let segments: LiveSegment[] = [];
        segments = tool(segments, 'start', 'web_search', 'c1');
        segments = tool(segments, 'success', 'web_search', 'c1');
        segments = applyLivePlan(segments, plan(1));
        segments = tool(segments, 'start', 'fetch', 'c2');
        expect(kinds(segments)).toEqual(['tools', 'plan', 'tools']);
    });
});

describe('delegation groups', () => {
    it('opens a group on a delegation call and settles its call on the result', () => {
        let segments = tool([], 'start', 'delegate_to', 'd1', { args: { agent: 'researcher', task: 'look it up' } });
        expect(groupOf(segments)).toMatchObject({ parentToolCallId: 'd1', parallel: false, runs: [], call: { key: 'd1', name: 'delegate_to', running: true } });
        segments = tool(segments, 'success', 'delegate_to', 'd1', { durationMs: 900 });
        expect(groupOf(segments).call).toMatchObject({ running: false, durationMs: 900 });
        expect(groupOf(segments).call?.error).toBeUndefined();
    });

    it('marks spawn_subagents_parallel as parallel and carries a failed call\'s error', () => {
        let segments = tool([], 'start', 'spawn_subagents_parallel', 'p1');
        expect(groupOf(segments).parallel).toBe(true);
        segments = tool(segments, 'error', 'spawn_subagents_parallel', 'p1', { error: 'too many' });
        expect(groupOf(segments).call).toMatchObject({ running: false, error: 'too many' });
    });

    it('settles a delegation call that has no id by the newest running one of that name', () => {
        let segments = tool([], 'start', 'spawn_subagent');
        segments = tool(segments, 'success', 'spawn_subagent', undefined, { durationMs: 5 });
        expect(groupOf(segments).call).toMatchObject({ running: false, durationMs: 5 });
    });

    it('ignores the end of a delegation call it never saw start', () => {
        expect(tool([], 'success', 'delegate_to', 'zz')).toEqual([]);
    });

    it('takes a delegation call for the agent\'s own even when it carries a stamp: a child cannot delegate, so no ghost run', () => {
        // A stamp on a delegation row only names the sub-agent the task was handed to.
        const stamp = { name: 'researcher' };
        let segments = tool([], 'start', 'delegate_to', 'd1', { subagent: stamp });
        expect(groupOf(segments)).toMatchObject({ parentToolCallId: 'd1', parallel: false, runs: [], call: { key: 'd1', name: 'delegate_to', running: true } });
        segments = applyLiveSubagent(segments, sub('start', { parentToolCallId: 'd1' }));
        segments = tool(segments, 'success', 'delegate_to', 'd1', { subagent: stamp, durationMs: 5 });
        expect(segments).toHaveLength(1);
        expect(groupOf(segments).call).toMatchObject({ running: false, durationMs: 5 });
        expect(groupOf(segments).runs.map((run) => run.id)).toEqual(['sa_1']);
        // Also for the parallel tool, and a stamped call without an id (settled by name).
        const parallel = tool([], 'start', 'spawn_subagents_parallel', 'p1', { subagent: { name: 'a, b', parallel: true } });
        expect(groupOf(parallel)).toMatchObject({ parallel: true, runs: [], call: { key: 'p1' } });
        const unnamed = tool(tool([], 'start', 'spawn_subagent', undefined, { subagent: { name: 'x' } }), 'success', 'spawn_subagent', undefined, { subagent: { name: 'x' }, durationMs: 3 });
        expect(groupOf(unnamed).call).toMatchObject({ running: false, durationMs: 3 });
        expect(groupOf(unnamed).runs).toEqual([]);
    });

    it('lets ordinary calls around a delegation stay ordinary rows', () => {
        let segments: LiveSegment[] = [];
        segments = tool(segments, 'start', 'web_search', 'c1');
        segments = tool(segments, 'start', 'delegate_to', 'd1');
        segments = tool(segments, 'start', 'fetch', 'c2');
        segments = tool(segments, 'success', 'web_search', 'c1');
        segments = tool(segments, 'success', 'fetch', 'c2');
        expect(kinds(segments)).toEqual(['tools', 'subagents', 'tools']);
        expect((segments[0] as { calls: { running: boolean }[] }).calls[0].running).toBe(false);
        expect((segments[2] as { calls: { running: boolean }[] }).calls[0].running).toBe(false);
    });
});

describe('a sub-agent\'s own tool calls', () => {
    const stampA: AgentToolCallSubagentStamp = { id: 'sa_1', name: 'a', parentToolCallId: 'p1', parallel: true };
    const stampB: AgentToolCallSubagentStamp = { id: 'sa_2', name: 'b', parentToolCallId: 'p1', parallel: true };

    function parallelGroup(): LiveSegment[] {
        let segments = tool([], 'start', 'spawn_subagents_parallel', 'p1');
        segments = applyLiveSubagent(segments, sub('start', { id: 'sa_1', name: 'a', parentToolCallId: 'p1', parallel: true, input: 'task a' }));
        return applyLiveSubagent(segments, sub('start', { id: 'sa_2', name: 'b', parentToolCallId: 'p1', parallel: true }));
    }

    it('goes into its run by id and never into the parent\'s rows', () => {
        let segments = parallelGroup();
        segments = tool(segments, 'start', 'web_search', 't1', { subagent: stampA, args: { query: 'q1' } });
        segments = tool(segments, 'start', 'web_search', 't2', { subagent: stampB });
        segments = tool(segments, 'success', 'web_search', 't1', { subagent: stampA, durationMs: 5 });
        expect(segments).toHaveLength(1);
        const [a, b] = groupOf(segments).runs;
        expect(a.steps).toEqual([{ key: 't1', name: 'web_search', detail: 'q1', running: false, durationMs: 5, subagent: stampA }]);
        expect(b.steps).toMatchObject([{ key: 't2', running: true }]);
    });

    it('records a failed call with its error', () => {
        let segments = parallelGroup();
        segments = tool(segments, 'start', 'fetch', 't1', { subagent: stampA });
        segments = tool(segments, 'error', 'fetch', 't1', { subagent: stampA, error: '404' });
        expect(groupOf(segments).runs[0].steps[0]).toMatchObject({ running: false, error: '404' });
    });

    it('settles a call without an id by the newest running one of that name in the run', () => {
        let segments = parallelGroup();
        segments = tool(segments, 'start', 'fetch', undefined, { subagent: stampA });
        segments = tool(segments, 'success', 'fetch', undefined, { subagent: stampA, durationMs: 7 });
        expect(groupOf(segments).runs[0].steps[0]).toMatchObject({ running: false, durationMs: 7 });
    });

    it('does not duplicate a call whose start it already has', () => {
        let segments = parallelGroup();
        segments = tool(segments, 'start', 'fetch', 't1', { subagent: stampA });
        segments = tool(segments, 'start', 'fetch', 't1', { subagent: stampA });
        expect(groupOf(segments).runs[0].steps).toHaveLength(1);
    });

    it('finds the group by the delegation call when the run is unknown, and creates the run', () => {
        let segments = tool([], 'start', 'delegate_to', 'd1');
        segments = tool(segments, 'start', 'web_search', 't1', { subagent: { id: 'sa_7', name: 'late', parentToolCallId: 'd1' } });
        expect(segments).toHaveLength(1);
        expect(groupOf(segments).runs).toMatchObject([{ id: 'sa_7', name: 'late', phase: 'start', steps: [{ key: 't1' }] }]);
    });

    it('falls back to the newest open group when the stamp names neither a run nor a delegation', () => {
        let segments = tool([], 'start', 'delegate_to', 'd1');
        segments = tool(segments, 'start', 'web_search', 't1', { subagent: { name: 'x' } });
        expect(segments).toHaveLength(1);
        expect(groupOf(segments).runs[0]).toMatchObject({ name: 'x', steps: [{ key: 't1' }] });
    });

    it('starts a group at the end when nothing is open (a follower that joined mid-run)', () => {
        let segments = appendLiveText([], 'working');
        segments = tool(segments, 'start', 'web_search', 't1', { subagent: { id: 'sa_1', name: 'a', parentToolCallId: 'd1' }, resumed: true });
        expect(kinds(segments)).toEqual(['text', 'subagents']);
        expect(groupOf(segments, 1)).toMatchObject({ parentToolCallId: 'd1', runs: [{ id: 'sa_1', resumed: true }] });
    });

    it('does not put a call into a group that has already ended', () => {
        let segments = tool([], 'start', 'delegate_to', 'd1');
        segments = applyLiveSubagent(segments, sub('start', { parentToolCallId: 'd1' }));
        segments = applyLiveSubagent(segments, sub('result', { parentToolCallId: 'd1', content: 'done' }));
        segments = tool(segments, 'success', 'delegate_to', 'd1');
        segments = tool(segments, 'start', 'web_search', 't9', { subagent: { id: 'sa_2', name: 'other' } });
        expect(kinds(segments)).toEqual(['subagents', 'subagents']);
    });

    it('puts a run that continues after a pause back to running on its next call', () => {
        let segments = tool([], 'start', 'delegate_to', 'd1');
        segments = applyLiveSubagent(segments, sub('start', { parentToolCallId: 'd1' }));
        segments = applyLiveSubagent(segments, sub('paused', { parentToolCallId: 'd1' }));
        expect(groupOf(segments).runs[0].phase).toBe('paused');
        segments = tool(segments, 'start', 'fetch', 't1', { subagent: { id: 'sa_1', name: 'researcher', parentToolCallId: 'd1' }, resumed: true });
        expect(groupOf(segments).runs[0]).toMatchObject({ phase: 'start', resumed: true });
    });
});

describe('sub-agent lifecycle frames', () => {
    it('updates the header from start to result without losing the task', () => {
        let segments = tool([], 'start', 'delegate_to', 'd1');
        segments = applyLiveSubagent(segments, sub('start', { parentToolCallId: 'd1', mode: 'registry', input: 'the task' }));
        segments = applyLiveSubagent(segments, sub('result', {
            parentToolCallId: 'd1',
            content: 'All done',
            status: 'ok',
            durationMs: 1200,
            usage: { totalTokens: 50 },
            target: { kind: 'ref', agentName: 'researcher', version: 2 },
        }));
        expect(groupOf(segments).runs).toEqual([{
            id: 'sa_1',
            name: 'researcher',
            mode: 'registry',
            parentToolCallId: 'd1',
            phase: 'result',
            input: 'the task',
            result: 'All done',
            status: 'ok',
            durationMs: 1200,
            usage: { totalTokens: 50 },
            target: { kind: 'ref', agentName: 'researcher', version: 2 },
            steps: [],
            compactions: [],
        }]);
    });

    it('records an error and a pause', () => {
        let segments = tool([], 'start', 'delegate_to', 'd1');
        segments = applyLiveSubagent(segments, sub('start', { parentToolCallId: 'd1' }));
        segments = applyLiveSubagent(segments, sub('error', { parentToolCallId: 'd1', error: 'boom' }));
        expect(groupOf(segments).runs[0]).toMatchObject({ phase: 'error', error: 'boom' });
        segments = applyLiveSubagent(segments, sub('paused', { parentToolCallId: 'd1', note: 'needs approval' }));
        expect(groupOf(segments).runs[0]).toMatchObject({ phase: 'paused', note: 'needs approval' });
    });

    it('keeps the run\'s steps when a resumed leg starts it again', () => {
        let segments = tool([], 'start', 'delegate_to', 'd1');
        segments = applyLiveSubagent(segments, sub('start', { parentToolCallId: 'd1' }));
        segments = tool(segments, 'start', 'fetch', 't1', { subagent: { id: 'sa_1', name: 'researcher', parentToolCallId: 'd1' } });
        segments = tool(segments, 'success', 'fetch', 't1', { subagent: { id: 'sa_1', name: 'researcher', parentToolCallId: 'd1' } });
        segments = applyLiveSubagent(segments, sub('paused', { parentToolCallId: 'd1' }));
        segments = applyLiveSubagent(segments, sub('start', { parentToolCallId: 'd1', resumed: true }));
        expect(groupOf(segments).runs).toHaveLength(1);
        expect(groupOf(segments).runs[0]).toMatchObject({ phase: 'start', resumed: true, steps: [{ key: 't1' }] });
    });

    it('lets a run\'s frames outrun the delegation call: the call then claims the group', () => {
        let segments = applyLiveSubagent([], sub('start', { parentToolCallId: 'd1' }));
        expect(groupOf(segments)).toMatchObject({ parentToolCallId: 'd1', runs: [{ id: 'sa_1' }] });
        expect(groupOf(segments).call).toBeUndefined();
        segments = tool(segments, 'start', 'delegate_to', 'd1');
        expect(segments).toHaveLength(1);
        expect(groupOf(segments).call).toMatchObject({ key: 'd1', running: true });
    });

    it('groups the runs of one parallel call and flags the group parallel from a run alone', () => {
        let segments = applyLiveSubagent([], sub('start', { id: 'a', name: 'a', parentToolCallId: 'p1', parallel: true }));
        segments = applyLiveSubagent(segments, sub('start', { id: 'b', name: 'b', parentToolCallId: 'p1', parallel: true }));
        expect(segments).toHaveLength(1);
        expect(groupOf(segments)).toMatchObject({ parallel: true });
        expect(groupOf(segments).runs.map((run) => run.id)).toEqual(['a', 'b']);
    });

    it('opens a group at the end for a run whose delegation call is unknown', () => {
        let segments = appendLiveText([], 'hello');
        segments = applyLiveSubagent(segments, sub('start', { id: 'orphan', name: 'o' }));
        expect(kinds(segments)).toEqual(['text', 'subagents']);
        expect('parentToolCallId' in groupOf(segments, 1)).toBe(false);
    });
});

describe('the children of a parallel spawn are keyed <call>#<n>', () => {
    // The SDK keys each child of spawn_subagents_parallel `<toolCallId>#<index>`; the call, and so the group, is `<toolCallId>`.
    const childA = { id: 'sa_a', name: 'a', parentToolCallId: 'p1#0', parallel: true };
    const childB = { id: 'sa_b', name: 'b', parentToolCallId: 'p1#1', parallel: true };

    it('puts every child into the group of its call, even with a later delegation open beside it', () => {
        let segments = tool([], 'start', 'spawn_subagents_parallel', 'p1');
        segments = tool(segments, 'start', 'delegate_to', 'd2');
        segments = applyLiveSubagent(segments, sub('start', childA));
        segments = applyLiveSubagent(segments, sub('start', childB));
        expect(segments).toHaveLength(2);
        expect(groupOf(segments, 0).runs.map((run) => run.id)).toEqual(['sa_a', 'sa_b']);
        expect(groupOf(segments, 1).runs).toEqual([]);
        // The run points back at the call, not at its own key.
        expect(groupOf(segments, 0).runs.map((run) => run.parentToolCallId)).toEqual(['p1', 'p1']);
    });

    it('does not take a call whose id only starts the same for the children\'s call', () => {
        let segments = tool([], 'start', 'spawn_subagents_parallel', 'p10');
        segments = tool(segments, 'start', 'spawn_subagents_parallel', 'p1');
        segments = applyLiveSubagent(segments, sub('start', { id: 'sa_x', name: 'x', parentToolCallId: 'p10#0', parallel: true }));
        expect(groupOf(segments, 0).runs.map((run) => run.id)).toEqual(['sa_x']);
        expect(groupOf(segments, 1).runs).toEqual([]);
    });

    it('opens the group under the call\'s id when a child outruns the call, and the call then claims it', () => {
        let segments = applyLiveSubagent([], sub('start', childA));
        expect(groupOf(segments)).toMatchObject({ parentToolCallId: 'p1', parallel: true, runs: [{ id: 'sa_a', parentToolCallId: 'p1' }] });
        expect(groupOf(segments).call).toBeUndefined();
        segments = tool(segments, 'start', 'spawn_subagents_parallel', 'p1');
        expect(segments).toHaveLength(1);
        expect(groupOf(segments).call).toMatchObject({ key: 'p1', name: 'spawn_subagents_parallel', running: true });
        segments = applyLiveSubagent(segments, sub('start', childB));
        segments = tool(segments, 'success', 'spawn_subagents_parallel', 'p1', { durationMs: 40 });
        expect(segments).toHaveLength(1);
        expect(groupOf(segments).runs.map((run) => run.id)).toEqual(['sa_a', 'sa_b']);
        expect(groupOf(segments).call).toMatchObject({ running: false, durationMs: 40 });
    });

    it('puts a child\'s own tool call into its run when the stamp carries the child\'s key', () => {
        let segments = tool([], 'start', 'spawn_subagents_parallel', 'p1');
        segments = tool(segments, 'start', 'delegate_to', 'd2');
        // The run is not known yet: the stamp's key finds the group of the call, and creates the run there.
        segments = tool(segments, 'start', 'web_search', 't1', { subagent: childA, args: { query: 'q' } });
        expect(segments).toHaveLength(2);
        expect(groupOf(segments, 0).runs).toMatchObject([
            { id: 'sa_a', parentToolCallId: 'p1', parallel: true, steps: [{ key: 't1', name: 'web_search', detail: 'q', running: true }] },
        ]);
        expect(groupOf(segments, 1).runs).toEqual([]);
        // Its own lifecycle frames, keyed the same way, update that run.
        segments = applyLiveSubagent(segments, sub('result', { ...childA, content: 'done', status: 'ok' }));
        segments = tool(segments, 'success', 'web_search', 't1', { subagent: childA, durationMs: 9 });
        expect(segments).toHaveLength(2);
        expect(groupOf(segments, 0).runs).toMatchObject([
            { id: 'sa_a', phase: 'result', result: 'done', steps: [{ key: 't1', running: false, durationMs: 9 }] },
        ]);
    });
});

describe('summarization passes', () => {
    it('shows a pass as pending from its start frame and replaces it in place with the finished pass', () => {
        let segments: LiveSegment[] = [];
        segments = tool(segments, 'start', 'a', 'c1');
        segments = tool(segments, 'success', 'a', 'c1');
        segments = applyLiveCompaction(segments, { at: AT, id: 'p1', phase: 'start' });
        expect(segments[1]).toMatchObject({ kind: 'compaction', pending: true });
        expect(isGenerating(segments)).toBe(false);
        segments = applyLiveCompaction(segments, pass());
        expect(kinds(segments)).toEqual(['tools', 'compaction']);
        expect(segments[1]).toMatchObject({ pending: false, compaction: { id: 'p1', tokensAfter: 200 } });
        expect((segments[1] as { compaction: AgentCompactionEvent }).compaction.phase).toBeUndefined();
        expect(isGenerating(segments)).toBe(true);
    });

    it('keeps the pass where it started, even after other segments followed', () => {
        let segments = applyLiveCompaction([], { at: AT, id: 'p1', phase: 'start' });
        segments = appendLiveText(segments, 'x');
        segments = applyLiveCompaction(segments, pass());
        expect(kinds(segments)).toEqual(['compaction', 'text']);
    });

    it('removes a pending pass that ended without a change, matching by id', () => {
        let segments = applyLiveCompaction([], { at: AT, id: 'p1', phase: 'start' });
        segments = applyLiveCompaction(segments, { at: AT, id: 'p2', phase: 'start' });
        segments = applyLiveCompaction(segments, { at: AT, id: 'p1', phase: 'skipped' });
        expect(segments).toHaveLength(1);
        expect(segments[0]).toMatchObject({ compaction: { id: 'p2' }, pending: true });
    });

    it('removes the newest pending pass for a skipped frame without an id, and ignores one with nothing to remove', () => {
        let segments = applyLiveCompaction([], { at: AT, phase: 'start' });
        segments = applyLiveCompaction(segments, { at: AT, phase: 'skipped' });
        expect(segments).toEqual([]);
        const same = [{ kind: 'text', text: 'x' } as LiveSegment];
        expect(applyLiveCompaction(same, { at: AT, id: 'zz', phase: 'skipped' })).toBe(same);
    });

    it('adds a finished pass that had no start frame (an older SDK), and one pass per id', () => {
        let segments = applyLiveCompaction([], pass({ id: 'a' }));
        segments = applyLiveCompaction(segments, pass({ id: 'b' }));
        segments = applyLiveCompaction(segments, pass({ id: 'b', tokensAfter: 100 }));
        expect(segments).toHaveLength(2);
        expect(segments[1]).toMatchObject({ compaction: { id: 'b', tokensAfter: 100 } });
        // Without an id every finished pass is its own.
        let anon = applyLiveCompaction([], { at: AT });
        anon = applyLiveCompaction(anon, { at: AT });
        expect(anon).toHaveLength(2);
    });

    it('replaces a finished pass with a later one of the same id (an older SDK reports a failed summarizer a second time)', () => {
        let segments = applyLiveCompaction([], { at: AT, id: 'p1', phase: 'start' });
        segments = applyLiveCompaction(segments, pass({ id: 'p1', tokensAfter: 200 }));
        segments = tool(segments, 'start', 'fetch', 't1');
        segments = applyLiveCompaction(segments, pass({ id: 'p1', failed: true, tokensAfter: 900 }));
        const passes = segments.filter((segment) => segment.kind === 'compaction');
        expect(passes).toHaveLength(1);
        expect(passes[0]).toMatchObject({ pending: false, compaction: { id: 'p1', failed: true, tokensAfter: 900 } });
        // It stays where the first one was, before the call that followed.
        expect(kinds(segments)).toEqual(['compaction', 'tools']);
    });

    it('does not let a start frame seen twice add a second pending pass', () => {
        let segments = applyLiveCompaction([], { at: AT, id: 'p1', phase: 'start' });
        segments = applyLiveCompaction(segments, { at: AT, id: 'p1', phase: 'start' });
        expect(segments).toHaveLength(1);
    });

    describe('inside a sub-agent', () => {
        const stamp = { id: 'sa_1', name: 'researcher' };

        function runWithStep(): LiveSegment[] {
            let segments = tool([], 'start', 'delegate_to', 'd1');
            segments = applyLiveSubagent(segments, sub('start', { parentToolCallId: 'd1' }));
            segments = tool(segments, 'start', 'fetch', 't1', { subagent: { ...stamp, parentToolCallId: 'd1' } });
            return tool(segments, 'success', 'fetch', 't1', { subagent: { ...stamp, parentToolCallId: 'd1' } });
        }

        it('goes into the run, never into the parent\'s segments, and is placed after the run\'s newest settled call', () => {
            let segments = runWithStep();
            segments = applyLiveCompaction(segments, pass({ id: 'cp1', phase: 'start', subagent: stamp }));
            expect(kinds(segments)).toEqual(['subagents']);
            expect(groupOf(segments).runs[0].compactions).toMatchObject([{ id: 'cp1', phase: 'start', afterToolCallId: 't1' }]);
        });

        it('replaces the pending pass with the finished one and keeps its place', () => {
            let segments = runWithStep();
            segments = applyLiveCompaction(segments, pass({ id: 'cp1', phase: 'start', subagent: stamp }));
            segments = tool(segments, 'start', 'fetch', 't2', { subagent: { ...stamp, parentToolCallId: 'd1' } });
            segments = applyLiveCompaction(segments, pass({ id: 'cp1', subagent: stamp }));
            const { compactions } = groupOf(segments).runs[0];
            expect(compactions).toHaveLength(1);
            expect(compactions[0].phase).toBeUndefined();
            expect(compactions[0].afterToolCallId).toBe('t1');
        });

        it('is positioned before any call (null) when the run had none, and after the latest settled one later', () => {
            let segments = tool([], 'start', 'delegate_to', 'd1');
            segments = applyLiveSubagent(segments, sub('start', { parentToolCallId: 'd1' }));
            segments = applyLiveCompaction(segments, pass({ id: 'cp0', subagent: stamp }));
            expect(groupOf(segments).runs[0].compactions[0].afterToolCallId).toBeNull();
            segments = tool(segments, 'start', 'fetch', 't1', { subagent: { ...stamp, parentToolCallId: 'd1' } });
            segments = tool(segments, 'success', 'fetch', 't1', { subagent: { ...stamp, parentToolCallId: 'd1' } });
            segments = applyLiveCompaction(segments, pass({ id: 'cp1', subagent: stamp }));
            expect(groupOf(segments).runs[0].compactions.map((c) => c.afterToolCallId)).toEqual([null, 't1']);
        });

        it('replaces a finished pass of the run with a later one of the same id and keeps its place', () => {
            let segments = runWithStep();
            segments = applyLiveCompaction(segments, pass({ id: 'cp1', subagent: stamp }));
            segments = tool(segments, 'start', 'fetch', 't2', { subagent: { ...stamp, parentToolCallId: 'd1' } });
            segments = tool(segments, 'success', 'fetch', 't2', { subagent: { ...stamp, parentToolCallId: 'd1' } });
            segments = applyLiveCompaction(segments, pass({ id: 'cp1', failed: true, subagent: stamp }));
            const { compactions } = groupOf(segments).runs[0];
            expect(compactions).toHaveLength(1);
            expect(compactions[0]).toMatchObject({ id: 'cp1', failed: true, afterToolCallId: 't1' });
        });

        it('drops a skipped pass from the run', () => {
            let segments = runWithStep();
            segments = applyLiveCompaction(segments, pass({ id: 'cp1', phase: 'start', subagent: stamp }));
            segments = applyLiveCompaction(segments, pass({ id: 'cp1', phase: 'skipped', subagent: stamp }));
            expect(groupOf(segments).runs[0].compactions).toEqual([]);
        });

        it('keeps a position the event already carries', () => {
            let segments = runWithStep();
            segments = applyLiveCompaction(segments, pass({ id: 'cp1', subagent: stamp, afterToolCallId: null }));
            expect(groupOf(segments).runs[0].compactions[0].afterToolCallId).toBeNull();
        });

        it('creates the run for a pass whose run is not known yet', () => {
            const segments = applyLiveCompaction([], pass({ id: 'cp1', subagent: { id: 'sa_9', name: 'late' } }));
            expect(groupOf(segments).runs).toMatchObject([{ id: 'sa_9', name: 'late', compactions: [{ id: 'cp1' }] }]);
        });
    });
});

describe('isGenerating', () => {
    it('is false for nothing, text and reasoning', () => {
        expect(isGenerating([])).toBe(false);
        expect(isGenerating([{ kind: 'text', text: 'x' }])).toBe(false);
        expect(isGenerating([{ kind: 'reasoning', text: 'x' }])).toBe(false);
    });

    it('is true when the newest segment is a settled tools run, false while a call runs', () => {
        let segments = tool([], 'start', 'a', 'c1');
        expect(isGenerating(segments)).toBe(false);
        segments = tool(segments, 'success', 'a', 'c1');
        expect(isGenerating(segments)).toBe(true);
    });

    it('treats a delegation as working until its call and every run have ended', () => {
        let segments = tool([], 'start', 'delegate_to', 'd1');
        expect(isGenerating(segments)).toBe(false);
        segments = applyLiveSubagent(segments, sub('start', { parentToolCallId: 'd1' }));
        segments = tool(segments, 'success', 'delegate_to', 'd1');
        expect(isGenerating(segments)).toBe(false);
        segments = applyLiveSubagent(segments, sub('paused', { parentToolCallId: 'd1' }));
        expect(isGenerating(segments)).toBe(false);
        segments = applyLiveSubagent(segments, sub('result', { parentToolCallId: 'd1' }));
        expect(isGenerating(segments)).toBe(true);
    });

    it('is true after a plan and after a finished pass', () => {
        expect(isGenerating(applyLivePlan([], plan(1)))).toBe(true);
        expect(isGenerating(applyLiveCompaction([], pass()))).toBe(true);
    });
});

describe('the reducers do not mutate what they are given', () => {
    it('runs a whole turn on frozen state', () => {
        let segments: LiveSegment[] = [];
        const step = (next: (current: LiveSegment[]) => LiveSegment[]) => {
            segments = deepFreeze(next(segments));
        };
        const stamp = { id: 'sa_1', name: 'researcher', parentToolCallId: 'd1' };
        step((s) => appendLiveText(s, 'Let me plan'));
        step((s) => tool(s, 'start', 'manage_plan', 'c1'));
        step((s) => applyLivePlan(s, plan(1)));
        step((s) => tool(s, 'success', 'manage_plan', 'c1'));
        step((s) => tool(s, 'start', 'delegate_to', 'd1'));
        step((s) => applyLiveSubagent(s, sub('start', { parentToolCallId: 'd1', input: 'go' })));
        step((s) => tool(s, 'start', 'fetch', 't1', { subagent: stamp }));
        step((s) => applyLiveCompaction(s, pass({ id: 'cp1', phase: 'start', subagent: stamp })));
        step((s) => applyLiveCompaction(s, pass({ id: 'cp1', subagent: stamp })));
        step((s) => tool(s, 'success', 'fetch', 't1', { subagent: stamp, durationMs: 4 }));
        step((s) => applyLiveSubagent(s, sub('result', { parentToolCallId: 'd1', content: 'done' })));
        step((s) => tool(s, 'success', 'delegate_to', 'd1'));
        step((s) => applyLiveCompaction(s, { at: AT, id: 'p1', phase: 'start' }));
        step((s) => applyLiveCompaction(s, pass()));
        step((s) => appendLiveText(s, 'Answer'));
        expect(kinds(segments)).toEqual(['text', 'plan', 'subagents', 'compaction', 'text']);
    });
});
