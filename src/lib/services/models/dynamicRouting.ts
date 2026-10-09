/**
 * Dynamic LLM routing engine (pure logic — no I/O).
 *
 * A "Dynamic LLM" is a virtual model whose config lives under
 * `model.settings.dynamic`. At call time the inference layer resolves it to a
 * concrete child model either by evaluating ordered rules against signals
 * derived from the request (rule-based) or by asking a decider model to
 * classify the request (model-based). This module owns the deterministic
 * parts: reading the config, computing signals, evaluating rules, and building
 * / parsing the decider classification. The actual model invocation and
 * logging live in `inferenceService`.
 */

import crypto from 'node:crypto';
import vm from 'node:vm';
import type {
  DynamicPoolPolicy,
  IDynamicComplexityConfig,
  IDynamicDeciderConfig,
  IDynamicDeciderLabel,
  IDynamicPoolEstimate,
  IDynamicRoutingCondition,
  IDynamicRoutingConfig,
  IDynamicRoutingGuards,
  IDynamicRoutingRule,
  IDynamicRoutingTarget,
  IModel,
  IModelPricing,
} from '@/lib/database';
import type {
  DecisionAnswer,
  DecisionChoiceQuestion,
  DecisionScoreQuestion,
} from '@/lib/providers';
import type { ResolvedModelCapabilities } from './modelCapabilities';
import { createLogger } from '@/lib/core/logger';
import { stripInlineReasoning } from '@/lib/shared/inlineReasoning';

const logger = createLogger('dynamic-routing');

/** Hard cap on router→model→router chaining to prevent runaway recursion. */
export const MAX_ROUTING_DEPTH = 3;

export interface RoutingSignals {
  inputTokensEst: number;
  messageCount: number;
  lastUserLength: number;
  hasTools: boolean;
  hasResponseFormat: boolean;
  hasImages: boolean;
  /** Realized spend of this conversation through the router so far. Lazy. */
  conversationCostUsd?: number;
  /** Share of `guards.budget.limitUsd` spent in its window. Lazy. */
  budgetUsedPct?: number;
  /** Output tokens predicted from the router's history. Lazy. */
  predictedOutputTokens?: number;
  /** Predicted output / input token ratio. Lazy. */
  ioRatio?: number;
  /** Caller's `max_tokens` / `max_completion_tokens`, when set. */
  maxOutputTokens?: number;
  /** Expected level index from the router's `complexity` decision model. Lazy. */
  complexityScore?: number;
  /** Latest user message text — used for keyword conditions and decider input. */
  lastUserText: string;
}

/** The subset of signals safe to persist on the usage log (excludes raw text). */
export function publicSignals(signals: RoutingSignals): Record<string, unknown> {
  return {
    inputTokensEst: signals.inputTokensEst,
    messageCount: signals.messageCount,
    lastUserLength: signals.lastUserLength,
    hasTools: signals.hasTools,
    hasResponseFormat: signals.hasResponseFormat,
    hasImages: signals.hasImages,
    ...(signals.maxOutputTokens !== undefined ? { maxOutputTokens: signals.maxOutputTokens } : {}),
    ...Object.fromEntries(
      LAZY_NUMERIC_SIGNALS.filter((key) => signals[key] !== undefined).map((key) => [
        key,
        signals[key],
      ]),
    ),
  };
}

/** Numeric signals that need a lookup (pricing, history, counters) and are
 *  therefore only computed when a rule references them. */
export const LAZY_NUMERIC_SIGNALS = [
  'complexityScore',
  'conversationCostUsd',
  'budgetUsedPct',
  'predictedOutputTokens',
  'ioRatio',
] as const;
export type LazyNumericSignal = (typeof LAZY_NUMERIC_SIGNALS)[number];

