/**
 * Carrying an agent's state between turns, and reporting how a turn ended.
 *
 * The integration half drives the REAL agent-sdk with a scripted model, turn
 * after turn, through the same helpers the console runtime uses
 * (save → load → buildTurnInputState), and asserts on what the model was
 * actually sent — the only place "the agent forgot" is observable.
 *
 * Findings covered:
 *  1. `summary_only` lost the instruction given in the first message;
 *  2. the ask-user tool was offered although no channel can answer it;
 *  3. tool results did not reach the next turn;
 *  4. a limit-stopped run returned an empty message and no reason;
 *  5. `maxCostUsd` never fired (no cost estimator);
 *  9. summarization was invisible.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ASK_USER_TOOL_NAME, createSmartAgent, createTool, type Message, type SmartAgentEvent } from '@cognipeer/agent-sdk';

import {
    MAX_STATE_BYTES,
    buildCostEstimator,
    buildTurnInputState,
    compactedToolResults,
    compactionFromEvent,
    describeTurnOutcome,
    loadConversationState,
    repairToolAdjacency,
    saveConversationState,
    serializeForStorage,
    toPlainMessage,
} from '@/lib/services/agents/agentTurnState';
import { resolveAgentRuntimeOptions } from '@/lib/services/agents/agentRuntimeConfig';
import { incompleteReason } from '@/lib/services/agents/agentService';
import type { IAgentConversationState } from '@/lib/database';

// ── Test doubles ────────────────────────────────────────────────────────────

type Reply = Record<string, unknown>;

/** A model that answers from a script and records every request it was sent. */
class ScriptedModel {
    readonly modelName = 'scripted-model';
    readonly calls: Message[][] = [];
    readonly summarizerCalls: Message[][] = [];
    boundTools: string[] = [];

    constructor(
        private readonly script: (messages: Message[], call: number) => Reply,
        private readonly summarizer?: (messages: Message[]) => Reply,
    ) {}

    bindTools(tools: Array<{ name?: string }>) {
        this.boundTools = tools.map((tool) => String(tool.name));
        return this;
    }

    async invoke(messages: Message[]): Promise<Reply> {
        const isSummarizer = messages.some((m) => m.role === 'system'
            && typeof m.content === 'string' && m.content.includes('summarizes conversation history'));
        if (isSummarizer) {
            this.summarizerCalls.push(messages);
            return this.summarizer?.(messages) ?? { role: 'assistant', content: '{}' };
        }
        this.calls.push(messages);
        return this.script(messages, this.calls.length - 1);
    }
}

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
});

const textOf = (messages: Message[]) => messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');

/** An in-memory `IAgentConversationState` store with the DB contract's shape. */
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

const searchLogs = createTool({
    name: 'search_logs',
    description: 'Search the application logs.',
    schema: z.object({ q: z.string() }),
    func: async ({ q }: { q: string }) => `LOG_RESULT for "${q}": connection pool exhausted on db-7`,
});

/**
 * Runs one turn the way `executePlaygroundChatLocal` does for a Session:
 * load the carried state, append the message, invoke, append the transcript,
 * save the state.
 */
async function runTurn(input: {
    agent: ReturnType<typeof createSmartAgent>;
    store: ReturnType<typeof memoryStore>;
    transcript: Array<{ role: string; content: string }>;
    userMessage: string;
    events?: SmartAgentEvent[];
}) {
    const conversation = { _id: 'conv-1', messages: input.transcript as never[] };
    const carried = await loadConversationState(input.store, conversation);
    const state = buildTurnInputState({ carried, transcript: input.transcript, userMessage: input.userMessage });
    const result = await input.agent.invoke(state, {
        onEvent: (event: SmartAgentEvent) => input.events?.push(event),
    });
    const outcome = describeTurnOutcome(result, state.messages.length);
    input.transcript.push({ role: 'user', content: input.userMessage }, { role: 'assistant', content: outcome.content });
    await saveConversationState(input.store, {
        conversationId: 'conv-1',
        tenantId: 't',
        projectId: 'p',
        agentKey: 'a',
        state: result.state,
        messageCount: input.transcript.length,
    });
    return { result, outcome, inputState: state };
}

// ── Integration: the real SDK, turn after turn ──────────────────────────────

