import { redactDataUrls } from '@/lib/services/logRedaction';
import { isServiceDisabledError } from '@/lib/services/availability/serviceAvailability';
import { UpstreamRequestError } from '@/lib/providers/contracts/upstreamError';
import type { TokenUsage, UsageCostResult } from './usageLogger';

export type OpenAIErrorBody = {
  message: string;
  type: string;
  param?: string | null;
  code?: string | null;
};

export type NormalizedOpenAIError = {
  status: number;
  error: OpenAIErrorBody;
};

/** What a failed call the core billed was billed, carried on its OutputTokenLimitError or UpstreamFinishError. */
export type OutputTokenLimitBilling = {
  /** The call's gateway usage (`toGatewayUsage` rule): the provider bills a cut-off call too. */
  usage?: TokenUsage;
  cost?: UsageCostResult;
  /** The core already wrote the call's usage row and settled its cost (`onUsageSettled`). */
  usageBooked?: boolean;
};

/** The wire dialect the caller spoke: it decides which request parameter the limit message names. */
export type OutputLimitDialect = 'chat' | 'messages' | 'responses';

/** The request parameter that sets the output limit in each dialect (chat completions also takes `max_tokens`). */
export const OUTPUT_LIMIT_PARAMETER: Record<OutputLimitDialect, string> = {
  chat: 'max_completion_tokens',
  messages: 'max_tokens',
  responses: 'max_output_tokens',
};

/** Anthropic / Bedrock stop reason: the CONTEXT window filled up, not the output limit; a larger limit cannot help. */
export const CONTEXT_WINDOW_EXCEEDED_REASON = 'model_context_window_exceeded';

export type OutputTokenLimitOptions = OutputTokenLimitBilling & {
  /** The provider's own stop reason (`max_tokens`, `incomplete`, `model_context_window_exceeded` ...), when it sent one. */
  rawFinishReason?: string;
  /** The caller's wire dialect, so the message names the parameter the caller actually sends. Default: chat completions. */
  dialect?: OutputLimitDialect;
};

export class OutputTokenLimitError extends Error {
  /** The limit the call SENT (the gateway's one resolved value); absent only when no limit was sent at all. */
  readonly limit?: number;
  readonly usage?: TokenUsage;
  readonly cost?: UsageCostResult;
  readonly usageBooked?: boolean;
  readonly rawFinishReason?: string;
  readonly dialect?: OutputLimitDialect;

  constructor(limit?: number, options?: OutputTokenLimitOptions) {
    const limitDescription = limit ? ` (${limit} tokens)` : '';
    const parameter = OUTPUT_LIMIT_PARAMETER[options?.dialect ?? 'chat'];
    super(
      options?.rawFinishReason === CONTEXT_WINDOW_EXCEEDED_REASON
        ? `The model's context window was full${limit ? ` (output limit ${limit} tokens)` : ''} before it produced a final answer or tool call. `
          + 'Shorten the conversation or the input: a higher output limit cannot help.'
        : `The model reached its output token limit${limitDescription} before producing a final answer or tool call. `
          + 'Reasoning models may consume this budget internally. '
          // Never the advertised maximum ("Maximum output tokens"): that one only caps defaults and retries.
          + `Increase ${parameter} on the request or raise the model's "Default max tokens" setting.`,
    );
    this.name = 'OutputTokenLimitError';
    this.limit = limit;
    if (options?.usage) this.usage = options.usage;
    if (options?.cost) this.cost = options.cost;
    if (options?.usageBooked) this.usageBooked = true;
    if (options?.rawFinishReason) this.rawFinishReason = options.rawFinishReason;
    if (options?.dialect) this.dialect = options.dialect;
  }
}

/**
 * A finish reason the provider names must be a plain token before it reaches a message, a code or a usage row:
 * a stray character set in an upstream's stop reason must not be echoed into any of them.
 */
const PROVIDER_FINISH_TOKEN = /^[\w.:-]{1,64}$/;

/**
 * A call the provider ended in its OWN error finish: Gemini's `MALFORMED_FUNCTION_CALL` / `UNEXPECTED_TOOL_CALL`,
 * Bedrock's `malformed_model_output` / `malformed_tool_use` (the agent-sdk normalizes the finish to `error`).
 * What the model produced is unusable, and reading the finish as a clean `stop` would hand the caller a broken
 * answer, so the call FAILS as an upstream error (502, a code derived from the raw reason). The provider billed
 * what it burned, so the core books it before this leaves, exactly as it does a limit hit (`usageBooked`).
 */
export class UpstreamFinishError extends UpstreamRequestError {
  /** The wire `error.code`: the provider's raw reason in lower snake case (`malformed_function_call`), `provider_error` when it named none. */
  readonly code: string;
  /** The provider's own stop reason, as it sent it. Absent when it sent none (the SDK's bare `error`). */
  readonly rawFinishReason?: string;
  readonly usage?: TokenUsage;
  readonly cost?: UsageCostResult;
  readonly usageBooked?: boolean;