/** Returns the routing config if `model` is a Dynamic LLM, else null. */
export function getDynamicRoutingConfig(model: IModel): IDynamicRoutingConfig | null {
  const dyn = (model.settings as Record<string, unknown> | undefined)?.dynamic;
  if (
    dyn &&
    typeof dyn === 'object' &&
    typeof (dyn as { strategy?: unknown }).strategy === 'string' &&
    typeof (dyn as { defaultModelKey?: unknown }).defaultModelKey === 'string'
  ) {
    return dyn as IDynamicRoutingConfig;
  }
  return null;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const type = (part as { type?: unknown }).type;
    return (
      type === 'image_url' ||
      type === 'image' ||
      type === 'input_image' ||
      'image_url' in (part as Record<string, unknown>)
    );
  });
}

/** Approximate token count without pulling in a tokenizer: ~4 chars/token. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function extractRoutingSignals(body: {
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  response_format?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
}): RoutingSignals {
  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<{ role?: string; content?: unknown }>)
    : [];

  let totalChars = 0;
  let hasImages = false;
  let lastUserText = '';

  for (const message of messages) {
    const text = contentToText(message?.content);
    totalChars += text.length;
    if (contentHasImage(message?.content)) hasImages = true;
    if (message?.role === 'user') lastUserText = text;
  }

  const hasTools =
    (Array.isArray(body.tools) && body.tools.length > 0) ||
    (body.tool_choice !== undefined && body.tool_choice !== null && body.tool_choice !== 'none');

  const maxTokens = [body.max_completion_tokens, body.max_tokens].find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
  );

  return {
    inputTokensEst: estimateTokens(totalChars),
    messageCount: messages.length,
    lastUserLength: lastUserText.length,
    hasTools,
    hasResponseFormat: body.response_format !== undefined && body.response_format !== null,
    hasImages,
    lastUserText,
    ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
  };
}

const NUMERIC_SIGNALS = new Set<string>([
  'inputTokensEst',
  'messageCount',
  'lastUserLength',
  ...LAZY_NUMERIC_SIGNALS,
]);
const BOOLEAN_SIGNALS = new Set(['hasTools', 'hasResponseFormat', 'hasImages']);

/** Every signal a rule condition may reference. */
export const KNOWN_RULE_SIGNALS = new Set<string>([
  'inputTokensEst',
  'messageCount',
  'lastUserLength',
  'hasTools',
  'hasResponseFormat',
  'hasImages',
  'keyword',
  ...LAZY_NUMERIC_SIGNALS,
]);

/** True when any rule condition references the given signal. */
export function rulesReferenceSignal(
  rules: IDynamicRoutingRule[] | undefined,
  signal: string,
): boolean {
  return (rules ?? []).some((rule) =>
    (rule.conditions ?? []).some((condition) => condition.signal === signal),
  );
}

/**
 * Estimate a request's USD cost against one model's pricing: input tokens at
 * the input rate (the `cachedShare` of them at the cached rate when the model
 * prices cache reads), plus the expected output at the output rate. Callers
 * pass the caller's max_tokens (worst case) or a history-based prediction as
 * `outputTokens`; without either the estimate is input-only.
 */
export function estimateRequestCostUsd(
  pricing: IModelPricing,
  inputTokensEst: number,
  outputTokens?: number,
  cachedShare = 0,
): number {
  const share = Math.min(1, Math.max(0, cachedShare));
  const cachedRate = pricing.cachedTokenPer1M ?? pricing.inputTokenPer1M ?? 0;
  const inputCost =
    ((pricing.inputTokenPer1M ?? 0) * inputTokensEst * (1 - share) +
      cachedRate * inputTokensEst * share) /
    1_000_000;
  const outputCost =
    outputTokens && outputTokens > 0
      ? ((pricing.outputTokenPer1M ?? 0) * outputTokens) / 1_000_000
      : 0;
  return inputCost + outputCost;
}

/** Per-condition hard timeout for a tenant-supplied "matches" regex. */
const REGEX_MATCH_TIMEOUT_MS = 50;

