// NOTE: This module is imported by 'use client' components (browser runtime).
// Do NOT use Winston logger here — only console.* is available in the browser.

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;
  /** Machine-readable error code from the body (`code`, or `error.code`), when the server sent one. */
  readonly code?: string;
  /** Retry hint from the `Retry-After` header, in milliseconds. */
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, payload?: unknown, meta?: { code?: string; retryAfterMs?: number }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
    this.code = meta?.code;
    this.retryAfterMs = meta?.retryAfterMs;
  }
}

function extractErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.code === 'string') return record.code;
  const inner = record.error;
  if (inner && typeof inner === 'object' && typeof (inner as Record<string, unknown>).code === 'string') {
    return (inner as Record<string, string>).code;
  }
  return undefined;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

export type ApiRequestInit = RequestInit & {
  parseJson?: boolean;
};

export async function apiRequest<TResponse = unknown>(
  input: string,
  init: ApiRequestInit = {},
): Promise<TResponse> {
  const { parseJson = true, headers, ...rest } = init;
  const resolvedHeaders = new Headers(headers);

  if (rest.body && !resolvedHeaders.has('Content-Type')) {
    resolvedHeaders.set('Content-Type', 'application/json');
  }

  const response = await fetch(input, {
    cache: 'no-store',
    ...rest,
    headers: resolvedHeaders,
  });

  if (!response.ok) {
    const errorPayload = await safeParseJson(response).catch(() => undefined);
    const message = extractErrorMessage(errorPayload) ?? response.statusText;
    throw new ApiError(message, response.status, errorPayload, {
      code: extractErrorCode(errorPayload),
      retryAfterMs: parseRetryAfterMs(response.headers.get('Retry-After')),
    });
  }

  if (!parseJson) {
    return undefined as TResponse;
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength === '0') {
    return undefined as TResponse;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    return text as TResponse;
  }

  return (await response.json()) as TResponse;
}

async function safeParseJson(response: Response): Promise<unknown | undefined> {
  try {
    return await response.json();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[api-client] Failed to parse error response body', error);
    return undefined;
  }
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const message = record.error ?? record.message ?? record.detail;
  if (typeof message === 'string' && message.trim().length > 0) {
    return message;
  }

  return undefined;
}
