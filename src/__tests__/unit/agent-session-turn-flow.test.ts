/**
 * The order of a stored turn (orderTurnFlow, shared with the server and the
 * portal), what each block needs to be drawn (components/agents/session/turnFlowUi.ts),
 * and that a turn built live from its events has the same order as the stored
 * message that came out of the same events.
 */
import { describe, expect, it } from 'vitest';
import { orderTurnFlow, type TurnFlowBlock } from '@/lib/shared/agentTurnFlow';
import {
    buildTurnFlow,
    buildTurnFlowAt,
    compactionAnchorId,
    compactionDividerView,
    compactionPassKey,
    compactionPlacement,
    delegationAnchorId,
    planAnchorId,
    type TurnFlowBlockView,
} from '@/components/agents/session/turnFlowUi';
import {
    appendLiveText,
    applyLiveCompaction,
    applyLivePlan,
    applyLiveSubagent,
    applyLiveToolEvent,
    type LiveSegment,
} from '@/components/agents/session/liveFlow';
import { assistantFromResult } from '@/components/agents/session/assistantFromResult';
import { subagentRunView } from '@/components/agents/session/subagentUi';
import type {
    IAgentConversationStep,
    IAgentMessagePendingAction,
    IAgentPlanStep,
    IAgentTurnCompaction,
    IAgentTurnPlanSnapshot,
    IAgentTurnSubagentRun,
} from '@/lib/database/provider/types.domain';

const T = (seconds: number) => `2026-10-23T10:00:${String(seconds).padStart(2, '0')}.000Z`;

const call = (id: string, name = 'web_search', extra: Partial<IAgentConversationStep> = {}): IAgentConversationStep => ({
    id,
    name,
    status: 'success',
    ...extra,
});

const planStep = (id: number, status: IAgentPlanStep['status']): IAgentPlanStep => ({ id, title: `Step ${id}`, status });

function plan(version: number, extra: Partial<IAgentTurnPlanSnapshot> = {}): IAgentTurnPlanSnapshot {
    return {
        version,
        operation: version === 1 ? 'write' : 'update',
        steps: [planStep(1, version === 1 ? 'in-progress' : 'completed'), planStep(2, version === 1 ? 'not-started' : 'in-progress')],
        at: T(version),
        ...extra,
    };
}

const pass = (id: string, extra: Partial<IAgentTurnCompaction> = {}): IAgentTurnCompaction => ({ at: T(5), id, ...extra });

function run(id: string, extra: Partial<IAgentTurnSubagentRun> = {}): IAgentTurnSubagentRun {
    return { id, name: `agent-${id}`, phase: 'result', steps: [], ...extra };
}

/** One line per block: `steps:c1,c2`, `plan:v2`, `pass:p1`, `group:d1(sa_1,sa_2)`, `text:…`. */
function shape(blocks: TurnFlowBlock[]): string[] {
    return blocks.map((block) => {
        switch (block.kind) {
            case 'narration': return `text:${block.text}`;
            case 'steps': return `steps:${block.steps.map((step) => step.id).join(',')}`;
            case 'plan': return `plan:v${block.plan.version}`;
            case 'compaction': return `pass:${block.compaction.id ?? block.index}`;
            case 'subagents': return `group:${block.parentToolCallId ?? ''}(${block.runs.map((r) => r.id).join(',')})`;
        }
    });
}

