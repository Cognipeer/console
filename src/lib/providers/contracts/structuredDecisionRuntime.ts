/**
 * Structured-output emulator for the decision category.
 *
 * Serves `POST /decisions` from any OpenAI-schema chat model: ONE chat call
 * whose `response_format` is a strict JSON schema built from the request, then
 * `normalizeDecisionOutput` derives the answers. Used by the OpenAI, Azure and
 * OpenAI-compatible drivers; other families get a clear 400 until their own
 * strategy (Anthropic forced tool, Gemini responseSchema) lands.
 *
 * It builds the chat model through the provider's own `createChatModel`, so the
 * per-model parameter stripping (`unsupportedParams`, e.g. no `temperature` on
 * the gpt-5 / o-series) and `extraBody` handling are inherited, not re-done.
 */
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { DecisionRequest, DecisionResult, DecisionRuntime } from '../domains/decision';
import type { ModelProviderRuntime, ModelRuntimeConfig } from '../domains/model';
import { repairJsonContent } from '@/lib/shared/jsonExtraction';
import { stripInlineReasoning } from '@/lib/shared/inlineReasoning';
import {
  buildDecisionQuestionsPrompt,
  buildDecisionResponseFormat,
  buildDecisionSystemPrompt,
  normalizeDecisionOutput,
  refuseAll,
} from './decisionHelpers';

/**
 * Capability flags the structured emulator contributes to a driver. `max_context`
 * is deliberately absent: it is a property of the underlying chat model, not of
 * the driver, and an invented number would gate callers wrongly.
 */
export const DECISION_CAPABILITIES = {
  'decision.question_types': ['choice', 'boolean', 'score'] as Array<'choice' | 'boolean' | 'score'>,
  // The driver can pass images through; whether a given model reads them is
  // declared per model (`settings.decision.supports.image`).
  'decision.supports.image': true,
  'decision.native': false,
};

/** The upstream answered, but not with a usable document — maps to HTTP 502. */
export class DecisionBackendError extends Error {
  /**
   * Makes `withResilience` treat this as NON-retryable (422 is in its
   * non-retryable set): the call already succeeded and cost tokens, and asking
   * again at temperature 0 mostly buys the same unparseable answer three times
   * over. The only repair is the in-runtime JSON recovery; the HTTP response is
   * still 502 (see the plugin). Transient 429/5xx/network errors are untouched.
   */
  readonly status = 422;

  constructor(message: string) {
    super(message);
    this.name = 'DecisionBackendError';
  }
}

interface ChatRunnable {
  invoke(input: unknown, options?: Record<string, unknown>): Promise<unknown>;
}

function isChatRunnable(value: unknown): value is ChatRunnable {
  return Boolean(
    value && typeof value === 'object' && typeof (value as { invoke?: unknown }).invoke === 'function',
  );
}

function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const text = (part as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }
  return '';
}

function numberOf(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function extractUsage(message: unknown): DecisionResult['usage'] {
  const record = (message ?? {}) as {
    usage_metadata?: Record<string, unknown>;
    response_metadata?: Record<string, unknown>;
  };
  const meta = record.usage_metadata ?? {};
  const wire = (record.response_metadata?.tokenUsage
    ?? record.response_metadata?.token_usage
    ?? record.response_metadata?.usage
    ?? {}) as Record<string, unknown>;
  const inputTokens = numberOf(meta.input_tokens, wire.promptTokens, wire.prompt_tokens, wire.input_tokens);
  const outputTokens = numberOf(meta.output_tokens, wire.completionTokens, wire.completion_tokens, wire.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

function buildMessages(request: DecisionRequest, includeRationale: boolean) {
  const content: Array<Record<string, unknown>> = [];
  const text = request.input
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
  if (text) content.push({ type: 'text', text: `Input:\n<input>\n${text}\n</input>` });
  for (const part of request.input) {
    if (part.type === 'image') content.push({ type: 'image_url', image_url: { url: part.data_url } });
  }
  content.push({ type: 'text', text: buildDecisionQuestionsPrompt(request.questions) });
  return [
    new SystemMessage(buildDecisionSystemPrompt(includeRationale)),
    new HumanMessage({ content: content as never }),
  ];
}

export function createStructuredDecisionRuntime(
  runtime: ModelProviderRuntime,
  config: ModelRuntimeConfig,
  provider: string,
): DecisionRuntime {
  return {
    async decide(request, options): Promise<DecisionResult> {
      if (!runtime.createChatModel) {
        throw new DecisionBackendError(`Provider "${provider}" has no chat runtime to serve decisions`);
      }
      const includeRationale = request.includeRationale === true;

      // Temperature 0 where accepted: createChatModel drops it again for the
      // models whose registry rule says they reject it.
      const chatModel = await runtime.createChatModel({
        modelId: config.modelId,
        category: 'llm',
        modelSettings: { ...(config.modelSettings ?? {}), temperature: 0 },
        options: { maxRetries: 0 },
      });
      if (!isChatRunnable(chatModel)) {
        throw new DecisionBackendError(`Provider "${provider}" returned a chat model that cannot be invoked`);
      }

      const response = await chatModel.invoke(buildMessages(request, includeRationale), {
        response_format: buildDecisionResponseFormat(request.questions, includeRationale),
        ...(options?.signal ? { signal: options.signal } : {}),
      });

      const usage = extractUsage(response);
      const backend = { kind: 'structured' as const, provider };

      const refusal = (response as { additional_kwargs?: { refusal?: unknown } }).additional_kwargs?.refusal;
      if (typeof refusal === 'string' && refusal.trim()) {
        return { ...refuseAll(request.questions), usage, backend };
      }

      const raw = stripInlineReasoning(messageText(response)).trim();
      if (!raw) {
        throw new DecisionBackendError('The model returned an empty response');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(repairJsonContent(raw).content);
      } catch {
        throw new DecisionBackendError('The model did not return valid JSON for the decision schema');
      }

      return {
        ...normalizeDecisionOutput(parsed, request.questions, includeRationale),
        usage,
        backend,
      };
    },
  };
}
