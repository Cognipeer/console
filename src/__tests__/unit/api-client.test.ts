// @vitest-environment jsdom
/**
 * `@/lib/api/client`: how a failed call becomes an `ApiError`, the empty and text answers, the body types that must not
 * get a JSON Content-Type, the verb helpers, and the rules of the central 401 redirect.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  apiRequest,
  errorMessage,
  isApiError,
  resetLoginRedirectForTests,
  shouldRedirectToLogin,
} from '@/lib/api/client';

const ORIGIN = 'http://localhost:3000';

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });
}

/** The error a call fails with. */
async function failureOf(call: Promise<unknown>): Promise<ApiError> {
  try {
    await call;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('the call did not fail');
}

let fetchMock: ReturnType<typeof vi.fn>;
const lastInit = () => fetchMock.mock.calls.at(-1)![1] as RequestInit;
const lastHeaders = () => new Headers(lastInit().headers);

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetLoginRedirectForTests();
  window.history.pushState({}, '', '/');
});

describe('apiRequest answers', () => {
  it('parses a JSON answer', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [1, 2] }));
    await expect(apiRequest('/api/x')).resolves.toEqual({ items: [1, 2] });
    expect(lastInit().cache).toBe('no-store');
  });

  it('answers undefined for 204, an empty body and parseJson: false', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(apiRequest('/api/x', { method: 'DELETE' })).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(new Response('', { status: 200, headers: { 'content-length': '0' } }));
    await expect(apiRequest('/api/x')).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(jsonResponse({ ignored: true }));
    await expect(apiRequest('/api/x', { parseJson: false })).resolves.toBeUndefined();
  });

  it('answers the text of a non-JSON body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('plain', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    await expect(apiRequest('/api/x')).resolves.toBe('plain');
  });

  it('passes an abort signal to fetch', async () => {
    const controller = new AbortController();
    await apiGet('/api/x', { signal: controller.signal });
    expect(lastInit().signal).toBe(controller.signal);
  });
});

describe('apiRequest errors', () => {
  it('maps the message, code and Retry-After of a failed call', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Bucket in use', code: 'bucket_in_use' }, { status: 409, headers: { 'Content-Type': 'application/json', 'Retry-After': '3' } }),
    );
    const error = await failureOf(apiRequest('/api/x'));
    expect(isApiError(error)).toBe(true);
    expect(error).toMatchObject({ name: 'ApiError', message: 'Bucket in use', status: 409, code: 'bucket_in_use', retryAfterMs: 3000 });
    expect(error.payload).toEqual({ error: 'Bucket in use', code: 'bucket_in_use' });
  });

  it('reads the code from error.code, and the message from message or detail', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Nope', error: { code: 'inner' } }, { status: 400 }));
    const nested = await failureOf(apiRequest('/api/x'));
    expect(nested.code).toBe('inner');

    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Too long' }, { status: 422 }));
    expect((await failureOf(apiRequest('/api/x'))).message).toBe('Too long');
  });

  it('falls back to the status text when the body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 502, statusText: 'Bad Gateway' }));
    const error = await failureOf(apiRequest('/api/x'));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('Bad Gateway');
    expect(error.payload).toBeUndefined();
  });

  it('errorMessage gives text for an ApiError, an Error, a string and anything else', () => {
    expect(errorMessage(new ApiError('Denied', 403))).toBe('Denied');
    expect(errorMessage(new Error('Offline'))).toBe('Offline');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(undefined)).toBe('Something went wrong');
    expect(errorMessage(new ApiError('', 500), 'Try again')).toBe('Try again');
  });
});

describe('request bodies', () => {
  it('sets a JSON Content-Type for a string body, but never over one that is given', async () => {
    await apiRequest('/api/x', { method: 'POST', body: '{"a":1}' });
    expect(lastHeaders().get('Content-Type')).toBe('application/json');

    await apiRequest('/api/x', { method: 'POST', body: 'a=1', headers: { 'Content-Type': 'text/plain' } });
    expect(lastHeaders().get('Content-Type')).toBe('text/plain');
  });

  it('leaves the Content-Type of FormData, Blob and URLSearchParams to the browser', async () => {
    const form = new FormData();
    form.set('file', new Blob(['x']), 'x.txt');
    await apiPost('/api/x', form);
    expect(lastInit().body).toBe(form);
    expect(lastHeaders().has('Content-Type')).toBe(false);

    const blob = new Blob(['x'], { type: 'text/plain' });
    await apiPut('/api/x', blob);
    expect(lastInit().body).toBe(blob);
    expect(lastHeaders().has('Content-Type')).toBe(false);

    const params = new URLSearchParams({ a: '1' });
    await apiPatch('/api/x', params);
    expect(lastInit().body).toBe(params);
    expect(lastHeaders().has('Content-Type')).toBe(false);
  });
});