describe('orderTurnFlow: summarization passes', () => {
    const steps = [call('c1', 'web_search', { timestamp: T(0) }), call('c2', 'fetch', { timestamp: T(10) })];

    it('puts a pass right after the tool call it followed', () => {
        expect(shape(orderTurnFlow({ steps, compactions: [pass('p1', { afterToolCallId: 'c1', index: 1 })] })))
            .toEqual(['steps:c1', 'pass:p1', 'steps:c2']);
    });

    it('puts a pass whose position is null before any call', () => {
        expect(shape(orderTurnFlow({ steps, compactions: [pass('p1', { afterToolCallId: null }), pass('p2', { afterToolCallId: null })] })))
            .toEqual(['pass:p1', 'pass:p2', 'steps:c1,c2']);
    });

    it('keeps several passes after the same call in the order they happened', () => {
        const compactions = [pass('p1', { afterToolCallId: 'c1' }), pass('p2', { afterToolCallId: 'c1' }), pass('p3', { afterToolCallId: 'c2' })];
        expect(shape(orderTurnFlow({ steps, compactions }))).toEqual(['steps:c1', 'pass:p1', 'pass:p2', 'steps:c2', 'pass:p3']);
    });

    it('numbers a pass by its own index, else by its place in the list', () => {
        const blocks = orderTurnFlow({ steps, compactions: [pass('p1', { index: 4, afterToolCallId: 'c1' }), pass('p2', { afterToolCallId: 'c1' })] });
        expect(blocks.filter((block) => block.kind === 'compaction').map((block) => (block as { index: number }).index)).toEqual([4, 2]);
    });

    it('places a pass stored before positions existed by wall clock', () => {
        expect(shape(orderTurnFlow({ steps, compactions: [pass('p1', { at: T(5) })] }))).toEqual(['steps:c1', 'pass:p1', 'steps:c2']);
        expect(shape(orderTurnFlow({ steps, compactions: [pass('p1', { at: T(30) })] }))).toEqual(['steps:c1,c2', 'pass:p1']);
        expect(shape(orderTurnFlow({ steps, compactions: [pass('p1', { at: '2026-10-23T09:00:00.000Z' })] }))).toEqual(['pass:p1', 'steps:c1,c2']);
    });

    it('puts a pass at the end when neither it nor the steps have a time', () => {
        const bare = [call('c1'), call('c2')];
        expect(shape(orderTurnFlow({ steps: bare, compactions: [pass('p1', { at: 'unknown' })] }))).toEqual(['steps:c1,c2', 'pass:p1']);
        expect(shape(orderTurnFlow({ steps: bare, compactions: [pass('p1')] }))).toEqual(['steps:c1,c2', 'pass:p1']);
    });

    it('falls back to the clock for a pass whose call is in another message', () => {
        expect(shape(orderTurnFlow({ steps, compactions: [pass('p1', { at: T(5), afterToolCallId: 'earlier-message' })] })))
            .toEqual(['steps:c1', 'pass:p1', 'steps:c2']);
    });
});

describe('orderTurnFlow: plan versions', () => {
    it('shows a plan version where the call that wrote it was', () => {
        const steps = [call('c0'), call('c1', 'manage_plan'), call('c2')];
        expect(shape(orderTurnFlow({ steps, plans: [plan(1, { toolCallId: 'c1' })] }))).toEqual(['steps:c0', 'plan:v1', 'steps:c2']);
    });

    it('shows every version one call wrote, and chains each to the one before', () => {
        const blocks = orderTurnFlow({ steps: [call('c1', 'manage_plan')], plans: [plan(1, { toolCallId: 'c1' }), plan(2, { toolCallId: 'c1' })] }, { previousPlan: plan(0) });
        expect(shape(blocks)).toEqual(['plan:v1', 'plan:v2']);
        const [first, second] = blocks as Array<Extract<TurnFlowBlock, { kind: 'plan' }>>;
        expect(first.previous?.version).toBe(0);
        expect(second.previous?.version).toBe(1);
    });

    it('hides a plan call that wrote nothing (a read) only when the message records plan versions', () => {
        const steps = [call('c1', 'manage_plan'), call('c2')];
        expect(shape(orderTurnFlow({ steps, plans: [] }))).toEqual(['steps:c2']);
        expect(shape(orderTurnFlow({ steps, plans: [plan(1, { toolCallId: 'other' })] }))).toEqual(['steps:c2', 'plan:v1']);
        // A message stored before plans were recorded keeps every call it made.
        expect(shape(orderTurnFlow({ steps }))).toEqual(['steps:c1,c2']);
    });

    it('keeps a plan call that failed, even when plans are recorded', () => {
        expect(shape(orderTurnFlow({ steps: [call('c1', 'manage_plan', { status: 'error', error: 'bad' })], plans: [] }))).toEqual(['steps:c1']);
    });

    it('places a version without a call by wall clock', () => {
        const steps = [call('c1', 'web_search', { timestamp: T(0) }), call('c2', 'fetch', { timestamp: T(10) })];
        expect(shape(orderTurnFlow({ steps, plans: [plan(1, { at: T(5) })] }))).toEqual(['steps:c1', 'plan:v1', 'steps:c2']);
    });

    it('lets the first version start from the plan an earlier message left', () => {
        const [block] = orderTurnFlow({ steps: [call('c1', 'manage_plan')], plans: [plan(3, { toolCallId: 'c1' })] }, { previousPlan: plan(2) });
        expect(block).toMatchObject({ kind: 'plan', previous: { version: 2 } });
        const [alone] = orderTurnFlow({ steps: [call('c1', 'manage_plan')], plans: [plan(1, { toolCallId: 'c1' })] });
        expect('previous' in alone).toBe(false);
    });
});

