/**
 * The view of a sub-agent run (components/agents/session/subagentUi.ts), built
 * the same from a live run and a stored one: header facts, status, approvals,
 * the rows of its steps and own summarization passes, the legacy view of a
 * delegation stored before runs were recorded, and the parallel container.
 */
import { describe, expect, it } from 'vitest';
import {
    firstLineOf,
    legacyDelegationView,
    liveRunView,
    parallelGroupView,
    storedRunView,
    subagentInitial,
    subagentRunView,
    type SubagentRow,
} from '@/components/agents/session/subagentUi';
import type { LiveSubagentRun } from '@/components/agents/session/liveFlow';
import type {
    IAgentConversationStep,
    IAgentMessagePendingAction,
    IAgentSubagentStep,
    IAgentTurnCompaction,
    IAgentTurnSubagentRun,
} from '@/lib/database/provider/types.domain';

const T = (seconds: number) => `2026-10-23T10:00:${String(seconds).padStart(2, '0')}.000Z`;

function stored(extra: Partial<IAgentTurnSubagentRun> = {}): IAgentTurnSubagentRun {
    return { id: 'sa_1', name: 'researcher', phase: 'result', steps: [], ...extra };
}

function live(extra: Partial<LiveSubagentRun> = {}): LiveSubagentRun {
    return { id: 'sa_1', name: 'researcher', phase: 'start', steps: [], compactions: [], ...extra };
}

const stepA: IAgentSubagentStep = { id: 'a', name: 'web_search', status: 'success', args: { query: 'q' }, output: 'r', durationMs: 5, timestamp: T(0) };
const stepB: IAgentSubagentStep = { id: 'b', name: 'fetch', status: 'error', error: '404', timestamp: T(10), _truncated: true };
const pass = (id: string, extra: Partial<IAgentTurnCompaction> = {}): IAgentTurnCompaction => ({ at: T(5), id, ...extra });

const order = (rows: SubagentRow[]) => rows.map((row) => (row.kind === 'step' ? row.key : `pass:${row.key}`));

describe('subagentInitial and firstLineOf', () => {
    it('takes the first letter or digit, upper-cased', () => {
        expect(subagentInitial('researcher')).toBe('R');
        expect(subagentInitial('  éclair')).toBe('É');
        expect(subagentInitial('3d-modeler')).toBe('3');
        expect(subagentInitial('--')).toBe('?');
        expect(subagentInitial('')).toBe('?');
    });

    it('takes the first non-empty line, clipped', () => {
        expect(firstLineOf('\n  First line  \nsecond')).toBe('First line');
        expect(firstLineOf('   ')).toBeUndefined();
        expect(firstLineOf(undefined)).toBeUndefined();
        const clipped = firstLineOf('x'.repeat(300), 20) as string;
        expect(clipped).toHaveLength(20);
        expect(clipped.endsWith('…')).toBe(true);
        expect(firstLineOf('x'.repeat(300))).toHaveLength(160);
    });
});

