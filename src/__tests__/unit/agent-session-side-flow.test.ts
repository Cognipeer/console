/**
 * What the inspector lists from stored turns (sideFlowUi.ts), and the small
 * helpers the transcript uses to open and label the flow's parts: the status
 * style of a sub-agent, the change label of a pass, the plan each turn starts
 * from, and what "Show in group" opens.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countEventRows, sessionContextPasses, sessionEventRows } from '@/components/agents/session/sideFlowUi';
import {
    buildTurnFlow,
    callExpansionKey,
    compactionAnchorId,
    compactionChangeLabel,
    delegationAnchorId,
    previousPlansOf,
    runExpansionKey,
    showInGroupExpansion,
    stepOffsetsOf,
    type TurnFlowBlockView,
} from '@/components/agents/session/turnFlowUi';
import { storedRunView, subagentStartsOpen, subagentStatusStyle, type SubagentStatusKind } from '@/components/agents/session/subagentUi';
import { planDiffLabel, planStatusView } from '@/components/agents/session/planUi';
import type { ChatMessage } from '@/components/agents/session/sessionTypes';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import type {
    IAgentConversationStep,
    IAgentTurnCompaction,
    IAgentTurnPlanSnapshot,
    IAgentTurnSubagentRun,
} from '@/lib/database/provider/types.domain';

const T = (seconds: number) => `2026-10-23T10:00:${String(seconds).padStart(2, '0')}.000Z`;

const call = (id: string, name: string, extra: Partial<IAgentConversationStep> = {}): IAgentConversationStep => ({ id, name, status: 'success', ...extra });

const plan = (version: number, extra: Partial<IAgentTurnPlanSnapshot> = {}): IAgentTurnPlanSnapshot => ({
    version,
    operation: version === 1 ? 'write' : 'update',
    steps: [{ id: 1, title: 'One', status: 'in-progress' }],
    at: T(version),
    ...extra,
});

const run = (id: string, extra: Partial<IAgentTurnSubagentRun> = {}): IAgentTurnSubagentRun => ({ id, name: `agent-${id}`, phase: 'result', steps: [], ...extra });

const pass = (id: string, extra: Partial<IAgentTurnCompaction> = {}): IAgentTurnCompaction => ({ at: T(5), id, ...extra });

const user: ChatMessage = { role: 'user', content: 'hi' };
const kinds = (rows: Array<{ kind: string }>) => rows.map((row) => row.kind);
/** A session as a list of turns, typed as the messages the view holds. */
const session = (...turns: ChatMessage[]): ChatMessage[] => turns;

