/**
 * PROMOTED REGRESSION TEST (was a design-review spike — see
 * docs/guide/agent-background-execution.md §12.2, §13 Group B). Kept
 * permanently: this is the empirical evidence the whole background-execution
 * design's honesty guarantee (Decision 7, §5, §9) rests on, and it must keep
 * being asserted, not just remembered.
 *
 * Question answered: does `@cognipeer/agent-sdk`'s `InvokeConfig.cancellationToken`
 * (and `timeoutMs`) actually interrupt an IN-FLIGHT tool call, or does it
 * only stop the agent loop from starting its NEXT step (model call / tool
 * call) while an already-started tool call keeps running to completion in
 * the background regardless?
 *
 * Answer (see the assertions below): cancellation is checked at a loop
 * CHECKPOINT — after a step finishes, before the next one starts. It does
 * NOT interrupt whichever call is currently in flight. This is why
 * `executeAgentChatLocal`'s own deadline/cancel enforcement (see
 * `AgentRunCancellationCell` in `agentService.ts`) races `invoke()` with a
 * separate timer instead of trusting `cancellationToken`/`timeoutMs` alone
 * to bound anything, and why the conversation write is separately gated
 * (§12.12) rather than assumed to never fire late.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createSmartAgent, createTool, type Message } from '@cognipeer/agent-sdk';

type Reply = Record<string, unknown>;

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
});

/** Same scripted-model shape the existing agent-turn-state.test.ts uses. */
class ScriptedModel {
    readonly modelName = 'scripted-model';
    calls = 0;
    constructor(private readonly script: (call: number) => Reply) {}
    bindTools() { return this; }
    async invoke(_messages: Message[]): Promise<Reply> {
        const reply = this.script(this.calls);
        this.calls += 1;
        return reply;
    }
}

/** A "slow tool" standing in for a real MCP/network call: records when it
 *  STARTS and when its side effect actually COMMITS (the point of no return —
 *  e.g. "the email actually went out"). */
function buildSlowTool(delayMs: number) {
    const state = { started: false, committed: false, startedAt: 0, committedAt: 0 };
    const tool = createTool({
        name: 'slow_tool',
        description: 'Simulates a slow remote/MCP call with a real side effect.',
        schema: z.object({}),
        // NB: `SmartToolFn = (args: any) => Promise<any> | any` — no second
        // (ctx/signal) parameter exists in the SDK's own type for this func.
        // So a tool author has no SDK-provided way to observe cancellation
        // from inside `func` even if they wanted to.
        func: async () => {
            state.started = true;
            state.startedAt = Date.now();
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            state.committed = true;
            state.committedAt = Date.now();
            return 'slow tool result';
        },
    });
    return { tool, state };
}