describe('subagentRunView header', () => {
    it('names where the run came from and what it ran', () => {
        expect(subagentRunView(stored({ mode: 'registry', target: { kind: 'ref', agentName: 'support', version: 3 } })))
            .toMatchObject({ id: 'sa_1', name: 'researcher', initial: 'R', modeLabelKey: 'subagentModeRegistry', targetText: 'support v3' });
        expect(subagentRunView(stored({ mode: 'adhoc' }))).toMatchObject({ modeLabelKey: 'subagentModeAdhoc' });
        expect(subagentRunView(stored({ target: { kind: 'ref', agentName: 'support' } }))).toMatchObject({ modeLabelKey: 'subagentModeRegistry', targetText: 'support' });
        expect(subagentRunView(stored({ target: { kind: 'inline' } }))).toMatchObject({ modeLabelKey: 'subagentModeAdhoc' });
        expect('targetText' in subagentRunView(stored({ target: { kind: 'inline' } }))).toBe(false);
    });

    it('leaves out what the stream did not say', () => {
        const view = subagentRunView(stored());
        for (const key of ['modeLabelKey', 'targetText', 'durationMs', 'tokens', 'input', 'result', 'resultFull', 'error']) {
            expect(key in view, key).toBe(false);
        }
        expect(view).toMatchObject({ stepCount: 0, approvals: 0, rows: [], resumed: false, stepsNotRecorded: false, stepsDropped: 0 });
    });

    it('counts steps past the stored cap', () => {
        expect(subagentRunView(stored({ steps: [stepA, stepB], stepsDropped: 3 }))).toMatchObject({ stepCount: 5, stepsDropped: 3 });
    });

    it('reads tokens from the total, else the sum of input and output', () => {
        expect(subagentRunView(stored({ usage: { totalTokens: 120, inputTokens: 1, outputTokens: 1 } })).tokens).toBe(120);
        expect(subagentRunView(stored({ usage: { inputTokens: 80, outputTokens: 20 } })).tokens).toBe(100);
        expect(subagentRunView(stored({ usage: { outputTokens: 20 } })).tokens).toBe(20);
        expect('tokens' in subagentRunView(stored({ usage: {} }))).toBe(false);
    });

    it('reads the duration from the run, else from when it started and ended', () => {
        expect(subagentRunView(stored({ durationMs: 900, startedAt: T(0), endedAt: T(5) })).durationMs).toBe(900);
        expect(subagentRunView(stored({ startedAt: T(0), endedAt: T(5) })).durationMs).toBe(5000);
        expect('durationMs' in subagentRunView(stored({ startedAt: T(5), endedAt: T(0) }))).toBe(false);
        expect('durationMs' in subagentRunView(stored({ startedAt: T(0) }))).toBe(false);
    });

    it('shows the task, the first line of the answer for the collapsed header, and the whole answer', () => {
        const view = subagentRunView(stored({ input: 'Find the report', result: '\nSummary: all good\nDetails follow' }));
        expect(view).toMatchObject({ input: 'Find the report', result: 'Summary: all good', resultFull: '\nSummary: all good\nDetails follow' });
        expect('input' in subagentRunView(stored({ input: '   ' }))).toBe(false);
        expect('result' in subagentRunView(stored({ result: '  \n ' }))).toBe(false);
    });

    it('carries the error and the continued flag', () => {
        expect(subagentRunView(stored({ phase: 'error', error: 'boom', resumed: true }))).toMatchObject({ error: 'boom', resumed: true });
    });
});

describe('subagentRunView status', () => {
    const kind = (run: IAgentTurnSubagentRun | LiveSubagentRun, pending?: IAgentMessagePendingAction[], live?: boolean) =>
        subagentRunView(run, pending, live === undefined ? {} : { live }).statusKind;

    it('maps a finished run by the SDK\'s status', () => {
        expect(kind(stored({ phase: 'result', status: 'ok' }))).toBe('done');
        expect(kind(stored({ phase: 'result' }))).toBe('done');
        expect(kind(stored({ phase: 'result', status: 'incomplete' }))).toBe('incomplete');
        expect(kind(stored({ phase: 'result', status: 'blocked' }))).toBe('blocked');
        expect(kind(stored({ phase: 'result', status: 'cancelled' }))).toBe('cancelled');
    });

    it('maps failures however they are reported', () => {
        expect(kind(stored({ phase: 'error' }))).toBe('failed');
        expect(kind(stored({ phase: 'result', status: 'error' }))).toBe('failed');
        expect(kind(stored({ phase: 'result', error: 'boom' }))).toBe('failed');
    });

    it('maps a paused run: waiting while the turn runs, continued once it is stored with no request of its own open', () => {
        // Running now, the run waits for a person.
        expect(kind(live({ phase: 'paused' }))).toBe('paused');
        expect(kind(stored({ phase: 'paused' }), undefined, true)).toBe('paused');
        expect(kind(stored({ phase: 'result', status: 'needs_input' }), undefined, true)).toBe('paused');
        // Stored, nobody is asked any more: the run went on in the next message, so this one is where it stopped.
        expect(kind(stored({ phase: 'paused' }))).toBe('continued');
        expect(kind(stored({ phase: 'result', status: 'needs_input' }))).toBe('continued');
        expect(storedRunView(stored({ phase: 'paused' })).statusKind).toBe('continued');
        expect(liveRunView(live({ phase: 'paused' })).statusKind).toBe('paused');
    });

    it('lets an error win over a pause, and a run that ended keep its verdict', () => {
        expect(kind(stored({ phase: 'paused', error: 'boom', status: 'error' }))).toBe('failed');
        expect(kind(stored({ phase: 'result', status: 'ok' }))).toBe('done');
    });

    it('reads a run that never reported an end as running while live and incomplete once stored', () => {
        expect(kind(live())).toBe('running');
        expect(kind(stored({ phase: 'start' }))).toBe('incomplete');
        expect(kind(stored({ phase: 'start' }), undefined, true)).toBe('running');
        expect(kind(live(), undefined, false)).toBe('incomplete');
        expect(liveRunView(stored({ phase: 'start' }) as unknown as LiveSubagentRun).statusKind).toBe('running');
        expect(storedRunView(stored({ phase: 'start' })).statusKind).toBe('incomplete');
    });

    it('tells a stored run from a live one by its steps when it can', () => {
        expect(kind(stored({ phase: 'start', steps: [stepA] }))).toBe('incomplete');
        const liveStep = { key: 't1', name: 'fetch', running: true };
        expect(kind(live({ steps: [liveStep] }))).toBe('running');
        expect(kind(stored({ phase: 'start', startedAt: T(0) }))).toBe('incomplete');
    });
});

