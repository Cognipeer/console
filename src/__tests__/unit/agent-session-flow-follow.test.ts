/**
 * Following a turn through the session event log (sessionFollow.ts) and reading
 * the log back (sessionActivityUi.ts) now that it carries plan versions,
 * sub-agent lifecycle and sub-agent passes: each frame becomes the update the
 * live reducers take, and a followed turn builds the same segments as one the
 * page ran itself.
 */
import { describe, expect, it } from 'vitest';
import { interpretSessionEvent, type FollowStep } from '@/components/agents/session/sessionFollow';
import {
    appendLiveText,
    applyLiveCompaction,
    applyLivePlan,
    applyLiveSubagent,
    applyLiveToolEvent,
    isGenerating,
    type LiveSegment,
} from '@/components/agents/session/liveFlow';
import { describeSessionEvent } from '@/components/agents/session/sessionActivityUi';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

const frame = (type: string, data: Record<string, unknown>) => ({ seq: 1, type, data });
const read = (type: string, data: Record<string, unknown>) => interpretSessionEvent(type, frame(type, data));

describe('interpretSessionEvent: sub-agent stamps on tool rows', () => {
    it('builds the stamp from the row\'s subagent name, id, delegation call and parallel flag', () => {
        expect(read('agent.tool_use', { toolCallId: 't1', name: 'fetch', args: { url: 'x' }, subagent: 'researcher', subagentId: 'sa_1', parentToolCallId: 'd1', parallel: true }))
            .toEqual({
                kind: 'tool',
                event: {
                    phase: 'start',
                    name: 'fetch',
                    id: 't1',
                    args: { url: 'x' },
                    subagent: { id: 'sa_1', name: 'researcher', parentToolCallId: 'd1', parallel: true },
                },
            });
    });

    it('stamps a result row the same way', () => {
        expect(read('agent.tool_result', { toolCallId: 't1', name: 'fetch', ok: false, error: '404', durationMs: 9, subagent: 'researcher', subagentId: 'sa_1' }))
            .toEqual({
                kind: 'tool',
                event: { phase: 'error', name: 'fetch', id: 't1', durationMs: 9, error: '404', subagent: { id: 'sa_1', name: 'researcher' } },
            });
    });

    it('leaves a row that names a sub-agent without its id as one of the agent\'s own calls: it cannot be matched to a run', () => {
        const step = read('agent.tool_use', { toolCallId: 't1', name: 'fetch', subagent: 'researcher' }) as Extract<FollowStep, { kind: 'tool' }>;
        expect('subagent' in step.event).toBe(false);
        const nameOnly = read('agent.tool_result', { toolCallId: 't1', name: 'fetch', ok: true, subagent: 'researcher', parentToolCallId: 'd1' }) as Extract<FollowStep, { kind: 'tool' }>;
        expect('subagent' in nameOnly.event).toBe(false);
    });

    it('reads { id, name } and falls back to the id when only the id is there', () => {
        const nested = read('agent.tool_use', { name: 'fetch', subagent: { id: 'sa_2', name: 'writer' } }) as Extract<FollowStep, { kind: 'tool' }>;
        expect(nested.event.subagent).toEqual({ id: 'sa_2', name: 'writer' });
        const idOnly = read('agent.tool_use', { name: 'fetch', subagentId: 'sa_3' }) as Extract<FollowStep, { kind: 'tool' }>;
        expect(idOnly.event.subagent).toEqual({ id: 'sa_3', name: 'sa_3' });
        // An empty name does not hide the id the row names the sub-agent by.
        const emptyName = read('agent.tool_use', { name: 'fetch', subagent: '', subagentId: 'sa_4' }) as Extract<FollowStep, { kind: 'tool' }>;
        expect(emptyName.event.subagent).toEqual({ id: 'sa_4', name: 'sa_4' });
    });

    it('adds no stamp to the agent\'s own calls, and no parallel flag that is false', () => {
        const own = read('agent.tool_use', { name: 'fetch', parallel: false, parentToolCallId: 'd1' }) as Extract<FollowStep, { kind: 'tool' }>;
        expect('subagent' in own.event).toBe(false);
        const child = read('agent.tool_use', { name: 'fetch', subagent: 'a', subagentId: 'sa_a', parallel: false }) as Extract<FollowStep, { kind: 'tool' }>;
        expect(child.event.subagent).toEqual({ id: 'sa_a', name: 'a' });
    });

    it('stamps no delegation call, whatever the row names: a child cannot delegate', () => {
        // The log writes the name of the sub-agent a task was handed to on the agent's OWN delegation rows.
        for (const name of ['delegate_to', 'spawn_subagent', 'spawn_subagents_parallel']) {
            const start = read('agent.tool_use', { toolCallId: 'd1', name, args: { agent: 'researcher' }, subagent: 'researcher' }) as Extract<FollowStep, { kind: 'tool' }>;
            expect(start.event, name).toMatchObject({ phase: 'start', name, id: 'd1' });
            expect('subagent' in start.event, name).toBe(false);
            const done = read('agent.tool_result', { toolCallId: 'd1', name, ok: true, durationMs: 5, subagent: 'researcher, writer' }) as Extract<FollowStep, { kind: 'tool' }>;
            expect('subagent' in done.event, name).toBe(false);
            // Not even a row that carries an id and a delegation call together.
            const odd = read('agent.tool_use', { toolCallId: 'd1', name, subagent: 'researcher', subagentId: 'sa_1', parentToolCallId: 'p0' }) as Extract<FollowStep, { kind: 'tool' }>;
            expect('subagent' in odd.event, name).toBe(false);
        }
    });
});