describe('orderTurnFlow: sub-agent groups', () => {
    it('turns a delegation call into a group of the runs it started', () => {
        const blocks = orderTurnFlow({ steps: [call('c0'), call('d1', 'delegate_to'), call('c2')], subagentRuns: [run('sa_1', { parentToolCallId: 'd1' })] });
        expect(shape(blocks)).toEqual(['steps:c0', 'group:d1(sa_1)', 'steps:c2']);
        expect(blocks[1]).toMatchObject({ kind: 'subagents', parallel: false, step: { id: 'd1' } });
    });

    it('makes a parallel container of spawn_subagents_parallel, and of any call that started several runs', () => {
        const parallel = orderTurnFlow({
            steps: [call('p1', 'spawn_subagents_parallel')],
            subagentRuns: [run('a', { parentToolCallId: 'p1', parallel: true }), run('b', { parentToolCallId: 'p1', parallel: true })],
        });
        expect(shape(parallel)).toEqual(['group:p1(a,b)']);
        expect(parallel[0]).toMatchObject({ parallel: true });
        const several = orderTurnFlow({ steps: [call('d1', 'delegate_to')], subagentRuns: [run('a', { parentToolCallId: 'd1' }), run('b', { parentToolCallId: 'd1' })] });
        expect(several[0]).toMatchObject({ parallel: true });
        const bare = orderTurnFlow({ steps: [call('p1', 'spawn_subagents_parallel')] });
        expect(bare[0]).toMatchObject({ parallel: true, runs: [] });
    });

    it('keeps a delegation stored before runs were recorded as a group with no runs', () => {
        const blocks = orderTurnFlow({ steps: [call('d1', 'delegate_to')] });
        expect(blocks).toEqual([{ kind: 'subagents', parentToolCallId: 'd1', step: call('d1', 'delegate_to'), runs: [], parallel: false }]);
    });

    it('shows a run whose call is not in this message (it paused earlier) where its clock says, or at the end', () => {
        const steps = [call('c1', 'web_search', { timestamp: T(0) }), call('c2', 'fetch', { timestamp: T(10) })];
        const orphan = run('sa_9', { parentToolCallId: 'earlier', startedAt: T(5), resumed: true });
        const blocks = orderTurnFlow({ steps, subagentRuns: [orphan] });
        expect(shape(blocks)).toEqual(['steps:c1', 'group:earlier(sa_9)', 'steps:c2']);
        expect('step' in blocks[1]).toBe(false);
        expect(shape(orderTurnFlow({ steps, subagentRuns: [run('sa_9', { parentToolCallId: 'earlier' })] }))).toEqual(['steps:c1,c2', 'group:earlier(sa_9)']);
    });

    it('keeps runs with no delegation call together under no id', () => {
        const blocks = orderTurnFlow({ steps: [call('c1')], subagentRuns: [run('a'), run('b')] });
        expect(shape(blocks)).toEqual(['steps:c1', 'group:(a,b)']);
        expect('parentToolCallId' in blocks[1]).toBe(false);
    });

    it('puts a pass that followed a delegation call after its group', () => {
        const blocks = orderTurnFlow({
            steps: [call('d1', 'delegate_to'), call('c2')],
            subagentRuns: [run('sa_1', { parentToolCallId: 'd1' })],
            compactions: [pass('p1', { afterToolCallId: 'd1' })],
        });
        expect(shape(blocks)).toEqual(['group:d1(sa_1)', 'pass:p1', 'steps:c2']);
    });

    it('puts narration before the call it was written with', () => {
        const blocks = orderTurnFlow({ steps: [call('c1', 'web_search', { narration: 'Let me look.' }), call('d1', 'delegate_to', { narration: 'Handing over.' })] });
        expect(shape(blocks)).toEqual(['text:Let me look.', 'steps:c1', 'text:Handing over.', 'group:d1()']);
    });
});

