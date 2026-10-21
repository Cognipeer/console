/**
 * How an agent's state is stored between turns, and what happens to a pause
 * the store cannot keep.
 *
 * Background: a 12-minute sandbox run paused for a second approval with a
 * 1.43 MB state — 1.0 MB of it tool outputs held twice (`output` and an
 * identical `rawOutput`). The normal snapshot alone was under the 1.5 MB cap,
 * so the paused copy (same document) had 67 KB left, the pause was dropped and
 * the session ended as `end_turn` with the reason in a warning line.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { reloadConfig } from '@/lib/core/config';
import {
    MAX_STATE_BYTES,
    decodeStoredState,
    encodeStoredState,
    loadConversationState,
    maxStateBytes,
    saveConversationState,
    serializeCarriedState,
    serializeForStorage,
} from '@/lib/services/agents/agentTurnState';
import {
    PAUSE_UNAVAILABLE_WARNING,
    parsePausedState,
    pauseUnavailableOutcome,
    serializePausedState,
} from '@/lib/services/agents/agentPendingActions';
import type { IAgentConversationState } from '@/lib/database';

/** Text Brotli cannot shrink: base64 of random bytes. */
const incompressible = (chars: number) => randomBytes(Math.ceil((chars * 3) / 4) + 3).toString('base64').slice(0, chars);

/** Log-like text that compresses the way real tool output does. */
function toolOutput(seed: number, chars: number): string {
    const lines = ['GET /api/agents 200 12ms', 'pool exhausted on db-7', 'retrying in 250ms', 'OK', 'WARN cache miss key=user:42'];
    let text = '';
    let i = seed;
    while (text.length < chars) {
        text += `${lines[i % lines.length]} #${(i * 7919) % 10_007}\n`;
        i += 1;
    }
    return text.slice(0, chars);
}

/** The shape of the incident's state: 37 tool calls, each result held in `output` AND `rawOutput`. */
function longRunState(): Record<string, unknown> {
    const toolHistory = Array.from({ length: 37 }, (_, i) => {
        const output = toolOutput(i, 27_000);
        return { executionId: `e${i}`, toolName: 'sandbox_exec', args: { cmd: `step ${i}` }, output, rawOutput: output, status: 'success' };
    });
    const messages = [{ role: 'user', content: 'Build the playbook.' }];
    for (let i = 0; i < 37; i += 1) {
        messages.push(
            { role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'sandbox_exec', arguments: '{}' } }] } as never,
            { role: 'tool', tool_call_id: `c${i}`, name: 'sandbox_exec', content: toolHistory[i].output.slice(0, 6_000) } as never,
        );
    }
    return { messages, toolHistory, summaries: [toolOutput(99, 40_000)] };
}

function memoryStore() {
    const rows = new Map<string, IAgentConversationState>();
    return {
        rows,
        async findAgentConversationState(id: string) { return rows.get(id) ?? null; },
        async saveAgentConversationState(state: Omit<IAgentConversationState, '_id' | 'createdAt' | 'updatedAt'>) {
            rows.set(state.conversationId, { ...state });
        },
        async deleteAgentConversationState(id: string) { return rows.delete(id); },
    };
}

