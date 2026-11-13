// NOTE: This module is imported by 'use client' components (browser runtime).
// Do NOT use Winston logger here — only console.* is available in the browser.

import { buildLoginPath } from '@/lib/security/returnTo';

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

/* ── Central 401 handling ────────────────────────────────────────────────── */

/** Pages that need a session. A 401 from the API while one of these is open means the session is gone. */
const AUTHENTICATED_PAGE_PREFIXES = ['/dashboard', '/no-project', '/change-password'] as const;

/** The sign-in endpoints answer 401 for a wrong password; that is a result, not an expired session. */
const AUTH_API_PREFIX = '/api/auth/';

function isInsideAuthenticatedApp(pathname: string): boolean {
  return AUTHENTICATED_PAGE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** The path of a same-origin request URL, or null for another origin / a malformed URL. */
function sameOriginPath(url: string, origin: string): string | null {
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === origin ? parsed.pathname : null;
  } catch {
    return null;
  }
}

/**
 * Whether a 401 answer to `requestUrl` while the browser shows `pathname` should send the person to the login page:
 * only inside the authenticated app, and only for a same-origin `/api/` call that is not an auth endpoint.
 */
export function shouldRedirectToLogin(requestUrl: string, pathname: string, origin: string): boolean {
  if (!isInsideAuthenticatedApp(pathname)) return false;
  const path = sameOriginPath(requestUrl, origin);
  if (path === null) return false;
  if (!path.startsWith('/api/')) return false;
  return !path.startsWith(AUTH_API_PREFIX);
}

let loginRedirectStarted = false;
const navigateByLocation = (path: string): void => window.location.assign(path);
let navigate: (path: string) => void = navigateByLocation;

/** Test hook: lets the next 401 redirect again, and replaces how the browser is sent (`window.location` cannot be spied on). */
export function resetLoginRedirectForTests(navigateTo?: (path: string) => void): void {
  loginRedirectStarted = false;
  navigate = navigateTo ?? navigateByLocation;
}

function redirectToLoginOnce(requestUrl: string): void {
  if (loginRedirectStarted || typeof window === 'undefined') return;
  const { pathname, search, origin } = window.location;
  if (!shouldRedirectToLogin(requestUrl, pathname, origin)) return;
  loginRedirectStarted = true;
  navigate(buildLoginPath(`${pathname}${search}`));
}

/* ── Request ─────────────────────────────────────────────────────────────── */

/** Bodies the browser describes itself (a multipart boundary, a blob type): a JSON Content-Type would break them. */
function hasSelfDescribingBody(body: unknown): boolean {
  return (
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
    (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

export async function apiRequest<TResponse = unknown>(
  input: string,
  init: ApiRequestInit = {},
): Promise<TResponse> {
  const { parseJson = true, headers, ...rest } = init;
  const resolvedHeaders = new Headers(headers);

  if (rest.body && !hasSelfDescribingBody(rest.body) && !resolvedHeaders.has('Content-Type')) {
    resolvedHeaders.set('Content-Type', 'application/json');
  }

  const response = await fetch(input, {
    cache: 'no-store',
    ...rest,
    headers: resolvedHeaders,
  });

  if (!response.ok) {
    if (response.status === 401) redirectToLoginOnce(input);
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

/* ── Helpers ─────────────────────────────────────────────────────────────── */

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** The text to show a person for a failed call: the server's message, else the error's, else `fallback`. */
export function errorMessage(error: unknown, fallback = 'Something went wrong'): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return fallback;
}

export type ApiCallInit = Omit<ApiRequestInit, 'method' | 'body'>;

/** A body the helpers send as JSON; FormData, Blob and strings go through untouched. */
function toBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string' || hasSelfDescribingBody(body)) return body as BodyInit;
  return JSON.stringify(body);
}

export function apiGet<T = unknown>(url: string, init: ApiCallInit = {}): Promise<T> {
  return apiRequest<T>(url, { ...init, method: 'GET' });
}

export function apiPost<T = unknown>(url: string, body?: unknown, init: ApiCallInit = {}): Promise<T> {
  return apiRequest<T>(url, { ...init, method: 'POST', body: toBody(body) });
}

export function apiPut<T = unknown>(url: string, body?: unknown, init: ApiCallInit = {}): Promise<T> {
  return apiRequest<T>(url, { ...init, method: 'PUT', body: toBody(body) });
}

export function apiPatch<T = unknown>(url: string, body?: unknown, init: ApiCallInit = {}): Promise<T> {
  return apiRequest<T>(url, { ...init, method: 'PATCH', body: toBody(body) });
}

export function apiDelete<T = unknown>(url: string, init: ApiCallInit & { body?: unknown } = {}): Promise<T> {
  const { body, ...rest } = init;
  return apiRequest<T>(url, { ...rest, method: 'DELETE', body: toBody(body) });
}