describe('subagentRunView approvals', () => {
    const action = (extra: Partial<IAgentMessagePendingAction>): IAgentMessagePendingAction => ({
        id: 'x',
        kind: 'tool_approval',
        status: 'pending',
        delegationToolCallId: 'd1',
        ...extra,
    });
    const run = stored({ phase: 'start', parentToolCallId: 'd1' });

    it('counts the open requests of the same delegation, and of this sub-agent when the request names one', () => {
        const view = subagentRunView(run, [
            action({ id: '1', subagent: 'researcher' }),
            action({ id: '2', kind: 'user_question' }),
            action({ id: '3', subagent: 'writer' }),
            action({ id: '4', delegationToolCallId: 'd2' }),
            action({ id: '5', status: 'resolved' }),
        ]);
        expect(view.approvals).toBe(2);
    });

    it('reads a run waiting on one as paused, live or stored', () => {
        const pending = [action({ subagent: 'researcher' })];
        expect(subagentRunView(run, pending).statusKind).toBe('paused');
        expect(subagentRunView(live({ parentToolCallId: 'd1' }), pending).statusKind).toBe('paused');
        // A live run that does not know its delegation call cannot be matched to a request.
        expect(subagentRunView(live(), pending).statusKind).toBe('running');
    });

    it('does not change the verdict of a run that already ended', () => {
        expect(subagentRunView(stored({ phase: 'result', parentToolCallId: 'd1' }), [action({})]).statusKind).toBe('done');
    });

    it('has none without a delegation call to match', () => {
        expect(subagentRunView(stored({ phase: 'start' }), [action({})]).approvals).toBe(0);
        expect(subagentRunView(run).approvals).toBe(0);
    });

    it('reads a stored run that paused as waiting only while a request of its own is open', () => {
        const paused = stored({ phase: 'paused', parentToolCallId: 'd1' });
        const open = subagentRunView(paused, [action({ subagent: 'researcher' })]);
        expect(open).toMatchObject({ statusKind: 'paused', approvals: 1 });
        // A question counts as much as an approval.
        expect(subagentRunView(paused, [action({ kind: 'user_question', subagent: 'researcher' })]).statusKind).toBe('paused');
        // Answered, expired or cancelled, another sub-agent's, another delegation's, or none at all: the run went on in
        // the next message, so this one does not say "waiting".
        const notWaiting: Array<IAgentMessagePendingAction[] | undefined> = [
            [action({ subagent: 'researcher', status: 'resolved' })],
            [action({ subagent: 'researcher', status: 'expired' })],
            [action({ subagent: 'researcher', status: 'cancelled' })],
            [action({ subagent: 'writer' })],
            [action({ subagent: 'researcher', delegationToolCallId: 'd2' })],
            [action({ subagent: 'researcher', delegationToolCallId: undefined })],
            [],
            undefined,
        ];
        for (const [index, pending] of notWaiting.entries()) {
            expect(subagentRunView(paused, pending), `case ${index}`).toMatchObject({ statusKind: 'continued', approvals: 0 });
        }
        // The stopped-at-a-pause reading is the same for a result that asked for input.
        expect(subagentRunView(stored({ phase: 'result', status: 'needs_input', parentToolCallId: 'd1' }), [action({ status: 'resolved' })]).statusKind).toBe('continued');
        expect(subagentRunView(stored({ phase: 'result', status: 'needs_input', parentToolCallId: 'd1' }), [action({})]).statusKind).toBe('paused');
    });

    it('keeps a live run that paused waiting, whatever the requests say', () => {
        const paused = live({ phase: 'paused', parentToolCallId: 'd1' });
        expect(subagentRunView(paused).statusKind).toBe('paused');
        expect(subagentRunView(paused, [action({ status: 'resolved' })]).statusKind).toBe('paused');
        expect(subagentRunView(paused, [action({ subagent: 'researcher' })])).toMatchObject({ statusKind: 'paused', approvals: 1 });
        expect(subagentRunView(stored({ phase: 'paused' }), undefined, { live: true }).statusKind).toBe('paused');
    });

    it('matches a parallel child\'s key <call>#<n> to its call, whichever side carries it', () => {
        const waiting = (runCall: string, actionCall: string, extra: Partial<IAgentMessagePendingAction> = {}) =>
            subagentRunView(stored({ phase: 'paused', parentToolCallId: runCall }), [action({ delegationToolCallId: actionCall, subagent: 'researcher', ...extra })]);
        // The run is keyed by its child, the request by the call.
        expect(waiting('p1#1', 'p1')).toMatchObject({ statusKind: 'paused', approvals: 1 });
        // The request is keyed by a child, the run by the call.
        expect(waiting('p1', 'p1#1')).toMatchObject({ statusKind: 'paused', approvals: 1 });
        // Both keyed by children of the one call, not necessarily the same child.
        expect(waiting('p1#1', 'p1#0')).toMatchObject({ statusKind: 'paused', approvals: 1 });
        expect(waiting('p1#0', 'p1#0')).toMatchObject({ statusKind: 'paused', approvals: 1 });
        // A call whose id only starts the same is another call, and so is another call's child.
        expect(waiting('p1#1', 'p10')).toMatchObject({ statusKind: 'continued', approvals: 0 });
        expect(waiting('p10#1', 'p1')).toMatchObject({ statusKind: 'continued', approvals: 0 });
        expect(waiting('p1#1', 'p10#1')).toMatchObject({ statusKind: 'continued', approvals: 0 });
        expect(waiting('p1#1', 'p2#1')).toMatchObject({ statusKind: 'continued', approvals: 0 });
        // Still a sub-agent name match when the request names one.
        expect(waiting('p1#1', 'p1', { subagent: 'writer' })).toMatchObject({ statusKind: 'continued', approvals: 0 });
    });
});

