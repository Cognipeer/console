/**
 * Structured-output emulator for the decision category.
 *
 * Serves `POST /decisions` from any OpenAI-schema chat model: ONE chat call
 * whose `response_format` is a strict JSON schema built from the request, then
 * `normalizeDecisionOutput` derives the answers. Used by the OpenAI, Azure and
 * OpenAI-compatible drivers; other families get a clear 400 until their own
 * strategy (Anthropic forced tool, Gemini responseSchema) lands.
 *
 * It builds the chat client through the provider's own `createNativeChatClient`, so the
 * per-model parameter stripping (`unsupportedParams`, e.g. no `temperature` on
 * the gpt-5 / o-series) and `extraBody` handling are inherited, not re-done.
 */
import type { ChatCompletionResponse, UnifiedMessage } from '@cognipeer/agent-sdk';
import { imageUrlToPart, type ContentPart } from './nativeParts';
import type { DecisionRequest, DecisionResult, DecisionRuntime } from '../domains/decision';
import type { ModelProviderRuntime, ModelRuntimeConfig } from '../domains/model';
import { repairJsonContent } from '@/lib/shared/jsonExtraction';
import { stripInlineReasoning } from '@/lib/shared/inlineReasoning';
import { toGatewayUsage } from '@/lib/services/models/gatewayUsage';
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

/**
 * Canonical gateway usage (input includes cache read/write, output includes
 * reasoning; cache/reasoning counts are subsets), converted with the client's driver.
 */
function extractUsage(response: ChatCompletionResponse, driver: string | undefined): DecisionResult['usage'] {
  const u = response.usage;
  if (!u || (!u.inputTokens && !u.outputTokens)) return undefined;
  const g = toGatewayUsage(driver, u);
  return {
    inputTokens: g.inputTokens ?? 0,
    outputTokens: g.outputTokens ?? 0,
    totalTokens: g.totalTokens ?? 0,
    ...(g.cachedInputTokens ? { cachedInputTokens: g.cachedInputTokens } : {}),
    ...(g.cachedWriteTokens ? { cachedWriteTokens: g.cachedWriteTokens } : {}),
    ...(g.reasoningTokens ? { reasoningTokens: g.reasoningTokens } : {}),
  };
}

function buildMessages(request: DecisionRequest, includeRationale: boolean): UnifiedMessage[] {
  const content: ContentPart[] = [];
  const text = request.input
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
  if (text) content.push({ type: 'text', text: `Input:\n<input>\n${text}\n</input>` });
  for (const part of request.input) {
    if (part.type === 'image') content.push(imageUrlToPart(part.data_url));
  }
  content.push({ type: 'text', text: buildDecisionQuestionsPrompt(request.questions) });
  return [
    { role: 'system', content: buildDecisionSystemPrompt(includeRationale) },
    { role: 'user', content },
  ];
}

export function createStructuredDecisionRuntime(
  runtime: ModelProviderRuntime,
  config: ModelRuntimeConfig,
  provider: string,
): DecisionRuntime {
  return {
    async decide(request, options): Promise<DecisionResult> {
      if (!runtime.createNativeChatClient) {
        throw new DecisionBackendError(`Provider "${provider}" has no chat runtime to serve decisions`);
      }
      const includeRationale = request.includeRationale === true;

      // Temperature 0 where accepted: the client drops it again for the
      // models whose registry rule says they reject it.
      const client = await runtime.createNativeChatClient({
        modelId: config.modelId,
        category: 'llm',
        modelSettings: { ...(config.modelSettings ?? {}), temperature: 0 },
        options: { maxRetries: 0 },
      });
      if (!client || typeof client.complete !== 'function') {
        throw new DecisionBackendError(`Provider "${provider}" returned a chat model that cannot be invoked`);
      }

      const format = buildDecisionResponseFormat(request.questions, includeRationale);
      const response = await client.complete({
        messages: buildMessages(request, includeRationale),
        responseFormat: { type: 'json_schema', name: format.json_schema.name, schema: format.json_schema.schema as Record<string, unknown> },
        ...(options?.signal ? { signal: options.signal } : {}),
      });

      const usage = extractUsage(response, client.driver);
      const backend = { kind: 'structured' as const, provider };

      const refusal = response.providerFields?.refusal;
      if (typeof refusal === 'string' && refusal.trim()) {
        return { ...refuseAll(request.questions), usage, backend };
      }

      const raw = stripInlineReasoning(response.content ?? '').trim();
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