describe('interpretSessionEvent: plan, sub-agent and pass frames', () => {
    const snapshot = { toolCallId: 'c1', version: 2, operation: 'update', steps: [{ id: 1, title: 'A', status: 'completed' }], at: '2026-10-23T10:00:00.000Z' };

    it('maps agent.plan to a plan step', () => {
        expect(read('agent.plan', snapshot)).toEqual({ kind: 'plan', plan: snapshot });
    });

    it('ignores a plan frame without a version or without steps', () => {
        expect(read('agent.plan', { steps: [] })).toEqual({ kind: 'ignore' });
        expect(read('agent.plan', { version: 1 })).toEqual({ kind: 'ignore' });
        expect(interpretSessionEvent('agent.plan', null)).toEqual({ kind: 'ignore' });
    });

    it('maps agent.subagent to a subagent step', () => {
        const data = { phase: 'result', id: 'sa_1', name: 'researcher', parentToolCallId: 'd1', content: 'ok', at: '2026-10-23T10:00:00.000Z' };
        expect(read('agent.subagent', data)).toEqual({ kind: 'subagent', event: data });
    });

    it('ignores a sub-agent frame that is not one', () => {
        expect(read('agent.subagent', { phase: 'result', name: 'x' })).toEqual({ kind: 'ignore' });
        expect(read('agent.subagent', { phase: 'weird', id: 'sa_1', name: 'x' })).toEqual({ kind: 'ignore' });
        expect(read('agent.subagent', { phase: 'start', id: 'sa_1' })).toEqual({ kind: 'ignore' });
    });

    it('keeps the position fields and the sub-agent of a pass', () => {
        const pass = { at: '2026-10-23T10:00:00.000Z', id: 'p1', index: 2, afterToolCallId: 'c3', trigger: 'post_tools', subagent: { id: 'sa_1', name: 'researcher' } };
        expect(read('agent.compaction', pass)).toEqual({ kind: 'compaction', compaction: pass });
    });
});