describe('sessionEventRows', () => {
    it('lists the calls of a turn that has nothing else as numbered steps, as before', () => {
        const rows = sessionEventRows(session(user, { role: 'assistant', content: 'a', steps: [call('a', 'web_search'), call('b', 'fetch')] }));
        expect(kinds(rows)).toEqual(['step', 'step']);
        expect(rows.map((row) => (row.kind === 'step' ? `${row.number}:${row.step.name}` : ''))).toEqual(['1:web_search', '2:fetch']);
        expect(rows.every((row) => row.turnIndex === 1)).toBe(true);
    });

    it('numbers the calls of each turn from 1 and skips turns that did nothing', () => {
        const rows = sessionEventRows(session(
            user,
            { role: 'assistant', content: 'a', steps: [call('a', 'x')] },
            user,
            { role: 'assistant', content: 'b' },
            user,
            { role: 'assistant', content: 'c', steps: [call('c', 'y'), call('d', 'z')] },
        ));
        expect(rows.map((row) => (row.kind === 'step' ? `${row.turnIndex}/${row.number}` : ''))).toEqual(['1/1', '5/1', '5/2']);
        expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    });

    it('ignores turns that are not the assistant\'s', () => {
        const rows = sessionEventRows(session(user, { role: 'error', content: 'boom', steps: [call('a', 'x')] }));
        expect(rows).toEqual([]);
    });

    it('puts plan versions where the manage_plan call was, named after the tool', () => {
        const rows = sessionEventRows(session(user, {
            role: 'assistant',
            content: 'a',
            steps: [call('p1', 'manage_plan', { timestamp: T(1) }), call('s1', 'web_search', { timestamp: T(2) }), call('p2', 'manage_todo_list', { timestamp: T(3) })],
            plans: [plan(1, { toolCallId: 'p1' }), plan(2, { toolCallId: 'p2' })],
        }));
        expect(kinds(rows)).toEqual(['plan', 'step', 'plan']);
        expect(rows[0]).toMatchObject({ toolName: 'manage_plan', version: 1, anchorId: 'flow-plan-v1' });
        expect(rows[2]).toMatchObject({ toolName: 'manage_todo_list', version: 2, anchorId: 'flow-plan-v2' });
        // the plan calls are not counted as calls
        expect(rows[1]).toMatchObject({ kind: 'step', number: 1 });
    });

    it('names a plan whose call is not in the message after the usual tool', () => {
        const rows = sessionEventRows(session(user, { role: 'assistant', content: 'a', plans: [plan(3, { toolCallId: 'elsewhere' })] }));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'plan', toolName: 'manage_plan', version: 3 });
    });

    it('indents a sub-agent\'s steps under its header, after the delegation call, and leaves its passes out', () => {
        const rows = sessionEventRows(session(user, {
            role: 'assistant',
            content: 'a',
            steps: [call('d1', 'delegate_to')],
            subagentRuns: [run('sa_1', {
                name: 'researcher',
                parentToolCallId: 'd1',
                steps: [{ id: 's1', name: 'kb_search', status: 'success' }, { id: 's2', name: 'kb_open', status: 'error', error: 'x' }],
                compactions: [pass('cp', { afterToolCallId: 's1' })],
            })],
        }));
        expect(kinds(rows)).toEqual(['step', 'subagent', 'child', 'child']);
        expect(rows[0]).toMatchObject({ kind: 'step', number: 1 });
        expect(rows[1]).toMatchObject({ kind: 'subagent', name: 'researcher', status: 'done', stepsNotRecorded: false, anchorId: delegationAnchorId('d1') });
        expect(rows[2]).toMatchObject({ kind: 'child', row: { name: 'kb_search', status: 'success' } });
        expect(rows[3]).toMatchObject({ kind: 'child', row: { name: 'kb_open', status: 'error' } });
        expect(countEventRows(rows)).toBe(3);
    });

    it('gives each run of a parallel spawn its own header', () => {
        const rows = sessionEventRows(session(user, {
            role: 'assistant',
            content: 'a',
            steps: [call('p1', 'spawn_subagents_parallel')],
            subagentRuns: [
                run('sa_a', { name: 'a', parentToolCallId: 'p1', parallel: true, steps: [{ name: 'x', status: 'success' }] }),
                run('sa_b', { name: 'b', parentToolCallId: 'p1', parallel: true, steps: [{ name: 'y', status: 'success' }] }),
            ],
        }));
        expect(kinds(rows)).toEqual(['step', 'subagent', 'child', 'subagent', 'child']);
    });

    it('says a delegation stored before runs were recorded has no recorded steps', () => {
        const rows = sessionEventRows(session(user, { role: 'assistant', content: 'a', steps: [call('d1', 'delegate_to', { subagent: 'researcher' })] }));
        expect(kinds(rows)).toEqual(['step', 'subagent']);
        expect(rows[1]).toMatchObject({ kind: 'subagent', stepsNotRecorded: true, name: 'researcher' });
        expect(countEventRows(rows)).toBe(1);
    });

    it('puts a summarization pass after the call it followed, numbered and anchored', () => {
        const rows = sessionEventRows(session(user, {
            role: 'assistant',
            content: 'a',
            steps: [call('c1', 'web_search'), call('c2', 'fetch')],
            compactions: [pass('p1', { index: 1, afterToolCallId: 'c1' }), pass('p2', { index: 2, afterToolCallId: 'c2', failed: true })],
        }));
        expect(kinds(rows)).toEqual(['step', 'compaction', 'step', 'compaction']);
        expect(rows[1]).toMatchObject({ kind: 'compaction', index: 1, failed: false, anchorId: compactionAnchorId(1, 'p1') });
        expect(rows[3]).toMatchObject({ kind: 'compaction', index: 2, failed: true, anchorId: compactionAnchorId(1, 'p2') });
    });

    it('does not count plan versions, headers or passes as events', () => {
        const rows = sessionEventRows(session(user, {
            role: 'assistant',
            content: 'a',
            steps: [call('p1', 'manage_plan'), call('c1', 'web_search')],
            plans: [plan(1, { toolCallId: 'p1' })],
            compactions: [pass('p1', { afterToolCallId: 'c1' })],
        }));
        expect(countEventRows(rows)).toBe(1);
    });

    describe('numbers the calls the way the transcript does', () => {
        const eventNumbers = (rows: ReturnType<typeof sessionEventRows>) =>
            rows.flatMap((row) => (row.kind === 'step' ? [`${row.number}:${row.step.name}`] : []));
        /** What the transcript puts on the cards: a block's offset, plus the call's place in it. */
        const transcriptNumbers = (blocks: TurnFlowBlockView[]) => {
            const offsets = stepOffsetsOf(blocks);
            return blocks.flatMap((block, i) => {
                if (block.kind === 'steps') return block.steps.map((step, j) => `${offsets[i] + j + 1}:${step.name}`);
                if (block.kind === 'subagents' && block.step) return [`${offsets[i] + 1}:${block.step.name}`];
                return [];
            });
        };

        it('counts a delegation as a step and leaves out a plan call that wrote a version and one that only read the plan', () => {
            const message: ChatMessage = {
                role: 'assistant',
                content: 'a',
                steps: [call('a', 'web_search'), call('p1', 'manage_plan'), call('d1', 'delegate_to'), call('p2', 'manage_plan'), call('b', 'fetch')],
                plans: [plan(1, { toolCallId: 'p1' })],
                subagentRuns: [run('sa_1', { name: 'researcher', parentToolCallId: 'd1' })],
            };
            const rows = sessionEventRows(session(user, message));
            expect(kinds(rows)).toEqual(['step', 'plan', 'step', 'subagent', 'step']);
            // The step after the delegation is the third call, in the tab and on the card.
            expect(eventNumbers(rows)).toEqual(['1:web_search', '2:delegate_to', '3:fetch']);
            expect(transcriptNumbers(buildTurnFlow(message))).toEqual(eventNumbers(rows));
            expect(stepOffsetsOf(buildTurnFlow(message))).toEqual([0, 1, 1, 2]);
        });

        it('counts a delegation stored without runs the same way', () => {
            const message: ChatMessage = {
                role: 'assistant',
                content: 'a',
                steps: [call('a', 'web_search'), call('d1', 'delegate_to', { subagent: 'researcher' }), call('b', 'fetch')],
            };
            const rows = sessionEventRows(session(user, message));
            expect(kinds(rows)).toEqual(['step', 'step', 'subagent', 'step']);
            expect(eventNumbers(rows)).toEqual(['1:web_search', '2:delegate_to', '3:fetch']);
            expect(transcriptNumbers(buildTurnFlow(message))).toEqual(eventNumbers(rows));
        });

        it('numbers every sub-agent group of a turn, a parallel spawn counting once', () => {
            const message: ChatMessage = {
                role: 'assistant',
                content: 'a',
                steps: [call('d1', 'delegate_to'), call('p1', 'spawn_subagents_parallel'), call('c', 'web_search')],
                subagentRuns: [
                    run('sa_1', { name: 'researcher', parentToolCallId: 'd1' }),
                    run('sa_a', { name: 'a', parentToolCallId: 'p1#0', parallel: true }),
                    run('sa_b', { name: 'b', parentToolCallId: 'p1#1', parallel: true }),
                ],
            };
            const rows = sessionEventRows(session(user, message));
            expect(eventNumbers(rows)).toEqual(['1:delegate_to', '2:spawn_subagents_parallel', '3:web_search']);
            expect(transcriptNumbers(buildTurnFlow(message))).toEqual(eventNumbers(rows));
        });

        it('numbers a plan call as a step when the turn does not record plan versions (an older message)', () => {
            const message: ChatMessage = { role: 'assistant', content: 'a', steps: [call('p1', 'manage_plan'), call('c1', 'web_search')] };
            const rows = sessionEventRows(session(user, message));
            expect(eventNumbers(rows)).toEqual(['1:manage_plan', '2:web_search']);
            expect(transcriptNumbers(buildTurnFlow(message))).toEqual(eventNumbers(rows));
        });

        it('starts every turn of a session at 1 again', () => {
            const turn: ChatMessage = { role: 'assistant', content: 'a', steps: [call('d1', 'delegate_to'), call('c1', 'fetch')], subagentRuns: [run('sa_1', { parentToolCallId: 'd1' })] };
            const rows = sessionEventRows(session(user, turn, user, turn));
            expect(rows.filter((row) => row.kind === 'step').map((row) => (row.kind === 'step' ? `${row.turnIndex}/${row.number}` : ''))).toEqual(['1/1', '1/2', '3/1', '3/2']);
            expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
        });
    });

    describe('hides the plan calls the transcript hides', () => {
        const stepIds = (rows: ReturnType<typeof sessionEventRows>) => rows.flatMap((row) => (row.kind === 'step' ? [row.step.id] : []));
        const transcriptIds = (message: ChatMessage) =>
            buildTurnFlow(message).flatMap((block) => (block.kind === 'steps' ? block.steps.map((step) => step.id) : []));
        const failed = call('p3', 'manage_plan', { status: 'error', error: 'bad plan' });

        it('keeps a call that failed, shows the one that wrote a version as that version, and drops the one that only read the plan', () => {
            const message: ChatMessage = {
                role: 'assistant',
                content: 'a',
                steps: [call('p1', 'manage_plan'), call('c1', 'web_search'), call('p2', 'manage_todo_list'), failed],
                plans: [plan(1, { toolCallId: 'p1' })],
            };
            const rows = sessionEventRows(session(user, message));
            expect(kinds(rows)).toEqual(['plan', 'step', 'step']);
            expect(stepIds(rows)).toEqual(['c1', 'p3']);
            expect(transcriptIds(message)).toEqual(stepIds(rows));
        });

        it('does the same when the turn recorded an empty plan list, which is what a turn whose plan calls wrote nothing sends', () => {
            const message: ChatMessage = {
                role: 'assistant',
                content: 'a',
                steps: [call('p2', 'manage_todo_list'), call('c1', 'web_search'), failed],
                plans: [],
            };
            const rows = sessionEventRows(session(user, message));
            expect(kinds(rows)).toEqual(['step', 'step']);
            expect(stepIds(rows)).toEqual(['c1', 'p3']);
            expect(transcriptIds(message)).toEqual(stepIds(rows));
        });

        it('lists every call, plan calls included, when the turn has no plans field (stored before plans were recorded)', () => {
            const message: ChatMessage = {
                role: 'assistant',
                content: 'a',
                steps: [call('p1', 'manage_plan'), call('c1', 'web_search'), call('p2', 'manage_todo_list'), failed],
            };
            const rows = sessionEventRows(session(user, message));
            expect(stepIds(rows)).toEqual(['p1', 'c1', 'p2', 'p3']);
            expect(transcriptIds(message)).toEqual(stepIds(rows));
        });
    });

    it('reads a sub-agent that paused as continued once nobody is asked, and as paused while a request of its own is open', () => {
        const turn = (status: 'pending' | 'resolved'): ChatMessage => ({
            role: 'assistant',
            content: 'a',
            steps: [call('d1', 'delegate_to')],
            subagentRuns: [run('sa_1', { name: 'researcher', parentToolCallId: 'd1', phase: 'paused' })],
            pendingActions: [{ id: 'x', kind: 'tool_approval', status, delegationToolCallId: 'd1', subagent: 'researcher' }],
        });
        const statusOf = (message: ChatMessage) => sessionEventRows(session(user, message)).flatMap((row) => (row.kind === 'subagent' ? [row.status] : []));
        expect(statusOf(turn('pending'))).toEqual(['paused']);
        expect(statusOf(turn('resolved'))).toEqual(['continued']);
    });
});