describe('subagentRunView rows', () => {
    it('turns stored steps into rows with their payloads', () => {
        const { rows } = subagentRunView(stored({ steps: [stepA, stepB] }));
        expect(rows).toEqual([
            { kind: 'step', key: 'a', name: 'web_search', status: 'success', detail: 'q', args: { query: 'q' }, output: 'r', durationMs: 5, timestamp: T(0), truncated: false },
            { kind: 'step', key: 'b', name: 'fetch', status: 'error', error: '404', timestamp: T(10), truncated: true },
        ]);
    });

    it('keys a stored step without an id by its place in the run', () => {
        const { rows } = subagentRunView(stored({ steps: [{ name: 'x', status: 'success' }, { name: 'y', status: 'success' }] }));
        expect(order(rows)).toEqual(['sa_1:step:0', 'sa_1:step:1']);
    });

    it('turns live steps into rows: running, done, failed', () => {
        const { rows } = subagentRunView(live({
            steps: [
                { key: 't1', name: 'a', running: true, detail: 'q' },
                { key: 't2', name: 'b', running: false, durationMs: 4 },
                { key: 't3', name: 'c', running: false, error: 'bad' },
            ],
        }));
        expect(rows).toMatchObject([
            { kind: 'step', key: 't1', status: 'running', detail: 'q', truncated: false },
            { kind: 'step', key: 't2', status: 'success', durationMs: 4 },
            { kind: 'step', key: 't3', status: 'error', error: 'bad' },
        ]);
    });

    describe('with the run\'s own summarization passes', () => {
        const steps = [stepA, stepB];

        it('places a pass by wall clock between the steps', () => {
            expect(order(subagentRunView(stored({ steps, compactions: [pass('p1', { at: T(5) })] })).rows)).toEqual(['a', 'pass:p1', 'b']);
            expect(order(subagentRunView(stored({ steps, compactions: [pass('p1', { at: T(30) })] })).rows)).toEqual(['a', 'b', 'pass:p1']);
            expect(order(subagentRunView(stored({ steps, compactions: [pass('p1', { at: T(0) })] })).rows)).toEqual(['a', 'pass:p1', 'b']);
        });

        it('puts a pass that predates every step first', () => {
            const early = pass('p1', { at: '2026-10-23T09:59:00.000Z' });
            expect(order(subagentRunView(stored({ steps, compactions: [early] })).rows)).toEqual(['pass:p1', 'a', 'b']);
        });

        it('puts a pass at the end when no step has a time', () => {
            const bare = [{ id: 'a', name: 'x', status: 'success' as const }];
            expect(order(subagentRunView(stored({ steps: bare, compactions: [pass('p1')] })).rows)).toEqual(['a', 'pass:p1']);
        });

        it('follows the anchor a pass carries over the clock: after that step, or first for null', () => {
            expect(order(subagentRunView(stored({ steps, compactions: [pass('p1', { at: T(30), afterToolCallId: 'a' })] })).rows)).toEqual(['a', 'pass:p1', 'b']);
            expect(order(subagentRunView(stored({ steps, compactions: [pass('p1', { at: T(30), afterToolCallId: null })] })).rows)).toEqual(['pass:p1', 'a', 'b']);
        });

        it('falls back to the clock when the anchor names no step of this run', () => {
            expect(order(subagentRunView(stored({ steps, compactions: [pass('p1', { at: T(5), afterToolCallId: 'elsewhere' })] })).rows)).toEqual(['a', 'pass:p1', 'b']);
        });

        it('keeps passes that share a place in their order', () => {
            const two = [pass('p1', { afterToolCallId: 'a' }), pass('p2', { afterToolCallId: 'a' }), pass('p3', { afterToolCallId: null }), pass('p4', { afterToolCallId: null })];
            expect(order(subagentRunView(stored({ steps, compactions: two })).rows)).toEqual(['pass:p3', 'pass:p4', 'a', 'pass:p1', 'pass:p2', 'b']);
        });

        it('keys a pass without an id by its number and flags a pending one', () => {
            const rows = subagentRunView(live({
                steps: [{ key: 't1', name: 'a', running: false }],
                compactions: [{ at: T(1), phase: 'start', afterToolCallId: 't1' }],
            })).rows;
            expect(rows[1]).toMatchObject({ kind: 'compaction', key: 'sa_1:pass-1', pending: true });
            expect(order(rows)).toEqual(['t1', 'pass:sa_1:pass-1']);
        });

        it('places a live pass by the call it follows', () => {
            const rows = subagentRunView(live({
                steps: [{ key: 't1', name: 'a', running: false }, { key: 't2', name: 'b', running: true }],
                compactions: [{ at: T(1), id: 'cp1', afterToolCallId: 't1' }],
            })).rows;
            expect(order(rows)).toEqual(['t1', 'pass:cp1', 't2']);
            expect(rows[1]).toMatchObject({ pending: false });
        });
    });
});

