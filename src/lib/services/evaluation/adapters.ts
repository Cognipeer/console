/**
 * Live invokers that bridge the pure evaluation engine to the platform model
 * runtime. `model` targets (and the llm-judge) call `handleChatCompletion`.
 * `agent` and `external` targets are recognised but not yet wired — they throw
 * a descriptive error, which the runner records as a per-item failure rather
 * than aborting the whole run.
 */

import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import type { IEvaluationTarget } from '@/lib/database';
import type { DatasetItem, JudgeInvoker, TargetInvoker, TargetOutput } from './types';

export interface EvaluationModelContext {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
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

export function buildTargetInvoker(target: IEvaluationTarget, ctx: EvaluationModelContext): TargetInvoker {
  return async (item: DatasetItem): Promise<TargetOutput> => {
    if (target.kind === 'model') {
      if (!target.modelKey) throw new Error(`Evaluation target "${target.key}" has no modelKey configured`);
      const messages = item.input.map((m) => ({ role: m.role, content: m.content }));
      const { text, latencyMs, raw } = await invokeModel(ctx, target.modelKey, messages);
      return { text, latencyMs, raw };
    }
    if (target.kind === 'agent') {
      throw new Error('agent evaluation targets are not yet supported (model targets only in this release)');
    }
    throw new Error('external evaluation targets are not yet supported (model targets only in this release)');
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
