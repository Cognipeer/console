import { redactDataUrls } from '@/lib/services/logRedaction';
import { isServiceDisabledError } from '@/lib/services/availability/serviceAvailability';
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

/** What a limit-hit call was billed, carried on its OutputTokenLimitError. */
export type OutputTokenLimitBilling = {
  /** The call's gateway usage (`toGatewayUsage` rule): the provider bills a cut-off call too. */
  usage?: TokenUsage;
  cost?: UsageCostResult;
  /** The core already wrote the call's usage row and settled its cost (`onUsageSettled`). */
  usageBooked?: boolean;
};

export class OutputTokenLimitError extends Error {
  readonly limit?: number;
  readonly usage?: TokenUsage;
  readonly cost?: UsageCostResult;
  readonly usageBooked?: boolean;

  constructor(limit?: number, billing?: OutputTokenLimitBilling) {
    const limitDescription = limit ? ` (${limit} tokens)` : '';
    super(
      `The model reached its output token limit${limitDescription} before producing a final answer or tool call. `
      + 'Reasoning models may consume this budget internally. Increase max_completion_tokens or configure a higher model default.',
    );
    this.name = 'OutputTokenLimitError';
    this.limit = limit;
    if (billing?.usage) this.usage = billing.usage;
    if (billing?.cost) this.cost = billing.cost;
    if (billing?.usageBooked) this.usageBooked = true;
  }
}

/** The core already wrote this call's usage row (an output-limit hit it billed): callers must not log another. */
export function isUsageBookedError(error: unknown): boolean {
  return error instanceof OutputTokenLimitError && error.usageBooked === true;
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