describe('carried state across turns (real agent-sdk)', () => {
    it('#3 the second turn sees the tool result the first turn fetched', async () => {
        const model = new ScriptedModel((messages, call) => {
            if (call === 0) {
                return { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'search_logs', { q: '502' })] };
            }
            if (call === 1) return { role: 'assistant', content: 'The pool on db-7 is exhausted.' };
            // Turn 2 answers from what it can see.
            return { role: 'assistant', content: textOf(messages).includes('LOG_RESULT') ? 'From the earlier log: db-7.' : 'No data.' };
        });
        const agent = createSmartAgent({ name: 'triage', model: model as never, tools: [searchLogs] });
        const store = memoryStore();
        const transcript: Array<{ role: string; content: string }> = [];

        await runTurn({ agent, store, transcript, userMessage: 'Why the 502s?' });
        const second = await runTurn({ agent, store, transcript, userMessage: 'Which host was it?' });

        const turnTwoRequest = model.calls[2];
        expect(textOf(turnTwoRequest)).toContain('LOG_RESULT');
        // ...as a real tool exchange, not flattened text.
        expect(turnTwoRequest.some((m) => m.role === 'tool')).toBe(true);
        expect(second.outcome.content).toBe('From the earlier log: db-7.');
        // The tool ran once, in turn 1 — turn 2 did not need to re-query.
        expect(model.calls).toHaveLength(3);
    });

    it('#3 without a stored state the transcript alone does NOT carry the tool result (the old behaviour)', async () => {
        const model = new ScriptedModel((_messages, call) => (call === 0
            ? { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'search_logs', { q: '502' })] }
            : { role: 'assistant', content: 'ok' }));
        const agent = createSmartAgent({ name: 'triage', model: model as never, tools: [searchLogs] });
        const store = memoryStore();
        const transcript: Array<{ role: string; content: string }> = [];
        await runTurn({ agent, store, transcript, userMessage: 'Why the 502s?' });
        store.rows.clear();
        await runTurn({ agent, store, transcript, userMessage: 'Which host?' });
        expect(textOf(model.calls[2])).not.toContain('LOG_RESULT');
    });

    it('#1/#9 summary_only keeps the first-message instruction across a summarization, and the summary is reported', async () => {
        const bigLog = createTool({
            name: 'fetch_logs',
            description: 'Fetch raw logs.',
            schema: z.object({ page: z.number() }),
            func: async ({ page }: { page: number }) => `PAGE ${page}: ${'timeout on db-7; '.repeat(250)}`,
        });
        let turnTwoCalls = 0;
        const model = new ScriptedModel(
            (messages) => {
                const lastUser = [...messages].reverse().find((m) => m.role === 'user');
                const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : '';
                const toolsSeen = messages.filter((m) => m.role === 'tool' && m.name === 'fetch_logs').length;
                if (lastUserText.startsWith('Pull')) {
                    turnTwoCalls += 1;
                    if (turnTwoCalls <= 2) {
                        return {
                            role: 'assistant',
                            content: '',
                            tool_calls: [toolCall(`p${turnTwoCalls}`, 'fetch_logs', { page: turnTwoCalls })],
                        };
                    }
                    return { role: 'assistant', content: `Sayfalar okundu (${toolsSeen}).` };
                }
                return { role: 'assistant', content: 'Tamam.' };
            },
            () => ({
                role: 'assistant',
                content: JSON.stringify({
                    user_directives: ['Always answer in Turkish.'],
                    stable_facts: [{ key: 'db_host', value: 'db-7', confidence: 0.9 }],
                    active_goals: ['find the root cause of the timeouts'],
                    open_questions: [],
                    discarded_obsolete: [],
                }),
            }),
        );
        const agent = createSmartAgent({
            name: 'triage',
            model: model as never,
            tools: [bigLog],
            context: { policy: 'summary_only', lastTurnsToKeep: 1 },
            summarization: { enable: true, summaryTriggerTokens: 800, maxTokens: 800 },
            limits: { maxContextTokens: 100_000, maxToolCalls: 10 },
        } as never);
        const store = memoryStore();
        const transcript: Array<{ role: string; content: string }> = [];
        const events: SmartAgentEvent[] = [];

        await runTurn({ agent, store, transcript, userMessage: 'ANCHOR: from now on always answer in Turkish.' });
        const pull = await runTurn({ agent, store, transcript, userMessage: 'Pull the timeout logs.', events });
        await runTurn({ agent, store, transcript, userMessage: 'Short status?' });

        // A summarization happened, and it is reportable.
        const summarizations = events.filter((e) => e.type === 'summarization');
        expect(summarizations.length).toBeGreaterThan(0);
        const compaction = compactionFromEvent(summarizations[0] as never);
        expect(compaction.summary?.userDirectives).toEqual(['Always answer in Turkish.']);
        expect(compaction.tokensBefore).toBeGreaterThan(compaction.tokensAfter ?? Infinity);
        expect(compactedToolResults(pull.inputState.messages, pull.result.state?.messages).length).toBeGreaterThan(0);

        // Turn 3 — two turns and a summarization later — still carries the
        // instruction, verbatim, AND the summary's directive block.
        const turnThree = textOf(model.calls[model.calls.length - 1]);
        expect(turnThree).toContain('ANCHOR: from now on always answer in Turkish.');
        expect(turnThree).toMatch(/User directives[^\n]*\n- Always answer in Turkish\./);
    });

    it('#2 a stored askUser: true never offers the question tool', async () => {
        const model = new ScriptedModel(() => ({ role: 'assistant', content: 'hi' }));
        const agent = createSmartAgent({
            name: 'triage',
            model: model as never,
            tools: [searchLogs],
            ...resolveAgentRuntimeOptions({ runtime: { askUser: true } }),
        } as never);
        await agent.invoke({ messages: [{ role: 'user', content: 'hello' }] } as never);
        expect(model.boundTools).toContain('search_logs');
        expect(model.boundTools).not.toContain(ASK_USER_TOOL_NAME);
    });
});

