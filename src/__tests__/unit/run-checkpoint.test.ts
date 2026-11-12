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
