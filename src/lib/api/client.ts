export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
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
    throw new ApiError(message, response.status, errorPayload);
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
    console.warn('Failed to parse error response body', error);
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