/**
 * Runs `pattern.test(text)` inside a fresh V8 context with a wall-clock
 * timeout so a malicious/pathological tenant-supplied regex (catastrophic
 * backtracking) cannot block the shared event loop indefinitely. A plain
 * try/catch cannot help here — a hung regex engine never throws, it just
 * never returns — but `vm.runInContext`'s `timeout` option can forcibly
 * interrupt long-running synchronous JS execution.
 */
function safeRegexTest(pattern: RegExp, text: string): boolean {
  try {
    const context = vm.createContext({ pattern, text });
    return Boolean(
      vm.runInContext('pattern.test(text)', context, { timeout: REGEX_MATCH_TIMEOUT_MS }),
    );
  } catch (error) {
    logger.warn('Dynamic routing keyword regex timed out or failed; treating as no match', {
      error: error instanceof Error ? error.message : error,
    });
    return false;
  }
}

export function evaluateCondition(
  condition: IDynamicRoutingCondition,
  signals: RoutingSignals,
): boolean {
  const { signal, operator, value } = condition;

  if (signal === 'keyword') {
    const text = signals.lastUserText ?? '';
    const needle = String(value ?? '');
    if (!needle) return false;
    if (operator === 'contains') {
      return text.toLowerCase().includes(needle.toLowerCase());
    }
    if (operator === 'matches') {
      try {
        return safeRegexTest(new RegExp(needle, 'i'), text);
      } catch {
        return false;
      }
    }
    return false;
  }

  if (BOOLEAN_SIGNALS.has(signal)) {
    const actual = signals[signal as 'hasTools' | 'hasResponseFormat' | 'hasImages'];
    if (operator === 'isTrue') return actual === true;
    if (operator === 'isFalse') return actual === false;
    if (operator === 'eq') return actual === Boolean(value);
    if (operator === 'neq') return actual !== Boolean(value);
    return false;
  }

  if (NUMERIC_SIGNALS.has(signal)) {
    const actual =
      signals[signal as 'inputTokensEst' | 'messageCount' | 'lastUserLength' | LazyNumericSignal];
    // Lazy signals are only computed when rules reference them; a missing
    // value must never match a condition.
    if (typeof actual !== 'number') return false;
    const target = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(target)) return false;
    switch (operator) {
      case 'gt':
        return actual > target;
      case 'gte':
        return actual >= target;
      case 'lt':
        return actual < target;
      case 'lte':
        return actual <= target;
      case 'eq':
        return actual === target;
      case 'neq':
        return actual !== target;
      default:
        return false;
    }
  }

  return false;
}

/**
 * Single wall-clock budget for one `evaluateRules()` call, shared across
 * every rule and condition it evaluates — not a per-condition allowance.
 * `REGEX_MATCH_TIMEOUT_MS` bounds a single "matches" regex, but a config
 * with many rules/conditions that never matches would otherwise pay that
 * timeout once per condition, so per-condition bounds alone don't bound the
 * cost of one request. This is checked on the hot, shared chat-completion
 * path, so once the budget is spent we stop evaluating and fall back to
 * `defaultModelKey` (as if no rule had matched) rather than let a single
 * request hold up the event loop.
 */
const RULES_EVALUATION_BUDGET_MS = 150;

/** Evaluates rules in order; returns the first matching rule, or null. */
export function evaluateRules(
  rules: IDynamicRoutingRule[],
  signals: RoutingSignals,
): IDynamicRoutingRule | null {
  const deadline = Date.now() + RULES_EVALUATION_BUDGET_MS;

  for (const rule of rules) {
    const conditions = rule.conditions ?? [];
    if (conditions.length === 0) continue;
    const matchType = rule.matchType ?? 'all';

    const results: boolean[] = [];
    let timedOut = false;
    for (const condition of conditions) {
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      results.push(evaluateCondition(condition, signals));
    }

    if (timedOut) {
      logger.warn(
        'Dynamic routing rule evaluation exceeded its time budget; falling back to the default model',
        { budgetMs: RULES_EVALUATION_BUDGET_MS, ruleLabel: rule.label },
      );
      return null;
    }

    const matched = matchType === 'any' ? results.some(Boolean) : results.every(Boolean);
    if (matched) return rule;
  }
  return null;
}