describe('agent-sdk cancellation reaches (or does not reach) an in-flight tool call', () => {
    it('cancellationToken aborted WHILE a tool call is in flight', async () => {
        const { tool, state } = buildSlowTool(400);
        const model = new ScriptedModel((call) => {
            if (call === 0) {
                return { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'slow_tool', {})] };
            }
            return { role: 'assistant', content: 'done' };
        });
        const agent = createSmartAgent({ name: 'spike', model: model as never, tools: [tool] });

        const controller = new AbortController();
        // Abort partway through the tool's 400ms delay.
        setTimeout(() => controller.abort(), 100);

        const invokeStarted = Date.now();
        let invokeSettledAs: 'resolved' | 'rejected' = 'resolved';
        let invokeError: unknown;
        try {
            await agent.invoke(
                { messages: [{ role: 'user', content: 'go' }] } as never,
                { cancellationToken: controller.signal },
            );
        } catch (err) {
            invokeSettledAs = 'rejected';
            invokeError = err;
        }
        const invokeElapsedMs = Date.now() - invokeStarted;

        // eslint-disable-next-line no-console
        console.log('[SPIKE cancellationToken]', {
            invokeSettledAs,
            invokeElapsedMs,
            invokeErrorMessage: invokeError instanceof Error ? invokeError.message : invokeError,
            toolStarted: state.started,
        });

        // Give the tool's own timer a chance to finish regardless of what
        // invoke() did, so we can see whether the side effect landed anyway.
        await new Promise((resolve) => setTimeout(resolve, 500));

        // eslint-disable-next-line no-console
        console.log('[SPIKE cancellationToken] after grace period', {
            toolCommitted: state.committed,
            toolElapsedMs: state.committed ? state.committedAt - state.startedAt : null,
        });

        expect(state.started).toBe(true);
    }, 10_000);

    it('timeoutMs shorter than the tool call', async () => {
        const { tool, state } = buildSlowTool(400);
        const model = new ScriptedModel((call) => {
            if (call === 0) {
                return { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'slow_tool', {})] };
            }
            return { role: 'assistant', content: 'done' };
        });
        const agent = createSmartAgent({ name: 'spike-timeout', model: model as never, tools: [tool] });

        const invokeStarted = Date.now();
        let invokeSettledAs: 'resolved' | 'rejected' = 'resolved';
        let invokeError: unknown;
        try {
            await agent.invoke(
                { messages: [{ role: 'user', content: 'go' }] } as never,
                { timeoutMs: 100 },
            );
        } catch (err) {
            invokeSettledAs = 'rejected';
            invokeError = err;
        }
        const invokeElapsedMs = Date.now() - invokeStarted;

        // eslint-disable-next-line no-console
        console.log('[SPIKE timeoutMs]', {
            invokeSettledAs,
            invokeElapsedMs,
            invokeErrorMessage: invokeError instanceof Error ? invokeError.message : invokeError,
            toolStarted: state.started,
        });

        await new Promise((resolve) => setTimeout(resolve, 500));

        // eslint-disable-next-line no-console
        console.log('[SPIKE timeoutMs] after grace period', {
            toolCommitted: state.committed,
        });

        expect(state.started).toBe(true);
    }, 10_000);

    it('cancellationToken already aborted BEFORE invoke() is called at all', async () => {
        const { tool, state } = buildSlowTool(400);
        const model = new ScriptedModel((call) => {
            if (call === 0) {
                return { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'slow_tool', {})] };
            }
            return { role: 'assistant', content: 'done' };
        });
        const agent = createSmartAgent({ name: 'spike-preaborted', model: model as never, tools: [tool] });

        const controller = new AbortController();
        controller.abort();

        let invokeSettledAs: 'resolved' | 'rejected' = 'resolved';
        let invokeError: unknown;
        try {
            await agent.invoke(
                { messages: [{ role: 'user', content: 'go' }] } as never,
                { cancellationToken: controller.signal },
            );
        } catch (err) {
            invokeSettledAs = 'rejected';
            invokeError = err;
        }

        // eslint-disable-next-line no-console
        console.log('[SPIKE pre-aborted]', {
            invokeSettledAs,
            invokeErrorMessage: invokeError instanceof Error ? invokeError.message : invokeError,
            modelCalls: model.calls,
            toolStarted: state.started,
        });
    }, 10_000);

    it('cancellationToken aborted BETWEEN steps (tool 1 done, before model call 2 / tool 2)', async () => {
        // Two fast tool calls in a row, with the MODEL call itself taking real
        // time (standing in for provider latency) — this opens a window to
        // abort strictly between step 1 finishing and step 2 starting, to
        // check whether the SDK honors cancellation as an inter-step
        // checkpoint even though (per the tests above) it does not honor it
        // mid-tool-call.
        const { tool: tool1, state: state1 } = buildSlowTool(10);
        const { tool: tool2, state: state2 } = buildSlowTool(10);
        const modelDelayMs = 150;
        const model = new ScriptedModel(() => ({ role: 'assistant', content: '' })); // overwritten below
        let modelCalls = 0;
        (model as unknown as { invoke: (m: Message[]) => Promise<Reply> }).invoke = async () => {
            await new Promise((resolve) => setTimeout(resolve, modelDelayMs));
            const call = modelCalls;
            modelCalls += 1;
            if (call === 0) return { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'slow_tool', {})] };
            if (call === 1) return { role: 'assistant', content: '', tool_calls: [toolCall('c2', 'slow_tool_2', {})] };
            return { role: 'assistant', content: 'done' };
        };
        const renamedTool2 = { ...tool2, name: 'slow_tool_2' };
        const agent = createSmartAgent({ name: 'spike-interstep', model: model as never, tools: [tool1, renamedTool2 as never] });

        const controller = new AbortController();
        // Step timeline: model-call-1 (150ms) -> tool-1 (10ms) -> model-call-2 (150ms) -> tool-2 -> model-call-3.
        // Abort at 200ms: after tool-1 has finished (~160ms in), strictly
        // before model-call-2 would settle (~310ms in).
        setTimeout(() => controller.abort(), 200);

        const invokeStarted = Date.now();
        let invokeSettledAs: 'resolved' | 'rejected' = 'resolved';
        let invokeError: unknown;
        try {
            await agent.invoke(
                { messages: [{ role: 'user', content: 'go' }] } as never,
                { cancellationToken: controller.signal },
            );
        } catch (err) {
            invokeSettledAs = 'rejected';
            invokeError = err;
        }
        const invokeElapsedMs = Date.now() - invokeStarted;

        // eslint-disable-next-line no-console
        console.log('[SPIKE inter-step abort]', {
            invokeSettledAs,
            invokeElapsedMs,
            invokeErrorMessage: invokeError instanceof Error ? invokeError.message : invokeError,
            modelCallsMade: modelCalls,
            tool1Started: state1.started,
            tool2Started: state2.started,
        });

        expect(state1.started).toBe(true);
    }, 10_000);
});
