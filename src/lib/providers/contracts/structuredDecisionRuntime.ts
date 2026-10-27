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
import type { IModel } from '@/lib/database';
import { raisedSideCallLimit, sideCallReasoning } from '@/lib/services/agents/agentReasoning';
import { modelMaxOutputTokens } from '@/lib/services/models/outputLimits';
import { resolveNativeMaxTokens } from './nativeClients';
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
  /** What the call(s) that produced no usable answer billed, when the provider reported it. */
  readonly usage?: DecisionResult['usage'];

  constructor(message: string, usage?: DecisionResult['usage']) {
    super(message);
    this.name = 'DecisionBackendError';
    if (usage) this.usage = usage;
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

/** Two calls' usage added up: a call that was retried billed both. */
function addUsage(a: DecisionResult['usage'], b: DecisionResult['usage']): DecisionResult['usage'] {
  if (!a || !b) return a ?? b;
  const sum = (x?: number, y?: number) => (x ?? 0) + (y ?? 0);
  const cachedInputTokens = sum(a.cachedInputTokens, b.cachedInputTokens);
  const cachedWriteTokens = sum(a.cachedWriteTokens, b.cachedWriteTokens);
  const reasoningTokens = sum(a.reasoningTokens, b.reasoningTokens);
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
    ...(cachedInputTokens ? { cachedInputTokens } : {}),
    ...(cachedWriteTokens ? { cachedWriteTokens } : {}),
    ...(reasoningTokens ? { reasoningTokens } : {}),
  };
}

function positiveSetting(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
      const messages = buildMessages(request, includeRationale);
      // The answer shares the output limit with the thinking: ask for the lowest thinking the model allows.
      const reasoning = sideCallReasoning({ modelId: config.modelId, providerDriver: provider, settings: config.modelSettings });
      const complete = (maxTokens?: number) => client.complete({
        messages,
        responseFormat: { type: 'json_schema', name: format.json_schema.name, schema: format.json_schema.schema as Record<string, unknown> },
        ...(reasoning ? { reasoning } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });

      let response = await complete();
      let usage = extractUsage(response, client.driver);

      if (response.finishReason === 'length') {
        // A cut-off document is no answer. This call sends no limit of its own, so the one it ran with is what the
        // client resolved: the model's "Default max tokens", raised for thinking where that applies (an OpenAI
        // reasoning model at 'minimal' runs at 4096 even when 1000 is configured), or the driver default. The retry
        // doubles THAT, so it is never below the first call (stopping at the model maximum).
        const settings = (config.modelSettings ?? {}) as Record<string, unknown>;
        const modelMax = modelMaxOutputTokens({ modelId: config.modelId, settings } as IModel);
        const sent = resolveNativeMaxTokens({
          driver: client.driver ?? provider,
          modelId: config.modelId,
          overrides: {
            maxCompletionTokens: positiveSetting(settings.maxCompletionTokens),
            maxTokens: positiveSetting(settings.maxTokens),
            extraBody: { ...asRecord(settings.requestDefaults), ...asRecord(settings.extraBody) },
          },
          reasoning: reasoning ?? settings.reasoning,
          stream: false,
          modelMax,
        });
        const raised = sent !== undefined ? raisedSideCallLimit(sent, modelMax) : undefined;
        if (raised !== undefined) {
          response = await complete(raised);
          usage = addUsage(usage, extractUsage(response, client.driver));
        }
        if (response.finishReason === 'length') {
          const limit = raised ?? sent;
          throw new DecisionBackendError(
            `The model reached its output token limit${limit ? ` (${limit} tokens)` : ''} before it finished the decision answer`
            + `${raised !== undefined ? ', also after one retry with a larger limit' : ''}. `
            + 'Raise the model\'s "Default max tokens" setting.',
            usage,
          );
        }
      }

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
