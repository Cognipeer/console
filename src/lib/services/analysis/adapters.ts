/**
 * Live invoker that bridges the pure analysis engine to the platform model
 * runtime. Both the extraction model and the judge model are reached through
 * `handleChatCompletion`. The invoker is built per-model-key so the service can
 * wire extraction and judge models independently (and inject fakes in tests).
 */

import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import type { AnalysisMessage, ModelInvoker } from './types';

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
