/**
 * The one definition of "reasoning" for direct (gateway) model calls.
 *
 * Pure on purpose (no server imports): the Model Hub form and the model page
 * import it too, so what the operator sees is what the gateway does.
 *
 * Normalized value: `{ effort?, budgetTokens?, includeThoughts? }`. Unset means
 * "send nothing" — the provider's own default applies.
 *
 * Precedence for a direct call (the UI wins):
 *   Model Hub default (if set)  >  value in the API request (if sent)  >  nothing.
 *
 * Visibility is separate from the request: `settings.returnReasoning === false`
 * hides the reasoning text from callers, and a request can hide it for itself
 * with `include_reasoning: false` but can never re-enable what the Model Hub
 * hid. Hiding never stops token accounting; the upstream still bills the tokens.
 */

import { mapReasoningEffort } from '@cognipeer/agent-sdk/model-rules';
import { EFFORT_BUDGETS, GEMINI_EFFORT_BUDGETS, effortsOfRule, resolveRuleForDriver } from './modelRules';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface NormalizedReasoning {
  effort?: ReasoningEffort;
  budgetTokens?: number;
  includeThoughts?: boolean;
  /** OpenAI reasoning summary mode; legacy field, kept so existing settings round-trip. */
  summary?: 'auto' | 'concise' | 'detailed';
}

export type ReasoningSource = 'model' | 'request' | 'none';

/**
 * In-process only: an AGENT's own reasoning pick, riding on the body of a call a
 * Dynamic LLM routes to a concrete model. The gateway's rule is Model Hub default
 * > request, but an agent's selection outranks the routed model's Model Hub
 * default too (agent > Model Hub > request). A symbol key cannot arrive over HTTP
 * (JSON has none), so a caller cannot claim the top rung; `{...body}` copies it.
 */
export const AGENT_REASONING_OVERRIDE: unique symbol = Symbol.for('cognipeer.agentReasoningOverride') as never;

const EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORTS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * Reads any reasoning shape in circulation: the typed settings value, the
 * legacy `{effort, summary}`, a request's `reasoning: {effort, max_tokens |
 * budget_tokens}` and a bare effort string.
 */
export function normalizeReasoning(value: unknown): NormalizedReasoning | undefined {
  if (typeof value === 'string') {
    const effort = value.trim().toLowerCase();
    return EFFORT_SET.has(effort) ? { effort: effort as ReasoningEffort } : undefined;
  }
  if (!isRecord(value)) return undefined;

  const out: NormalizedReasoning = {};
  if (typeof value.effort === 'string') {
    const effort = value.effort.trim().toLowerCase();
    if (EFFORT_SET.has(effort)) out.effort = effort as ReasoningEffort;
  }
  const budget = positiveInt(
    value.budgetTokens ?? value.budget_tokens ?? value.max_tokens ?? value.maxTokens,
  );
  if (budget !== undefined) out.budgetTokens = budget;

  const include = value.includeThoughts ?? value.include_thoughts;
  if (typeof include === 'boolean') out.includeThoughts = include;

  if (value.summary === 'auto' || value.summary === 'concise' || value.summary === 'detailed') {
    out.summary = value.summary;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The Model Hub default, or undefined when the operator set nothing. */
export function readModelReasoning(settings: unknown): NormalizedReasoning | undefined {
  return isRecord(settings) ? normalizeReasoning(settings.reasoning) : undefined;
}

/**
 * What the API request asked for. `reasoning` (object) wins over the legacy
 * `reasoning_effort` string when both are present; an Anthropic-style
 * `thinking: {type, budget_tokens}` is understood too.
 */
export function readRequestReasoning(body: unknown): NormalizedReasoning | undefined {
  if (!isRecord(body)) return undefined;
  const fromObject = normalizeReasoning(body.reasoning);
  const fromEffort = normalizeReasoning(body.reasoning_effort);
  let merged: NormalizedReasoning | undefined = fromObject || fromEffort
    ? { ...(fromEffort ?? {}), ...(fromObject ?? {}) }
    : undefined;

  if (!merged && isRecord(body.thinking)) {
    if (body.thinking.type === 'disabled') {
      merged = { effort: 'none' };
    } else if (body.thinking.type === 'enabled') {
      const budget = positiveInt(body.thinking.budget_tokens);
      merged = budget ? { budgetTokens: budget } : undefined;
    }
  }
  return merged;
}

export interface ResolvedReasoning {
  reasoning?: NormalizedReasoning;
  source: ReasoningSource;
}

/**
 * Model Hub default > request value > nothing. Whole-value precedence, not a
 * field merge: a model pinned to `high` is not silently downgraded or
 * decorated by a caller's budget.
 */
export function resolveGatewayReasoning(
  modelSettings: unknown,
  body: unknown,
): ResolvedReasoning {
  const fromModel = readModelReasoning(modelSettings);
  if (fromModel) return { reasoning: fromModel, source: 'model' };
  const fromRequest = readRequestReasoning(body);
  if (fromRequest) return { reasoning: fromRequest, source: 'request' };
  return { source: 'none' };
}

/**
 * Whether reasoning text may reach the caller. The Model Hub switch is the
 * ceiling; a request can only narrow it (`include_reasoning: false`, or the
 * OpenRouter-style `reasoning: { exclude: true }`).
 */
export function shouldReturnReasoning(modelSettings: unknown, body?: unknown): boolean {
  if (isRecord(modelSettings) && modelSettings.returnReasoning === false) return false;
  if (isRecord(body)) {
    if (body.include_reasoning === false) return false;
    if (isRecord(body.reasoning) && body.reasoning.exclude === true) return false;
  }
  return true;
}

/**
 * The reasoning a call is sent upstream with, given whether its text will be shown.
 * Hidden: the provider is told not to produce thought text (`includeThoughts: false`),
 * so a Claude model does not spend output tokens summarizing thoughts nobody sees; the
 * thinking itself still runs. Visible: Claude (Anthropic, Bedrock), Vertex Gemini with a
 * thinking budget (it returns thought summaries only when asked) and OpenAI-schema models
 * on the Responses upstream (the only OpenAI API that returns a reasoning summary) are
 * asked for them explicitly unless the Model Hub record already decided.
 *
 * A call with no reasoning at all gets nothing added, except for an adaptive Claude (5.x,
 * 4.6+): it thinks by default and returns the thinking text empty unless a summary is asked
 * for, so a visible call asks even with no effort configured. Only the ask is added: no
 * effort and no output-limit headroom (the model keeps its own default effort).
 * `modelId` is what tells the two Claude generations apart.
 */
export function withReasoningVisibility<T extends { includeThoughts?: boolean }>(
  reasoning: T | undefined,
  visible: boolean,
  driver?: string,
  upstreamApi?: string,
  modelId?: string,
): T | undefined {
  if (!reasoning) {
    return visible && thinksAdaptivelyByDefault(driver, modelId) ? ({ includeThoughts: true } as T) : reasoning;
  }
  if (!visible) return reasoning.includeThoughts === false ? reasoning : { ...reasoning, includeThoughts: false };
  const asksForThoughts = driver === 'anthropic' || driver === 'bedrock' || upstreamApi === 'responses'
    // Gemini sends thought summaries only with `thinkingConfig.includeThoughts`, and only thinks on a budget:
    // effort none (budget 0) or no budget at all leaves nothing to show.
    || (driver === 'vertex' && (reasoningBudget(normalizeReasoning(reasoning)) ?? 0) > 0);
  if (reasoning.includeThoughts === undefined && asksForThoughts) {
    return { ...reasoning, includeThoughts: true };
  }
  return reasoning;
}

/** Claude 4.6+/5.x on the Messages API or Bedrock: thinks adaptively when sent no thinking setting at all. */
function thinksAdaptivelyByDefault(driver: string | undefined, modelId: string | undefined): boolean {
  if (driver !== 'anthropic' && !(driver === 'bedrock' && bedrockCarriesThinking(modelId))) return false;
  return supportsAdaptiveThinking(modelId);
}

// ─── Provider translation (pure; contracts apply the result) ────────────────

/** Anthropic requires budget_tokens >= 1024. */
export const ANTHROPIC_MIN_THINKING_BUDGET = 1024;
/** Room kept for the visible answer above the thinking budget. */
export const THINKING_ANSWER_HEADROOM = 4096;
/** Gemini: output limit above the thinking budget (same rule as the agent-sdk Gemini reasoning mapping). */
export const GEMINI_ANSWER_HEADROOM = 2048;
/**
 * The agent-sdk's own guard rails for budget thinking (`THINKING_OUTPUT_RESERVE` / `THINKING_MIN_MAX_TOKENS` in
 * providers/utils/reasoning.ts; the SDK does not export them): it raises `max_tokens` to at least
 * `max(SDK_THINKING_MIN_MAX_TOKENS, budget + SDK_THINKING_OUTPUT_RESERVE)` itself. A call whose limit is fixed
 * (a caller's cap) must be handed a budget that already fits, or the SDK silently raises the cap.
 */
export const SDK_THINKING_OUTPUT_RESERVE = 1024;
export const SDK_THINKING_MIN_MAX_TOKENS = 4096;

const EFFORT_BUDGET = EFFORT_BUDGETS;
/** Vertex Gemini thinks up to this many tokens; xhigh / max map to the largest budget. */
const VERTEX_MAX_THINKING_BUDGET = GEMINI_EFFORT_BUDGETS.max;

/**
 * Drivers whose wire format is OpenAI Chat Completions / Responses. Their SDK providers read the reasoning
 * EFFORT only (there is no token-budget field), and reasoning tokens count against `max_(completion_)tokens`.
 */
export const OPENAI_SCHEMA_DRIVERS: ReadonlySet<string> = new Set(['openai', 'openai-compatible', 'azure', 'together']);

/**
 * Bedrock extended thinking is a Claude feature; the other Converse families (Nova, Llama, gpt-oss ...) carry their own
 * reasoning envelope, so the client leaves reasoning off their wire. Decided by name: an ARN (an application inference
 * profile hides its model) can only be told when it spells the model out.
 */
export function bedrockCarriesThinking(modelId: string | undefined): boolean {
  return /anthropic|claude/i.test(modelId ?? '');
}

/**
 * The effort a token budget stands for, with the thresholds the agent-sdk uses for adaptive Claude (`applyAdaptiveThinking`):
 * up to the `low` budget is low, up to the `medium` budget is medium, anything above is high.
 */
export function effortForBudget(budget: number): 'low' | 'medium' | 'high' {
  return budget <= EFFORT_BUDGET.low ? 'low' : budget <= EFFORT_BUDGET.medium ? 'medium' : 'high';
}

/**
 * The budget to hand the SDK under a limit that cannot move, so that it never raises it, or undefined when no budget fits
 * (the call then runs without thinking). The SDK needs `max_tokens` >= its own floor and >= budget + its reserve; the budget
 * is shrunk to what fits and never goes under Anthropic's minimum.
 */
export function fitThinkingBudget(budget: number, limit: number): number | undefined {
  const room = limit - SDK_THINKING_OUTPUT_RESERVE;
  if (limit < SDK_THINKING_MIN_MAX_TOKENS || room < ANTHROPIC_MIN_THINKING_BUDGET) return undefined;
  return Math.min(Math.max(budget, ANTHROPIC_MIN_THINKING_BUDGET), room);
}

/** Effort -> token budget for engines that think in tokens. 0 = thinking off. */
export function reasoningBudget(reasoning: NormalizedReasoning | undefined): number | undefined {
  if (!reasoning) return undefined;
  if (reasoning.effort === 'none') return 0;
  if (reasoning.budgetTokens) return reasoning.budgetTokens;
  return reasoning.effort ? EFFORT_BUDGET[reasoning.effort] : undefined;
}

export interface ThinkingTranslation {
  /** Body fragment, in Anthropic's wire shape. */
  thinking: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' } | { type: 'disabled' };
  /** `output_config` fragment: adaptive thinking carries its level here. */
  outputConfig?: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  /** max_tokens to send: budget + THINKING_ANSWER_HEADROOM at least when budget thinking is on. */
  maxTokens?: number;
  /** Thinking forbids temperature / top_p. */
  dropSampling: boolean;
}

/**
 * Whether the model takes `thinking: {type:'adaptive'}` + `output_config.effort` (Claude 4.6+, 5.x, fable)
 * instead of `enabled` + `budget_tokens` - the style of its rule in the SDK table.
 */
export function supportsAdaptiveThinking(modelId: string | undefined): boolean {
  return resolveRuleForDriver('anthropic', modelId)?.reasoning.style === 'adaptive';
}

/**
 * Anthropic (and Bedrock-Claude) extended thinking. `undefined` = send nothing.
 * An explicit `thinking` in the operator's extra body is the caller's job to
 * respect (see `hasExplicitThinking`).
 *
 * `maxTokens` is the budget-style floor only; the adaptive effort headroom (ADAPTIVE_MIN_OUTPUT_TOKENS) and
 * the model-maximum cap are applied by `computeOutputTokenLimit` (outputLimits.ts), the one place the sent
 * limit is decided.
 */
export function translateAnthropicThinking(
  reasoning: NormalizedReasoning | undefined,
  currentMaxTokens: number | undefined,
  modelId?: string,
): ThinkingTranslation | undefined {
  const budget = reasoningBudget(reasoning);
  if (budget === undefined) return undefined;
  if (budget === 0) {
    // `none` on an adaptive model is not "no thinking setting": the SDK sends the rule's off switch
    // (`thinking: {type: rule.off}` - between_tools on Sonnet 5.x, disabled on Haiku 5.5 / 4.6 / 4.7) or, for a model whose
    // rule has none (Opus 5, Fable), its lowest effort. Either way there is no effort to size a limit for, so nothing is
    // translated and the limit gets no thinking headroom. A budget-style model takes `disabled`.
    return supportsAdaptiveThinking(modelId)
      ? undefined
      : { thinking: { type: 'disabled' }, maxTokens: currentMaxTokens, dropSampling: false };
  }
  if (supportsAdaptiveThinking(modelId)) {
    const asked: ReasoningEffort = reasoning?.effort ?? effortForBudget(budget);
    // The model's rule decides what it takes (4.6 tops out at max, 4.7+ adds xhigh; 'minimal' is not offered).
    const rule = resolveRuleForDriver('anthropic', modelId);
    const mapped = rule ? mapReasoningEffort(rule, asked).effort : undefined;
    const effort = (mapped ?? (asked === 'minimal' ? 'low' : asked)) as Exclude<ReasoningEffort, 'none' | 'minimal'>;
    return { thinking: { type: 'adaptive' }, outputConfig: { effort }, maxTokens: currentMaxTokens, dropSampling: true };
  }

  const budgetTokens = Math.max(budget, ANTHROPIC_MIN_THINKING_BUDGET);
  const floor = budgetTokens + THINKING_ANSWER_HEADROOM;
  // A limit only above the budget leaves the answer less than the headroom (cap 20000, budget 16384: 3616): it is kept
  // only when it already holds budget + headroom.
  const maxTokens = currentMaxTokens !== undefined && currentMaxTokens >= floor
    ? currentMaxTokens
    : floor;
  return {
    thinking: { type: 'enabled', budget_tokens: budgetTokens },
    maxTokens,
    dropSampling: true,
  };
}

export function hasExplicitThinking(extraBody: unknown): boolean {
  return isRecord(extraBody) && extraBody.thinking !== undefined;
}

export interface VertexThinkingTranslation {
  thinkingConfig: { thinkingBudget: number; includeThoughts: boolean };
}

/** Vertex Gemini `thinkingConfig`. Budget 0 turns thinking off. */
export function translateVertexThinking(
  reasoning: NormalizedReasoning | undefined,
): VertexThinkingTranslation | undefined {
  const budget = reasoningBudget(reasoning);
  if (budget === undefined) return undefined;
  return {
    thinkingConfig: {
      thinkingBudget: Math.min(budget, VERTEX_MAX_THINKING_BUDGET),
      includeThoughts: budget === 0 ? false : (reasoning?.includeThoughts ?? true),
    },
  };
}

// ─── What the operator may pick, per driver (UI + validation) ──────────────

export type ReasoningControlKind = 'effort' | 'budget' | 'toggle' | 'none';

export interface ReasoningControl {
  kind: ReasoningControlKind;
  /** Effort values offered (kind 'effort'; also the shortcuts of 'budget'). */
  efforts: ReasoningEffort[];
  /** Whether a numeric token budget can be entered. */
  budget: boolean;
  /** Whether "include thoughts" is meaningful. */
  includeThoughts: boolean;
}

/**
 * Which knobs a model understands, from its rule in the agent-sdk table (see modelRules.ts):
 * exactly the rule's efforts (+ Off when the rule can turn reasoning off). A model that only
 * matched a family's permissive default is offered the whole ladder - the SDK maps at request time.
 * Budget-style engines (older Claude, Gemini) also take a token budget.
 *
 * A Bedrock model that is not Claude (Nova, Llama, gpt-oss ...) has no control: the client leaves reasoning off its
 * wire, so a setting offered here would be silently dropped. That is decided by the id, so it needs `modelId`; an ARN
 * (an application inference profile hides its model) and a missing id keep the control, as the id cannot tell.
 */
export function reasoningControlForDriver(driver: string | undefined, modelId?: string): ReasoningControl {
  const noControl = (): ReasoningControl => ({ kind: 'none', efforts: [], budget: false, includeThoughts: false });
  const id = modelId?.trim();
  if (driver === 'bedrock' && id && !/^arn:/i.test(id) && !bedrockCarriesThinking(id)) return noControl();
  const rule = resolveRuleForDriver(driver, modelId);
  if (!rule) return noControl();
  const efforts = effortsOfRule(rule);
  const { style } = rule.reasoning;
  if (style === 'none' || efforts.length === 0) return noControl();
  // Vertex Gemini sends thought summaries only when asked (`thinkingConfig.includeThoughts`): its form offers the
  // "show thoughts" switch. The Claude drivers have none: a visible call asks by itself (withReasoningVisibility).
  // Adaptive thinking has no token budget.
  if (style === 'budget') return { kind: 'budget', efforts, budget: true, includeThoughts: driver === 'vertex' };
  if (style === 'adaptive') return { kind: 'budget', efforts, budget: false, includeThoughts: false };
  if (style === 'toggle') return { kind: 'toggle', efforts, budget: false, includeThoughts: false };
  return { kind: 'effort', efforts, budget: false, includeThoughts: false };
}

/**
 * The effective setting as the model page states it. `forcedNoneWithTools` is
 * the GPT-5 rule: with tools in the request the upstream refuses any effort but
 * 'none', so the gateway forces it regardless of what is configured here.
 */
export function describeEffectiveReasoning(input: {
  settings: unknown;
  forcedNoneWithTools?: boolean;
}): {
  reasoning?: NormalizedReasoning;
  returned: boolean;
  forcedNoneWithTools: boolean;
} {
  return {
    reasoning: readModelReasoning(input.settings),
    returned: shouldReturnReasoning(input.settings),
    forcedNoneWithTools: input.forcedNoneWithTools === true,
  };
}
