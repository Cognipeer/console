/**
 * Durable runs: what a run's turn checkpoints and when (sparse, as deltas,
 * fenced by the run's generation), how a checkpoint reads back, and how tool
 * calls cut off by a lost node are settled.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Message } from '@cognipeer/agent-sdk';

import type { AgentRunCheckpointWrite, IAgentRunCheckpoint } from '@/lib/database';

const limits = vi.hoisted(() => ({ maxBytes: 5_000_000 }));
vi.mock('@/lib/services/agents/agentTurnState', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/services/agents/agentTurnState')>()),
    maxStateBytes: () => limits.maxBytes,
}));

import {
    CHECKPOINT_SCHEMA,
    INTERRUPTED_TOOL_RESULT,
    agentRunTurnKey,
    createRunCheckpointer,
    readRunCheckpoint,
    runLeaseHolds,
    settleInterruptedToolCalls,
    stampRunTurn,
    transcriptHasTurn,
    withCheckpointBeforeTool,
    type RunCheckpointerOptions,
} from '@/lib/services/agents/runCheckpoint';

/** An in-memory checkpoint store with the same append/reset/fencing rules as the providers. */
function memoryStore() {
    let doc: IAgentRunCheckpoint | null = null;
    const writes: AgentRunCheckpointWrite[] = [];
    let refuse = false;
    return {
        writes,
        get doc() {
            return doc;
        },
        refuseFromNowOn() {
            refuse = true;
        },
        async writeAgentRunCheckpoint(write: AgentRunCheckpointWrite): Promise<boolean> {
            writes.push(write);
            if (refuse) return false;
            if (write.mode === 'append') {
                if (!doc || doc.generation !== write.generation) return false;
                doc = {
                    ...doc,
                    head: write.head ?? doc.head,
                    messageChunks: [...doc.messageChunks, ...write.messageChunks],
                    toolHistoryChunks: [...doc.toolHistoryChunks, ...write.toolHistoryChunks],
                    messageCount: write.messageCount,
                    toolHistoryCount: write.toolHistoryCount,
                    sizeBytes: write.sizeBytes,
                };
                return true;
            }
            if (doc && doc.generation > write.generation) return false;
            doc = { _id: write.runId, ...write, head: write.head! };
            return true;
        },
    };
}

const user = (content: string) => ({ role: 'user', content });
const assistant = (content: string, toolCalls?: Array<{ id: string; name: string }>) => ({
    role: 'assistant',
    content,
    ...(toolCalls ? { tool_calls: toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: '{}' } })) } : {}),
});
const toolResult = (id: string, name: string, content = 'ok') => ({ role: 'tool', tool_call_id: id, name, content });

function setup(overrides: Partial<RunCheckpointerOptions> = {}) {
    const store = memoryStore();
    let clock = 1_000_000;
    const onFenced = vi.fn();
    const checkpointer = createRunCheckpointer({
        db: store,
        runId: 'run-1',
        tenantId: 't-1',
        conversationId: 'conv-1',
        generation: 2,
        deadlineAt: clock + 60_000,
        intervalMs: 10_000,
        turn: () => ({ kind: 'chat', userTurnIndex: 0, userMessage: { role: 'user', content: 'hi', timestamp: new Date(0) } as never }),
        isReadOnlyTool: (name) => name === 'search',
        onFenced,
        now: () => clock,
        ...overrides,
    });
    return { store, checkpointer, onFenced, tick: (ms: number) => { clock += ms; } };
}

beforeEach(() => {
    limits.maxBytes = 5_000_000;
});