describe('stored state encoding', () => {
    it('round-trips through the compressed form, and still reads a plain-JSON row written before', () => {
        const json = JSON.stringify({ messages: [{ role: 'user', content: 'héllo — 你好' }] });
        const stored = encodeStoredState(json);
        expect(stored.startsWith('br64:')).toBe(true);
        expect(decodeStoredState(stored)).toBe(json);
        expect(decodeStoredState(json)).toBe(json);
    });

    it('stores the incident\'s 1.4 MB state in a fraction of the cap, losslessly', () => {
        const state = longRunState();
        const raw = JSON.stringify(state).length;
        expect(raw).toBeGreaterThan(1_300_000);

        const stored = serializeForStorage(state as never)!;
        expect(stored).not.toBeNull();
        expect(stored.length).toBeLessThan(MAX_STATE_BYTES / 4);

        const back = JSON.parse(decodeStoredState(stored)) as { toolHistory: Array<Record<string, unknown>>; messages: unknown[] };
        // A rawOutput that only repeats output is dropped (the SDK reads `rawOutput ?? output`)…
        expect(back.toolHistory[0].rawOutput).toBeUndefined();
        expect(back.toolHistory[0].output).toBe((state.toolHistory as Array<{ output: string }>)[0].output);
        expect(back.messages).toHaveLength((state.messages as unknown[]).length);
        expect(stored).not.toContain('[truncated for storage]');
    });

    it('keeps a rawOutput that differs from what the model saw', () => {
        const stored = serializeForStorage({
            messages: [{ role: 'user', content: 'q' }],
            toolHistory: [{ executionId: 'e1', toolName: 't', output: 'reduced', rawOutput: { full: 'payload' } }],
        } as never)!;
        const back = JSON.parse(decodeStoredState(stored)) as { toolHistory: Array<Record<string, unknown>> };
        expect(back.toolHistory[0].rawOutput).toEqual({ full: 'payload' });
    });

    it('trims only when the STORED form is over the cap, cheapest loss first, and gives up rather than exceed it', () => {
        const fits = serializeForStorage({
            messages: [{ role: 'user', content: 'q' }],
            toolHistory: [{ executionId: 'e1', toolName: 't', output: 'small', rawOutput: incompressible(2_200_000) }],
        } as never);
        expect(fits).not.toBeNull();
        expect(fits!.length).toBeLessThanOrEqual(MAX_STATE_BYTES);
        const back = decodeStoredState(fits!);
        expect(back).toContain('small');
        expect(back).not.toContain('rawOutput');

        const hopeless = serializeForStorage({
            messages: Array.from({ length: 400 }, () => ({ role: 'user', content: incompressible(10_000) })),
        } as never);
        expect(hopeless).toBeNull();
    });

    it('a saved state loads back through the store', async () => {
        const store = memoryStore();
        await saveConversationState(store, {
            conversationId: 'conv-1', tenantId: 't', projectId: 'p', agentKey: 'a',
            state: longRunState() as never,
            messageCount: 2,
        });
        const row = store.rows.get('conv-1')!;
        expect(row.snapshot.startsWith('br64:')).toBe(true);
        expect(row.sizeBytes).toBe(row.snapshot.length);
        const carried = await loadConversationState(store, { _id: 'conv-1', messages: new Array(2) as never });
        expect(carried?.toolHistory).toHaveLength(37);
        expect(carried?.messages?.length).toBeGreaterThan(70);
    });
});

describe('the cap is a deployment setting', () => {
    afterEach(() => {
        delete process.env.AGENT_STATE_MAX_BYTES;
        reloadConfig();
    });

    it('AGENT_STATE_MAX_BYTES raises it where the database allows (MongoDB, Cosmos vCore), within what any supported database stores', () => {
        expect(maxStateBytes()).toBe(MAX_STATE_BYTES);
        const large = {
            messages: [{ role: 'user', content: 'q' }],
            toolHistory: [{ executionId: 'e1', toolName: 't', output: 'small', rawOutput: incompressible(2_200_000) }],
        };
        expect(decodeStoredState(serializeForStorage(large as never)!)).not.toContain('rawOutput');

        process.env.AGENT_STATE_MAX_BYTES = '4000000';
        reloadConfig();
        expect(maxStateBytes()).toBe(4_000_000);
        // What the default had to trim is now stored whole.
        expect(decodeStoredState(serializeForStorage(large as never)!)).toContain('rawOutput');
        expect(serializePausedState(large as never, 'agent')).not.toBeNull();

        process.env.AGENT_STATE_MAX_BYTES = '99999999';
        reloadConfig();
        expect(maxStateBytes()).toBe(15_000_000);
        process.env.AGENT_STATE_MAX_BYTES = '1';
        reloadConfig();
        expect(maxStateBytes()).toBe(100_000);
    });
});

describe('a pause of a long run', () => {
    it('now fits beside the normal snapshot in the same document', () => {
        const state = {
            ...longRunState(),
            pendingApprovals: [{ id: 'a1', status: 'pending', toolName: 'sandbox_run_code', toolCallId: 'c37', args: { code: 'ls' } }],
            ctx: { __awaitingApproval: { id: 'a1' } },
        };
        const normal = serializeCarriedState(state as never)!;
        expect(normal).not.toBeNull();
        const paused = serializePausedState(state as never, 'agent', MAX_STATE_BYTES - normal.length);
        expect(paused).not.toBeNull();
        expect(normal.length + paused!.length).toBeLessThanOrEqual(MAX_STATE_BYTES);
        const parsed = parsePausedState(paused!);
        expect(parsed?.source).toBe('agent');
        expect((parsed?.state as { pendingApprovals?: unknown[] }).pendingApprovals).toHaveLength(1);
        expect((parsed?.state as { messages?: unknown[] }).messages?.length).toBeGreaterThan(70);
    });

    it('that still cannot be stored ends the turn as an error that says why — not as a quiet end of turn', () => {
        expect(serializePausedState({ messages: [{ role: 'user', content: incompressible(50_000) }] } as never, 'agent', 1_000)).toBeNull();
        expect(pauseUnavailableOutcome({ stopReason: 'paused', stopDetail: 'waiting for a tool approval', content: '', partial: true }))
            .toEqual({ stopReason: 'error', stopDetail: PAUSE_UNAVAILABLE_WARNING, content: '', partial: true });
    });
});