/** Builds the chat messages sent to the decider model for classification. */
export function buildDeciderMessages(
  decider: IDynamicDeciderConfig,
  signals: RoutingSignals,
): Array<{ role: string; content: string }> {
  const labelList = decider.labels
    .map((label) => `- "${label.label}": ${label.description}`)
    .join('\n');

  const system =
    decider.promptOverride?.trim() ||
    [
      'You are a routing classifier. Read the user request below and classify it',
      'into exactly ONE of the categories. Respond with ONLY the category label,',
      'with no extra words, punctuation, or explanation.',
      '',
      'Categories:',
      labelList,
    ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: signals.lastUserText || '(empty request)' },
  ];
}

// ── Decision-model deciders ─────────────────────────────────────────────
// A `decision`-category decider is asked one closed `choice` question whose
// choices are the router's labels, and answers with a probability per label —
// no free text to parse, and a confidence the router can threshold on.

export const DECIDER_QUESTION_ID = 'route';
export const COMPLEXITY_QUESTION_ID = 'complexity';

const DEFAULT_DECIDER_INSTRUCTIONS =
  'Route the request: pick the single category that best fits the user request.';
const DEFAULT_COMPLEXITY_INSTRUCTIONS =
  'Rate how demanding the user request is for a language model to answer well.';

/** The `choice` question a decision decider answers. */
export function buildDeciderQuestion(decider: IDynamicDeciderConfig): DecisionChoiceQuestion {
  return {
    type: 'choice',
    instructions: decider.promptOverride?.trim() || DEFAULT_DECIDER_INSTRUCTIONS,
    choices: Object.fromEntries(decider.labels.map((label) => [label.label, label.description || label.label])),
  };
}

/** The `score` question behind the `complexityScore` signal. */
export function buildComplexityQuestion(complexity: IDynamicComplexityConfig): DecisionScoreQuestion {
  return {
    type: 'score',
    instructions: complexity.instructions?.trim() || DEFAULT_COMPLEXITY_INSTRUCTIONS,
    levels: complexity.levels,
  };
}

export interface DecisionLabelPick {
  label: IDynamicDeciderLabel | null;
  probability?: number;
  confidence?: number;
  /** Winning probability minus the runner-up's. */
  margin?: number;
  /** True when `minConfidence` is set and the answer fell short of it. */
  belowThreshold: boolean;
}

/**
 * Reads a decision answer back into a configured label and applies the
 * confidence floor. `confidence` is used when the backend reports one;
 * otherwise the winning probability stands in for it.
 */
export function pickDecisionLabel(
  answer: DecisionAnswer | undefined,
  decider: IDynamicDeciderConfig,
): DecisionLabelPick {
  if (!answer || answer.type !== 'choice') return { label: null, belowThreshold: false };
  const label = decider.labels.find((l) => l.label === answer.choice) ?? null;
  if (!label) return { label: null, belowThreshold: false };
  const probability = answer.probabilities?.[answer.choice];
  const others = Object.entries(answer.probabilities ?? {})
    .filter(([key]) => key !== answer.choice)
    .map(([, p]) => p);
  const margin =
    probability !== undefined && others.length > 0 ? probability - Math.max(...others) : undefined;
  const strength = answer.confidence ?? probability;
  const belowThreshold =
    decider.minConfidence !== undefined && (strength === undefined || strength < decider.minConfidence);
  return { label, probability, confidence: answer.confidence, margin, belowThreshold };
}

/** Matches the decider's free-text answer back to a configured label. */
export function parseDeciderLabel(
  text: string,
  labels: IDynamicDeciderLabel[],
): IDynamicDeciderLabel | null {
  // A reasoning model whose upstream leaks `<reasoning>…</reasoning>` into
  // `content` would never match a label, and every request would silently fall
  // back to the default model.
  const normalized = stripInlineReasoning(text).trim().toLowerCase();
  if (!normalized) return null;

  // Exact match first, then a contains-match so minor decorations
  // ("Category: simple") still resolve.
  const exact = labels.find((label) => label.label.toLowerCase() === normalized);
  if (exact) return exact;

  const contained = labels.find((label) => normalized.includes(label.label.toLowerCase()));
  return contained ?? null;
}