describe('anchors', () => {
    it('are stable and CSS-safe', () => {
        expect(compactionAnchorId(2, 'p1')).toBe('flow-pass-2-p1');
        expect(compactionAnchorId(0, 'a b/c')).toBe('flow-pass-0-a_b_c');
        expect(compactionAnchorId(0, 3)).toBe('flow-pass-0-3');
        expect(planAnchorId(4)).toBe('flow-plan-v4');
        expect(delegationAnchorId('toolu_01.x:y')).toBe('flow-delegation-toolu_01_x_y');
        for (const id of [compactionAnchorId(1, 'we!rd id'), delegationAnchorId('a#b c'), planAnchorId(2)]) {
            expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
        }
    });

    it('name a pass by its id, else its index, else its place', () => {
        expect(compactionPassKey({ id: 'p1', index: 2 }, 5)).toBe('p1');
        expect(compactionPassKey({ index: 2 }, 5)).toBe(2);
        expect(compactionPassKey({}, 5)).toBe(5);
    });
});

describe('compactionDividerView', () => {
    it('gives the figures of one pass', () => {
        const view = compactionDividerView(
            pass('p1', {
                tokensBefore: 84200,
                tokensAfter: 11900,
                durationMs: 3100,
                model: 'gpt-x',
                compactedTools: [{ toolName: 'a', toolCallId: '1' }, { toolName: 'b', toolCallId: '2' }],
            }),
            { index: 2 },
        );
        expect(view).toEqual({
            index: 2,
            pending: false,
            failed: false,
            tokensBefore: 84200,
            tokensAfter: 11900,
            savedPercent: 86,
            durationMs: 3100,
            replacedTools: 2,
            compactedTools: [{ toolName: 'a', toolCallId: '1' }, { toolName: 'b', toolCallId: '2' }],
            model: 'gpt-x',
        });
    });

    it('has no pass number inside a sub-agent\'s group', () => {
        expect('index' in compactionDividerView(pass('p1'))).toBe(false);
    });

    it('falls back to the count the SDK gave when the pass lists no tools, and says nothing when there is none', () => {
        expect(compactionDividerView(pass('p1', { messagesCompressed: 3 })).replacedTools).toBe(3);
        expect('replacedTools' in compactionDividerView(pass('p1'))).toBe(false);
        expect(compactionDividerView(pass('p1')).compactedTools).toEqual([]);
    });

    it('needs both token counts (and a before above zero) to say how much it saved', () => {
        expect('savedPercent' in compactionDividerView(pass('p1', { tokensBefore: 1000 }))).toBe(false);
        expect('savedPercent' in compactionDividerView(pass('p1', { tokensBefore: 0, tokensAfter: 0 }))).toBe(false);
        expect(compactionDividerView(pass('p1', { tokensBefore: 1000, tokensAfter: 1200 })).savedPercent).toBe(-20);
    });

    it('flags a failed pass and a pending one', () => {
        expect(compactionDividerView(pass('p1', { failed: true })).failed).toBe(true);
        expect(compactionDividerView({ at: T(1), id: 'p1', phase: 'start' }).pending).toBe(true);
    });
});

describe('compactionPlacement', () => {
    const message = {
        steps: [call('c1', 'web_search'), call('d1', 'delegate_to'), call('d2', 'delegate_to')],
        subagentRuns: [run('a', { parentToolCallId: 'd1' }), run('b', { parentToolCallId: 'd1' })],
    };

    it('says where a pass happened', () => {
        expect(compactionPlacement(message, { afterToolCallId: null })).toEqual({ kind: 'turn_start' });
        expect(compactionPlacement(message, { afterToolCallId: 'c1' })).toEqual({ kind: 'after_tool', toolName: 'web_search' });
        expect(compactionPlacement(message, { afterToolCallId: 'd1' })).toEqual({ kind: 'after_subagents', names: ['agent-a', 'agent-b'] });
    });

    it('names the delegation tool when it started no recorded run', () => {
        expect(compactionPlacement(message, { afterToolCallId: 'd2' })).toEqual({ kind: 'after_tool', toolName: 'delegate_to' });
    });

    it('says nothing for a pass stored before positions, or whose call is in another message', () => {
        expect(compactionPlacement(message, {})).toEqual({ kind: 'unplaced' });
        expect(compactionPlacement(message, { afterToolCallId: 'elsewhere' })).toEqual({ kind: 'unplaced' });
    });
});