describe('run checkpointer: when it writes', () => {
    it('a turn that only reads, or calls no tool, writes nothing', async () => {
        const { store, checkpointer } = setup();
        const messages = [user('hi'), assistant('', [{ id: 'c1', name: 'search' }])];
        checkpointer.onStateChange({ messages, toolHistory: [] });
        await checkpointer.beforeTool('search');
        checkpointer.afterTool('search');
        checkpointer.onStateChange({ messages: [...messages, toolResult('c1', 'search'), assistant('done')], toolHistory: [] });
        expect(store.writes).toHaveLength(0);
        expect(checkpointer.wrote).toBe(false);
    });

    it('a tool with side effects runs only after the step that asked for it is stored', async () => {
        const { store, checkpointer } = setup();
        const step = { messages: [user('hi'), assistant('', [{ id: 'c1', name: 'send_email' }])], toolHistory: [] };
        checkpointer.onStateChange(step);
        await checkpointer.beforeTool('send_email');
        expect(store.writes).toHaveLength(1);
        expect(store.doc).toMatchObject({ generation: 2, schema: CHECKPOINT_SCHEMA, messageCount: 2 });
        expect(checkpointer.wrote).toBe(true);

        // Once written, a second tool of the same step does not write again.
        await checkpointer.beforeTool('create_ticket');
        expect(store.writes).toHaveLength(1);
    });

    it('after such a tool the next step boundary is written; later boundaries wait for the interval', async () => {
        const { store, checkpointer, tick } = setup();
        const m1 = [user('hi'), assistant('', [{ id: 'c1', name: 'send_email' }])];
        checkpointer.onStateChange({ messages: m1, toolHistory: [] });
        await checkpointer.beforeTool('send_email');
        checkpointer.afterTool('send_email');
        const m2 = [...m1, toolResult('c1', 'send_email')];
        checkpointer.onStateChange({ messages: m2, toolHistory: [{ tool: 'send_email' }] });
        await checkpointer.flush();
        expect(store.writes).toHaveLength(2);

        const m3 = [...m2, assistant('thinking')];
        checkpointer.onStateChange({ messages: m3, toolHistory: [{ tool: 'send_email' }] });
        await checkpointer.flush().then(() => undefined);
        // flush() writes on demand; the interval path alone would not have.
        const writesAfterFlush = store.writes.length;
        const m4 = [...m3, assistant('more')];
        checkpointer.onStateChange({ messages: m4, toolHistory: [{ tool: 'send_email' }] });
        await Promise.resolve();
        expect(store.writes).toHaveLength(writesAfterFlush);
        tick(10_000);
        const m5 = [...m4, assistant('again')];
        checkpointer.onStateChange({ messages: m5, toolHistory: [{ tool: 'send_email' }] });
        await checkpointer.flush();
        expect(store.writes.length).toBe(writesAfterFlush + 1);
        expect(store.doc!.messageCount).toBe(m5.length);
    });

    it('onStateChange never pauses the turn', () => {
        const { checkpointer } = setup();
        expect(checkpointer.onStateChange({ messages: [user('hi')] })).toBe(false);
        expect(checkpointer.onStateChange(null)).toBe(false);
    });
});