describe('legacyDelegationView', () => {
    const call = (extra: Partial<IAgentConversationStep> = {}): IAgentConversationStep => ({
        id: 'd1',
        name: 'delegate_to',
        args: { agent: 'researcher', task: 'Find the report' },
        output: 'Found it\nit is long',
        status: 'success',
        ...extra,
    });

    it('shows what the call alone says: the sub-agent, the task and the answer', () => {
        expect(legacyDelegationView(call())).toMatchObject({
            id: 'd1',
            name: 'researcher',
            initial: 'R',
            input: 'Find the report',
            result: 'Found it',
            resultFull: 'Found it\nit is long',
            statusKind: 'done',
            stepCount: 0,
            rows: [],
            approvals: 0,
            stepsNotRecorded: true,
        });
    });

    it('reads a failed call as failed, with its error', () => {
        expect(legacyDelegationView(call({ status: 'error', error: 'boom' }))).toMatchObject({ statusKind: 'failed', error: 'boom' });
    });

    it('does not call a call a person denied a failure', () => {
        expect(legacyDelegationView(call({ status: 'rejected', deniedByUser: true })).statusKind).toBe('done');
    });

    it('falls back to the step\'s sub-agent, then to the tool name, when the arguments name none', () => {
        expect(legacyDelegationView(call({ args: { task: 'x' }, subagent: 'writer' })).name).toBe('writer');
        expect(legacyDelegationView(call({ args: undefined })).name).toBe('delegate_to');
    });

    it('has no answer when the output is not text', () => {
        const view = legacyDelegationView(call({ output: { ok: true } }));
        expect('result' in view).toBe(false);
    });
});