describe('sessionContextPasses', () => {
    it('says where in its turn each pass happened', () => {
        const entries = sessionContextPasses(session(user, {
            role: 'assistant',
            content: 'a',
            steps: [call('c1', 'web_search'), call('d1', 'delegate_to')],
            subagentRuns: [run('sa_1', { name: 'researcher', parentToolCallId: 'd1' })],
            compactions: [
                pass('start', { afterToolCallId: null }),
                pass('tool', { afterToolCallId: 'c1' }),
                pass('group', { afterToolCallId: 'd1' }),
                pass('old'),
            ],
        }));
        expect(entries.map((entry) => entry.placement)).toEqual([
            { kind: 'turn_start' },
            { kind: 'after_tool', toolName: 'web_search' },
            { kind: 'after_subagents', names: ['researcher'] },
            { kind: 'unplaced' },
        ]);
        expect(entries.map((entry) => entry.pass)).toEqual([1, 2, 3, 4]);
        expect(entries.every((entry) => entry.kind === 'agent' && entry.turnIndex === 1)).toBe(true);
        expect(entries[1].anchorId).toBe(compactionAnchorId(1, 'tool'));
    });

    it('numbers a pass by its own index when it has one', () => {
        const entries = sessionContextPasses(session(user, { role: 'assistant', content: 'a', compactions: [pass('x', { index: 3 })] }));
        expect(entries[0].pass).toBe(3);
    });

    it('lists a sub-agent\'s passes with its name, after the agent\'s own, and links them to the group', () => {
        const entries = sessionContextPasses(session(user, {
            role: 'assistant',
            content: 'a',
            steps: [call('d1', 'delegate_to')],
            subagentRuns: [run('sa_1', { name: 'researcher', parentToolCallId: 'd1', compactions: [pass('c1'), pass('c2')] })],
            compactions: [pass('mine', { afterToolCallId: 'd1' })],
        }));
        expect(entries.map((entry) => entry.kind)).toEqual(['agent', 'subagent', 'subagent']);
        expect(entries[1]).toMatchObject({ subagentName: 'researcher', pass: 1, anchorId: delegationAnchorId('d1') });
        expect(entries[2]).toMatchObject({ subagentName: 'researcher', pass: 2 });
        expect(new Set(entries.map((entry) => entry.key)).size).toBe(3);
    });

    it('names the sub-agents of a parallel call a pass followed and anchors theirs at its group, whichever key their runs carry', () => {
        const entries = sessionContextPasses(session(user, {
            role: 'assistant',
            content: 'a',
            steps: [call('p1', 'spawn_subagents_parallel')],
            subagentRuns: [
                run('sa_a', { name: 'a', parentToolCallId: 'p1#0', parallel: true, compactions: [pass('c1')] }),
                run('sa_b', { name: 'b', parentToolCallId: 'p1#1', parallel: true }),
            ],
            compactions: [pass('mine', { afterToolCallId: 'p1' })],
        }));
        expect(entries.map((entry) => entry.kind)).toEqual(['agent', 'subagent']);
        expect(entries[0].placement).toEqual({ kind: 'after_subagents', names: ['a', 'b'] });
        expect(entries[1]).toMatchObject({ subagentName: 'a', anchorId: 'flow-delegation-p1' });
        expect(entries[1].anchorId).toBe(delegationAnchorId('p1'));
    });

    it('goes through every turn in order', () => {
        const entries = sessionContextPasses(session(
            user, { role: 'assistant', content: 'a', compactions: [pass('a')] },
            user, { role: 'assistant', content: 'b', compactions: [pass('b')] },
        ));
        expect(entries.map((entry) => entry.turnIndex)).toEqual([1, 3]);
    });
});