describe('verb helpers', () => {
  it('send the method and a JSON body', async () => {
    await apiGet('/api/x');
    expect(lastInit().method).toBe('GET');
    expect(lastInit().body).toBeUndefined();

    await apiPost('/api/x', { a: 1 });
    expect(lastInit().method).toBe('POST');
    expect(lastInit().body).toBe('{"a":1}');
    expect(lastHeaders().get('Content-Type')).toBe('application/json');

    await apiPut('/api/x', [1]);
    expect(lastInit().method).toBe('PUT');
    expect(lastInit().body).toBe('[1]');

    await apiPatch('/api/x', { b: 2 });
    expect(lastInit().method).toBe('PATCH');

    await apiDelete('/api/x');
    expect(lastInit().method).toBe('DELETE');
    expect(lastInit().body).toBeUndefined();

    await apiDelete('/api/x', { body: { ids: ['a'] } });
    expect(lastInit().body).toBe('{"ids":["a"]}');
  });

  it('send a string body as it is, and no body for a post without one', async () => {
    await apiPost('/api/x', 'raw');
    expect(lastInit().body).toBe('raw');
    await apiPost('/api/x');
    expect(lastInit().body).toBeUndefined();
  });
});

describe('shouldRedirectToLogin', () => {
  it('redirects for a same-origin /api/ call from a page inside the app', () => {
    expect(shouldRedirectToLogin('/api/prompts', '/dashboard/prompts', ORIGIN)).toBe(true);
    expect(shouldRedirectToLogin('/api/prompts?x=1', '/dashboard', ORIGIN)).toBe(true);
    expect(shouldRedirectToLogin(`${ORIGIN}/api/prompts`, '/no-project', ORIGIN)).toBe(true);
    expect(shouldRedirectToLogin('/api/prompts', '/change-password', ORIGIN)).toBe(true);
  });

  it('never redirects from a public page', () => {
    for (const page of ['/login', '/register', '/forgot-password', '/reset-password', '/p/support', '/', '/dashboardx']) {
      expect(shouldRedirectToLogin('/api/prompts', page, ORIGIN), page).toBe(false);
    }
  });

  it('does not redirect for the auth endpoints, another origin, or a call that is not /api/', () => {
    expect(shouldRedirectToLogin('/api/auth/login', '/dashboard', ORIGIN)).toBe(false);
    expect(shouldRedirectToLogin('/api/auth/me', '/dashboard', ORIGIN)).toBe(false);
    expect(shouldRedirectToLogin('https://elsewhere.example/api/prompts', '/dashboard', ORIGIN)).toBe(false);
    expect(shouldRedirectToLogin('/other/prompts', '/dashboard', ORIGIN)).toBe(false);
    expect(shouldRedirectToLogin('http://[bad', '/dashboard', ORIGIN)).toBe(false);
  });
});

describe('central 401 redirect', () => {
  it('sends the person to the login page once, keeping the page to come back to', async () => {
    const navigate = vi.fn();
    resetLoginRedirectForTests(navigate);
    window.history.pushState({}, '', '/dashboard/prompts?tab=1');
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'Unauthorized' }, { status: 401 }));

    await expect(apiGet('/api/prompts')).rejects.toMatchObject({ status: 401, message: 'Unauthorized' });
    await expect(apiGet('/api/prompts/stats')).rejects.toMatchObject({ status: 401 });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/login?returnTo=%2Fdashboard%2Fprompts%3Ftab%3D1');
  });

  it('stays on a public page, and ignores a 401 of the auth endpoints', async () => {
    const navigate = vi.fn();
    resetLoginRedirectForTests(navigate);
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'Unauthorized' }, { status: 401 }));

    window.history.pushState({}, '', '/login');
    await expect(apiPost('/api/prompts', {})).rejects.toBeInstanceOf(ApiError);

    window.history.pushState({}, '', '/dashboard');
    await expect(apiPost('/api/auth/login', {})).rejects.toBeInstanceOf(ApiError);

    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not redirect for other failures', async () => {
    const navigate = vi.fn();
    resetLoginRedirectForTests(navigate);
    window.history.pushState({}, '', '/dashboard');
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'Forbidden' }, { status: 403 }));

    await expect(apiGet('/api/prompts')).rejects.toMatchObject({ status: 403 });
    expect(navigate).not.toHaveBeenCalled();
  });
});