describe('run checkpointer: how much it writes', () => {
    it('appends only the new messages and tool entries, and re-sends the head only when it changed', async () => {
        const { store, checkpointer } = setup();
        const m1 = [user('hi'), assistant('', [{ id: 'c1', name: 'send_email' }])];
        checkpointer.onStateChange({ messages: m1, toolHistory: [], plan: null });
        await checkpointer.beforeTool('send_email');
        checkpointer.afterTool('send_email');
        const m2 = [...m1, toolResult('c1', 'send_email'), assistant('', [{ id: 'c2', name: 'send_email' }])];
        checkpointer.onStateChange({ messages: m2, toolHistory: [{ tool: 'send_email' }], plan: null });
        await checkpointer.beforeTool('send_email');

        expect(store.writes[0]).toMatchObject({ mode: 'reset', messageCount: 2 });
        expect(store.writes[0].head).toBeTruthy();
        expect(store.writes[1]).toMatchObject({ mode: 'append', messageCount: 4, toolHistoryCount: 1 });
        expect(store.writes[1].head).toBeUndefined();
        expect(store.writes[1].messageChunks).toHaveLength(1);

        // A plan update changes the head: it is sent with the next append.
        checkpointer.afterTool('send_email');
        const m3 = [...m2, toolResult('c2', 'send_email')];
        checkpointer.onStateChange({ messages: m3, toolHistory: [{ tool: 'send_email' }, { tool: 'send_email' }], plan: { steps: ['a'] } });
        await checkpointer.flush();
        expect(store.writes[2]).toMatchObject({ mode: 'append', messageCount: 5, toolHistoryCount: 2 });
        expect(store.writes[2].head).toBeTruthy();

        const read = await readRunCheckpoint(store.doc);
        expect(read.kind).toBe('ok');
        if (read.kind !== 'ok') return;
        expect(read.checkpoint.carried.messages).toHaveLength(5);
        expect(read.checkpoint.carried.toolHistory).toHaveLength(2);
        expect(read.checkpoint.carried.plan).toEqual({ steps: ['a'] });
        expect(read.checkpoint.turn).toMatchObject({ kind: 'chat', userTurnIndex: 0 });
        expect(read.checkpoint.generation).toBe(2);
    });

    it('writes everything again when the turn rewrote its history (a summary)', async () => {
        const { store, checkpointer } = setup();
        const m1 = [user('a'), assistant('b'), user('c'), assistant('', [{ id: 'c1', name: 'send_email' }])];
        checkpointer.onStateChange({ messages: m1, toolHistory: [] });
        await checkpointer.beforeTool('send_email');
        checkpointer.afterTool('send_email');
        const summarized = [user('[summary of a, b]'), user('c'), assistant('', [{ id: 'c1', name: 'send_email' }]), toolResult('c1', 'send_email')];
        checkpointer.onStateChange({ messages: summarized, toolHistory: [], summaries: ['a+b'] });
        await checkpointer.flush();
        expect(store.writes[1].mode).toBe('reset');

        const read = await readRunCheckpoint(store.doc);
        if (read.kind !== 'ok') throw new Error(read.kind);
        expect((read.checkpoint.carried.messages ?? []).map((m) => m.content)).toEqual(['[summary of a, b]', 'c', '', 'ok']);
        expect(read.checkpoint.carried.summaries).toEqual(['a+b']);
    });

    it('seals the checkpoint once the turn grew past the size cap, and writes nothing more', async () => {
        limits.maxBytes = 200;
        const { store, checkpointer } = setup();
        const big = Array.from({ length: 50 }, (_, i) => `${i}-${Math.random().toString(36)}`).join(' ');
        checkpointer.onStateChange({ messages: [user(big), assistant('', [{ id: 'c1', name: 'send_email' }])], toolHistory: [] });
        await checkpointer.beforeTool('send_email');
        expect(checkpointer.sealed).toBe(true);
        expect(store.doc).toMatchObject({ sealed: 'too_large', messageChunks: [], toolHistoryChunks: [] });
        expect(await readRunCheckpoint(store.doc)).toEqual({ kind: 'unusable', reason: 'too_large' });

        // The turn itself goes on; nothing more is stored.
        await checkpointer.beforeTool('send_email');
        checkpointer.onStateChange({ messages: [user(big), assistant('x')], toolHistory: [] });
        expect(await checkpointer.flush()).toBe(false);
        expect(store.writes).toHaveLength(1);
    });

    it('the TTL outlives the run ceiling', async () => {
        const { store, checkpointer } = setup();
        checkpointer.onStateChange({ messages: [user('hi'), assistant('', [{ id: 'c1', name: 'x' }])], toolHistory: [] });
        await checkpointer.beforeTool('x');
        expect(store.writes[0].expiresAt.getTime()).toBe(1_000_000 + 60_000 + 3_600_000);
    });
});