// ── Targets, pools and guards ────────────────────────────────────────────
// A rule, a decider label or the default resolves to a *target*: one fixed
// model, or a pool of candidates plus the policy that picks one per request.
// Guards then apply router-wide cost limits, and may only move a request to a
// cheaper model. Everything below is pure; history and counters are looked up
// by `dynamicRoutingState` and passed in.

/** Normalizes the legacy `targetModelKey` shorthand and the `target` object. */
export function normalizeTarget(spec: {
  target?: IDynamicRoutingTarget;
  targetModelKey?: string;
}): IDynamicRoutingTarget {
  const target = spec.target;
  if (target && Array.isArray(target.pool) && target.pool.length > 0) {
    return { pool: target.pool, policy: target.policy ?? 'best-under-cap' };
  }
  if (target?.modelKey) return { modelKey: target.modelKey };
  return { modelKey: spec.targetModelKey ?? '' };
}

/** The model a target uses when no policy runs (shadow mode, no estimates). */
export function primaryModelKey(target: IDynamicRoutingTarget): string {
  if (target.pool && target.pool.length > 0) return target.pool[0].modelKey;
  return target.modelKey ?? '';
}

/** Every model key a target can resolve to. */
export function targetModelKeys(target: IDynamicRoutingTarget): string[] {
  if (target.pool && target.pool.length > 0) return target.pool.map((c) => c.modelKey);
  return target.modelKey ? [target.modelKey] : [];
}

function hashId(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/**
 * A stable identifier for the conversation a request belongs to, used for
 * per-conversation budgets, stickiness and canary bucketing. Prefers an
 * explicit id from the caller (`metadata.conversationId` / `conversation_id`
 * / `session_id`, then `user`); otherwise hashes the opening of the
 * conversation (system prompt + first user turn), which stays the same as the
 * thread grows. Always hashed so raw ids never reach logs or cache keys.
 */
export function deriveConversationId(body: {
  messages?: unknown;
  metadata?: unknown;
  user?: unknown;
}): string {
  const metadata =
    body.metadata && typeof body.metadata === 'object'
      ? (body.metadata as Record<string, unknown>)
      : {};
  for (const key of ['conversationId', 'conversation_id', 'sessionId', 'session_id', 'threadId', 'thread_id']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return hashId(`id:${value.trim()}`);
  }

  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<{ role?: string; content?: unknown }>)
    : [];
  const system = messages.find((m) => m?.role === 'system' || m?.role === 'developer');
  const firstUser = messages.find((m) => m?.role === 'user');
  const user = typeof body.user === 'string' ? body.user : '';
  const opening = `${user}\u0000${contentToText(system?.content).slice(0, 2000)}\u0000${contentToText(firstUser?.content).slice(0, 2000)}`;
  return hashId(`open:${opening}`);
}

/** Deterministic canary bucketing: the same conversation always lands on the same side. */
export function isInCanary(conversationId: string, percent: number | undefined): boolean {
  if (percent === undefined || percent >= 100) return true;
  if (percent <= 0) return false;
  const bucket = parseInt(conversationId.slice(0, 8), 16) % 100;
  return bucket < percent;
}

/**
 * History bucket a request falls into: the route that matched, whether it
 * uses tools / structured output, and a log2 input-size band. Requests in one
 * segment have similar output/input ratios, which is what the token-profile
 * policy predicts from.
 */
export function segmentKey(route: string, signals: RoutingSignals): string {
  const band = Math.max(0, Math.min(8, Math.floor(Math.log2(Math.max(1, signals.inputTokensEst) / 256)) + 1));
  return `${route}|t${signals.hasTools ? 1 : 0}|f${signals.hasResponseFormat ? 1 : 0}|s${band}`;
}