describe('the helpers of the flow components', () => {
    it('words a pass that shrank, grew or kept the context', () => {
        expect(compactionChangeLabel(86)).toBe('−86%');
        expect(compactionChangeLabel(-4)).toBe('+4%');
        expect(compactionChangeLabel(0)).toBe('0%');
    });

    it('gives each sub-agent status a label key and a color, and opens the ones that need a look', () => {
        const all: SubagentStatusKind[] = ['running', 'done', 'failed', 'paused', 'blocked', 'incomplete', 'cancelled', 'continued'];
        expect(all.map((kind) => subagentStatusStyle(kind).labelKey)).toEqual([
            'subagentStatusRunning', 'subagentStatusDone', 'subagentStatusFailed', 'subagentStatusPaused',
            'subagentStatusBlocked', 'subagentStatusIncomplete', 'subagentStatusCancelled', 'subagentStatusContinued',
        ]);
        expect(subagentStatusStyle('paused').color).toBe('orange');
        expect(subagentStatusStyle('failed').color).toBe('red');
        // A run that went on in the next message is settled here: it starts closed, like a finished one.
        expect(subagentStatusStyle('continued').color).toBe('gray');
        expect(all.filter(subagentStartsOpen)).toEqual(['running', 'failed', 'paused']);
    });

    it('works out for each message the plan an earlier message left', () => {
        const v1 = plan(1);
        const v2 = plan(2);
        const v3 = plan(3);
        expect(previousPlansOf([{ plans: [v1] }, {}, { plans: [v2, v3] }, { plans: [] }, {}])).toEqual([undefined, v1, v1, v3, v3]);
        expect(previousPlansOf([])).toEqual([]);
    });

    it('keeps group open-states under keys that cannot collide', () => {
        expect(runExpansionKey('sa_1')).toBe('run:sa_1');
        expect(callExpansionKey('call_1')).toBe('call:call_1');
        expect(runExpansionKey('x')).not.toBe(callExpansionKey('x'));
    });

    describe('"Show in group"', () => {
        const message = {
            steps: [call('d1', 'delegate_to'), call('p1', 'spawn_subagents_parallel'), call('old', 'delegate_to')],
            subagentRuns: [
                run('sa_1', { name: 'researcher', parentToolCallId: 'd1' }),
                run('sa_a', { name: 'billing', parentToolCallId: 'p1', parallel: true }),
                run('sa_b', { name: 'payments', parentToolCallId: 'p1', parallel: true }),
            ],
        };
        const blocks = buildTurnFlow(message);

        it('opens the run of a single delegation', () => {
            expect(showInGroupExpansion(blocks, 'd1')).toEqual({ 'call:d1': true, 'run:sa_1': true });
        });

        it('opens the container and only the run the request names', () => {
            expect(showInGroupExpansion(blocks, 'p1', 'billing')).toEqual({ 'call:p1': true, 'run:sa_a': true });
        });

        it('opens every run when the request names none', () => {
            expect(showInGroupExpansion(blocks, 'p1')).toEqual({ 'call:p1': true, 'run:sa_a': true, 'run:sa_b': true });
        });

        it('opens the group of a delegation stored without runs', () => {
            expect(showInGroupExpansion(blocks, 'old')).toEqual({ 'call:old': true, 'run:old': true });
        });

        it('opens nothing for a call that is not in this message', () => {
            expect(showInGroupExpansion(blocks, 'nope')).toEqual({});
        });

        describe('for the children of a parallel spawn, keyed <call>#<n>', () => {
            const groupOf = (parentToolCallId: string, runs: IAgentTurnSubagentRun[]): TurnFlowBlockView => ({
                kind: 'subagents',
                key: `subagents-${parentToolCallId}`,
                anchorId: delegationAnchorId(parentToolCallId),
                parentToolCallId,
                parallel: runs.length > 1,
                runs: runs.map((stored) => storedRunView(stored)),
            });
            const children = [
                run('sa_a', { name: 'billing', parentToolCallId: 'p1#0', parallel: true }),
                run('sa_b', { name: 'payments', parentToolCallId: 'p1#1', parallel: true }),
            ];

            it('opens the group of the call for a request a child raised', () => {
                const parallel = [groupOf('p1', children)];
                expect(showInGroupExpansion(parallel, 'p1#1', 'billing')).toEqual({ 'call:p1': true, 'run:sa_a': true });
                expect(showInGroupExpansion(parallel, 'p1#0')).toEqual({ 'call:p1': true, 'run:sa_a': true, 'run:sa_b': true });
                expect(showInGroupExpansion(parallel, 'p1')).toEqual({ 'call:p1': true, 'run:sa_a': true, 'run:sa_b': true });
            });

            it('opens a group the transcript keyed by a child\'s own key, under that key, for a request naming the call', () => {
                const orphan = [groupOf('p1#0', [children[0]])];
                expect(showInGroupExpansion(orphan, 'p1')).toEqual({ 'call:p1#0': true, 'run:sa_a': true });
                expect(showInGroupExpansion(orphan, 'p1#1')).toEqual({ 'call:p1#0': true, 'run:sa_a': true });
            });

            it('does not open the group of another call whose id only starts the same', () => {
                const parallel = [groupOf('p1', children)];
                expect(showInGroupExpansion(parallel, 'p10#1')).toEqual({});
                expect(showInGroupExpansion(parallel, 'p10')).toEqual({});
                expect(showInGroupExpansion(parallel, 'p')).toEqual({});
                expect(showInGroupExpansion([groupOf('p10', children)], 'p1#1')).toEqual({});
            });
        });
    });

    it('anchors every key of a parallel call at the call\'s group', () => {
        expect(delegationAnchorId('p1')).toBe('flow-delegation-p1');
        expect(delegationAnchorId('p1#0')).toBe('flow-delegation-p1');
        expect(delegationAnchorId('p1#12')).toBe(delegationAnchorId('p1'));
        // A call whose id only starts the same, or has a '#' that is not a child's index, is its own.
        expect(delegationAnchorId('p10#1')).toBe('flow-delegation-p10');
        expect(delegationAnchorId('p1#x')).toBe('flow-delegation-p1_x');
        // Characters a DOM id cannot hold are replaced.
        expect(delegationAnchorId('call:x/1#2')).toBe('flow-delegation-call_x_1');
    });
});