describe('following a turn through the log builds the same segments as running it', () => {
    function follow(frames: Array<[string, Record<string, unknown>]>): LiveSegment[] {
        let segments: LiveSegment[] = [];
        for (const [type, data] of frames) {
            const step = read(type, data);
            if (step.kind === 'tool') segments = applyLiveToolEvent(segments, step.event);
            else if (step.kind === 'text') segments = appendLiveText(segments, step.text);
            else if (step.kind === 'plan') segments = applyLivePlan(segments, step.plan);
            else if (step.kind === 'subagent') segments = applyLiveSubagent(segments, step.event);
            else if (step.kind === 'compaction') segments = applyLiveCompaction(segments, step.compaction);
        }
        return segments;
    }

    it('shows the plan, the group with its child steps and child pass, and the agent\'s own pass in order', () => {
        const at = '2026-10-23T10:00:00.000Z';
        const segments = follow([
            ['agent.tool_use', { toolCallId: 'c1', name: 'manage_plan', args: { operation: 'write' } }],
            ['agent.plan', { toolCallId: 'c1', version: 1, operation: 'write', steps: [{ id: 1, title: 'A', status: 'in-progress' }], at }],
            ['agent.tool_result', { toolCallId: 'c1', name: 'manage_plan', ok: true }],
            ['agent.tool_use', { toolCallId: 'd1', name: 'delegate_to', args: { agent: 'researcher', task: 'go' } }],
            ['agent.subagent', { phase: 'start', id: 'sa_1', name: 'researcher', parentToolCallId: 'd1', input: 'go', at }],
            ['agent.tool_use', { toolCallId: 't1', name: 'fetch', subagent: 'researcher', subagentId: 'sa_1', parentToolCallId: 'd1' }],
            ['agent.tool_result', { toolCallId: 't1', name: 'fetch', ok: true, durationMs: 4, subagent: 'researcher', subagentId: 'sa_1', parentToolCallId: 'd1' }],
            ['agent.compaction', { at, id: 'cp1', subagent: { id: 'sa_1', name: 'researcher' } }],
            ['agent.subagent', { phase: 'result', id: 'sa_1', name: 'researcher', parentToolCallId: 'd1', content: 'found it', at }],
            ['agent.tool_result', { toolCallId: 'd1', name: 'delegate_to', ok: true, durationMs: 800 }],
            ['agent.compaction', { at, id: 'p1', afterToolCallId: 'd1' }],
            ['agent.message.delta', { text: 'Done.' }],
        ]);
        expect(segments.map((segment) => segment.kind)).toEqual(['plan', 'subagents', 'compaction', 'text']);
        const group = segments[1];
        if (group.kind !== 'subagents') throw new Error('expected a group');
        expect(group.call).toMatchObject({ key: 'd1', running: false, durationMs: 800 });
        expect(group.runs).toHaveLength(1);
        expect(group.runs[0]).toMatchObject({
            id: 'sa_1',
            phase: 'result',
            input: 'go',
            result: 'found it',
            steps: [{ key: 't1', running: false, durationMs: 4 }],
            compactions: [{ id: 'cp1', afterToolCallId: 't1' }],
        });
    });

    it('opens one run, not a ghost beside it, when the delegation rows name the sub-agent', () => {
        const at = '2026-10-23T10:00:00.000Z';
        // What the log writes: the agent's own delegation rows carry the name of the sub-agent the task went to (no id).
        const delegation = { name: 'delegate_to', subagent: 'researcher' };
        const segments = follow([
            ['agent.tool_use', { toolCallId: 'd1', ...delegation, args: { subagent: 'researcher', task: 'go' } }],
            ['agent.subagent', { phase: 'start', id: 'sa_1', name: 'researcher', parentToolCallId: 'd1', input: 'go', at }],
            ['agent.tool_use', { toolCallId: 't1', name: 'fetch', subagent: 'researcher', subagentId: 'sa_1', parentToolCallId: 'd1' }],
            ['agent.tool_result', { toolCallId: 't1', name: 'fetch', ok: true, durationMs: 4, subagent: 'researcher', subagentId: 'sa_1', parentToolCallId: 'd1' }],
            ['agent.subagent', { phase: 'result', id: 'sa_1', name: 'researcher', parentToolCallId: 'd1', content: 'found it', at }],
            ['agent.tool_result', { toolCallId: 'd1', ...delegation, ok: true, durationMs: 800 }],
        ]);
        expect(segments.map((segment) => segment.kind)).toEqual(['subagents']);
        const group = segments[0];
        if (group.kind !== 'subagents') throw new Error('expected a group');
        // The delegation call is the group's own call, and it settled...
        expect(group.call).toMatchObject({ key: 'd1', name: 'delegate_to', running: false, durationMs: 800 });
        // ...the one run is the real one, with its own call in it and no delegation step of its own...
        expect(group.runs).toHaveLength(1);
        expect(group.runs[0]).toMatchObject({ id: 'sa_1', phase: 'result', result: 'found it', steps: [{ key: 't1', name: 'fetch', running: false }] });
        // ...and nothing is left spinning, so the view goes back to writing.
        expect(isGenerating(segments)).toBe(true);
    });

    it('does the same for a parallel spawn: one container, a run per child, no run for the spawn call', () => {
        const at = '2026-10-23T10:00:00.000Z';
        const spawn = { name: 'spawn_subagents_parallel', subagent: 'a, b' };
        const segments = follow([
            ['agent.tool_use', { toolCallId: 'p1', ...spawn }],
            ['agent.subagent', { phase: 'start', id: 'sa_a', name: 'a', parentToolCallId: 'p1#0', parallel: true, at }],
            ['agent.subagent', { phase: 'start', id: 'sa_b', name: 'b', parentToolCallId: 'p1#1', parallel: true, at }],
            ['agent.tool_use', { toolCallId: 't1', name: 'fetch', subagent: 'a', subagentId: 'sa_a', parentToolCallId: 'p1#0', parallel: true }],
            ['agent.subagent', { phase: 'result', id: 'sa_a', name: 'a', parentToolCallId: 'p1#0', parallel: true, content: 'ok', at }],
            ['agent.subagent', { phase: 'result', id: 'sa_b', name: 'b', parentToolCallId: 'p1#1', parallel: true, content: 'ok', at }],
            ['agent.tool_result', { toolCallId: 'p1', ...spawn, ok: true }],
        ]);
        expect(segments.map((segment) => segment.kind)).toEqual(['subagents']);
        const group = segments[0];
        if (group.kind !== 'subagents') throw new Error('expected a group');
        expect(group).toMatchObject({ parentToolCallId: 'p1', parallel: true, call: { key: 'p1', running: false } });
        expect(group.runs.map((run) => run.id)).toEqual(['sa_a', 'sa_b']);
        expect(group.runs[0].steps).toMatchObject([{ key: 't1', running: true }]);
        expect(isGenerating(segments)).toBe(true);
    });
});

