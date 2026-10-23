/**
 * Live invoker that bridges the pure analysis engine to the platform model
 * runtime. Both the extraction model and the judge model are reached through
 * `handleChatCompletion`; a Model Hub `decision` model is reached through
 * `handleDecisionRequest`. The invoker is built per-model-key so the service can
 * wire the models independently (and inject fakes in tests).
 */

import { randomUUID } from 'node:crypto';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import { handleDecisionRequest } from '@/lib/services/models/decisionService';
import { parseDecisionRequest } from '@/lib/providers/contracts/decisionHelpers';
import type { AnalysisMessage, DecisionInvoker, ModelInvoker } from './types';

export interface AnalysisModelContext {
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

export function buildModelInvoker(
  modelKey: string | undefined,
  ctx: AnalysisModelContext,
  role: 'extraction' | 'judge',
): ModelInvoker {
  return async (messages: AnalysisMessage[]): Promise<string> => {
    if (!modelKey) {
      throw new Error(`an ${role} model is required (set ${role === 'judge' ? 'judgeModelKey' : 'extractionModelKey'} on the definition)`);
    }
    const result = (await handleChatCompletion({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      modelKey,
      projectId: ctx.projectId,
      body: { messages: messages.map((m) => ({ role: m.role, content: m.content })) },
    })) as { response?: unknown };
    return extractAssistantText(result.response);
  };
}

/**
 * Invoker for a Model Hub `decision` model: one call answers every question of a
 * conversation. The request goes through `parseDecisionRequest` (same validation
 * and limits as the HTTP route), so a malformed request or a backend failure
 * throws here and the engine records it as an item error, never a run failure.
 */
export function buildDecisionInvoker(modelKey: string, ctx: AnalysisModelContext): DecisionInvoker {
  return async ({ input, questions, includeRationale }) => {
    const request = parseDecisionRequest({
      model: modelKey,
      input,
      questions,
      options: { include_rationale: includeRationale },
    });
    const outcome = await handleDecisionRequest({
      tenantDbName: ctx.tenantDbName,
      projectId: ctx.projectId,
      request,
      requestId: `analysis-${randomUUID()}`,
    });
    return {
      answers: outcome.result.answers,
      rationale: outcome.result.rationale,
      backendKind: outcome.result.backend.kind,
    };
  };
}