describe('buildTurnFlow', () => {
    it('draws the first plan version of a turn in full and the later ones as updates, with what changed', () => {
        const blocks = buildTurnFlow({ steps: [call('c1', 'manage_plan'), call('c2'), call('c3', 'manage_plan')], plans: [plan(1, { toolCallId: 'c1' }), plan(2, { toolCallId: 'c3' })] });
        const plans = blocks.filter((block): block is Extract<TurnFlowBlockView, { kind: 'plan' }> => block.kind === 'plan');
        expect(plans.map((block) => [block.plan.version, block.full, block.anchorId])).toEqual([[1, true, 'flow-plan-v1'], [2, false, 'flow-plan-v2']]);
        expect(plans[0].parts).toEqual([]);
        expect(plans[0]).toMatchObject({ progress: { done: 0, total: 2 }, percent: 0 });
        expect(plans[1].parts.map((part) => [part.kind, part.text])).toEqual([['completed', '1'], ['started', '2']]);
        expect(plans[1]).toMatchObject({ progress: { done: 1, total: 2 }, percent: 50 });
    });

    it('builds run views, a parallel header and a legacy view', () => {
        const pending: IAgentMessagePendingAction[] = [{ id: 'x', kind: 'tool_approval', status: 'pending', delegationToolCallId: 'p1', subagent: 'agent-a' }];
        const blocks = buildTurnFlow({
            steps: [call('p1', 'spawn_subagents_parallel'), call('d1', 'delegate_to', { args: { agent: 'old-one', task: 't' } }), call('d2', 'delegate_to')],
            subagentRuns: [
                run('a', { parentToolCallId: 'p1', parallel: true, phase: 'paused', durationMs: 100 }),
                run('b', { parentToolCallId: 'p1', parallel: true, durationMs: 300 }),
                run('c', { parentToolCallId: 'd2', durationMs: 50 }),
            ],
            pendingActions: pending,
        });
        const groups = blocks.filter((block): block is Extract<TurnFlowBlockView, { kind: 'subagents' }> => block.kind === 'subagents');
        expect(groups).toHaveLength(3);
        const [parallel, legacy, single] = groups;
        expect(parallel).toMatchObject({ anchorId: 'flow-delegation-p1', parentToolCallId: 'p1', parallel: true });
        expect(parallel.runs.map((view) => [view.id, view.statusKind])).toEqual([['a', 'paused'], ['b', 'done']]);
        expect(parallel.group).toMatchObject({ count: 2, done: 1, approvals: 1, durationMs: 300, names: ['agent-a', 'agent-b'], statusKind: 'paused' });
        expect(legacy.runs).toEqual([]);
        expect(legacy.legacy).toMatchObject({ name: 'old-one', input: 't', stepsNotRecorded: true });
        expect(legacy.anchorId).toBe('flow-delegation-d1');
        expect('group' in single).toBe(false);
        expect('legacy' in single).toBe(false);
        expect(single.runs[0]).toMatchObject({ id: 'c', statusKind: 'done', stepsNotRecorded: false });
    });

    it('reads a run that paused for a person who has since answered as continued, so the group does not say it waits', () => {
        const answered: IAgentMessagePendingAction[] = [{ id: 'x', kind: 'tool_approval', status: 'resolved', delegationToolCallId: 'p1', subagent: 'agent-a' }];
        const blocks = buildTurnFlow({
            steps: [call('p1', 'spawn_subagents_parallel')],
            subagentRuns: [
                run('a', { parentToolCallId: 'p1', parallel: true, phase: 'paused' }),
                run('b', { parentToolCallId: 'p1', parallel: true }),
            ],
            pendingActions: answered,
        });
        const group = blocks.find((block): block is Extract<TurnFlowBlockView, { kind: 'subagents' }> => block.kind === 'subagents');
        if (!group) throw new Error('expected a group');
        expect(group.runs.map((view) => [view.id, view.statusKind])).toEqual([['a', 'continued'], ['b', 'done']]);
        expect(group.group).toMatchObject({ count: 2, done: 2, approvals: 0, statusKind: 'done' });
    });

    it('anchors a pass by its message and its id, and gives its figures', () => {
        const blocks = buildTurnFlow(
            { steps: [call('c1')], compactions: [pass('p1', { afterToolCallId: 'c1', index: 3, tokensBefore: 1000, tokensAfter: 250 })] },
            { messageIndex: 5 },
        );
        const divider = blocks.find((block) => block.kind === 'compaction') as Extract<TurnFlowBlockView, { kind: 'compaction' }>;
        expect(divider.anchorId).toBe('flow-pass-5-p1');
        expect(divider.index).toBe(3);
        expect(divider.view).toMatchObject({ index: 3, savedPercent: 75 });
    });

    it('gives every block its own key', () => {
        const blocks = buildTurnFlow({ steps: [call('c1', 'web_search', { narration: 'a' }), call('c2', 'fetch', { narration: 'b' })], compactions: [pass('p1', { afterToolCallId: 'c1' })] });
        const keys = blocks.map((block) => block.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('starts from the plan an earlier message of the session left', () => {
        const messages = [
            { steps: [call('c1', 'manage_plan')], plans: [plan(1, { toolCallId: 'c1' })] },
            { steps: [call('c2')] },
            { steps: [call('c3', 'manage_plan')], plans: [plan(2, { toolCallId: 'c3' })] },
        ];
        const first = buildTurnFlowAt(messages, 0)[0] as Extract<TurnFlowBlockView, { kind: 'plan' }>;
        expect(first.previous).toBeUndefined();
        const later = buildTurnFlowAt(messages, 2)[0] as Extract<TurnFlowBlockView, { kind: 'plan' }>;
        expect(later.previous?.version).toBe(1);
        expect(later.full).toBe(true);
        expect(later.parts.map((part) => part.kind)).toEqual(['completed', 'started']);
    });

    it('anchors passes with the message\'s own index', () => {
        const messages = [{ steps: [call('c1')] }, { steps: [call('c2')], compactions: [pass('p1', { afterToolCallId: 'c2' })] }];
        const divider = buildTurnFlowAt(messages, 1).find((block) => block.kind === 'compaction') as Extract<TurnFlowBlockView, { kind: 'compaction' }>;
        expect(divider.anchorId).toBe('flow-pass-1-p1');
    });
});

describe('live and stored turns have the same order', () => {
    const at = T(1);

    /** What the order of a live turn is, in the terms `shape` uses for a stored one (the trailing answer text is not part of the flow). */
    function liveShape(segments: LiveSegment[]): string[] {
        const body = [...segments];
        while (body[body.length - 1]?.kind === 'text') body.pop();
        return body.map((segment) => {
            switch (segment.kind) {
                case 'text': return `text:${segment.text}`;
                case 'reasoning': return 'reasoning';
                case 'tools': return `steps:${segment.calls.map((c) => c.key).join(',')}`;
                case 'plan': return `plan:v${segment.plan.version}`;
                case 'compaction': return `pass:${segment.compaction.id}`;
                case 'subagents': return `group:${segment.parentToolCallId ?? ''}(${segment.runs.map((r) => r.id).join(',')})`;
            }
        });
    }

    function liveTurn(): LiveSegment[] {
        let s: LiveSegment[] = [];
        const tool = (phase: string, name: string, id: string, extra: object = {}) => {
            s = applyLiveToolEvent(s, { phase, name, id, ...extra });
        };
        const stamp = { id: 'sa_1', name: 'agent-sa_1', parentToolCallId: 'd1' };
        s = appendLiveText(s, 'Let me plan.');
        tool('start', 'manage_plan', 'c1');
        s = applyLivePlan(s, plan(1, { toolCallId: 'c1', at: T(1) }));
        tool('success', 'manage_plan', 'c1');
        tool('start', 'web_search', 'c2');
        tool('start', 'web_search', 'c3');
        tool('success', 'web_search', 'c2');
        tool('success', 'web_search', 'c3');
        s = applyLiveCompaction(s, { at, id: 'p1', phase: 'start' });
        s = applyLiveCompaction(s, { at, id: 'p1', index: 1, afterToolCallId: 'c3', tokensBefore: 900, tokensAfter: 300 });
        s = appendLiveText(s, 'Now delegating.');
        tool('start', 'delegate_to', 'd1');
        s = applyLiveSubagent(s, { phase: 'start', id: 'sa_1', name: 'agent-sa_1', parentToolCallId: 'd1', input: 'go', at });
        tool('start', 'fetch', 't1', { subagent: stamp });
        tool('success', 'fetch', 't1', { subagent: stamp, durationMs: 4 });
        s = applyLiveCompaction(s, { at, id: 'cp1', phase: 'start', subagent: { id: 'sa_1', name: 'agent-sa_1' } });
        s = applyLiveCompaction(s, { at, id: 'cp1', subagent: { id: 'sa_1', name: 'agent-sa_1' } });
        s = applyLiveSubagent(s, { phase: 'result', id: 'sa_1', name: 'agent-sa_1', parentToolCallId: 'd1', content: 'found', status: 'ok', at });
        tool('success', 'delegate_to', 'd1');
        tool('start', 'manage_plan', 'c5');
        s = applyLivePlan(s, plan(2, { toolCallId: 'c5', at: T(2) }));
        tool('success', 'manage_plan', 'c5');
        s = appendLiveText(s, 'Answer');
        return s;
    }

    /** The message the server stores for the same events (what the turn tracker records). */
    function storedTurn() {
        const sub = run('sa_1', {
            parentToolCallId: 'd1',
            input: 'go',
            result: 'found',
            status: 'ok',
            startedAt: T(3),
            steps: [{ id: 't1', name: 'fetch', status: 'success', durationMs: 4, timestamp: T(3) }],
            compactions: [{ at: T(4), id: 'cp1' }],
        });
        return {
            steps: [
                call('c1', 'manage_plan', { narration: 'Let me plan.' }),
                call('c2'),
                call('c3'),
                call('d1', 'delegate_to', { narration: 'Now delegating.' }),
                call('c5', 'manage_plan'),
            ],
            plans: [plan(1, { toolCallId: 'c1' }), plan(2, { toolCallId: 'c5' })],
            subagentRuns: [{ ...sub, name: 'agent-sa_1' }],
            compactions: [pass('p1', { index: 1, afterToolCallId: 'c3' })],
        };
    }

    it('lists the same blocks in the same order', () => {
        const live = liveShape(liveTurn());
        const stored = shape(orderTurnFlow(storedTurn()));
        expect(live).toEqual(['text:Let me plan.', 'plan:v1', 'steps:c2,c3', 'pass:p1', 'text:Now delegating.', 'group:d1(sa_1)', 'plan:v2']);
        expect(stored).toEqual(live);
    });

    it('groups the children of a parallel spawn, keyed <call>#<n>, under the call, in one container', () => {
        let s: LiveSegment[] = [];
        s = applyLiveToolEvent(s, { phase: 'start', name: 'spawn_subagents_parallel', id: 'p1' });
        s = applyLiveSubagent(s, { phase: 'start', id: 'sa_a', name: 'agent-sa_a', parentToolCallId: 'p1#0', parallel: true, at });
        s = applyLiveSubagent(s, { phase: 'start', id: 'sa_b', name: 'agent-sa_b', parentToolCallId: 'p1#1', parallel: true, at });
        s = applyLiveToolEvent(s, { phase: 'success', name: 'spawn_subagents_parallel', id: 'p1' });
        expect(liveShape(s)).toEqual(['group:p1(sa_a,sa_b)']);
        const group = s[0];
        if (group?.kind !== 'subagents') throw new Error('expected a group');
        expect(group.call).toMatchObject({ key: 'p1', running: false });
    });

    it('chains the plan versions the same way', () => {
        const segments = liveTurn();
        const livePlans = segments.filter((segment): segment is Extract<LiveSegment, { kind: 'plan' }> => segment.kind === 'plan');
        const storedPlans = orderTurnFlow(storedTurn()).filter((block): block is Extract<TurnFlowBlock, { kind: 'plan' }> => block.kind === 'plan');
        expect(livePlans.map((entry) => entry.previous?.version)).toEqual([undefined, 1]);
        expect(storedPlans.map((entry) => entry.previous?.version)).toEqual([undefined, 1]);
    });

    it('gives the sub-agent the same rows and verdict', () => {
        const liveGroup = liveTurn().find((segment) => segment.kind === 'subagents');
        if (liveGroup?.kind !== 'subagents') throw new Error('expected a group');
        const liveView = subagentRunView(liveGroup.runs[0], undefined, { live: true });
        const storedGroup = orderTurnFlow(storedTurn()).find((block) => block.kind === 'subagents');
        if (storedGroup?.kind !== 'subagents') throw new Error('expected a group');
        const storedView = subagentRunView(storedGroup.runs[0], undefined, { live: false });
        const rowKeys = (view: typeof liveView) => view.rows.map((row) => `${row.kind}:${row.key}`);
        expect(rowKeys(liveView)).toEqual(['step:t1', 'compaction:cp1']);
        expect(rowKeys(storedView)).toEqual(rowKeys(liveView));
        expect(liveView).toMatchObject({ statusKind: 'done', input: 'go', result: 'found', stepCount: 1 });
        expect(storedView).toMatchObject({ statusKind: 'done', input: 'go', result: 'found', stepCount: 1 });
    });
});

describe('assistantFromResult: the message a result event describes', () => {
    const planCall = call('p1', 'manage_plan');

    it('keeps an empty plans list, so a plan call that wrote nothing stays out of the flow, as it does after a reload', () => {
        const message = assistantFromResult({ content: 'ok', steps: [planCall, call('c1')], plans: [] }, 0);
        expect(message.plans).toEqual([]);
        expect(shape(orderTurnFlow(message))).toEqual(['steps:c1']);
        expect(buildTurnFlow(message).map((block) => block.kind)).toEqual(['steps']);
    });

    it('shows the plan call as a step when the result carries no plans field (a server that does not record versions)', () => {
        const message = assistantFromResult({ content: 'ok', steps: [planCall, call('c1')] }, 0);
        expect('plans' in message).toBe(false);
        expect(shape(orderTurnFlow(message))).toEqual(['steps:p1,c1']);
    });

    it('copies the plan versions a result carries, and shows the call that wrote one as that version', () => {
        const written = plan(1, { toolCallId: 'p1' });
        const message = assistantFromResult({ content: 'ok', steps: [planCall, call('c1')], plans: [written] }, 0);
        expect(message.plans).toEqual([written]);
        expect(shape(orderTurnFlow(message))).toEqual(['plan:v1', 'steps:c1']);
    });

    it('only takes a list for the plan versions', () => {
        for (const plans of [null, 'x', { length: 0 }, 3]) {
            expect('plans' in assistantFromResult({ content: 'ok', plans }, 0), String(plans)).toBe(false);
        }
    });

    it('leaves out what is empty, as the stored message does', () => {
        const message = assistantFromResult({
            content: 'ok',
            steps: [],
            subagentRuns: [],
            compactions: [],
            compactedTools: [],
            warnings: [],
            pendingActions: [],
            attachments: [],
        }, 0);
        for (const key of ['steps', 'subagentRuns', 'compactions', 'compactedTools', 'warnings', 'pendingActions', 'attachments', 'plans']) {
            expect(key in message, key).toBe(false);
        }
        expect(message).toMatchObject({ role: 'assistant', content: 'ok', version: null });
    });

    it('carries the sub-agent runs and passes of the turn, and the latency the server measured', () => {
        const message = assistantFromResult({
            content: 'ok',
            steps: [call('d1', 'delegate_to')],
            subagentRuns: [run('sa_1', { parentToolCallId: 'd1' })],
            compactions: [pass('p1', { afterToolCallId: 'd1' })],
            latencyMs: 1234,
            version: 3,
        }, 0);
        expect(message.subagentRuns).toHaveLength(1);
        expect(message.compactions).toHaveLength(1);
        expect(message).toMatchObject({ latencyMs: 1234, version: 3 });
        expect(shape(orderTurnFlow(message))).toEqual(['group:d1(sa_1)', 'pass:p1']);
    });
});