  constructor(rawFinishReason?: string, billing?: OutputTokenLimitBilling) {
    const raw = rawFinishReason?.trim();
    // The SDK's own word for an error finish (`error`) is not a provider reason: it names nothing.
    const named = raw && PROVIDER_FINISH_TOKEN.test(raw) && raw.toLowerCase() !== 'error' ? raw : undefined;
    super(
      `The model provider ended the call with an error finish reason${named ? ` (${named})` : ''}, `
      + 'so the answer or tool call it produced cannot be used.',
      502,
    );
    this.name = 'UpstreamFinishError';
    this.code = named ? named.toLowerCase().replace(/[.:-]/g, '_') : 'provider_error';
    if (named) this.rawFinishReason = named;
    if (billing?.usage) this.usage = billing.usage;
    if (billing?.cost) this.cost = billing.cost;
    if (billing?.usageBooked) this.usageBooked = true;
  }
}

/** The core already wrote this call's usage row (an output-limit hit or an error finish it billed): callers must not log another. */
export function isUsageBookedError(error: unknown): boolean {
  return (error instanceof OutputTokenLimitError || error instanceof UpstreamFinishError) && error.usageBooked === true;
}

type ErrorRecord = Record<string, unknown>;

export const MODEL_PARAMETER_UNSUPPORTED_CODE = 'model_parameter_unsupported';
const MODEL_REQUEST_ERROR_CODES = new Set(['unsupported_parameter', 'unsupported_value', 'model_request_invalid']);

/**
 * The agent-sdk's `ModelRequestError`: the model answered 400 about a parameter or value the SDK could not
 * adjust away (after its own retries). Recognised by shape so this module stays free of the SDK.
 */
export function isModelRequestError(error: unknown): error is Error & {
  code: string;
  param?: string;
  value?: unknown;
  supportedValues?: string[];
  provider?: string;
  model?: string;
} {
  if (!(error instanceof Error)) return false;
  const candidate = error as unknown as ErrorRecord;
  return candidate.status === 400
    && typeof candidate.code === 'string'
    && MODEL_REQUEST_ERROR_CODES.has(candidate.code)
    && typeof candidate.model === 'string';
}

/** A clean 400 for a request setting the model refuses: names the model, the parameter and, when known, what it takes. */
function normalizeModelRequestError(error: NonNullable<ReturnType<typeof asModelRequestError>>): NormalizedOpenAIError {
  const supported = error.supportedValues?.length ? ` Supported values: ${error.supportedValues.join(', ')}.` : '';
  const message = `The model "${error.model}" does not accept this request: ${error.message.replace(/\s+/g, ' ').trim()}${supported}`;
  const code = error.code === 'model_request_invalid' ? 'model_request_invalid' : MODEL_PARAMETER_UNSUPPORTED_CODE;
  return normalized(400, message, 'invalid_request_error', code, error.param ?? null);
}

function asModelRequestError(error: unknown) {
  return isModelRequestError(error) ? error : undefined;
}

function asRecord(value: unknown): ErrorRecord | null {
  return value !== null && typeof value === 'object' ? value as ErrorRecord : null;
}

/** A provider error body kept as text (`{"error":{"code":...}}`) is read as the object it is. */
function parseJsonBody(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function collectErrorRecords(error: unknown): ErrorRecord[] {
  const records: ErrorRecord[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();

  while (queue.length > 0 && records.length < 16) {
    const value = queue.shift();
    if (!value || seen.has(value)) continue;
    seen.add(value);

    const record = asRecord(value);
    if (!record) continue;
    records.push(record);
    queue.push(
      record.cause,
      record.error,
      record.errors,
      record.response,
      // The agent-sdk providers' ProviderError keeps the upstream's error body here.
      parseJsonBody(record.responseBody),
      record.body,
      record.data,
      record.details,
    );
    for (const nested of Object.values(record)) {
      if (Array.isArray(nested)) queue.push(...nested);
    }
  }

  return records;
}

function firstString(records: ErrorRecord[], keys: string[]): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      if (typeof record[key] === 'string' && record[key]) {
        return record[key];
      }
    }
  }
  return undefined;
}

function firstStatus(records: ErrorRecord[]): number | undefined {
  for (const record of records) {
    for (const key of ['status', 'statusCode', 'status_code']) {
      const value = record[key];
      if (typeof value === 'number' && value >= 400 && value <= 599) return value;
    }
  }
  return undefined;
}

