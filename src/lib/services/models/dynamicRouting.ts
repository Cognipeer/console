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

import type {
  IDynamicDeciderConfig,
  IDynamicDeciderLabel,
  IDynamicRoutingCondition,
  IDynamicRoutingConfig,
  IDynamicRoutingRule,
  IModel,
} from '@/lib/database';

/** Hard cap on router→model→router chaining to prevent runaway recursion. */
export const MAX_ROUTING_DEPTH = 3;

export interface RoutingSignals {
  inputTokensEst: number;
  messageCount: number;
  lastUserLength: number;
  hasTools: boolean;
  hasResponseFormat: boolean;
  hasImages: boolean;
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
  };
}

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

  return {
    inputTokensEst: estimateTokens(totalChars),
    messageCount: messages.length,
    lastUserLength: lastUserText.length,
    hasTools,
    hasResponseFormat: body.response_format !== undefined && body.response_format !== null,
    hasImages,
    lastUserText,
  };
}

const NUMERIC_SIGNALS = new Set(['inputTokensEst', 'messageCount', 'lastUserLength']);
const BOOLEAN_SIGNALS = new Set(['hasTools', 'hasResponseFormat', 'hasImages']);

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
        return new RegExp(needle, 'i').test(text);
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
    const actual = signals[signal as 'inputTokensEst' | 'messageCount' | 'lastUserLength'];
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

/** Evaluates rules in order; returns the first matching rule, or null. */
export function evaluateRules(
  rules: IDynamicRoutingRule[],
  signals: RoutingSignals,
): IDynamicRoutingRule | null {
  for (const rule of rules) {
    const conditions = rule.conditions ?? [];
    if (conditions.length === 0) continue;
    const matchType = rule.matchType ?? 'all';
    const results = conditions.map((condition) => evaluateCondition(condition, signals));
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

/** Matches the decider's free-text answer back to a configured label. */
export function parseDeciderLabel(
  text: string,
  labels: IDynamicDeciderLabel[],
): IDynamicDeciderLabel | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  // Exact match first, then a contains-match so minor decorations
  // ("Category: simple") still resolve.
  const exact = labels.find((label) => label.label.toLowerCase() === normalized);
  if (exact) return exact;

  const contained = labels.find((label) => normalized.includes(label.label.toLowerCase()));
  return contained ?? null;
}
