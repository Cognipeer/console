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

export class OutputTokenLimitError extends Error {
  readonly limit?: number;

  constructor(limit?: number) {
    const limitDescription = limit ? ` (${limit} tokens)` : '';
    super(
      `The model reached its output token limit${limitDescription} before producing a final answer or tool call. `
      + 'Reasoning models may consume this budget internally. Increase max_completion_tokens or configure a higher model default.',
    );
    this.name = 'OutputTokenLimitError';
    this.limit = limit;
  }
}

type ErrorRecord = Record<string, unknown>;

function asRecord(value: unknown): ErrorRecord | null {
  return value !== null && typeof value === 'object' ? value as ErrorRecord : null;
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
  return message
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

  const records = collectErrorRecords(error);
  const rawMessage = error instanceof Error
    ? error.message
    : firstString(records, ['message']) || 'Inference request failed';
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