/**
 * Why a candidate cannot serve this request, or null when it can. Only
 * capabilities that are KNOWN to be missing exclude a model — an unknown
 * capability (no metadata) never does, so an unconfigured model is not
 * silently dropped from every pool.
 */
export function candidateIneligibility(
  capabilities: Pick<ResolvedModelCapabilities, 'contextWindow' | 'inputModalities' | 'supportsToolCalls'> | null,
  signals: RoutingSignals,
  expectedOutputTokens: number,
): string | null {
  if (!capabilities) return null;
  if (signals.hasTools && capabilities.supportsToolCalls === false) return 'no tool calling';
  if (signals.hasImages && !capabilities.inputModalities.includes('image')) return 'no image input';
  if (
    capabilities.contextWindow &&
    signals.inputTokensEst + Math.max(0, expectedOutputTokens) > capabilities.contextWindow
  ) {
    return `context window ${capabilities.contextWindow} too small`;
  }
  return null;
}

/** History the output prediction can draw on, most specific first. */
export interface OutputHistory {
  /** EWMA output/input ratio of this conversation's previous turns. */
  conversationIoRatio?: number;
  /** EWMA output/input ratio of this router segment (any model). */
  segmentIoRatio?: number;
  /** This model's average output/input ratio over recent traffic. */
  modelIoRatio?: number;
  /** Mean of `modelIoRatio` across the pool's candidates that have one. */
  poolMeanIoRatio?: number;
  /** This model's average output tokens per request over recent traffic. */
  modelAvgOutputTokens?: number;
}

const VERBOSITY_MIN = 0.25;
const VERBOSITY_MAX = 4;

/**
 * Predicts a request's output tokens for one candidate.
 *
 * `simple` (cheapest / best-under-cap): the caller's max_tokens (worst case),
 * else this model's average output, else `defaultOutputTokens`.
 *
 * `profile` (token-profile): the request's output/input ratio ρ from the most
 * specific history available (conversation → router segment), scaled by the
 * model's verbosity — its own ρ relative to the pool's mean, which is what
 * makes a reasoning model's hidden thinking tokens show up in its price. With
 * no request-level history, the model's own ρ is used directly. Capped by
 * max_tokens; falls back to `simple` when there is no history at all.
 */
export function predictOutputTokens(
  mode: 'simple' | 'profile',
  inputTokens: number,
  history: OutputHistory,
  options: { maxOutputTokens?: number; defaultOutputTokens: number },
): number {
  const cap = options.maxOutputTokens;
  const simple = () => cap ?? history.modelAvgOutputTokens ?? options.defaultOutputTokens;
  if (mode === 'simple') return Math.max(0, Math.round(simple()));

  const requestRatio = history.conversationIoRatio ?? history.segmentIoRatio;
  let predicted: number | undefined;
  if (requestRatio !== undefined) {
    let verbosity = 1;
    if (history.modelIoRatio && history.poolMeanIoRatio) {
      verbosity = Math.min(
        VERBOSITY_MAX,
        Math.max(VERBOSITY_MIN, history.modelIoRatio / history.poolMeanIoRatio),
      );
    }
    predicted = inputTokens * requestRatio * verbosity;
  } else if (history.modelIoRatio !== undefined) {
    predicted = inputTokens * history.modelIoRatio;
  }
  if (predicted === undefined || !Number.isFinite(predicted)) return Math.max(0, Math.round(simple()));
  return Math.max(1, Math.round(cap !== undefined ? Math.min(cap, predicted) : predicted));
}

export interface PoolCandidateEstimate extends IDynamicPoolEstimate {
  /** False when the candidate was skipped (see `skipped`) or has no pricing. */
  eligible: boolean;
}

export interface PoolSelection {
  modelKey: string;
  estimatedCostUsd?: number;
  predictedOutputTokens?: number;
  reason: string;
}

