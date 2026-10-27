/**
 * Live invokers bridging the pure red-team engine to the platform model
 * runtime. `model` targets call `handleChatCompletion`; `agent` targets call
 * `executeAgentChat` (so the FULL agent — guardrails, RAG, tools — is exercised,
 * which is the point of red-teaming an agent rather than a raw model). The judge
 * also runs through `handleChatCompletion`, driven at temperature 0 for
 * reproducible verdicts. The judge and the attacker are short side calls: they are
 * sent the lowest thinking their model allows and an explicit output limit, and a
 * reply that stops at that limit is asked for once more with a larger one.
 *
 * Mirrors `services/evaluation/adapters.ts` to keep one bridging convention.
 */

import crypto from 'node:crypto';
import { sideCallPlan, sideCallReasoning } from '@/lib/services/agents/agentReasoning';
import { getDynamicRoutingConfig } from '@/lib/services/models/dynamicRouting';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import { CONTEXT_WINDOW_EXCEEDED_REASON, OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import { AGENT_REASONING_OVERRIDE, type NormalizedReasoning } from '@/lib/services/models/reasoning';
import { extractAgentText, extractAssistantText } from '@/lib/services/evaluation/adapters';
import type { AgentRunSelector } from '@/lib/services/agents/agentRevision';
import type { AttackerInvoker, JudgeInvoker, RedTeamMessage, RedTeamOutput, TargetInvoker } from './types';

export interface RedTeamModelContext {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  /** Actor running the campaign — required for agent targets. */
  userId?: string;
}

/** What is under test. Agent targets exercise the whole agent stack. */
export interface RedTeamTargetSpec {
  kind: 'model' | 'agent';
  key: string;
  modelKey?: string;
  agentKey?: string;
  /** Which agent configuration every call hits; absent follows the published version. */
  agentRun?: AgentRunSelector;
}

/** A judge replies with one JSON verdict and the attacker with one message: these are caps, not targets. */
const JUDGE_MAX_TOKENS = 1024;
const ATTACKER_MAX_TOKENS = 1024;

/** How a judge / attacker call is sent: the lowest thinking its model allows, and its output limits. */
interface SideCall {
  reasoning?: NormalizedReasoning;
  /** The first limit; undefined when the model's thinking cannot be switched off from here (it runs on the model default). */
  limit?: number;
  /** The limit of the one retry of a reply that stopped at the limit (given the output it observed); undefined when it cannot grow. */
  retryAfter: (observedOutputTokens?: number) => number | undefined;
}

async function resolveSideCall(ctx: RedTeamModelContext, modelKey: string, floor: number): Promise<SideCall> {
  // Lazy import: the model service pulls a heavy module graph, and a model target never needs it.
  const { getModelByKey } = await import('@/lib/services/models/modelService');
  const model = await getModelByKey(ctx.tenantDbName, modelKey, ctx.projectId);
  const options = { dynamic: model ? Boolean(getDynamicRoutingConfig(model)) : false };
  const reasoning = model ? sideCallReasoning(model, options) : undefined;
  const { limit, retryAfter } = sideCallPlan(model ?? {}, floor, options);
  return { ...(limit !== undefined ? { limit } : {}), retryAfter, ...(reasoning ? { reasoning } : {}) };
}

type ChatResult = { response?: unknown; latencyMs?: number };

function finishReasonOf(response: unknown): string | undefined {
  return (response as { choices?: Array<{ finish_reason?: string }> } | null | undefined)?.choices?.[0]?.finish_reason;
}

/** A model reply. A side call's also says whether it still stopped at the output limit, and the limit it was sent. */
type ModelCall = RedTeamOutput & { cutOff?: boolean; limit?: number };

async function invokeModel(
  ctx: RedTeamModelContext,
  modelKey: string,
  messages: RedTeamMessage[],
  options?: { temperature?: number; sideCall?: { maxTokens: number } },
): Promise<ModelCall> {
  const side = options?.sideCall ? await resolveSideCall(ctx, modelKey, options.sideCall.maxTokens) : undefined;
  const send = async (maxTokens?: number): Promise<ChatResult> => (await handleChatCompletion({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    modelKey,
    projectId: ctx.projectId,
    body: {
      messages,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(side?.reasoning ? { [AGENT_REASONING_OVERRIDE]: side.reasoning } : {}),
    },
  })) as ChatResult;
  const output = (result: ChatResult): RedTeamOutput => ({
    text: extractAssistantText(result.response),
    latencyMs: result.latencyMs,
    raw: result.response,
  });

  if (!side) return output(await send());

  // No text at all (the thinking took the limit) comes back as an OutputTokenLimitError; text that ends
  // mid-way comes back as a `length` finish. Either way the call is repeated once with a larger limit.
  const attempt = async (limit: number | undefined): Promise<{ result: ChatResult; cutOff: boolean } | { error: OutputTokenLimitError }> => {
    try {
      const result = await send(limit);
      return { result, cutOff: finishReasonOf(result.response) === 'length' };
    } catch (error) {
      if (error instanceof OutputTokenLimitError) return { error };
      throw error;
    }
  };
  let limit = side.limit;
  let last = await attempt(limit);
  // A full context window is not cured by a larger output limit.
  const retryable = 'error' in last ? last.error.rawFinishReason !== CONTEXT_WINDOW_EXCEEDED_REASON : last.cutOff;
  if (retryable) {
    const observed = 'error' in last
      ? undefined
      : (last.result.response as { usage?: { completion_tokens?: number } } | null | undefined)?.usage?.completion_tokens;
    const retry = side.retryAfter(observed);
    if (retry !== undefined) {
      limit = retry;
      last = await attempt(limit);
    }
  }
  if ('error' in last) throw last.error;
  return { ...output(last.result), cutOff: last.cutOff, limit };
}

/** The last user turn drives an agent (agents own their own conversation state). */
function lastUser(messages: RedTeamMessage[]): string {
  const found = [...messages].reverse().find((m) => m.role === 'user');
  return found?.content ?? messages.map((m) => m.content).join('\n');
}

export function buildTargetInvoker(target: RedTeamTargetSpec, ctx: RedTeamModelContext): TargetInvoker {
  // Each attempt gets its own agent conversation so multi-turn attacks share
  // state WITHIN an attempt but never bleed across attempts. The runner feeds a
  // fresh history (no assistant turns yet) at the start of every attempt — we
  // mint a new conversation id whenever we see that.
  let conversationId = `redteam-${target.key}-${crypto.randomUUID()}`;

  return async (messages: RedTeamMessage[]): Promise<RedTeamOutput> => {
    if (target.kind === 'model') {
      if (!target.modelKey) throw new Error(`Red-team target "${target.key}" has no modelKey configured`);
      return invokeModel(ctx, target.modelKey, messages);
    }
    if (target.kind === 'agent') {
      if (!target.agentKey) throw new Error(`Red-team target "${target.key}" has no agentKey configured`);
      // Lazy import: the agent runtime pulls a heavy module graph we only want
      // loaded when an agent target actually runs.
      const { executeAgentChat, createConversation } = await import('@/lib/services/agents/agentService');
      // A fresh attempt (no assistant turns yet) gets its own conversation, so
      // multi-turn state is shared within an attempt but never across attempts.
      // The conversation must exist before executeAgentChat (it loads by id).
      if (!messages.some((m) => m.role === 'assistant')) {
        const convo = await createConversation(
          ctx.tenantDbName,
          ctx.tenantId,
          ctx.projectId,
          ctx.userId ?? 'redteam',
          target.agentKey,
          `redteam: ${target.key}`,
          { source: 'redteam' },
        );
        conversationId = String(convo._id);
      }
      const started = Date.now();
      const response = await executeAgentChat({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        agentKey: target.agentKey,
        conversationId,
        userMessage: lastUser(messages),
        userId: ctx.userId ?? 'redteam',
        ...(target.agentRun ?? { usePublished: true }),
        // No one is present during a red-team run: a gated tool follows the agent's
        // `humanInTheLoop.unattended` setting (deny by default).
        unattended: true,
      });
      return { text: extractAgentText(response), latencyMs: Date.now() - started, raw: response };
    }
    throw new Error(`Unsupported red-team target kind: ${(target as RedTeamTargetSpec).kind}`);
  };
}

export function buildJudgeInvoker(judgeModelKey: string | undefined, ctx: RedTeamModelContext): JudgeInvoker {
  return async (messages) => {
    if (!judgeModelKey) {
      throw new Error('judgeModelKey is required when a campaign uses llm-judge detectors');
    }
    // Temperature 0 for deterministic, replayable verdicts.
    const { text, cutOff, limit } = await invokeModel(ctx, judgeModelKey, messages, {
      temperature: 0,
      sideCall: { maxTokens: JUDGE_MAX_TOKENS },
    });
    // A verdict that still stops at the limit never closes its JSON: report that, not a parse error.
    if (cutOff) {
      throw new Error(
        `The judge model reached its output token limit${limit ? ` (${limit} tokens)` : ''} before it finished the verdict. `
        + 'Raise the judge model\'s "Default max tokens" setting.',
      );
    }
    return text;
  };
}

export function buildAttackerInvoker(attackerModelKey: string | undefined, ctx: RedTeamModelContext): AttackerInvoker {
  return async (messages) => {
    if (!attackerModelKey) {
      throw new Error('attackerModelKey is required to drive adaptive multi-turn attacks');
    }
    // Higher temperature so the attacker varies tactics across turns.
    const { text } = await invokeModel(ctx, attackerModelKey, messages, {
      temperature: 0.8,
      sideCall: { maxTokens: ATTACKER_MAX_TOKENS },
    });
    return text;
  };
}