describe('describeSessionEvent: plan and sub-agent rows', () => {
    const event = (type: string, data: Record<string, unknown>) => ({ seq: 1, type, data });

    it('reads a plan version with its progress', () => {
        expect(describeSessionEvent(event('agent.plan', {
            version: 3,
            steps: [{ id: 1, title: 'a', status: 'completed' }, { id: 2, title: 'b', status: 'completed' }, { id: 3, title: 'c', status: 'in-progress' }],
        }))).toMatchObject({ key: 'evPlan', values: { version: 3, done: 2, total: 3 } });
        expect(describeSessionEvent(event('agent.plan', {}))).toMatchObject({ key: 'evPlan', values: { version: '?', done: 0, total: 0 } });
    });

    it('reads each phase of a sub-agent with its name', () => {
        expect(describeSessionEvent(event('agent.subagent', { phase: 'start', name: 'researcher' })))
            .toMatchObject({ key: 'evSubagentStarted', values: { name: 'researcher' } });
        expect(describeSessionEvent(event('agent.subagent', { phase: 'result', name: 'researcher', status: 'ok' })))
            .toMatchObject({ key: 'evSubagentFinished', tone: 'green' });
        expect(describeSessionEvent(event('agent.subagent', { phase: 'error', name: 'researcher', error: 'boom' })))
            .toMatchObject({ key: 'evSubagentFailed', tone: 'red', detail: 'boom' });
        expect(describeSessionEvent(event('agent.subagent', { phase: 'result', name: 'researcher', status: 'error' })))
            .toMatchObject({ key: 'evSubagentFailed' });
        expect(describeSessionEvent(event('agent.subagent', { phase: 'paused', name: 'researcher' })))
            .toMatchObject({ key: 'evSubagentPaused', tone: 'orange' });
    });

    it('names the sub-agent whose own pass it was, and keeps the agent\'s own pass plain', () => {
        expect(describeSessionEvent(event('agent.compaction', { subagent: { id: 'sa_1', name: 'researcher' } })))
            .toMatchObject({ key: 'evSubagentCompaction', values: { name: 'researcher' } });
        expect(describeSessionEvent(event('agent.compaction', { subagent: 'writer' })))
            .toMatchObject({ key: 'evSubagentCompaction', values: { name: 'writer' } });
        expect(describeSessionEvent(event('agent.compaction', {}))).toMatchObject({ key: 'evCompaction' });
    });

    it('has the wording in English and Turkish, with the same placeholders', () => {
        const english = en.agents.activity as Record<string, string>;
        const turkish = tr.agents.activity as Record<string, string>;
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const key of ['evPlan', 'evSubagentStarted', 'evSubagentFinished', 'evSubagentFailed', 'evSubagentPaused', 'evSubagentCompaction']) {
            expect(english[key], key).toBeTruthy();
            expect(turkish[key], key).toBeTruthy();
            expect(turkish[key], key).not.toBe(english[key]);
            expect(placeholders(turkish[key]), key).toEqual(placeholders(english[key]));
        }
    });
});

describe('agents.sessionFlow wording', () => {
    it('exists in both languages with the same keys and placeholders', () => {
        const english = (en.agents as unknown as Record<string, Record<string, string>>).sessionFlow;
        const turkish = (tr.agents as unknown as Record<string, Record<string, string>>).sessionFlow;
        expect(Object.keys(turkish).sort()).toEqual(Object.keys(english).sort());
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const key of Object.keys(english)) {
            expect(turkish[key].trim(), key).not.toBe('');
            expect(placeholders(turkish[key]), key).toEqual(placeholders(english[key]));
        }
    });
});
