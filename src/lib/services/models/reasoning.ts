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

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
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
 * thinking itself still runs. Visible: Claude (Anthropic, Bedrock) is asked for them
 * explicitly unless the Model Hub record already decided. Nothing is added when the
 * call has no reasoning at all.
 */
export function withReasoningVisibility<T extends { includeThoughts?: boolean }>(
  reasoning: T | undefined,
  visible: boolean,
  driver?: string,
): T | undefined {
  if (!reasoning) return reasoning;
  if (!visible) return reasoning.includeThoughts === false ? reasoning : { ...reasoning, includeThoughts: false };
  if (reasoning.includeThoughts === undefined && (driver === 'anthropic' || driver === 'bedrock')) {
    return { ...reasoning, includeThoughts: true };
  }
  return reasoning;
}

// ─── Provider translation (pure; contracts apply the result) ────────────────

/** Anthropic requires budget_tokens >= 1024. */
export const ANTHROPIC_MIN_THINKING_BUDGET = 1024;
/** Room kept for the visible answer above the thinking budget. */
export const THINKING_ANSWER_HEADROOM = 4096;

const EFFORT_BUDGET: Record<Exclude<ReasoningEffort, 'none'>, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
};

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
  outputConfig?: { effort: 'low' | 'medium' | 'high' };
  /** max_tokens to send: always above the budget when thinking is on. */
  maxTokens?: number;
  /** Thinking forbids temperature / top_p. */
  dropSampling: boolean;
}

/**
 * Claude 5.x and fable models take `thinking: {type:'adaptive'}` + `output_config.effort`;
 * older ones take `enabled` + `budget_tokens`. Mirrors the SDK's `supportsAdaptiveThinking`:
 * this module is bundled into the Model Hub form, so it cannot import the SDK.
 * reasoning-adaptive-parity.test.ts keeps the two in step.
 */
export function supportsAdaptiveThinking(modelId: string | undefined): boolean {
  if (typeof modelId !== 'string') return false;
  const id = modelId.toLowerCase();
  const at = id.indexOf('claude-');
  if (at < 0) return false;
  for (const tok of id.slice(at + 7).split('-')) {
    if (tok === 'fable') return true;
    if (/^\d{1,2}$/.test(tok)) return Number(tok) >= 5;
    if (/^\d+$/.test(tok)) return false;
  }
  return false;
}

/**
 * Anthropic (and Bedrock-Claude) extended thinking. `undefined` = send nothing.
 * An explicit `thinking` in the operator's extra body is the caller's job to
 * respect (see `hasExplicitThinking`).
 */
export function translateAnthropicThinking(
  reasoning: NormalizedReasoning | undefined,
  currentMaxTokens: number | undefined,
  modelId?: string,
): ThinkingTranslation | undefined {
  const budget = reasoningBudget(reasoning);
  if (budget === undefined) return undefined;
  if (budget === 0) {
    // `none` on an adaptive model sends no thinking at all (the SDK does the same).
    return supportsAdaptiveThinking(modelId)
      ? undefined
      : { thinking: { type: 'disabled' }, maxTokens: currentMaxTokens, dropSampling: false };
  }
  if (supportsAdaptiveThinking(modelId)) {
    const effort = reasoning?.effort
      ? (reasoning.effort === 'minimal' ? 'low' : reasoning.effort as 'low' | 'medium' | 'high')
      : budget <= EFFORT_BUDGET.low ? 'low' : budget <= EFFORT_BUDGET.medium ? 'medium' : 'high';
    return { thinking: { type: 'adaptive' }, outputConfig: { effort }, maxTokens: currentMaxTokens, dropSampling: true };
  }

  const budgetTokens = Math.max(budget, ANTHROPIC_MIN_THINKING_BUDGET);
  const floor = budgetTokens + THINKING_ANSWER_HEADROOM;
  const maxTokens = currentMaxTokens !== undefined && currentMaxTokens > budgetTokens
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
      thinkingBudget: budget,
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
 * Which knobs a driver understands. OpenAI-family takes effort levels;
 * Anthropic / Bedrock / Vertex think in token budgets (levels are shortcuts);
 * OpenAI-compatible engines only have on/off.
 */
export function reasoningControlForDriver(driver: string | undefined): ReasoningControl {
  switch (driver) {
    case 'openai':
    case 'azure':
      return { kind: 'effort', efforts: ['none', 'minimal', 'low', 'medium', 'high'], budget: false, includeThoughts: false };
    case 'anthropic':
    case 'bedrock':
      return { kind: 'budget', efforts: ['none', 'low', 'medium', 'high'], budget: true, includeThoughts: false };
    case 'vertex':
      // The Vertex client derives includeThoughts from the budget itself (on
      // whenever the budget is above 0), so there is no separate switch to offer.
      return { kind: 'budget', efforts: ['none', 'low', 'medium', 'high'], budget: true, includeThoughts: false };
    case 'openai-compatible':
    case 'together':
      return { kind: 'toggle', efforts: ['none', 'medium'], budget: false, includeThoughts: false };
    default:
      return { kind: 'none', efforts: [], budget: false, includeThoughts: false };
  }
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