describe('agents.sessionFlow strings', () => {
    const english = (en.agents as unknown as { sessionFlow: Record<string, string> }).sessionFlow;
    const turkish = (tr.agents as unknown as { sessionFlow: Record<string, string> }).sessionFlow;
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

    it('exist in both languages with the same placeholders, and none is empty', () => {
        expect(Object.keys(turkish).sort()).toEqual(Object.keys(english).sort());
        for (const key of Object.keys(english)) {
            expect(english[key].trim(), key).not.toBe('');
            expect(turkish[key].trim(), key).not.toBe('');
            expect(placeholders(turkish[key]), key).toEqual(placeholders(english[key]));
        }
    });

    it('are the words the keys the model files return stand for', () => {
        const keys = [
            ...(['not-started', 'in-progress', 'completed', 'blocked', 'whatever'] as const).map((status) => planStatusView(status).labelKey),
            ...(['running', 'done', 'failed', 'paused', 'blocked', 'incomplete', 'cancelled', 'continued'] as const).map((kind) => subagentStatusStyle(kind).labelKey),
            ...planDiffLabel({
                completed: [{ id: 1, title: 'a', status: 'completed' }],
                started: [{ id: 2, title: 'b', status: 'in-progress' }],
                blocked: [{ id: 3, title: 'c', status: 'blocked' }],
                added: [{ id: 4, title: 'd', status: 'not-started' }],
                removed: [{ id: 5, title: 'e', status: 'not-started' }],
            }).map((part) => part.labelKey),
            'subagentModeRegistry',
            'subagentModeAdhoc',
        ];
        for (const key of keys) expect(english[key], key).toBeTruthy();
        expect(new Set(keys).size).toBeGreaterThan(14);
    });

    it('cover every literal key the flow components ask for', () => {
        const files = [
            'PlanCard', 'SessionPlanPanel', 'SubagentGroup', 'CompactionDivider', 'PendingActionCards', 'SessionSidePanel',
        ].map((name) => `components/agents/session/${name}.tsx`);
        let checked = 0;
        const missing: string[] = [];
        for (const file of files) {
            const source = readFileSync(join(__dirname, '../..', file), 'utf8');
            const names = [...source.matchAll(/const\s+(\w+)\s*=\s*useTranslations\('agents\.sessionFlow'\)/g)].map((match) => match[1]);
            for (const name of names) {
                for (const call of source.matchAll(new RegExp(`(?<![\\w.])${name}\\(\\s*'([^']+)'`, 'g'))) {
                    checked += 1;
                    if (typeof english[call[1]] !== 'string' || typeof turkish[call[1]] !== 'string') missing.push(`${file}: ${call[1]}`);
                }
            }
        }
        expect(checked).toBeGreaterThan(30);
        expect(missing).toEqual([]);
    });
});
