/**
 * Live invokers that bridge the pure evaluation engine to the platform model
 * runtime. `model` targets (and the llm-judge) call `handleChatCompletion`;
 * `agent` targets call `executeAgentChat`; semantic scorers embed via
 * `handleEmbeddingRequest`. `external` targets are recognised but not yet wired
 * — they throw a descriptive error, which the runner records as a per-item
 * failure rather than aborting the whole run.
 */

import { handleChatCompletion, handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import type { IEvaluationTarget } from '@/lib/database';
import type { DatasetItem, EmbedInvoker, JudgeInvoker, TargetInvoker, TargetOutput } from './types';

export interface EvaluationModelContext {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  /** Actor running the suite — required for agent targets. */
  userId?: string;
}

interface ChatLikeResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/** Pull the assistant text out of an OpenAI-shaped chat completion response. */
export function extractAssistantText(response: unknown): string {
  const content = (response as ChatLikeResponse | null | undefined)?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

async function invokeModel(
  ctx: EvaluationModelContext,
  modelKey: string,
  messages: Array<{ role: string; content: string }>,
): Promise<{ text: string; latencyMs?: number; raw: unknown }> {
  const result = (await handleChatCompletion({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    modelKey,
    projectId: ctx.projectId,
    body: { messages },
  })) as { response?: unknown; latencyMs?: number };
  return { text: extractAssistantText(result.response), latencyMs: result.latencyMs, raw: result.response };
}

/** Pull the assistant text out of an agent chat (Responses-shaped) result. */
export function extractAgentText(response: unknown): string {
  const output = (response as { output?: Array<{ content?: Array<{ text?: unknown; type?: string }> }> })?.output;
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const message of output) {
    for (const part of message?.content ?? []) {
      if (typeof part?.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('').trim();
}

/** The last user turn (falling back to a join of all turns) drives an agent. */
function toUserMessage(item: DatasetItem): string {
  const lastUser = [...item.input].reverse().find((m) => m.role === 'user');
  if (lastUser) return lastUser.content;
  return item.input.map((m) => m.content).join('\n');
}

export function buildTargetInvoker(target: IEvaluationTarget, ctx: EvaluationModelContext): TargetInvoker {
  return async (item: DatasetItem): Promise<TargetOutput> => {
    if (target.kind === 'model') {
      if (!target.modelKey) throw new Error(`Evaluation target "${target.key}" has no modelKey configured`);
      const messages = item.input.map((m) => ({ role: m.role, content: m.content }));
      const { text, latencyMs, raw } = await invokeModel(ctx, target.modelKey, messages);
      return { text, latencyMs, raw };
    }
    if (target.kind === 'agent') {
      if (!target.agentKey) throw new Error(`Evaluation target "${target.key}" has no agentKey configured`);
      // Lazy import: the agent runtime pulls in a heavy module graph (rag /
      // document conversion) that we only want loaded when an agent target
      // actually runs — not at evaluation-engine import time.
      const { createConversation, executeAgentChat } = await import('@/lib/services/agents/agentService');
      const userId = ctx.userId ?? 'evaluation';
      // Each item runs in its own fresh conversation so cases never bleed into
      // each other. `executeAgentChat` requires an existing conversation, so we
      // create one first (the id is DB-generated, not synthesised).
      const conversation = await createConversation(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        userId,
        target.agentKey,
        `Eval ${target.key} · ${item.id}`,
      );
      const started = Date.now();
      const response = await executeAgentChat({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        agentKey: target.agentKey,
        conversationId: String(conversation._id),
        userMessage: toUserMessage(item),
        userId,
        usePublished: true,
      });
      return { text: extractAgentText(response), latencyMs: Date.now() - started, raw: response };
    }
    throw new Error('external evaluation targets are not yet supported (model targets only in this release)');
  };
}

export function buildEmbedInvoker(embeddingModelKey: string | undefined, ctx: EvaluationModelContext): EmbedInvoker {
  return async (texts) => {
    if (!embeddingModelKey) {
      throw new Error('embeddingModelKey is required when a suite uses semantic scorers');
    }
    const result = (await handleEmbeddingRequest({
      tenantDbName: ctx.tenantDbName,
      modelKey: embeddingModelKey,
      projectId: ctx.projectId,
      body: { input: texts },
    })) as { response?: { data?: Array<{ embedding?: number[] }> } };
    const data = result.response?.data;
    if (!data || data.length < texts.length) {
      throw new Error('embedding provider returned fewer vectors than requested');
    }
    return data.map((d) => {
      if (!d.embedding) throw new Error('missing embedding in provider response');
      return d.embedding;
    });
  };
}

export function buildJudgeInvoker(judgeModelKey: string | undefined, ctx: EvaluationModelContext): JudgeInvoker {
  return async (messages) => {
    if (!judgeModelKey) {
      throw new Error('judgeModelKey is required when a suite uses llm-judge scorers');
    }
    const { text } = await invokeModel(
      ctx,
      judgeModelKey,
      messages.map((m) => ({ role: m.role, content: m.content })),
    );
    return text;
  };
}