describe('#4/#5 a run stopped by a limit', () => {
    const pricing = { inputTokenPer1M: 1000, outputTokenPer1M: 1000, currency: 'USD' };
    const calculate = (p: typeof pricing, usage: { inputTokens?: number; outputTokens?: number }) => ({
        totalCost: ((usage.inputTokens ?? 0) * p.inputTokenPer1M + (usage.outputTokens ?? 0) * p.outputTokenPer1M) / 1_000_000,
    });
    const expensive = () => new ScriptedModel((_messages, call) => ({
        role: 'assistant',
        content: call === 0 ? 'Checking the app logs first.' : 'Final answer.',
        ...(call === 0 ? { tool_calls: [toolCall('c1', 'search_logs', { q: 'x' })] } : {}),
        usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 },
        response_metadata: { token_usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 } },
    }));

    it('maxCostUsd stops the run once priced, and the outcome says why and keeps the partial text', async () => {
        const model = expensive();
        const agent = createSmartAgent({
            name: 'triage',
            model: model as never,
            tools: [searchLogs],
            limits: { maxCostUsd: 0.5 },
            costEstimator: buildCostEstimator([{ names: ['scripted-model'], pricing: pricing as never }], pricing as never, calculate as never),
        } as never);
        const input = { messages: [{ role: 'user', content: 'Why the 502s?' }] };
        const result = await agent.invoke(input as never);
        const outcome = describeTurnOutcome(result, input.messages.length);

        expect(model.calls).toHaveLength(1);
        expect(outcome.stopReason).toBe('limit');
        expect(outcome.stopDetail).toMatch(/^maxCostUsd/);
        expect(outcome.content).toBe('Checking the app logs first.');
        expect(outcome.partial).toBe(true);
        expect(incompleteReason(outcome.stopReason, outcome.stopDetail)).toBe('max_cost');
    });

    it('without an estimator the same limit never fires (the old no-op)', async () => {
        const model = expensive();
        const agent = createSmartAgent({
            name: 'triage', model: model as never, tools: [searchLogs], limits: { maxCostUsd: 0.5 },
        } as never);
        const result = await agent.invoke({ messages: [{ role: 'user', content: 'Why?' }] } as never);
        expect(describeTurnOutcome(result, 1).stopReason).toBe('completed');
        expect(model.calls).toHaveLength(2);
    });

    it('maxTotalOutputTokens maps to OpenAI\'s max_output_tokens', () => {
        expect(incompleteReason('limit', 'maxTotalOutputTokens (100) exceeded')).toBe('max_output_tokens');
        expect(incompleteReason('limit', 'maxWallClockMs (1000ms) exceeded')).toBe('max_duration');
    });
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('state persistence helpers', () => {
    it('strips LangChain baggage from a model reply but keeps what the SDK needs', () => {
        const plain = toPlainMessage({
            role: 'assistant',
            content: 'x',
            tool_calls: [{ id: 'c1', name: 'search_logs', args: {} }],
            lc_serializable: true,
            lc_kwargs: { content: 'x' },
            response_metadata: { big: true },
            usage_metadata: { input_tokens: 1 },
            additional_kwargs: { reasoning_content: 'r' },
        }) as unknown as Record<string, unknown>;
        expect(Object.keys(plain).sort()).toEqual(['additional_kwargs', 'content', 'role', 'tool_calls']);
    });

    it('drops tool calls a stopped run never answered, so the next request is valid', () => {
        const repaired = repairToolAdjacency([
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'done', tool_calls: [toolCall('ok', 'a', {})] },
            { role: 'tool', tool_call_id: 'ok', content: 'r' },
            {
                role: 'assistant',
                content: 'checking two things',
                tool_calls: [toolCall('dangling', 'b', {}), toolCall('answered', 'c', {})],
                additional_kwargs: { tool_calls: [toolCall('dangling', 'b', {}), toolCall('answered', 'c', {})] },
            },
            { role: 'tool', tool_call_id: 'answered', content: 'r2' },
            { role: 'assistant', content: 'last words', tool_calls: [toolCall('never', 'd', {})] },
            { role: 'tool', tool_call_id: 'orphan', content: 'no call' },
        ] as never) as unknown as Array<Record<string, unknown>>;

        const ids = repaired.flatMap((m) => ((m.tool_calls as Array<{ id: string }> | undefined) ?? []).map((c) => c.id));
        expect(ids).toEqual(['ok', 'answered']);
        // The raw provider copy must not resurrect the dropped call.
        expect((repaired[3].additional_kwargs as Record<string, unknown>).tool_calls).toBeUndefined();
        // Text of a fully-unanswered turn survives as plain text.
        expect(repaired.some((m) => m.content === 'last words' && !m.tool_calls)).toBe(true);
        expect(repaired.some((m) => m.tool_call_id === 'orphan')).toBe(false);
    });

    it('trims a state that is too large, cheapest loss first, and gives up rather than exceed the cap', () => {
        const huge = 'x'.repeat(MAX_STATE_BYTES);
        const fits = serializeForStorage({
            messages: [{ role: 'user', content: 'q' }] as never,
            toolHistory: [{ executionId: 'e1', toolName: 't', output: 'small', rawOutput: huge }] as never,
        });
        expect(fits).not.toBeNull();
        expect(fits!.length).toBeLessThanOrEqual(MAX_STATE_BYTES);
        expect(fits).toContain('small');
        expect(fits).not.toContain('rawOutput');

        const hopeless = serializeForStorage({
            messages: Array.from({ length: 400 }, () => ({ role: 'user', content: 'y'.repeat(10_000) })) as never,
        });
        expect(hopeless).toBeNull();
    });

    it('ignores a stored state the transcript has moved past', async () => {
        const store = memoryStore();
        await saveConversationState(store, {
            conversationId: 'conv-1', tenantId: 't', projectId: 'p', agentKey: 'a',
            state: { messages: [{ role: 'user', content: 'q' }] } as never,
            messageCount: 2,
        });
        expect(await loadConversationState(store, { _id: 'conv-1', messages: new Array(2) as never })).not.toBeNull();
        // A connected agent (or an older build) appended a turn without saving state.
        expect(await loadConversationState(store, { _id: 'conv-1', messages: new Array(4) as never })).toBeNull();
    });

    it('never carries the system prompt, the usage ledger or per-run ctx verdicts', async () => {
        const store = memoryStore();
        await saveConversationState(store, {
            conversationId: 'conv-1', tenantId: 't', projectId: 'p', agentKey: 'a',
            state: {
                messages: [{ role: 'system', content: 'OLD PROMPT' }, { role: 'user', content: 'q' }],
                usage: { totals: { m: { input: 999 } } },
                ctx: { __limitBreached: 'maxCostUsd' },
            } as never,
            messageCount: 2,
        });
        const snapshot = store.rows.get('conv-1')!.snapshot;
        expect(snapshot).not.toContain('OLD PROMPT');
        expect(snapshot).not.toContain('__limitBreached');
        expect(snapshot).not.toContain('"usage"');
    });

    it('reports a paused run as paused, not as an empty answer', () => {
        const outcome = describeTurnOutcome({
            content: '',
            state: { messages: [], ctx: { __awaitingApproval: { id: 'x' } } } as never,
        }, 0);
        expect(outcome).toMatchObject({ stopReason: 'paused', partial: true, content: '' });
    });

    it('treats zero prices as "not priced", so maxCostUsd is not silently a no-op at $0', () => {
        const calc = () => ({ totalCost: 0 });
        expect(buildCostEstimator([{ names: ['m'], pricing: { inputTokenPer1M: 0, outputTokenPer1M: 0 } as never }], undefined, calc)).toBeUndefined();
    });
});
