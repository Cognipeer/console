/**
 * Live invokers bridging the pure red-team engine to the platform model
 * runtime. `model` targets call `handleChatCompletion`; `agent` targets call
 * `executeAgentChat` (so the FULL agent — guardrails, RAG, tools — is exercised,
 * which is the point of red-teaming an agent rather than a raw model). The judge
 * also runs through `handleChatCompletion`, driven at temperature 0 for
 * reproducible verdicts.
 *
 * Mirrors `services/evaluation/adapters.ts` to keep one bridging convention.
 */

import crypto from 'node:crypto';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import { extractAgentText, extractAssistantText } from '@/lib/services/evaluation/adapters';
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
}

async function invokeModel(
  ctx: RedTeamModelContext,
  modelKey: string,
  messages: RedTeamMessage[],
  options?: { temperature?: number },
): Promise<RedTeamOutput> {
  const result = (await handleChatCompletion({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    modelKey,
    projectId: ctx.projectId,
    body: { messages, ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}) },
  })) as { response?: unknown; latencyMs?: number };
  return { text: extractAssistantText(result.response), latencyMs: result.latencyMs, raw: result.response };
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
        usePublished: true,
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
    const { text } = await invokeModel(ctx, judgeModelKey, messages, { temperature: 0 });
    return text;
  };
}

export function buildAttackerInvoker(attackerModelKey: string | undefined, ctx: RedTeamModelContext): AttackerInvoker {
  return async (messages) => {
    if (!attackerModelKey) {
      throw new Error('attackerModelKey is required to drive adaptive multi-turn attacks');
    }
    // Higher temperature so the attacker varies tactics across turns.
    const { text } = await invokeModel(ctx, attackerModelKey, messages, { temperature: 0.8 });
    return text;
  };
}
