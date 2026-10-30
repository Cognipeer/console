/**
 * Shared pieces of the per-model request-parameter controls, used by both the
 * create form and the edit page so the two surfaces cannot drift.
 */

import { isOpenAiSchemaDriver } from '@/lib/providers/unsupportedParams';
import { computeOutputTokenLimit } from '@/lib/services/models/outputLimits';

export {
  detectUnsupportedParams,
  type DetectedUnsupportedParams,
} from '@/lib/providers/unsupportedParams';

/**
 * Parameters a provider may reject outright. The OpenAI reasoning family answers
 * `temperature` with a 400 ("Only the default (1) is supported"), and some
 * self-hosted OpenAI-compatible servers reject `stream_options`. Listing one here
 * drops it from the request instead of letting the call fail.
 */
export const UNSUPPORTED_PARAM_OPTIONS = [
  { value: 'temperature', label: 'temperature' },
  { value: 'top_p', label: 'top_p' },
  { value: 'presence_penalty', label: 'presence_penalty' },
  { value: 'frequency_penalty', label: 'frequency_penalty' },
  { value: 'max_tokens', label: 'max_tokens (send max_completion_tokens instead)' },
  { value: 'reasoning_effort', label: 'reasoning_effort' },
  { value: 'stream_options', label: 'stream_options' },
];

/**
 * The options for a model of this driver. `max_tokens` is the OpenAI-schema field that `max_completion_tokens` replaces:
 * Anthropic, Bedrock and Vertex have no such choice, so it is not offered there - unless the model already lists it, so
 * a value saved earlier can still be seen and removed.
 */
export function unsupportedParamOptions(driver: string | undefined, selected: readonly string[] = []) {
  return UNSUPPORTED_PARAM_OPTIONS.filter(
    (option) => option.value !== 'max_tokens' || isOpenAiSchemaDriver(driver) || selected.includes(option.value),
  );
}

/** A number a form field holds, or undefined while it is blank (`''`), not a number yet, or not positive. */
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The `max_tokens` a call to this model is sent while "Default max tokens" is blank, when there is one: Anthropic's
 * Messages API requires it, so a call gets the model maximum (the declared "Maximum output tokens", else the built-in
 * table by model id, else 8192). Every other driver sends none and the provider's own default applies (undefined). The
 * resolver the gateway and the native clients use, for a streaming call (a non-streaming default is capped lower).
 */
export function blankMaxTokensDefault(input: {
  driver: string | undefined;
  modelId: string | undefined;
  /** The "Maximum output tokens" field. */
  maxOutputTokens: unknown;
}): number | undefined {
  return computeOutputTokenLimit({
    driver: input.driver,
    modelId: input.modelId || undefined,
    modelMax: positive(input.maxOutputTokens),
    stream: true,
  });
}

/**
 * The text of the "Default max tokens" placeholder: both defaults when a streaming and a non-streaming call differ
 * (`splitTemplate` has `{streaming}` and `{nonStreaming}`), the single value when they agree, `fallback` when the
 * driver sends none.
 */
export function blankMaxTokensPlaceholder(
  input: { driver: string | undefined; modelId: string | undefined; maxOutputTokens: unknown },
  splitTemplate: string,
  fallback: string,
): string {
  const streaming = blankMaxTokensDefault(input);
  if (streaming === undefined) return fallback;
  const nonStreaming = computeOutputTokenLimit({
    driver: input.driver,
    modelId: input.modelId || undefined,
    modelMax: positive(input.maxOutputTokens),
    stream: false,
  });
  const fmt = (n: number) => n.toLocaleString('en-US');
  if (nonStreaming === undefined || nonStreaming === streaming) return fmt(streaming);
  return splitTemplate.replace('{streaming}', fmt(streaming)).replace('{nonStreaming}', fmt(nonStreaming));
}

export type LimitWarning = 'defaultAboveMaxOutput' | 'maxOutputAboveContext';

/**
 * The limit combinations the forms warn about without blocking the save: a default above the model's own maximum asks
 * the provider for more than it can write, and a maximum above the context window cannot be reached. Only values
 * somebody entered take part.
 */
export function limitWarnings(input: {
  contextWindow: unknown;
  maxOutputTokens: unknown;
  /** The "Default max tokens" field. */
  maxTokens: unknown;
}): LimitWarning[] {
  const contextWindow = positive(input.contextWindow);
  const maxOutputTokens = positive(input.maxOutputTokens);
  const maxTokens = positive(input.maxTokens);
  const warnings: LimitWarning[] = [];
  if (maxTokens !== undefined && maxOutputTokens !== undefined && maxTokens > maxOutputTokens) {
    warnings.push('defaultAboveMaxOutput');
  }
  if (maxOutputTokens !== undefined && contextWindow !== undefined && maxOutputTokens > contextWindow) {
    warnings.push('maxOutputAboveContext');
  }
  return warnings;
}

/**
 * A number field of the edit form as the update API takes it: `null` while the field is blank (a cleared NumberInput
 * holds `''`), which the settings merge reads as "remove the key". Sent as `''` it would be stored as an empty string
 * instead. Any other value (a number, or a numeric string that `normalizeModelSettings` heals) goes through as it is.
 */
export function numberSettingOrNull(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value === 'number' && Number.isNaN(value)) return null;
  return value;
}

export const REQUEST_DEFAULTS_PLACEHOLDER = `{
  "chat_template_kwargs": { "enable_thinking": false },
  "top_k": 20
}`;

export function parseRequestDefaults(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function validateRequestDefaults(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return 'Must be valid JSON';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'Must be a JSON object';
  }
  for (const key of ['model', 'messages', 'stream']) {
    if (key in (parsed as Record<string, unknown>)) {
      return `"${key}" is set by the gateway and cannot be a default`;
    }
  }
  return null;
}

/** Pretty-prints a stored defaults object for the JSON editor. */
export function formatRequestDefaults(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return JSON.stringify(value, null, 2);
}

export function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
