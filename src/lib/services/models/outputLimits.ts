/**
 * Output token limits: what a call's `max_tokens` is, in ONE place.
 *
 * Pure on purpose (no server imports). The gateway resolver
 * (`resolveOutputTokenLimit`, gatewayRequest.ts) and the native client
 * (`buildNativeOptions` / `prepare`, nativeClients.ts) both go through
 * `computeOutputTokenLimit`, so the number the gateway reports on an
 * `OutputTokenLimitError` or an `output_limit` event is the number the provider
 * was sent - they cannot drift.
 *
 * Precedence: the caller's value (the request's or a retry's) > the model's
 * `maxCompletionTokens` > `maxTokens` > the driver default, then the thinking
 * headroom, then capped by the model maximum when the value is a default or a
 * bump (an explicit value is never lowered). The caller's value is a hard cap:
 * thinking never raises it (a budget is fitted to it instead, `fitThinkingToLimit`).
 */

import { mapReasoningEffort } from '@cognipeer/agent-sdk/model-rules';
import type { IModel } from '@/lib/database';
import { modelIdCandidates, resolveRuleForDriver } from './modelRules';
import {
  GEMINI_ANSWER_HEADROOM,
  OPENAI_SCHEMA_DRIVERS,
  bedrockCarriesThinking,
  effortForBudget,
  fitThinkingBudget,
  normalizeReasoning,
  translateAnthropicThinking,
  translateVertexThinking,
  type NormalizedReasoning,
  type ReasoningEffort,
} from './reasoning';

/**
 * Minimum output limit of an adaptive-thinking Claude, per effort: thinking
 * tokens count toward `max_tokens`, so a high effort with a small limit ends the turn inside the
 * thinking block. Same table as the agent-sdk model rules (`adaptiveMaxTokens`), so the console and
 * the SDK ask the provider for the same number.
 */
export const ADAPTIVE_MIN_OUTPUT_TOKENS: Record<'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', number> = {
  minimal: 4096,
  low: 8192,
  medium: 16384,
  high: 32768,
  xhigh: 64000,
  max: 64000,
};

/**
 * The official Anthropic SDKs refuse a NON-streaming request whose `max_tokens` could take longer than
 * their time budget (above this value). A default for a non-streaming call never goes above it; an
 * explicit value is the caller's to size.
 */
export const NON_STREAM_DEFAULT_CAP = 21333;

/** `max_tokens` of an anthropic call whose model maximum is unknown and nothing is configured (legacy floor). */
export const ANTHROPIC_FALLBACK_OUTPUT_TOKENS = 8192;

// ─── Model maximum ──────────────────────────────────────────────────────────

/**
 * Maximum output tokens by Claude generation. Matched against the model id with its gateway prefix
 * stripped (`us.anthropic.claude-sonnet-5-5-v1:0` -> `claude-sonnet-5-5-v1:0`), anywhere in the id and
 * not only at its start, so a Foundry deployment name (`claude-sonnet-5-5-2`, `prod-claude-opus-5-1`)
 * resolves too. The digit lookahead keeps `4-5` from matching `4-50`.
 *
 * Claude 4.6+/5.x: 128000. The 4.5 family: 64000. Anything else (3.x, 4.0/4.1, other vendors): unknown.
 */
const CLAUDE = '(?<![a-z0-9])claude-';
const BUILT_IN_MAX_OUTPUT: ReadonlyArray<readonly [RegExp, number]> = [
  [new RegExp(`${CLAUDE}(?:fable|mythos)`), 128000],
  [new RegExp(`${CLAUDE}(?:(?:opus|sonnet|haiku)-5|5(?:-\\d+)?-(?:opus|sonnet|haiku))(?!\\d)`), 128000],
  [new RegExp(`${CLAUDE}(?:(?:opus|sonnet)-4[-.][678]|4[-.][678]-(?:opus|sonnet))(?!\\d)`), 128000],
  [new RegExp(`${CLAUDE}(?:(?:opus|sonnet|haiku)-4[-.]5|4[-.]5-(?:opus|sonnet|haiku))(?!\\d)`), 64000],
];

function positiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

/** The built-in table by model id; undefined for an id it does not know. */
export function builtInMaxOutputTokens(modelId: string | undefined | null): number | undefined {
  if (!modelId) return undefined;
  for (const candidate of modelIdCandidates(modelId)) {
    for (const [pattern, max] of BUILT_IN_MAX_OUTPUT) {
      if (pattern.test(candidate)) return max;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The most a model can produce in one answer: what the operator declared for it (Model Hub
 * `capabilities.maxOutputTokens`, stored in `metadata.capabilities`), else the built-in table by
 * model id, else unknown.
 *
 * Deliberately NOT `settings.maxTokens`: that is the DEFAULT per-request limit an operator picked for
 * convenience, not what the model can do - reading it as a maximum would cap defaults and the raised
 * retry at it.
 */
export function modelMaxOutputTokens(model: IModel | undefined | null): number | undefined {
  if (!model) return undefined;
  const metadata = isRecord(model.metadata) ? model.metadata : {};
  const settings = isRecord(model.settings) ? model.settings : {};
  const capabilities = isRecord(metadata.capabilities) ? metadata.capabilities : {};
  const declared = positiveInteger(
    capabilities.maxOutputTokens,
    metadata.maxOutputTokens,
    metadata.max_output_tokens,
    settings.maxOutputTokens,
    settings.max_output_tokens,
  );
  return declared ?? builtInMaxOutputTokens(model.modelId);
}

// ─── The limit ──────────────────────────────────────────────────────────────

export interface OutputLimitInput {
  driver?: string;
  modelId?: string;
  /** The model record: its declared maximum beats the built-in table. */
  model?: IModel | null;
  /** The model maximum when the caller already has it (skips the lookup). */
  modelMax?: number;
  /**
   * The caller's own limit for this call (the request's `max_tokens` or a retry's raised value). It beats
   * `configured` and is a hard cap: thinking is never given room above it, so it is never raised for it.
   * Adaptive thinking fits itself into it; a thinking budget is fitted under it (`fitThinkingToLimit`).
   */
  override?: number;
  /**
   * The model's own value: its `maxCompletionTokens`, then `maxTokens` ("Default max tokens").
   * Undefined = nothing configured.
   */
  configured?: number;
  /** A streaming call. Anything else is non-streaming and its default is capped. */
  stream?: boolean;
  /** What thinking is derived from; any reasoning shape in circulation. */
  reasoning?: unknown;
  /** The operator put a `thinking` block in the extra body: that is the whole instruction, nothing is added. */
  explicitThinking?: boolean;
}

/**
 * The `max_tokens` a call is sent with, or undefined when none is sent (the provider's own maximum then applies).
 *
 *  - anthropic requires one: the model maximum (else 8192) when nothing is configured, a default for a
 *    non-streaming call never above NON_STREAM_DEFAULT_CAP. Other drivers send none by default.
 *  - Claude thinking (anthropic, bedrock-Claude) shares the limit with the answer. Adaptive thinking:
 *    at least ADAPTIVE_MIN_OUTPUT_TOKENS[effort]; budget thinking: budget + the answer headroom at least.
 *    Neither ever raises the caller's own limit.
 *  - An OpenAI-schema reasoning model (reasoning tokens count against `max_(completion_)tokens`) with an
 *    effort configured and a limit set: at least ADAPTIVE_MIN_OUTPUT_TOKENS[effort]. Not the caller's own.
 *  - Vertex Gemini with a thinking budget and a limit set: at least budget + GEMINI_ANSWER_HEADROOM.
 *  - A default or a raise stops at the model maximum; an explicit value above it stays.
 */
export function computeOutputTokenLimit(input: OutputLimitInput): number | undefined {
  const driver = input.driver ?? input.model?.providerDriver;
  const modelId = input.modelId ?? input.model?.modelId;
  const modelMax = positiveInteger(input.modelMax)
    ?? (input.model ? modelMaxOutputTokens(input.model) : builtInMaxOutputTokens(modelId));
  const override = positiveInteger(input.override);
  const explicit = override ?? positiveInteger(input.configured);

  let limit = explicit;
  if (limit === undefined && driver === 'anthropic') {
    // The Messages API refuses a request without max_tokens; the model can write as much as it can.
    limit = modelMax ?? ANTHROPIC_FALLBACK_OUTPUT_TOKENS;
    if (input.stream !== true) limit = Math.min(limit, NON_STREAM_DEFAULT_CAP);
  }

  const raised = raisedForThinking(input, driver, modelId, limit, override !== undefined);
  if (raised !== undefined && (limit === undefined || raised > limit)) {
    // The model maximum caps what we add; it never lowers what was already there.
    limit = Math.max(limit ?? 0, modelMax !== undefined ? Math.min(raised, modelMax) : raised);
  }
  return limit;
}

/** The limit thinking needs, or undefined when it needs nothing (or there is no limit to raise). */
function raisedForThinking(
  input: OutputLimitInput,
  driver: string | undefined,
  modelId: string | undefined,
  limit: number | undefined,
  callerCapped: boolean,
): number | undefined {
  const reasoning: NormalizedReasoning | undefined = normalizeReasoning(input.reasoning);
  if (!reasoning) return undefined;

  if (driver === 'anthropic' || driver === 'bedrock') {
    // Extended thinking on Bedrock is a Claude feature; the other Converse families carry their own envelope.
    if (driver === 'bedrock' && !bedrockCarriesThinking(modelId)) return undefined;
    if (input.explicitThinking) return undefined;
    const thinking = translateAnthropicThinking(reasoning, limit, modelId);
    if (thinking?.thinking.type === 'adaptive') {
      // Bedrock with no limit set stays unset: Converse then takes the model maximum. A caller's own
      // limit stays as it is: adaptive thinking fits itself into it.
      if (limit === undefined || callerCapped) return undefined;
      const effort = thinking.outputConfig?.effort;
      return effort ? Math.max(limit, ADAPTIVE_MIN_OUTPUT_TOKENS[effort]) : undefined;
    }
    // A caller's own limit stays as it is for a budget too: the budget is fitted under it instead
    // (`fitThinkingToLimit`), or the call runs without thinking when nothing fits.
    if (thinking?.thinking.type === 'enabled') return callerCapped ? undefined : thinking.maxTokens;
    return undefined;
  }

  if (driver !== undefined && OPENAI_SCHEMA_DRIVERS.has(driver)) {
    // Reasoning tokens count against the limit here too. Only a limit the model's record set is raised:
    // a caller's is a hard cap, and none set means the provider's own maximum applies.
    if (limit === undefined || callerCapped) return undefined;
    const effort = openAiReasoningEffort(driver, modelId, reasoning);
    return effort ? Math.max(limit, ADAPTIVE_MIN_OUTPUT_TOKENS[effort]) : undefined;
  }

  if (driver === 'vertex') {
    // A caller's cap is not raised here: the budget is fitted under it instead (`fitThinkingToLimit`). The one
    // exception is Pro, where thinking cannot be off: a cap below its minimum budget (128) + GEMINI_ANSWER_HEADROOM
    // cannot be honoured, and the SDK sends that sum (2176).
    if (limit === undefined || callerCapped) return undefined;
    const budget = translateVertexThinking(reasoning)?.thinkingConfig.thinkingBudget;
    if (budget === undefined || budget <= 0) return undefined;
    return Math.max(limit, budget + GEMINI_ANSWER_HEADROOM);
  }
  return undefined;
}

/**
 * The effort an OpenAI-schema reasoning model runs at, to size its limit for; undefined = nothing to size for.
 * Only a configured effort counts (a token budget counts as the effort it stands for: that is what the client
 * sends, `effortForBudget`); `none` thinks nothing. Only a model its SDK rule knows to reason is sized: an id only
 * the family's permissive default matched (a vanity deployment, a self-hosted model) is left as the operator set it.
 * The rule maps the effort to the nearest one the model takes, like the SDK does on the wire.
 */
function openAiReasoningEffort(
  driver: string,
  modelId: string | undefined,
  reasoning: NormalizedReasoning,
): Exclude<ReasoningEffort, 'none'> | undefined {
  const asked = reasoning.effort ?? (reasoning.budgetTokens ? effortForBudget(reasoning.budgetTokens) : undefined);
  if (!asked || asked === 'none') return undefined;
  const rule = resolveRuleForDriver(driver, modelId);
  if (!rule || rule.isDefault || rule.reasoning.style !== 'effort') return undefined;
  const effort = mapReasoningEffort(rule, asked).effort;
  return effort && effort !== 'none' ? effort : undefined;
}

/**
 * The reasoning a call is handed to the SDK with, given the limit it is sent with.
 *
 * The SDK raises `max_tokens` itself when it is below a thinking budget + its own reserve (or below its own floor).
 * For a limit that cannot move - a caller's cap, the model maximum - that would be a silent raise. So budget-style
 * Claude thinking (anthropic, bedrock-Claude) is fitted to the limit: the budget is shrunk to what fits under it, or,
 * when the limit leaves no room for the smallest budget, the call runs without thinking (undefined). Everything else
 * (adaptive thinking, other drivers, a budget that already fits, an operator's own thinking block) comes back as given.
 *
 * Vertex Gemini likewise: the SDK raises `maxOutputTokens` when it is below budget + GEMINI_ANSWER_HEADROOM, so a numeric
 * budget is shrunk to `limit - GEMINI_ANSWER_HEADROOM`; under the model's minimum (0 on Flash = thinking off, 128 on Pro)
 * the minimum is sent. Dynamic (-1), levels and no-thinking are left alone.
 * On Pro (thinking cannot be off) a cap below minimum budget + GEMINI_ANSWER_HEADROOM (128 + 2048 = 2176) therefore
 * cannot be honoured: the SDK sends 2176.
 */
export function fitThinkingToLimit<T extends NormalizedReasoning>(
  reasoning: T | undefined,
  input: { driver?: string; modelId?: string; limit?: number; explicitThinking?: boolean },
): T | undefined {
  const { driver, modelId, limit } = input;
  if (!reasoning || limit === undefined) return reasoning;
  if (driver === 'vertex') return fitVertexThinking(reasoning, modelId, limit);
  if (driver !== 'anthropic' && driver !== 'bedrock') return reasoning;
  if (driver === 'bedrock' && !bedrockCarriesThinking(modelId)) return reasoning;
  if (input.explicitThinking) return reasoning;
  const thinking = translateAnthropicThinking(reasoning, limit, modelId);
  if (thinking?.thinking.type !== 'enabled') return reasoning;
  const fitted = fitThinkingBudget(thinking.thinking.budget_tokens, limit);
  if (fitted === undefined) return undefined;
  return fitted === thinking.thinking.budget_tokens ? reasoning : { ...reasoning, budgetTokens: fitted };
}

/** Smallest thinking budget a Gemini model takes: Pro cannot turn thinking off (128), Flash can (0). */
function minGeminiBudget(modelId: string | undefined): number {
  return /pro/i.test(modelId ?? '') ? 128 : 0;
}

function fitVertexThinking<T extends NormalizedReasoning>(reasoning: T, modelId: string | undefined, limit: number): T {
  const budget = translateVertexThinking(reasoning)?.thinkingConfig.thinkingBudget;
  if (budget === undefined || budget <= 0 || limit >= budget + GEMINI_ANSWER_HEADROOM) return reasoning;
  const fitted = Math.max(limit - GEMINI_ANSWER_HEADROOM, minGeminiBudget(modelId));
  // 0 means off, and a falsy `budgetTokens` would fall back to the effort's budget: say it as the effort.
  if (fitted <= 0) return { ...reasoning, effort: 'none', budgetTokens: undefined };
  return { ...reasoning, budgetTokens: fitted };
}