function cheapestOf(estimates: PoolCandidateEstimate[]): PoolCandidateEstimate | undefined {
  return estimates
    .filter((e) => e.eligible && e.estimatedCostUsd !== undefined)
    .sort((a, b) => (a.estimatedCostUsd ?? 0) - (b.estimatedCostUsd ?? 0) || a.tier - b.tier)[0];
}

function toSelection(estimate: PoolCandidateEstimate, reason: string): PoolSelection {
  return {
    modelKey: estimate.modelKey,
    estimatedCostUsd: estimate.estimatedCostUsd,
    predictedOutputTokens: estimate.predictedOutputTokens,
    reason,
  };
}

const usd = (value: number | undefined) =>
  value === undefined ? 'n/a' : `$${value < 0.01 ? value.toFixed(5) : value.toFixed(4)}`;

/**
 * Picks one pool candidate. Returns null when no candidate is eligible, so the
 * caller can fall back to the router's default model.
 */
export function selectPoolCandidate(
  estimates: PoolCandidateEstimate[],
  policy: DynamicPoolPolicy,
  options: { maxCostPerRequestUsd?: number; stickyModelKey?: string; switchMarginPct?: number } = {},
): PoolSelection | null {
  const eligible = estimates.filter((e) => e.eligible);
  if (eligible.length === 0) return null;
  const priced = eligible.filter((e) => e.estimatedCostUsd !== undefined);

  if (policy === 'best-under-cap') {
    const cap = options.maxCostPerRequestUsd;
    const fitting = eligible
      .filter((e) => cap === undefined || (e.estimatedCostUsd !== undefined && e.estimatedCostUsd <= cap))
      .sort((a, b) => b.tier - a.tier || (a.estimatedCostUsd ?? 0) - (b.estimatedCostUsd ?? 0));
    if (fitting.length > 0) {
      const pick = fitting[0];
      return toSelection(
        pick,
        cap === undefined
          ? `Highest tier (${pick.tier}) in pool`
          : `Highest tier (${pick.tier}) within cap ${usd(cap)} (est. ${usd(pick.estimatedCostUsd)})`,
      );
    }
    const cheapest = cheapestOf(eligible);
    if (cheapest) {
      return toSelection(cheapest, `No candidate fits cap ${usd(cap)}; cheapest est. ${usd(cheapest.estimatedCostUsd)}`);
    }
    return toSelection(eligible[0], 'No priced candidate; first eligible');
  }

  const cheapest = cheapestOf(eligible);
  if (!cheapest) return toSelection(eligible[0], 'No priced candidate; first eligible');

  if (policy === 'token-profile' && options.stickyModelKey) {
    const sticky = priced.find((e) => e.modelKey === options.stickyModelKey);
    if (sticky && sticky.modelKey !== cheapest.modelKey) {
      const margin = (options.switchMarginPct ?? 15) / 100;
      const saving =
        sticky.estimatedCostUsd && sticky.estimatedCostUsd > 0
          ? (sticky.estimatedCostUsd - (cheapest.estimatedCostUsd ?? 0)) / sticky.estimatedCostUsd
          : 0;
      if (saving < margin) {
        return toSelection(
          sticky,
          `Kept conversation on ${sticky.modelKey} (switching saves ${(saving * 100).toFixed(0)}% < ${(margin * 100).toFixed(0)}% margin)`,
        );
      }
    }
  }

  return toSelection(
    cheapest,
    policy === 'token-profile'
      ? `Lowest expected cost for predicted ${cheapest.predictedOutputTokens ?? '?'} output tokens (est. ${usd(cheapest.estimatedCostUsd)})`
      : `Cheapest candidate (est. ${usd(cheapest.estimatedCostUsd)})`,
  );
}

export interface GuardState {
  conversationCostUsd?: number;
  budgetUsedPct?: number;
}

export interface GuardOutcome {
  /** The model to use after guards (unchanged when no guard tripped). */
  modelKey: string;
  estimatedCostUsd?: number;
  /** Guard that tripped, when one did. */
  guard?: string;
  reason?: string;
  /** budget exhausted with `onExceeded: 'reject'`. */
  reject?: boolean;
}