describe('run checkpointer: fencing', () => {
    it('a refused write stops the turn from starting another tool with side effects', async () => {
        const { store, checkpointer, onFenced } = setup();
        store.refuseFromNowOn();
        checkpointer.onStateChange({ messages: [user('hi'), assistant('', [{ id: 'c1', name: 'send_email' }])], toolHistory: [] });
        await expect(checkpointer.beforeTool('send_email')).rejects.toThrow(/another server/);
        expect(onFenced).toHaveBeenCalledTimes(1);
        // Even a read-only tool is refused now: the execution lost its run.
        await expect(checkpointer.beforeTool('search')).rejects.toThrow(/another server/);
        expect(await checkpointer.flush()).toBe(false);
    });

    it('a write that fails (the database is unreachable) does not let a tool with side effects run', async () => {
        const store = memoryStore();
        let fail = true;
        const flaky = {
            async writeAgentRunCheckpoint(write: AgentRunCheckpointWrite) {
                if (fail) throw new Error('connection reset');
                return store.writeAgentRunCheckpoint(write);
            },
        };
        const { checkpointer } = setup({ db: flaky });
        checkpointer.onStateChange({ messages: [user('hi'), assistant('', [{ id: 'c1', name: 'send_email' }])], toolHistory: [] });
        await expect(checkpointer.beforeTool('send_email')).rejects.toThrow(/could not be saved/);
        // A tool that only reads needs no checkpoint and still runs.
        await expect(checkpointer.beforeTool('search')).resolves.toBeUndefined();
        // Once the database answers again, the same step is stored and the tool runs.
        fail = false;
        await expect(checkpointer.beforeTool('send_email')).resolves.toBeUndefined();
        expect(store.doc?.messageCount).toBe(2);
    });

    it('a tool with side effects is refused once this execution may have lost its hold on the run', async () => {
        let holds = true;
        const { store, checkpointer } = setup({ leaseHolds: () => holds });
        const step1 = [user('hi'), assistant('', [{ id: 'c1', name: 'send_email' }])];
        checkpointer.onStateChange({ messages: step1, toolHistory: [] });
        await expect(checkpointer.beforeTool('send_email')).resolves.toBeUndefined();
        holds = false;
        checkpointer.onStateChange({ messages: [...step1, toolResult('c1', 'send_email'), assistant('', [{ id: 'c2', name: 'send_email' }])], toolHistory: [] });
        await expect(checkpointer.beforeTool('send_email')).rejects.toThrow(/could not confirm/);
        // Reading is harmless: a tool that only reads still runs.
        await expect(checkpointer.beforeTool('search')).resolves.toBeUndefined();
        // The step is stored all the same: a node continuing the run sees the call.
        expect(store.doc?.messageCount).toBe(4);
    });

    it('a write the store applied but answered with an error is not read back twice', async () => {
        const store = memoryStore();
        let ambiguous = false;
        const lossy = {
            async writeAgentRunCheckpoint(write: AgentRunCheckpointWrite) {
                const ok = await store.writeAgentRunCheckpoint(write);
                if (ambiguous) {
                    ambiguous = false;
                    throw new Error('socket timeout after the write was applied');
                }
                return ok;
            },
        };
        const { checkpointer } = setup({ db: lossy });
        const step1 = [user('hi'), assistant('', [{ id: 'c1', name: 'send_email' }])];
        checkpointer.onStateChange({ messages: step1, toolHistory: [] });
        await checkpointer.beforeTool('send_email');
        const step2 = [...step1, toolResult('c1', 'send_email'), assistant('', [{ id: 'c2', name: 'send_email' }])];
        checkpointer.onStateChange({ messages: step2, toolHistory: [] });
        ambiguous = true;
        await checkpointer.beforeTool('send_email').catch(() => undefined);
        const step3 = [...step2, toolResult('c2', 'send_email'), assistant('', [{ id: 'c3', name: 'send_email' }])];
        checkpointer.onStateChange({ messages: step3, toolHistory: [] });
        await checkpointer.beforeTool('send_email');

        const read = await readRunCheckpoint(store.doc);
        expect(read.kind).toBe('ok');
        const messages = read.kind === 'ok' ? read.checkpoint.carried.messages ?? [] : [];
        expect(messages.map((m) => m.role)).toEqual(step3.map((m) => m.role));
    });

    it('after a handoff (stop) no tool starts and nothing is written', async () => {
        const { store, checkpointer } = setup();
        checkpointer.onStateChange({ messages: [user('hi'), assistant('', [{ id: 'c1', name: 'send_email' }])], toolHistory: [] });
        expect(await checkpointer.flush()).toBe(true);
        checkpointer.stop();
        await expect(checkpointer.beforeTool('send_email')).rejects.toThrow(/another server/);
        checkpointer.onStateChange({ messages: [user('hi'), assistant('later')], toolHistory: [] });
        expect(store.writes).toHaveLength(1);
    });

    it('a wrapped tool waits for the checkpoint and is not run when the run moved on', async () => {
        const { store, checkpointer } = setup();
        const run = vi.fn<(input: unknown) => Promise<string>>(async () => 'sent');
        const tool = { name: 'send_email', description: 'd', invoke: run, call: run, func: run, run };
        const wrapped = withCheckpointBeforeTool(tool, checkpointer);
        checkpointer.onStateChange({ messages: [user('hi'), assistant('', [{ id: 'c1', name: 'send_email' }])], toolHistory: [] });

        expect(await wrapped.call({})).toBe('sent');
        expect(store.writes).toHaveLength(1);
        expect(wrapped.invoke).toBe(wrapped.func);

        checkpointer.stop();
        await expect(wrapped.invoke({})).rejects.toThrow(/another server/);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('a wrapped tool that only reads, by the approval rule, writes no checkpoint', async () => {
        const { store, checkpointer } = setup({ isReadOnlyTool: undefined });
        const run = vi.fn<(input: unknown) => Promise<string>>(async () => 'ok');
        const tool = (name: string, hitlKind?: 'reads' | 'writes') => withCheckpointBeforeTool(
            { name, description: 'd', invoke: run, call: run, func: run, run, ...(hitlKind ? { hitlKind } : {}) },
            checkpointer,
        );
        checkpointer.onStateChange({ messages: [user('hi'), assistant('', [{ id: 'c1', name: 'x' }])], toolHistory: [] });

        // A bound tool marked read-only, and one of Console's own read-only tools.
        await tool('crm_get_contact', 'reads').invoke({});
        await tool('knowledge_search').invoke({});
        expect(store.writes).toHaveLength(0);

        // A bound tool without a read-only marking.
        await tool('crm_update_contact', 'writes').invoke({});
        expect(store.writes).toHaveLength(1);
    });
});

describe('the hold an execution has on its run', () => {
    it('lapses one heartbeat before the reconciler may give the run to another node', () => {
        // Defaults: a heartbeat every 15 s, stale after 45 s: tools stop 30 s after the last accepted one.
        expect(runLeaseHolds({ leaseRenewedAt: 1_000 }, 1_000 + 29_999)).toBe(true);
        expect(runLeaseHolds({ leaseRenewedAt: 1_000 }, 1_000 + 30_000)).toBe(false);
        expect(runLeaseHolds({}, 10_000_000)).toBe(true);
        expect(runLeaseHolds(undefined)).toBe(true);
    });
});

describe('reading a checkpoint back', () => {
    it('none, and a newer format, are told apart', async () => {
        expect(await readRunCheckpoint(null)).toEqual({ kind: 'none' });
        const doc = { runId: 'r', tenantId: 't', conversationId: 'c', generation: 1, schema: CHECKPOINT_SCHEMA + 1, head: '{}', messageChunks: [], toolHistoryChunks: [], messageCount: 0, toolHistoryCount: 0, sizeBytes: 0, expiresAt: new Date() };
        expect(await readRunCheckpoint(doc)).toEqual({ kind: 'unusable', reason: 'unknown_schema' });
        expect(await readRunCheckpoint({ ...doc, schema: CHECKPOINT_SCHEMA, head: 'br64:not-brotli' })).toEqual({ kind: 'unusable', reason: 'unreadable' });
    });

    it('drops the system prompt (it is rebuilt from the current config)', async () => {
        const { store, checkpointer } = setup();
        checkpointer.onStateChange({ messages: [{ role: 'system', content: 'old prompt' }, user('hi'), assistant('', [{ id: 'c1', name: 'x' }])], toolHistory: [] });
        await checkpointer.beforeTool('x');
        const read = await readRunCheckpoint(store.doc);
        if (read.kind !== 'ok') throw new Error(read.kind);
        expect((read.checkpoint.carried.messages ?? []).map((m) => m.role)).toEqual(['user', 'assistant']);
    });
});

describe('settling interrupted tool calls', () => {
    it('gives each unanswered call an unknown-outcome result after its step\'s own results', () => {
        const messages = [
            user('hi'),
            assistant('', [{ id: 'a', name: 'read_record' }, { id: 'b', name: 'send_email' }, { id: 'c', name: 'create_ticket' }]),
            toolResult('a', 'read_record'),
        ] as unknown as Message[];
        const { messages: settled, interrupted } = settleInterruptedToolCalls(messages);
        expect(interrupted).toEqual(['send_email', 'create_ticket']);
        expect(settled.map((m) => [(m as { role: string }).role, (m as { tool_call_id?: string }).tool_call_id ?? null])).toEqual([
            ['user', null],
            ['assistant', null],
            ['tool', 'a'],
            ['tool', 'b'],
            ['tool', 'c'],
        ]);
        expect((settled[3] as { content: string }).content).toBe(INTERRUPTED_TOOL_RESULT);
    });

    it('leaves a complete transcript as it is', () => {
        const messages = [user('hi'), assistant('', [{ id: 'a', name: 'x' }]), toolResult('a', 'x'), assistant('done')] as unknown as Message[];
        const { messages: settled, interrupted } = settleInterruptedToolCalls(messages);
        expect(interrupted).toEqual([]);
        expect(settled).toEqual(messages);
    });
});

describe('turn keys', () => {
    it('name the first turn and each continuation, independent of the order of action ids', () => {
        expect(agentRunTurnKey('r1', null)).toBe('r1:turn');
        expect(agentRunTurnKey('r1', [])).toBe('r1:turn');
        const k = agentRunTurnKey('r1', ['b', 'a']);
        expect(k).toBe(agentRunTurnKey('r1', ['a', 'b']));
        expect(k).not.toBe(agentRunTurnKey('r1', ['a']));
        expect(k).toMatch(/^r1:[0-9a-f]{16}$/);
    });

    it('find the answer a turn already wrote', () => {
        const answer: { role: string; content: string; metadata?: Record<string, unknown> } = { role: 'assistant', content: 'done' };
        stampRunTurn(answer, 'r1:turn');
        expect(transcriptHasTurn([{ role: 'user' }, answer as never], 'r1:turn')).toBe(true);
        expect(transcriptHasTurn([answer as never], 'r1:other')).toBe(false);
        expect(transcriptHasTurn([{ role: 'user', metadata: { runTurn: 'r1:turn' } }], 'r1:turn')).toBe(false);
        expect(transcriptHasTurn(undefined, 'r1:turn')).toBe(false);
    });
});

describe('a recovered turn reaches the model whole', () => {
    // One turn as a checkpoint carries it: a user message, then 12 tool steps, the last one cut
    // off (settled with the unknown-outcome result).
    const recoveredMessages = (): Message[] => {
        const messages: Message[] = [{ role: 'user', content: 'handle the case' } as Message];
        for (let step = 1; step <= 12; step += 1) {
            const name = step % 2 === 0 ? 'create_ticket' : 'get_order';
            messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `call_${step}`, type: 'function', function: { name, arguments: '{}' } }] } as unknown as Message);
            if (step < 12) messages.push({ role: 'tool', tool_call_id: `call_${step}`, name, content: `done ${step}` } as unknown as Message);
        }
        return settleInterruptedToolCalls(messages).messages as Message[];
    };

    /** The tool steps the model is shown on the recovered execution's first call. */
    async function stepsTheModelSees(recoveredTurnSteps: number | undefined): Promise<number> {
        const { createSmartAgent, createTool } = await import('@cognipeer/agent-sdk');
        const { z } = await import('zod');
        const { keepRecoveredTurn, resolveAgentRuntimeOptions } = await import('@/lib/services/agents/agentRuntimeConfig');
        const { buildContinueInputState } = await import('@/lib/services/agents/agentTurnState');
        const seen: number[] = [];
        const model = {
            modelName: 'test-model',
            bindTools() { return this; },
            async invoke(messages: Message[]) {
                seen.push(messages.filter((m) => m.role === 'assistant' && (m as { tool_calls?: unknown[] }).tool_calls?.length).length);
                return { role: 'assistant', content: 'done' };
            },
        };
        const options = resolveAgentRuntimeOptions({ modelKey: 'm' });
        const tools = ['get_order', 'create_ticket'].map((name) => createTool({ name, description: name, schema: z.object({}), func: async () => 'ok' }));
        const agent = createSmartAgent({
            name: 'recovered',
            model: model as never,
            tools: tools as never,
            ...(recoveredTurnSteps ? keepRecoveredTurn(options, recoveredTurnSteps) : options),
        });
        await agent.invoke(buildContinueInputState({ carried: { messages: recoveredMessages() } as never }) as never);
        return seen[0];
    }

    it('without keeping the turn, the context policy drops its first steps (the reason for keepRecoveredTurn)', async () => {
        expect(await stepsTheModelSees(undefined)).toBeLessThan(12);
    });

    it('keepRecoveredTurn shows the model every step of the recovered turn', async () => {
        const { stepsOfTurnInProgress } = await import('@/lib/services/agents/agentRuntimeConfig');
        const steps = stepsOfTurnInProgress(recoveredMessages());
        expect(steps).toBe(12);
        expect(await stepsTheModelSees(steps)).toBe(12);
    });

    it('a short turn keeps the configured window', async () => {
        const { keepRecoveredTurn, resolveAgentRuntimeOptions } = await import('@/lib/services/agents/agentRuntimeConfig');
        const options = resolveAgentRuntimeOptions({ modelKey: 'm' });
        expect(keepRecoveredTurn(options, 3)).toBe(options);
        expect(keepRecoveredTurn(options, 10).context?.lastTurnsToKeep).toBe(11);
    });

    it('counts only the steps after the last user message', async () => {
        const { stepsOfTurnInProgress } = await import('@/lib/services/agents/agentRuntimeConfig');
        expect(stepsOfTurnInProgress([
            { role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }, { role: 'tool' }, { role: 'assistant' },
        ])).toBe(2);
        expect(stepsOfTurnInProgress([])).toBe(0);
    });
});