describe('parallelGroupView', () => {
    const view = (extra: Partial<IAgentTurnSubagentRun>, pending?: IAgentMessagePendingAction[]) => subagentRunView(stored(extra), pending);

    it('summarizes the runs of one parallel call', () => {
        const group = parallelGroupView([
            view({ id: 'a', name: 'a', durationMs: 1000, usage: { totalTokens: 10 } }),
            view({ id: 'b', name: 'b', phase: 'start' }, undefined),
            view({ id: 'c', name: 'c', phase: 'error', durationMs: 3000, usage: { totalTokens: 5 } }),
        ]);
        // `b` never reported an end in a stored message: it reads incomplete, which is settled.
        expect(group).toEqual({ count: 3, done: 3, running: 0, failed: 1, approvals: 0, durationMs: 3000, tokens: 15, names: ['a', 'b', 'c'], statusKind: 'failed' });
    });

    it('counts a run still working as not done, and says the group is running', () => {
        const group = parallelGroupView([
            subagentRunView(stored({ id: 'a', name: 'a', durationMs: 1000 })),
            liveRunView(live({ id: 'b', name: 'b' })),
        ]);
        expect(group).toMatchObject({ count: 2, done: 1, running: 1, statusKind: 'running', durationMs: 1000 });
        expect('tokens' in group).toBe(false);
    });

    it('sums the approvals waiting across the runs and reads a group that only waits as paused', () => {
        const pending: IAgentMessagePendingAction[] = [
            { id: '1', kind: 'tool_approval', status: 'pending', delegationToolCallId: 'p1', subagent: 'a' },
            { id: '2', kind: 'user_question', status: 'pending', delegationToolCallId: 'p1', subagent: 'b' },
        ];
        const group = parallelGroupView([
            subagentRunView(stored({ id: 'a', name: 'a', phase: 'paused', parentToolCallId: 'p1' }), pending),
            subagentRunView(stored({ id: 'b', name: 'b', phase: 'paused', parentToolCallId: 'p1' }), pending),
            subagentRunView(stored({ id: 'c', name: 'c', parentToolCallId: 'p1' }), pending),
        ]);
        expect(group).toMatchObject({ count: 3, done: 1, approvals: 2, statusKind: 'paused' });
    });

    it('counts a run that went on in the next message as done: it is not waiting here, so the group does not say it is', () => {
        const group = parallelGroupView([
            view({ id: 'a', name: 'a', phase: 'paused', parentToolCallId: 'p1#0' }),
            view({ id: 'b', name: 'b', parentToolCallId: 'p1#1' }),
        ]);
        expect(group).toMatchObject({ count: 2, done: 2, running: 0, failed: 0, approvals: 0, statusKind: 'done' });
    });

    it('keeps the group waiting while one run still has a request of its own open, matched by the call of the child\'s key', () => {
        const pending: IAgentMessagePendingAction[] = [
            { id: '1', kind: 'tool_approval', status: 'pending', delegationToolCallId: 'p1', subagent: 'a' },
            { id: '2', kind: 'tool_approval', status: 'resolved', delegationToolCallId: 'p1', subagent: 'b' },
        ];
        const group = parallelGroupView([
            view({ id: 'a', name: 'a', phase: 'paused', parentToolCallId: 'p1#0' }, pending),
            view({ id: 'b', name: 'b', phase: 'paused', parentToolCallId: 'p1#1' }, pending),
        ]);
        expect(group).toMatchObject({ count: 2, done: 1, approvals: 1, statusKind: 'paused' });
    });

    it('is done when every run is, and empty for no runs', () => {
        expect(parallelGroupView([view({ id: 'a' }), view({ id: 'b' })])).toMatchObject({ count: 2, done: 2, failed: 0, statusKind: 'done' });
        const empty = parallelGroupView([]);
        expect(empty).toMatchObject({ count: 0, done: 0, names: [], statusKind: 'done' });
        expect('durationMs' in empty).toBe(false);
    });
});