/**
 * Applies router-wide cost guards to a resolved choice. `downgrade` is the
 * cheaper option a tripped guard moves to (the cheapest eligible pool
 * candidate, or the economy model); a guard never moves to a model that is
 * estimated to cost more than the current choice.
 */
export function applyCostGuards(
  choice: { modelKey: string; estimatedCostUsd?: number },
  guards: IDynamicRoutingGuards | undefined,
  state: GuardState,
  downgrade: { modelKey: string; estimatedCostUsd?: number } | null,
): GuardOutcome {
  const keep: GuardOutcome = { modelKey: choice.modelKey, estimatedCostUsd: choice.estimatedCostUsd };
  if (!guards) return keep;

  const budget = guards.budget;
  if (budget && state.budgetUsedPct !== undefined && state.budgetUsedPct >= 100 && budget.onExceeded === 'reject') {
    return { ...keep, guard: 'budget', reason: `Budget ${usd(budget.limitUsd)} / ${budget.windowHours}h exhausted`, reject: true };
  }

  let trip: { guard: string; reason: string } | null = null;
  if (budget && state.budgetUsedPct !== undefined && state.budgetUsedPct >= (budget.downgradeAtPct ?? 80)) {
    trip = { guard: 'budget', reason: `Budget ${state.budgetUsedPct.toFixed(0)}% used of ${usd(budget.limitUsd)} / ${budget.windowHours}h` };
  } else if (
    guards.conversationBudgetUsd !== undefined &&
    state.conversationCostUsd !== undefined &&
    state.conversationCostUsd >= guards.conversationBudgetUsd
  ) {
    trip = { guard: 'conversationBudgetUsd', reason: `Conversation spent ${usd(state.conversationCostUsd)} ≥ ${usd(guards.conversationBudgetUsd)}` };
  } else if (
    guards.maxCostPerRequestUsd !== undefined &&
    choice.estimatedCostUsd !== undefined &&
    choice.estimatedCostUsd > guards.maxCostPerRequestUsd
  ) {
    trip = { guard: 'maxCostPerRequestUsd', reason: `Est. ${usd(choice.estimatedCostUsd)} > cap ${usd(guards.maxCostPerRequestUsd)}` };
  }
  if (!trip) return keep;

  const cheaper =
    downgrade &&
    downgrade.modelKey !== choice.modelKey &&
    (downgrade.estimatedCostUsd === undefined ||
      choice.estimatedCostUsd === undefined ||
      downgrade.estimatedCostUsd < choice.estimatedCostUsd);
  if (!cheaper || !downgrade) {
    return { ...keep, guard: trip.guard, reason: `${trip.reason}; no cheaper model to move to` };
  }
  return {
    modelKey: downgrade.modelKey,
    estimatedCostUsd: downgrade.estimatedCostUsd,
    guard: trip.guard,
    reason: `${trip.reason}; downgraded to ${downgrade.modelKey}`,
  };
}

/** Every model key a config can route to (targets, pools, default, fallback, economy). */
export function configModelKeys(config: IDynamicRoutingConfig): string[] {
  const keys = new Set<string>();
  const add = (key?: string) => key && keys.add(key);
  add(config.defaultModelKey);
  add(config.fallbackModelKey);
  add(config.guards?.economyModelKey);
  add(config.baselineModelKey);
  if (config.defaultTarget) targetModelKeys(normalizeTarget({ target: config.defaultTarget })).forEach(add);
  for (const rule of config.rules ?? []) targetModelKeys(normalizeTarget(rule)).forEach(add);
  for (const label of config.decider?.labels ?? []) targetModelKeys(normalizeTarget(label)).forEach(add);
  if (config.decider?.belowConfidence) {
    targetModelKeys(normalizeTarget({ target: config.decider.belowConfidence })).forEach(add);
  }
  return [...keys];
}