function safeMessage(message: string): string {
  return redactDataUrls(message)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(
      /\b(api[_-]?key|access[_-]?key|authorization|credential|secret|session[_-]?token|token)\b\s*[:=]\s*["']?[^\s,"'}]+/gi,
      '$1=[REDACTED]',
    )
    .slice(0, 2000);
}

function normalized(
  status: number,
  message: string,
  type: string,
  code?: string | null,
  param?: string | null,
): NormalizedOpenAIError {
  return {
    status,
    error: {
      message: safeMessage(message),
      type,
      ...(param !== undefined ? { param } : {}),
      ...(code !== undefined ? { code } : {}),
    },
  };
}

/**
 * The upstream's OWN message out of a provider error body. agent-sdk's
 * ProviderError words its `message` as `<Provider> API error <status>: <raw
 * response text>`; a client wants the sentence the upstream wrote, not the wrapper
 * and a JSON blob around it. Anthropic / OpenAI / Gemini nest it under
 * `error.message`, Bedrock and some compatible servers put `message` at the top.
 */
function upstreamMessage(error: unknown): string | undefined {
  const body = parseJsonBody(asRecord(error)?.responseBody);
  const record = asRecord(body);
  if (!record) return undefined;
  const nested = asRecord(record.error);
  for (const candidate of [nested?.message, typeof record.error === 'string' ? record.error : undefined, record.message]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return undefined;
}

export function normalizeInferenceError(error: unknown): NormalizedOpenAIError {
  if (error instanceof OutputTokenLimitError) {
    return normalized(
      422,
      error.message,
      'output_token_limit_exceeded',
      'output_token_limit_exceeded',
      'max_completion_tokens',
    );
  }

  // The provider's own error finish is its fault, not the caller's: a 502 with the code its raw reason names.
  if (error instanceof UpstreamFinishError) {
    return normalized(error.status, error.message, 'server_error', error.code);
  }

  // A switched-off service keeps its own status (403, or 402 when the license
  // lacks it) and code rather than falling through to a generic 500.
  if (isServiceDisabledError(error)) {
    return normalized(error.status, error.message, 'permission_error', error.code);
  }

  const modelRequestError = asModelRequestError(error);
  if (modelRequestError) return normalizeModelRequestError(modelRequestError);

  const records = collectErrorRecords(error);
  const rawMessage = upstreamMessage(error)
    ?? (error instanceof Error
      ? error.message
      : firstString(records, ['message']) || 'Inference request failed');
  const message = safeMessage(rawMessage);
  const status = firstStatus(records);
  const providerCode = firstString(records, ['code']);
  const providerType = firstString(records, ['type']);
  const providerParam = firstString(records, ['param']);
  const signal = [
    error instanceof Error ? error.name : '',
    message,
    providerCode,
    providerType,
  ].filter(Boolean).join(' ').toLowerCase();

  if (/output.{0,20}token.{0,20}limit/.test(signal)) {
    return normalized(422, message, 'output_token_limit_exceeded', 'output_token_limit_exceeded', 'max_completion_tokens');
  }

  if (/context.{0,20}(length|window)|maximum context|too many tokens|prompt.{0,20}too long/.test(signal)) {
    return normalized(400, message, 'invalid_request_error', providerCode || 'context_length_exceeded', providerParam || 'messages');
  }

  if (/content[_ ]filter|content policy|policy violation|safety.{0,20}filter/.test(signal)) {
    return normalized(400, message, 'invalid_request_error', providerCode || 'content_policy_violation', providerParam);
  }

  if (status === 401 || /authentication|unauthorized|invalid.{0,20}api.?key/.test(signal)) {
    return normalized(401, 'Model provider authentication failed. Verify the configured provider credentials.', 'authentication_error', providerCode || 'invalid_api_key');
  }

  if (status === 403 || /permission denied|forbidden/.test(signal)) {
    return normalized(403, message, 'permission_error', providerCode || 'permission_denied');
  }

  if (status === 429 || /rate.?limit|too many requests|insufficient_quota|quota exceeded/.test(signal)) {
    const code = /insufficient_quota|quota exceeded/.test(signal)
      ? 'insufficient_quota'
      : providerCode || 'rate_limit_exceeded';
    return normalized(429, message, 'rate_limit_error', code, providerParam);
  }

  if (status === 408 || status === 504 || /timeout|timed out|aborterror/.test(signal)) {
    return normalized(status === 408 ? 408 : 504, message, 'server_error', providerCode || 'provider_timeout');
  }

  if (/apiconnectionerror|econn|enotfound|fetch failed|connection (error|refused|reset)|circuit breaker/.test(signal)) {
    return normalized(503, message, 'server_error', providerCode || 'provider_unavailable');
  }

  if (status === 404 || /model.{0,40}not found|notfounderror/.test(signal)) {
    return normalized(404, message, 'not_found_error', providerCode || 'model_not_found', providerParam || 'model');
  }

  if (
    status === 400
    || /invalid_request|badrequest|is required|must be|unsupported|does not support|json schema|tool.{0,20}(invalid|schema)/.test(signal)
  ) {
    return normalized(400, message, 'invalid_request_error', providerCode || 'invalid_request', providerParam);
  }

  if (status === 409) {
    return normalized(409, message, 'conflict_error', providerCode || 'conflict', providerParam);
  }

  if (status === 422) {
    return normalized(422, message, 'unprocessable_entity_error', providerCode || 'unprocessable_entity', providerParam);
  }

  if (status && status >= 500) {
    return normalized(status, message, 'server_error', providerCode || 'provider_error');
  }

  return normalized(500, message, 'server_error', providerCode || 'inference_error');
}