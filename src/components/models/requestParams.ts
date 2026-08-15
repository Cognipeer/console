/**
 * Shared pieces of the per-model request-parameter controls, used by both the
 * create form and the edit page so the two surfaces cannot drift.
 */

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
